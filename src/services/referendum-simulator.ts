import { ReferendumInfo, SimulationResult } from '../types';
import { Logger } from '../utils/logger';
import { stringify } from '../utils/json';
import { ChopsticksManager } from './chopsticks-manager';
import { serializeEventData, parseBlockEvent, ParsedEvent } from '../utils/event-serializer';
import { interpretDispatchResult, formatDispatchError } from '../utils/dispatch-result';
import {
  convertOriginToStorageFormat,
  convertProposalToStorageFormat,
  convertAgendaToStorageFormat,
} from '../utils/storage-format-converter';

/** Arbitrary high number of voters for fellowship passing tally */
const FELLOWSHIP_PASSING_BARE_AYES = 100;
/** High rank-weighted support for fellowship passing tally */
const FELLOWSHIP_PASSING_AYES = 1000;

export class ReferendumSimulator {
  private logger: Logger;
  private chopsticks: ChopsticksManager;
  private api: any;
  private isFellowship: boolean;

  constructor(
    logger: Logger,
    chopsticks: ChopsticksManager,
    api: any,
    isFellowship: boolean = false
  ) {
    this.logger = logger;
    this.chopsticks = chopsticks;
    this.api = api;
    this.isFellowship = isFellowship;
  }

  /**
   * Get the correct referenda pallet name based on whether this is a fellowship referendum
   */
  private getReferendaPalletName(): string {
    return this.isFellowship ? 'FellowshipReferenda' : 'Referenda';
  }

  async simulate(
    referendum: ReferendumInfo,
    preExecutionOptions?: { preCall?: string; preOrigin?: string }
  ): Promise<SimulationResult> {
    const result: SimulationResult = {
      success: false,
      referendumId: referendum.id,
      executionSucceeded: false,
      events: [],
    };

    try {
      // If referendum is already approved, skip simulation
      if (referendum.status === 'approved') {
        this.logger.info(`Referendum #${referendum.id} is already approved - skipping simulation`);
        return {
          success: true,
          referendumId: referendum.id,
          executionSucceeded: true,
          events: [],
          blockExecuted: 0,
        };
      }

      this.logger.section('Simulating Referendum Execution (Force Approval Strategy)');

      const executionResult = await this.forceReferendumExecution(referendum, preExecutionOptions);

      result.success = executionResult.success;
      result.executionSucceeded = executionResult.executionSucceeded;
      result.events = executionResult.events;
      result.blockExecuted = executionResult.blockExecuted;

      if (executionResult.errors && executionResult.errors.length > 0) {
        result.errors = executionResult.errors;
      }

      return result;
    } catch (error) {
      this.logger.error('Simulation failed', error as Error);
      result.errors = [(error as Error).message];
      return result;
    }
  }

