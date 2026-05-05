import { FixedSizeBinary } from '@polkadot-api/substrate-bindings';
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

    const taskName = FixedSizeBinary.fromBytes(getEnactmentTaskName(referendumId));
    let lookup: [number, number] | undefined;
    try {
      lookup = await api.query.Scheduler.Lookup.getValue(taskName as unknown as Uint8Array);
    } catch (error) {
      this.logger.warn(
        `Failed to read Scheduler.Lookup for referendum #${referendumId}: ${(error as Error).message}`
      );
      return stub;
    }

    if (!lookup) {
      this.logger.info(
        `Referendum #${referendumId} is approved and its scheduled enactment has already executed`
      );
      return stub;
    }

    const [scheduledBlock, agendaIndex] = lookup;
    let agenda: Awaited<ReturnType<typeof api.query.Scheduler.Agenda.getValue>>;
    try {
      agenda = await api.query.Scheduler.Agenda.getValue(scheduledBlock);
    } catch (error) {
      this.logger.warn(
        `Failed to read Scheduler.Agenda[${scheduledBlock}] for referendum #${referendumId}: ${(error as Error).message}`
      );
      return stub;
    }
    const entry = agenda?.[agendaIndex];

    if (!entry?.call) {
      this.logger.warn(
        `Referendum #${referendumId} is approved with a scheduler lookup at block ${scheduledBlock} index ${agendaIndex}, but no agenda entry was found there`
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
