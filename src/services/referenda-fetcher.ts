import { ReferendumInfo } from '../types';
import { Logger } from '../utils/logger';
import { stringify } from '../utils/json';
import { getReferendaPalletName, getReferendaPallet } from './chain-registry';

const STATUS_MAP: Record<string, ReferendumInfo['status']> = {
  Ongoing: 'ongoing',
  Approved: 'approved',
  Rejected: 'rejected',
  Cancelled: 'cancelled',
  TimedOut: 'timedout',
  Killed: 'killed',
};

export class ReferendaFetcher {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async fetchReferendum(
    api: any,
    referendumId: number,
    useFellowship: boolean = false
  ): Promise<ReferendumInfo | null> {
    try {
      const palletName = getReferendaPalletName(useFellowship);
      this.logger.debug(`Fetching referendum #${referendumId} from ${palletName} pallet...`);

      const pallet = getReferendaPallet(api, useFellowship);
      const refInfo = await pallet.ReferendumInfoFor.getValue(referendumId);

      if (!refInfo) {
        this.logger.error(`Referendum #${referendumId} not found in ${palletName} pallet`);
        return null;
      }

      this.logger.debug(`Raw referendum info: ${stringify(refInfo, 2)}`);

      // Handle both enum formats: { Ongoing: ... } and { type: "Ongoing", value: ... }
      const refType = refInfo.type || Object.keys(refInfo)[0];
      const refValue = refInfo.value || refInfo[refType];

      // Resolve status via lookup, falling back to key-based detection
      const resolvedType = STATUS_MAP[refType]
        ? refType
        : Object.keys(STATUS_MAP).find((key) => key in refInfo);

      if (!resolvedType) {
        throw new Error(`Unknown referendum status: ${stringify(refInfo)}`);
      }

      const status = STATUS_MAP[resolvedType];

      let tally;
      let deciding;

      if (status === 'ongoing') {
        const ongoing = refValue || refInfo.Ongoing;

        tally = ongoing.tally
          ? {
              ayes: ongoing.tally.ayes,
              nays: ongoing.tally.nays,
              support: ongoing.tally.support,
            }
          : undefined;

        deciding = ongoing.deciding
          ? {
              since: ongoing.deciding.since,
              confirming: ongoing.deciding.confirming,
            }
          : undefined;
      }

      const ongoing = (refType === 'Ongoing' && refValue) || refInfo.Ongoing || null;

      if (!ongoing) {
        // For approved/rejected/etc referenda, return minimal info
        // This allows the flow to continue (e.g., test main referendum even if fellowship is approved)
        if (status === 'approved') {
          this.logger.info(
            `Referendum #${referendumId} is already approved - calls have been executed`
          );
          return {
            id: referendumId,
            track: 'unknown',
            origin: null,
            proposal: {
              hash: 'unknown',
              call: undefined,
              type: 'Lookup' as const,
            },
            status,
            submittedAt: 0,
          };
        }

        this.logger.warn(`Referendum #${referendumId} is not ongoing (status: ${status})`);
        this.logger.info(`Please try an ongoing referendum ID`);
        return null;
      }

      const referendumInfo = await this.buildOngoingReferendumInfo(
        api,
        referendumId,
        ongoing,
        status,
        tally,
        deciding,
        useFellowship
      );

      this.logger.debug(`Parsed referendum info: ${stringify(referendumInfo, 2)}`);

      return referendumInfo;
    } catch (error) {
      const palletName = getReferendaPalletName(useFellowship);
      this.logger.error(
        `Failed to fetch referendum #${referendumId} from ${palletName} pallet`,
        error as Error
      );
      return null;
    }
  }

  private async buildOngoingReferendumInfo(
    api: any,
    referendumId: number,
    ongoing: any,
    status: ReferendumInfo['status'],
    tally: ReferendumInfo['tally'],
    deciding: ReferendumInfo['deciding'],
    useFellowship: boolean
  ): Promise<ReferendumInfo> {
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
    const track = tracks.find((t: any) => t[0] === trackId);
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

  private parseProposal(proposal: any): {
    hash: string | undefined;
    call: any;
    type: 'Lookup' | 'Inline';
    len: number;
  } {
    if (proposal.type === 'Lookup') {
      return {
        hash: proposal.value.hash.asHex(),
        call: undefined,
        type: 'Lookup',
        len: proposal.value.len,
      };
    }

    const inlineValue = proposal.value ?? proposal;
    const proposalHash = inlineValue?.hash ?? inlineValue;
    const len = inlineValue?.length || inlineValue?.len || 0;

    let hash: string | undefined;
    if (typeof proposalHash === 'string') {
      hash = proposalHash.startsWith('0x') ? proposalHash : '0x' + proposalHash;
    } else if (proposalHash && typeof proposalHash.asHex === 'function') {
      hash = proposalHash.asHex();
    } else if (proposalHash && typeof proposalHash.toString === 'function') {
      hash = proposalHash.toString();
    }

    return { hash, call: inlineValue, type: 'Inline', len };
  }

  async getLatestBlock(api: any): Promise<number> {
    const header = await api.query.System.Number.getValue();
    return Number(header);
  }
}