  /**
   * Force referendum execution by manipulating its state to pass and execute
   */
  private async forceReferendumExecution(
    referendum: ReferendumInfo,
    preExecutionOptions?: { preCall?: string; preOrigin?: string }
  ): Promise<{
    success: boolean;
    executionSucceeded: boolean;
    events: any[];
    errors?: string[];
    blockExecuted: number;
  }> {
    // If pre-execution call is provided, execute it first
    if (preExecutionOptions?.preCall) {
      await this.executePreCall(preExecutionOptions.preCall, preExecutionOptions.preOrigin);
    }

    this.logger.startSpinner('Forcing referendum to passing state...');

    try {
      // Get current referendum info from Chopsticks instance using the correct pallet
      const palletName = this.getReferendaPalletName();
      const refInfo = await (this.api.query as any)[palletName].ReferendumInfoFor.getValue(
        referendum.id
      );

      if (!refInfo) {
        throw new Error(
          `Referendum ${referendum.id} not found in ${palletName} pallet in Chopsticks instance`
        );
      }

      if (refInfo.type !== 'Ongoing') {
        const actualState = refInfo.type || Object.keys(refInfo)[0] || 'unknown';
        this.logger.info(
          `Referendum ${referendum.id} is in state: ${actualState} (expected: Ongoing)`
        );

        // If it's already approved, we can skip forcing and just try to execute
        if (actualState === 'Approved' || actualState === 'approved') {
          this.logger.info(
            'Referendum already approved in Chopsticks fork, attempting to execute scheduled call...'
          );
        } else {
          throw new Error(
            `Referendum ${referendum.id} is not in Ongoing state (current state: ${actualState})`
          );
        }
      }

      // Get total issuance for creating passing votes
      const totalIssuance = await this.api.query.Balances.TotalIssuance.getValue();
      this.logger.debug(`Total issuance: ${totalIssuance}`);

      // Get current and target block numbers (using relay chain blocks for main governance on parachains)
      const { currentBlock, targetBlock } = await this.getSchedulingBlocks();
      this.logger.debug(`Current block: ${currentBlock}, Target block: ${targetBlock}`);

      // Modify the referendum to have passing votes and set it to confirm soon
      const ongoingData = refInfo.value;

      const originForStorage = convertOriginToStorageFormat(ongoingData.origin);
      const proposalForStorage = convertProposalToStorageFormat(ongoingData.proposal);

      // For deciding fields, use the same block numbering system as scheduling
      const decidingSince = currentBlock - 1;
      const decidingConfirming = currentBlock - 1;

      this.logger.debug('Setting referendum enactment to execute immediately (after: 0 blocks)');

      const enactmentForStorage = { after: 0 };

      // Build tally based on referendum type
      let tally: any;
      if (this.isFellowship) {
        tally = {
          bare_ayes: FELLOWSHIP_PASSING_BARE_AYES,
          ayes: FELLOWSHIP_PASSING_AYES,
          nays: 0,
        };
      } else {
        // Regular governance: use near-total issuance to guarantee passing
        // Subtract 1 to avoid exactly matching total issuance
        tally = {
          ayes: (totalIssuance - 1n).toString(),
          nays: '0',
          support: (totalIssuance - 1n).toString(),
        };
      }

      const modifiedRefInfo = {
        ongoing: {
          track: ongoingData.track,
          origin: originForStorage,
          proposal: proposalForStorage,
          enactment: enactmentForStorage,
          submitted: ongoingData.submitted,
          submission_deposit: ongoingData.submission_deposit,
          decision_deposit: ongoingData.decision_deposit,
          deciding: {
            since: decidingSince,
            confirming: decidingConfirming,
          },
          tally,
          in_queue: ongoingData.in_queue || false,
          alarm: [currentBlock + 1, [currentBlock + 1, 0]],
        },
      };

      const palletNameForStorage = this.getReferendaPalletName();
      const referendumStorageUpdate = {
        [palletNameForStorage]: {
          ReferendumInfoFor: [[[referendum.id], modifiedRefInfo]],
        },
      };

      this.logger.debug(
        `Sending storage update to ${palletNameForStorage} pallet in Chopsticks: ${stringify(modifiedRefInfo, 2)}`
      );
      await this.chopsticks.setStorageBatch(referendumStorageUpdate);
      this.logger.succeedSpinner('Referendum state updated to passing');

      // Create block to commit storage changes
      await this.chopsticks.newBlock();

      // Verify the referendum was modified correctly
      this.logger.startSpinner('Verifying referendum modification...');
      const verifyRefInfo = await (this.api.query as any)[
        palletNameForStorage
      ].ReferendumInfoFor.getValue(referendum.id);
      if (verifyRefInfo && verifyRefInfo.type === 'Ongoing') {
        const ongoing = verifyRefInfo.value;
        const enactment = ongoing.enactment;
        const verifyTally = ongoing.tally;
        const deciding = ongoing.deciding;

        this.logger.succeedSpinner('Referendum modification verified');
        this.logger.info(`\u2713 Enactment: ${stringify(enactment)}`);
        this.logger.info(`\u2713 Tally: ${stringify(verifyTally)}`);
        this.logger.info(`\u2713 Deciding: ${deciding ? stringify(deciding) : 'null'}`);
      } else {
        this.logger.failSpinner(
          `Failed to verify - referendum is ${verifyRefInfo?.type || 'unknown'} state`
        );
      }

      // Move nudgeReferendum scheduled call to next block
      this.logger.startSpinner('Moving nudgeReferendum to next block...');
      await this.moveScheduledCallToNextBlock(referendum.id, 'nudge');
      this.logger.succeedSpinner('nudgeReferendum moved');

      // Create a block to trigger nudgeReferendum
      this.logger.startSpinner('Creating block to trigger referendum nudge...');
      await this.chopsticks.newBlock();
      this.logger.succeedSpinner('Referendum nudged');

      // Move the actual proposal execution to next block
      this.logger.startSpinner('Moving proposal execution to next block...');
      const proposalHash = referendum.proposal.hash;
      this.logger.debug(`Looking for proposal execution with hash: ${proposalHash}`);
      const scheduledBlock = await this.moveScheduledCallToNextBlock(
        referendum.id,
        'execute',
        proposalHash
      );
      this.logger.succeedSpinner(`Proposal execution scheduled at block ${scheduledBlock}`);

      // Create a block to execute the proposal
      this.logger.startSpinner('Creating block to execute proposal...');
      await this.chopsticks.newBlock();

      const executionBlock = Number(await this.api.query.System.Number.getValue());
      this.logger.succeedSpinner(`Proposal executed at block ${executionBlock}`);

      // Get events from the execution block
      const events = await this.getBlockEvents(executionBlock);

      // Check for execution results
      const { executionSucceeded, errors } = this.checkExecutionResults(
        events,
        referendum.id,
        scheduledBlock
      );

      return {
        success: true,
        executionSucceeded,
        events,
        errors,
        blockExecuted: executionBlock,
      };
    } catch (error) {
      this.logger.failSpinner('Failed to force referendum execution');
      throw error;
    }
  }

