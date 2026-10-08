import type { ReferendumInfo } from '../types';
import type {
  ReferendumOngoing,
  ScheduledCall,
  SubstrateApi,
  TrackInfo,
} from '../types/substrate-api';
import { toHexString } from '../utils/hex';
import { stringify } from '../utils/json';
import type { Logger } from '../utils/logger';
import { getEnactmentTaskName } from '../utils/scheduler-task-name';
import { getReferendaPallet, getReferendaPalletName } from './chain-registry';

interface BuildReferendumInfoParams {
  api: SubstrateApi;
  referendumId: number;
  ongoing: ReferendumOngoing;
  status: ReferendumInfo['status'];
  tally: ReferendumInfo['tally'];
  deciding: ReferendumInfo['deciding'];
  useFellowship: boolean;
}

export class ReferendaFetcher {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async fetchReferendum(
    api: SubstrateApi,
    referendumId: number,
    useFellowship: boolean = false
  ): Promise<ReferendumInfo | null> {
    const palletName = getReferendaPalletName(useFellowship);
    this.logger.debug(`Fetching referendum #${referendumId} from ${palletName} pallet...`);

    const pallet = getReferendaPallet(api, useFellowship);
    const refInfo = await pallet.ReferendumInfoFor.getValue(referendumId);

    if (!refInfo) {
      this.logger.error(`Referendum #${referendumId} not found in ${palletName} pallet`);
      return null;
    }

    this.logger.debug(`Raw referendum info: ${stringify(refInfo, 2)}`);

    const status = refInfo.type.toLowerCase() as ReferendumInfo['status'];

    if (refInfo.type !== 'Ongoing') {
      if (refInfo.type === 'Approved') {
        return await this.buildApprovedReferendumInfo(api, referendumId, status);
      }

      this.logger.warn(`Referendum #${referendumId} is not ongoing (status: ${status})`);
      this.logger.info('Please try an ongoing referendum ID');
      return null;
    }

    const ongoing = refInfo.value;

    const tally: ReferendumInfo['tally'] = ongoing.tally
      ? {
          ayes: ongoing.tally.ayes,
          nays: ongoing.tally.nays,
          support:
            'support' in ongoing.tally ? (ongoing.tally as { support: bigint }).support : BigInt(0),
        }
      : undefined;

    const deciding: ReferendumInfo['deciding'] = ongoing.deciding
      ? {
          since: ongoing.deciding.since,
          confirming: ongoing.deciding.confirming,
        }
      : undefined;

    const referendumInfo = await this.buildOngoingReferendumInfo({
      api,
      referendumId,
      ongoing,
      status,
      tally,
      deciding,
      useFellowship,
    });

    this.logger.debug(`Parsed referendum info: ${stringify(referendumInfo, 2)}`);

    return referendumInfo;
  }

  private async buildOngoingReferendumInfo(
    params: BuildReferendumInfoParams
  ): Promise<ReferendumInfo> {
    const { api, referendumId, ongoing, status, tally, deciding, useFellowship } = params;

    const {
      hash: proposalHashHex,
      call: preimage,
      type: proposalType,
      len: proposalLen,
    } = this.parseProposal(ongoing.proposal);

    this.logger.debug(
      `Proposal type: ${proposalType}, hash: ${proposalHashHex ?? 'unknown'}, preimage length: ${proposalLen}`
    );

    const trackId = ongoing.track;
    const referendaConstants = useFellowship
      ? api.constants.FellowshipReferenda
      : api.constants.Referenda;
    const tracks = await referendaConstants.Tracks();
    const track = tracks.find((t: TrackInfo) => t[0] === trackId);
    const trackName = track ? track[1]?.name || `track_${trackId}` : `track_${trackId}`;

    return {
      id: referendumId,
      track: trackName,
      origin: ongoing.origin,
      proposal: {
        hash: proposalHashHex ?? 'inline',
        call: preimage,
        type: proposalType,
        len: proposalType === 'Lookup' ? proposalLen : undefined,
      },
      status,
      tally,
      submittedAt: ongoing.submitted,
      submissionDeposit: ongoing.submission_deposit
        ? {
            who: ongoing.submission_deposit.who,
            amount: ongoing.submission_deposit.amount,
          }
        : undefined,
      decisionDeposit: ongoing.decision_deposit
        ? {
            who: ongoing.decision_deposit.who,
            amount: ongoing.decision_deposit.amount,
          }
        : undefined,
      deciding,
    };
  }

