import { ReferendumInfo } from '../types';
import { Logger } from '../utils/logger';

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
      const palletName = useFellowship ? 'FellowshipReferenda' : 'Referenda';
      this.logger.debug(`Fetching referendum #${referendumId} from ${palletName} pallet...`);

      // Fetch referendum info from the appropriate pallet
      let refInfo;
      if (useFellowship) {
        // Use FellowshipReferenda pallet
        refInfo = await (api.query.FellowshipReferenda as any).ReferendumInfoFor.getValue(
          referendumId
        );
      } else {
        // Use regular Referenda pallet
        refInfo = await (api.query.Referenda as any).ReferendumInfoFor.getValue(referendumId);
      }

      if (!refInfo) {
        this.logger.error(`Referendum #${referendumId} not found in ${palletName} pallet`);
        return null;
      }

      this.logger.debug(
        `Raw referendum info: ${JSON.stringify(refInfo, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}`
      );

      // Parse the referendum status
      let status: ReferendumInfo['status'];
      let tally;
      let deciding;

      // Handle both enum formats: { Ongoing: ... } and { type: "Ongoing", value: ... }
      const refType = refInfo.type || Object.keys(refInfo)[0];
      const refValue = refInfo.value || refInfo[refType];

      if (refType === 'Ongoing' || 'Ongoing' in refInfo) {
        status = 'ongoing';
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
      } else if (refType === 'Approved' || 'Approved' in refInfo) {
        status = 'approved';
      } else if (refType === 'Rejected' || 'Rejected' in refInfo) {
        status = 'rejected';
      } else if (refType === 'Cancelled' || 'Cancelled' in refInfo) {
        status = 'cancelled';
      } else if (refType === 'TimedOut' || 'TimedOut' in refInfo) {
        status = 'timedout';
      } else if (refType === 'Killed' || 'Killed' in refInfo) {
        status = 'killed';
      } else {
        throw new Error(`Unknown referendum status: ${JSON.stringify(refInfo)}`);
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

      // Get the proposal hash and preimage
      // Handle both direct hash and Lookup format
      let proposalHashHex: string | undefined;
      let proposalLen: number;
      let proposalType: 'Lookup' | 'Inline';
      let proposalCall: any;

      if (ongoing.proposal.type === 'Lookup') {
        // For Lookup, call .asHex() on the hash object
        proposalHashHex = ongoing.proposal.value.hash.asHex();
        proposalLen = ongoing.proposal.value.len;
        proposalType = 'Lookup';
        proposalCall = undefined;
      } else {
        // For Inline, handle the hash conversion
        const inlineValue = ongoing.proposal.value ?? ongoing.proposal;
        const proposalHash = inlineValue?.hash ?? inlineValue;
        proposalLen = inlineValue?.length || inlineValue?.len || 0;
        proposalType = 'Inline';
        proposalCall = inlineValue;

        if (typeof proposalHash === 'string') {
          proposalHashHex = proposalHash.startsWith('0x') ? proposalHash : '0x' + proposalHash;
        } else if (proposalHash && typeof proposalHash.asHex === 'function') {
          proposalHashHex = proposalHash.asHex();
        } else if (proposalHash && typeof proposalHash.toString === 'function') {
          proposalHashHex = proposalHash.toString();
        } else {
          proposalHashHex = undefined;
        }
      }

      this.logger.debug(
        `Proposal type: ${proposalType}, hash: ${proposalHashHex ?? 'unknown'}, preimage length: ${proposalLen}`
      );

      // For Lookup proposals, the preimage must already be on-chain
      // We don't fetch it - the Scheduler will look it up when executing
      // For Inline proposals, the call data is embedded in the referendum
      let preimage;
      if (proposalType === 'Inline') {
        preimage = proposalCall;
      }

      // Determine the track
      const trackId = ongoing.track;
      const tracks = useFellowship
        ? await api.constants.FellowshipReferenda.Tracks()
        : await api.constants.Referenda.Tracks();
      const track = tracks.find((t: any) => t[0] === trackId);
      const trackName = track ? this.getTrackName(track[0]) : `Unknown (${trackId})`;

      const hashValue = proposalHashHex ?? 'inline';

      const referendumInfo: ReferendumInfo = {
        id: referendumId,
        track: trackName,
        origin: ongoing.origin,
        proposal: {
          hash: hashValue,
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

      this.logger.debug(
        `Parsed referendum info: ${JSON.stringify(referendumInfo, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}`
      );

      return referendumInfo;
    } catch (error) {
      const palletName = useFellowship ? 'FellowshipReferenda' : 'Referenda';
      this.logger.error(
        `Failed to fetch referendum #${referendumId} from ${palletName} pallet`,
        error as Error
      );
      return null;
    }
  }

  private getTrackName(trackId: number): string {
    // Common Polkadot governance tracks
    const trackNames: Record<number, string> = {
      0: 'root',
      1: 'whitelisted_caller',
      10: 'staking_admin',
      11: 'treasurer',
      12: 'lease_admin',
      13: 'fellowship_admin',
      14: 'general_admin',
      15: 'auction_admin',
      20: 'referendum_canceller',
      21: 'referendum_killer',
      30: 'small_tipper',
      31: 'big_tipper',
      32: 'small_spender',
      33: 'medium_spender',
      34: 'big_spender',
    };

    return trackNames[trackId] || `track_${trackId}`;
  }

  async getLatestBlock(api: any): Promise<number> {
    const header = await api.query.System.Number.getValue();
    return Number(header);
  }
}