  /**
   * Get the appropriate block numbers for scheduling based on chain type.
   * Returns relay chain blocks for main governance on parachains, otherwise parachain blocks.
   */
  private async getSchedulingBlocks(): Promise<{ currentBlock: number; targetBlock: number }> {
    const parachainBlock = Number(await this.api.query.System.Number.getValue());
    let currentBlock = parachainBlock;
    let targetBlock = parachainBlock + 1;

    // Only main governance on parachains uses relay chain block numbers
    if (!this.isFellowship) {
      const lastRelayBlockQuery = (this.api.query as any)?.ParachainSystem
        ?.LastRelayChainBlockNumber;
      if (typeof lastRelayBlockQuery?.getValue === 'function') {
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
  private async moveScheduledCallToNextBlock(
    referendumId: number,
    callType: 'nudge' | 'execute',
    proposalHash?: string
  ): Promise<number> {
    const { targetBlock } = await this.getSchedulingBlocks();

    this.logger.debug(`Searching for ${callType} call (referendum ${referendumId}) in scheduler`);

    const agendaEntries = await (this.api.query.Scheduler as any).Agenda.getEntries();

    this.logger.debug(`Found ${agendaEntries.length} total agenda entries`);

    let found = false;

    for (const entry of agendaEntries) {
      const { keyArgs, value: agendaItems } = entry;

      if (!agendaItems || agendaItems.length === 0) {
        continue;
      }

      for (const scheduledEntry of agendaItems) {
        if (!scheduledEntry) continue;

        const call = scheduledEntry.call;
        if (!call) continue;

        let isMatch = false;

        if (callType === 'nudge') {
          isMatch = await this.isNudgeReferendumCall(call, referendumId);
        } else {
          isMatch = this.isProposalExecutionCall(call, proposalHash);
        }

        if (isMatch) {
          found = true;
          this.logger.debug(
            `Found ${callType} call at block ${keyArgs[0]}, moving to block ${targetBlock}`
          );

          const callInfo = this.getCallInfo(call);
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
              const lookup = await (this.api.query.Scheduler as any).Lookup.getValue(lookupId);

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
      }
    }

    if (!found) {
      throw new Error(`Scheduled ${callType} call not found for referendum ${referendumId}`);
    }

    return targetBlock;
  }

  private getCallInfo(call: any): { type: string; hex?: string; hash?: string } {
    if (!call) {
      return { type: 'unknown' };
    }

    if (call.type === 'Inline' && call.value) {
      let hexValue = '';
      const inlineValue = call.value;

      if (typeof inlineValue === 'string') {
        hexValue = inlineValue.startsWith('0x') ? inlineValue : '0x' + inlineValue;
      } else if (typeof inlineValue.asHex === 'function') {
        hexValue = inlineValue.asHex();
      } else if (typeof inlineValue.toHex === 'function') {
        hexValue = inlineValue.toHex();
      } else if (Buffer.isBuffer(inlineValue)) {
        hexValue = '0x' + inlineValue.toString('hex');
      }

      return {
        type: 'Inline',
        hex: hexValue || undefined,
      };
    }

    if (call.type === 'Lookup' || (call.lookup && call.value)) {
      const lookupData = call.type === 'Lookup' ? call.value : call.lookup;
      let hashValue = '';

      if (lookupData?.hash) {
        if (typeof lookupData.hash === 'string') {
          hashValue = lookupData.hash;
        } else if (typeof lookupData.hash.asHex === 'function') {
          hashValue = lookupData.hash.asHex();
        } else if (typeof lookupData.hash.toHex === 'function') {
          hashValue = lookupData.hash.toHex();
        }
      }

      return {
        type: 'Lookup',
        hash: hashValue || undefined,
      };
    }

    return { type: 'unknown' };
  }

  private isProposalExecutionCall(call: any, proposalHash?: string): boolean {
    try {
      if (!call) {
        return false;
      }

      if (call.type === 'Lookup' || call.lookup) {
        const lookupData = call.type === 'Lookup' ? call.value : call.lookup;
        if (proposalHash && lookupData) {
          let callHash = lookupData.hash;
          if (callHash?.asHex && typeof callHash.asHex === 'function') {
            callHash = callHash.asHex();
          } else if (callHash?.toHex && typeof callHash.toHex === 'function') {
            callHash = callHash.toHex();
          }

          const matches = callHash === proposalHash;
          if (matches) {
            this.logger.debug(`\u2713 Found Lookup call matching proposal hash: ${proposalHash}`);
          }
          return matches;
        }
        return !proposalHash;
      }

      if (call.type === 'Inline' || call.inline) {
        const inlineValue = call.type === 'Inline' ? call.value : call.inline;

        if (!proposalHash) {
          this.logger.debug('Found Inline call (no hash to verify against)');
          return true;
        }

        let callDataHex = '';
        if (typeof inlineValue === 'string') {
          callDataHex = inlineValue.startsWith('0x') ? inlineValue : '0x' + inlineValue;
        } else if (typeof inlineValue?.asHex === 'function') {
          callDataHex = inlineValue.asHex();
        } else if (typeof inlineValue?.toHex === 'function') {
          callDataHex = inlineValue.toHex();
        } else if (Buffer.isBuffer(inlineValue)) {
          callDataHex = '0x' + inlineValue.toString('hex');
        } else if (inlineValue && typeof inlineValue === 'object') {
          callDataHex = stringify(inlineValue);
        }

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
      }

      return false;
    } catch (error) {
      this.logger.debug(`Error checking proposal execution call: ${error}`);
      return false;
    }
  }

  private async isNudgeReferendumCall(callData: any, referendumId: number): Promise<boolean> {
    try {
      const palletName = this.getReferendaPalletName();

      if (callData?.type === 'Inline' && callData?.value) {
        const inlineBytes = callData.value;

        try {
          const decoded = await this.api.txFromCallData(inlineBytes);

          if (decoded?.decodedCall?.type === palletName) {
            const callValue = decoded.decodedCall.value;
            if (callValue?.type === 'nudge_referendum' || callValue?.type === 'nudgeReferendum') {
              const args = callValue.value;
              if (args?.index !== undefined) {
                const refId = Number(args.index);
                if (refId === referendumId) {
                  this.logger.debug(
                    `Found matching nudge_referendum for ref ${referendumId} in ${palletName}`
                  );
                  return true;
                }
              }
            }
          }
        } catch (decodeError) {
          this.logger.debug(`Failed to decode inline call: ${decodeError}`);
        }

        if (inlineBytes?.type === palletName || inlineBytes?.pallet === palletName) {
          const callValue = inlineBytes.value || inlineBytes;
          if (
            callValue?.type === 'nudge_referendum' ||
            callValue?.method === 'nudge_referendum' ||
            callValue?.type === 'nudgeReferendum' ||
            callValue?.method === 'nudgeReferendum'
          ) {
            const args = callValue.value || callValue.args;
            if (args) {
              const refId = args.ref_index || args.refIndex || args[0];
              if (refId === referendumId || Number(refId) === referendumId) {
                return true;
              }
            }
            return true;
          }
        }

        if (
          inlineBytes?.method === 'nudge_referendum' ||
          inlineBytes?.method === 'nudgeReferendum'
        ) {
          return true;
        }
      }

      if (callData?.method === 'nudgeReferendum' || callData?.method === 'nudge_referendum') {
        return true;
      }

      if (
        callData?.value?.type === 'nudgeReferendum' ||
        callData?.value?.type === 'nudge_referendum'
      ) {
        return true;
      }

      if (callData?.type === palletName || callData?.pallet === palletName) {
        const callValue = callData.value || callData;
        if (callValue?.type === 'nudge_referendum' || callValue?.type === 'nudgeReferendum') {
          return true;
        }
      }

      return false;
    } catch (error) {
      this.logger.debug(`Error checking nudge call: ${error}`);
      return false;
    }
  }

  private checkExecutionResults(
    events: ParsedEvent[],
    referendumId: number,
    expectedBlock?: number
  ): { executionSucceeded: boolean; errors?: string[] } {
    const extrinsicFailures = events.filter(
      (e) => e.section === 'System' && e.method === 'ExtrinsicFailed'
    );
    const extrinsicFailureMessages = extrinsicFailures.map(
      (e) => `ExtrinsicFailed: ${formatDispatchError(e.data)}`
    );

    this.logger.info(`Events in block:`);
    events.forEach((e) => {
      this.logger.info(`  \u2022 ${e.section}.${e.method}`);

      if (this.logger.isVerbose() && e.data) {
        const serialized = serializeEventData(e.data);
        this.logger.debug(`    Data: ${stringify(serialized, 2)}`);
      }
    });

    // Check if proposal scheduled future tasks (common with Treasury proposals)
    const scheduledEvents = events.filter(
      (e) => e.section === 'Scheduler' && e.method === 'Scheduled'
    );
    if (scheduledEvents.length > 0) {
      scheduledEvents.forEach((e) => {
        const whenBlock = e.data?.value?.when || e.data?.when;
        if (whenBlock) {
          this.logger.info(
            `Note: Proposal scheduled a future task at block ${whenBlock} (this is from the proposal content, not the referendum enactment)`
          );
        }
      });
    }

    const schedulerEvents = events.filter((e) => e.section === 'Scheduler');
    const dispatchedEvents = schedulerEvents.filter((e) => e.method === 'Dispatched');

    this.logger.debug(`Found ${dispatchedEvents.length} Scheduler.Dispatched events`);

    if (dispatchedEvents.length > 0) {
      const successfulDispatches: any[] = [];
      const failedDispatches: Array<{ event: any; message?: string }> = [];
      const unmatchedDispatches: any[] = [];

      dispatchedEvents.forEach((e) => {
        const eventValue = e.data?.value || e.data;
        const task = eventValue?.task;
        const result = eventValue?.result;

        if (task && Array.isArray(task)) {
          const taskBlock = Number(task[0]);
          const taskIndex = Number(task[1]);
          const resultStatus = interpretDispatchResult(result).outcome;
          this.logger.info(
            `Scheduler.Dispatched: task [${taskBlock}, ${taskIndex}], result: ${resultStatus}`
          );
        }

        if (expectedBlock !== undefined && task && Array.isArray(task)) {
          const taskBlock = Number(task[0]);
          const taskIndex = Number(task[1]);

          if (taskBlock !== expectedBlock) {
            this.logger.debug(
              `Skipping Scheduler.Dispatched for task [${taskBlock}, ${taskIndex}] - doesn't match expected block ${expectedBlock}`
            );
            unmatchedDispatches.push(e);
            return;
          }

          this.logger.info(
            `\u2713 Verified Scheduler.Dispatched for task [${taskBlock}, ${taskIndex}] matches expected proposal execution block`
          );
        }

        const parsedResult = interpretDispatchResult(result);

        if (parsedResult.outcome === 'success') {
          successfulDispatches.push(e);
        } else if (parsedResult.outcome === 'failure') {
          failedDispatches.push({ event: e, message: parsedResult.message });
        }
      });

      if (
        successfulDispatches.length > 0 &&
        failedDispatches.length === 0 &&
        extrinsicFailures.length === 0
      ) {
        return { executionSucceeded: true };
      }

      if (failedDispatches.length > 0 || extrinsicFailures.length > 0) {
        const errors: string[] = [];
        failedDispatches.forEach((dispatch) => {
          errors.push(dispatch.message || 'Scheduler dispatch failed');
        });
        errors.push(...extrinsicFailureMessages);
        return { executionSucceeded: false, errors };
      }
    }

    if (extrinsicFailures.length > 0) {
      return {
        executionSucceeded: false,
        errors: extrinsicFailureMessages,
      };
    }

    const errorMsg =
      expectedBlock !== undefined
        ? `No Scheduler.Dispatched event found for block ${expectedBlock} - proposal execution did not happen`
        : 'No Scheduler.Dispatched event found - referendum was not executed';

    return {
      executionSucceeded: false,
      errors: [errorMsg],
    };
  }

  /**
   * Execute a pre-execution call via Scheduler before the main referendum
   */
  private async executePreCall(callHex: string, originString?: string): Promise<void> {
    this.logger.section('Executing Pre-Call');

    const preCallHex = callHex.startsWith('0x') ? callHex : `0x${callHex}`;
    this.logger.debug(`Pre-call hex: ${preCallHex.substring(0, 66)}...`);

    const preOrigin = originString ? this.parseOriginString(originString) : { System: 'Root' };
    this.logger.info(`Pre-call origin: ${stringify(preOrigin)}`);

    const currentBlock = await this.api.query.System.Number.getValue();
    let nextBlock = Number(currentBlock) + 1;

    const lastRelayBlockQuery = (this.api.query as any)?.ParachainSystem?.LastRelayChainBlockNumber;
    if (!this.isFellowship && typeof lastRelayBlockQuery?.getValue === 'function') {
      try {
        const relayBlock = await lastRelayBlockQuery.getValue();
        if (relayBlock !== undefined && relayBlock !== null) {
          const relayBlockNumber = Number(relayBlock);
          if (!Number.isNaN(relayBlockNumber)) {
            nextBlock = relayBlockNumber;
            this.logger.debug(
              `Main governance on parachain: scheduling pre-call at relay block ${nextBlock}`
            );
          }
        }
      } catch (error) {
        this.logger.debug(`Failed to read LastRelayChainBlockNumber: ${error}`);
      }
    }

    this.logger.startSpinner(`Injecting pre-call into Scheduler at block ${nextBlock}...`);

    const storageUpdate = {
      Scheduler: {
        agenda: [
          [
            [nextBlock],
            [
              {
                call: { Inline: preCallHex },
                origin: preOrigin,
              },
            ],
          ],
        ],
      },
    };

    await this.chopsticks.setStorageBatch(storageUpdate);
    this.logger.succeedSpinner(`Pre-call injected into Scheduler at block ${nextBlock}`);

    this.logger.startSpinner('Creating block to execute pre-call...');
    await this.chopsticks.newBlock();
    const executionBlock = Number(await this.api.query.System.Number.getValue());
    this.logger.succeedSpinner(`Pre-call executed at block ${executionBlock}`);

    const events = await this.getBlockEvents(executionBlock);
    const schedulerDispatched = events.filter(
      (e) => e.section === 'Scheduler' && e.method === 'Dispatched'
    );

    if (schedulerDispatched.length > 0) {
      const lastDispatch = schedulerDispatched[schedulerDispatched.length - 1];
      const dispatchResult = lastDispatch.data?.value?.result;

      if (dispatchResult?.type === 'Ok') {
        this.logger.success('Pre-call executed successfully');
      } else if (dispatchResult?.type === 'Err') {
        this.logger.warn(`Pre-call dispatch error: ${formatDispatchError(dispatchResult.value)}`);
      } else {
        this.logger.warn('Pre-call dispatch result unclear');
      }
    } else {
      this.logger.warn('No Scheduler.Dispatched event found for pre-call');
    }
  }

  /**
   * Parse origin string into Chopsticks format
   */
  private parseOriginString(originString: string): any {
    if (originString === 'Root') {
      return { System: 'Root' };
    }

    if (originString.includes('.')) {
      const [palletOrType, variant] = originString.split('.');
      return { [palletOrType]: variant };
    }

    const commonOrigins = [
      'WhitelistedCaller',
      'StakingAdmin',
      'Treasurer',
      'LeaseAdmin',
      'FellowshipAdmin',
      'GeneralAdmin',
      'AuctionAdmin',
      'ReferendumCanceller',
      'ReferendumKiller',
      'SmallTipper',
      'BigTipper',
      'SmallSpender',
      'MediumSpender',
      'BigSpender',
    ];

    if (commonOrigins.includes(originString)) {
      return { Origins: originString };
    }

    this.logger.warn(`Unknown origin format "${originString}", treating as System origin`);
    return { System: originString };
  }

  private async getBlockEvents(blockNumber: number): Promise<ParsedEvent[]> {
    try {
      const blockHash = await this.api.query.System.BlockHash.getValue(blockNumber);

      if (!blockHash) {
        this.logger.warn(`No block hash found for block ${blockNumber}`);
        return [];
      }

      const events = await this.api.query.System.Events.getValue();

      this.logger.debug(`Raw events count: ${events?.length || 0}`);

      if (!events || events.length === 0) {
        return [];
      }

      return events.map((e: any) => parseBlockEvent(e));
    } catch (error) {
      this.logger.warn(`Failed to get events for block ${blockNumber}: ${error}`);
      return [];
    }
  }
}