  private async buildApprovedReferendumInfo(
    api: SubstrateApi,
    referendumId: number,
    status: ReferendumInfo['status']
  ): Promise<ReferendumInfo> {
    const stub: ReferendumInfo = {
      id: referendumId,
      track: 'unknown',
      origin: null,
      proposal: { hash: 'unknown', call: undefined, type: 'Lookup' },
      status,
      submittedAt: 0,
    };

    const taskName = getEnactmentTaskName(referendumId);
    const taskNameHex = (toHexString(taskName) ?? '').toLowerCase();

    // Locate the enactment entry. Prefer Scheduler.Lookup, but some runtimes expose a Lookup
    // storage shape polkadot-api cannot decode ("Incompatible runtime entry"); fall back to
    // scanning Scheduler.Agenda (which stays decodable) for the entry carrying this referendum's
    // enactment task id.
    let scheduledBlock: number | undefined;
    let agendaIndex: number | undefined;
    let entry: { call?: ScheduledCall } | undefined;
    try {
      const lookup = await api.query.Scheduler.Lookup.getValue(taskName as unknown as Uint8Array);
      if (lookup) {
        [scheduledBlock, agendaIndex] = lookup;
        const agenda = await api.query.Scheduler.Agenda.getValue(scheduledBlock);
        entry = agenda?.[agendaIndex];
      }
    } catch (error) {
      this.logger.debug(
        `Scheduler.Lookup unavailable for referendum #${referendumId} (${(error as Error).message}); scanning agenda by task id`
      );
    }

    if (!entry?.call) {
      let entries: Awaited<ReturnType<typeof api.query.Scheduler.Agenda.getEntries>>;
      try {
        entries = await api.query.Scheduler.Agenda.getEntries();
      } catch (error) {
        this.logger.warn(
          `Failed to scan Scheduler.Agenda for referendum #${referendumId}: ${(error as Error).message}`
        );
        return stub;
      }
      outer: for (const agendaEntry of entries) {
        const items = (agendaEntry.value ?? []) as Array<
          { maybe_id?: unknown; maybeId?: unknown; call?: ScheduledCall } | undefined
        >;
        for (let index = 0; index < items.length; index++) {
          const item = items[index];
          const id = item?.maybe_id ?? item?.maybeId;
          if (id && (toHexString(id) ?? '').toLowerCase() === taskNameHex) {
            scheduledBlock = Number((agendaEntry.keyArgs as unknown[])[0]);
            agendaIndex = index;
            entry = item;
            break outer;
          }
        }
      }
    }

    if (!entry?.call || scheduledBlock === undefined) {
      this.logger.info(
        `Referendum #${referendumId} is approved and its scheduled enactment has already executed`
      );
      return stub;
    }

    const { hash, call, type, len } = this.parseProposal(entry.call);
    const currentBlock = await this.getLatestBlock(api);

    this.logger.info(
      `Referendum #${referendumId} is approved with scheduled enactment at block ${scheduledBlock} (current block ${currentBlock})`
    );
    this.logger.debug(`Scheduled enactment proposal type: ${type}, hash: ${hash ?? 'inline'}`);

    return {
      id: referendumId,
      track: 'unknown',
      origin: null,
      proposal: {
        hash: hash ?? 'inline',
        call,
        type,
        len: type === 'Lookup' ? len : undefined,
      },
      status,
      submittedAt: 0,
    };
  }

  private parseProposal(proposal: ScheduledCall): {
    hash: string | undefined;
    call: unknown;
    type: 'Lookup' | 'Inline';
    len: number;
  } {
    if (proposal.type === 'Lookup') {
      return {
        hash: toHexString(proposal.value.hash),
        call: undefined,
        type: 'Lookup',
        len: proposal.value.len,
      };
    }

    // proposal.type === 'Inline' → proposal.value is Binary
    const inlineHex = toHexString(proposal.value);
    return { hash: inlineHex, call: proposal.value, type: 'Inline', len: 0 };
  }

  async getLatestBlock(api: SubstrateApi): Promise<number> {
    const header = await api.query.System.Number.getValue();
    return Number(header);
  }
}
