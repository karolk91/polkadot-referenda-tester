import type { ScheduledCall, ScheduledEntry, SubstrateApi } from '../types/substrate-api';
import { toHexString } from '../utils/hex';
import { stringify } from '../utils/json';
import type { Logger } from '../utils/logger';
import { convertAgendaToStorageFormat } from '../utils/storage-format-converter';
import { getReferendaPalletName } from './chain-registry';
import type { ChopsticksManager } from './chopsticks-manager';

export class SchedulerManager {
  private logger: Logger;
  private chopsticks: ChopsticksManager;
  private api: SubstrateApi;
  private isFellowship: boolean;

  constructor(
    logger: Logger,
    chopsticks: ChopsticksManager,
    api: SubstrateApi,
    isFellowship: boolean
  ) {
    this.logger = logger;
    this.chopsticks = chopsticks;
    this.api = api;
    this.isFellowship = isFellowship;
  }

  /**
   * Get the appropriate block numbers for scheduling based on chain type.
   * Returns relay chain blocks for main governance on parachains, otherwise parachain blocks.
   */
  async getSchedulingBlocks(): Promise<{ currentBlock: number; targetBlock: number }> {
    const parachainBlock = Number(await this.api.query.System.Number.getValue());
    let currentBlock = parachainBlock;
    let targetBlock = parachainBlock + 1;

    if (!this.isFellowship) {
      const lastRelayBlockQuery = this.api.query.ParachainSystem?.LastRelayChainBlockNumber;
      if (lastRelayBlockQuery && typeof lastRelayBlockQuery.getValue === 'function') {
        try {
          const relayBlock = await lastRelayBlockQuery.getValue();
          if (relayBlock !== undefined && relayBlock !== null) {
            const relayBlockNumber = Number(relayBlock);
            if (!Number.isNaN(relayBlockNumber)) {
              currentBlock = relayBlockNumber - 1;
              targetBlock = relayBlockNumber;
              this.logger.debug(
                `Main governance on parachain: using relay blocks (current: ${currentBlock}, target: ${targetBlock}, parachain: ${parachainBlock})`
              );
            }
          }
        } catch (error) {
          this.logger.debug(`Failed to read LastRelayChainBlockNumber: ${error}`);
        }
      }
    }

    return { currentBlock, targetBlock };
  }

  /**
   * Move scheduled call to next block.
   * Returns the block number where the call was scheduled.
   */
  async moveScheduledCallToNextBlock(
    referendumId: number,
    callType: 'nudge' | 'execute',
    proposalHash?: string
  ): Promise<number> {
    const { targetBlock } = await this.getSchedulingBlocks();

    const match = await this.findMatchingScheduledCall(referendumId, callType, proposalHash);

    if (!match) {
      throw new Error(`Scheduled ${callType} call not found for referendum ${referendumId}`);
    }

    const { keyArgs, agendaItems, scheduledEntry } = match;

    this.logger.debug(
      `Found ${callType} call at block ${keyArgs[0]}, moving to block ${targetBlock}`
    );

    const callInfo = this.getCallInfo(scheduledEntry.call);
    this.logger.info(`\u{1F4CB} Scheduling ${callType} call:`);
    this.logger.info(`   From block: ${keyArgs[0]}`);
    this.logger.info(`   To block: ${targetBlock}`);
    this.logger.info(`   Call type: ${callInfo.type}`);
    if (callInfo.hex) {
      this.logger.info(
        `   Call hex: ${callInfo.hex.substring(0, 100)}${callInfo.hex.length > 100 ? '...' : ''}`
      );
    }

    const convertedAgenda = convertAgendaToStorageFormat(agendaItems);

    await this.chopsticks.setStorageBatch({
      Scheduler: {
        Agenda: [
          [[keyArgs[0]], null],
          [[targetBlock], convertedAgenda],
        ],
      },
    });

    if (scheduledEntry.maybeId) {
      try {
        const lookupId = scheduledEntry.maybeId;
        const lookup = await this.api.query.Scheduler.Lookup.getValue(lookupId);

        if (lookup) {
          await this.chopsticks.setStorageBatch({
            Scheduler: {
              Lookup: [[[lookupId], [targetBlock, 0]]],
            },
          });
        }
      } catch (err) {
        this.logger.debug(`No lookup found: ${err}`);
      }
    }

    return targetBlock;
  }

  private async findMatchingScheduledCall(
    referendumId: number,
    callType: 'nudge' | 'execute',
    proposalHash?: string
  ): Promise<{
    keyArgs: unknown[];
    agendaItems: ScheduledEntry[];
    scheduledEntry: ScheduledEntry;
  } | null> {
    this.logger.debug(`Searching for ${callType} call (referendum ${referendumId}) in scheduler`);

    const agendaEntries = await this.api.query.Scheduler.Agenda.getEntries();
    this.logger.debug(`Found ${agendaEntries.length} total agenda entries`);

    for (const entry of agendaEntries) {
      const { keyArgs, value: agendaItems } = entry;

      if (!agendaItems || agendaItems.length === 0) {
        continue;
      }

      for (const scheduledEntry of agendaItems) {
        if (!scheduledEntry?.call) continue;

        const isMatch =
          callType === 'nudge'
            ? await this.isNudgeReferendumCall(scheduledEntry.call, referendumId)
            : this.isProposalExecutionCall(scheduledEntry.call, proposalHash);

        if (isMatch) {
          return { keyArgs, agendaItems, scheduledEntry };
        }
      }
    }

    return null;
  }

  private getCallInfo(call: ScheduledCall): { type: string; hex?: string; hash?: string } {
    if (call.type === 'Inline') {
      return {
        type: 'Inline',
        hex: toHexString(call.value) || undefined,
      };
    }

    return {
      type: 'Lookup',
      hash: (call.value.hash ? toHexString(call.value.hash) : undefined) || undefined,
    };
  }

  private isProposalExecutionCall(call: ScheduledCall, proposalHash?: string): boolean {
    try {
      if (call.type === 'Lookup') {
        if (proposalHash) {
          const callHash = toHexString(call.value.hash) ?? String(call.value.hash);
          const matches = callHash === proposalHash;
          if (matches) {
            this.logger.debug(`\u2713 Found Lookup call matching proposal hash: ${proposalHash}`);
          }
          return matches;
        }
        return true;
      }

      // call.type === 'Inline'
      if (!proposalHash) {
        this.logger.debug('Found Inline call (no hash to verify against)');
        return true;
      }

      const callDataHex =
        toHexString(call.value) ??
        (call.value && typeof call.value === 'object' ? stringify(call.value) : '');

      const matches =
        callDataHex === proposalHash || callDataHex.toLowerCase() === proposalHash.toLowerCase();

      if (matches) {
        this.logger.debug(
          `\u2713 Found Inline call matching proposal call data: ${proposalHash.substring(0, 66)}...`
        );
      } else {
        this.logger.debug(
          `Inline call data ${callDataHex.substring(0, 66)}... doesn't match proposal ${proposalHash.substring(0, 66)}...`
        );
      }

      return matches;
    } catch (error) {
      this.logger.debug(`Error checking proposal execution call: ${error}`);
      return false;
    }
  }

  private async isNudgeReferendumCall(
    callData: ScheduledCall,
    referendumId: number
  ): Promise<boolean> {
    try {
      const palletName = getReferendaPalletName(this.isFellowship);

      // Strategy 1: Decode inline bytes via the runtime API (most reliable)
      if (callData?.type === 'Inline' && callData?.value) {
        try {
          const decoded = await this.api.txFromCallData(callData.value);
          if (decoded?.decodedCall?.type === palletName) {
            const callValue = decoded.decodedCall.value;
            if (this.isNudgeMethod(callValue?.type)) {
              const refId = Number(callValue.value?.index);
              if (refId === referendumId) {
                this.logger.debug(
                  `Found matching nudge_referendum for ref ${referendumId} in ${palletName}`
                );
                return true;
              }
            }
          }
        } catch (decodeError) {
          this.logger.debug(`Failed to decode inline call: ${decodeError}`);
        }
      }

      // Strategy 2: Check structural properties on the call object itself
      return this.matchNudgeFromProperties(callData, palletName);
    } catch (error) {
      this.logger.debug(`Error checking nudge call: ${error}`);
      return false;
    }
  }

  private isNudgeMethod(name: string | undefined): boolean {
    return name === 'nudge_referendum' || name === 'nudgeReferendum';
  }

  private matchNudgeFromProperties(callObject: unknown, palletName: string): boolean {
    if (!callObject || typeof callObject !== 'object') return false;

    const record = callObject as Record<string, unknown>;
    const value = record.value as Record<string, unknown> | undefined;

    if (
      this.isNudgeMethod(record.method as string | undefined) ||
      this.isNudgeMethod(value?.type as string | undefined)
    ) {
      return true;
    }

    if ((record.type === palletName || record.pallet === palletName) && value) {
      if (
        this.isNudgeMethod(value.type as string | undefined) ||
        this.isNudgeMethod(value.method as string | undefined)
      ) {
        return true;
      }
    }

    if (record.type === 'Inline' && record.value) {
      return this.matchNudgeFromProperties(record.value, palletName);
    }

    return false;
  }
}
