import { ReferendumInfo, SimulationResult } from '../types';
import { Logger } from '../utils/logger';
import { ChopsticksManager } from './chopsticks-manager';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { Keyring } from '@polkadot/keyring';
import { getPolkadotSigner } from 'polkadot-api/signer';

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
    await cryptoWaitReady();

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
          // Continue with execution attempt
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

      // Convert origin to Chopsticks format (lowercase enum)
      const originForStorage = this.convertOriginToStorageFormat(ongoingData.origin);

      // Convert proposal to storage format
      const proposalForStorage = this.convertProposalToStorageFormat(ongoingData.proposal);

      // For deciding fields, use the same block numbering system as scheduling
      // If on parachain, use relay blocks; otherwise use parachain blocks
      const decidingSince = currentBlock - 1;
      const decidingConfirming = currentBlock - 1;

      this.logger.debug('Setting referendum enactment to execute immediately (after: 0 blocks)');

      // Convert enactment to Chopsticks storage format (lowercase enum)
      const enactmentForStorage = { after: 0 };

      // Build tally based on referendum type
      // Fellowship referenda use: { bareAyes, ayes, nays }
      // Regular referenda use: { ayes, nays, support }
      let tally: any;
      if (this.isFellowship) {
        // Fellowship voting uses rank-weighted votes
        // bareAyes: raw number of voters
        // ayes: sum of rank-weighted yes votes
        // nays: sum of rank-weighted no votes
        tally = {
          bare_ayes: 100, // Arbitrary high number of voters
          ayes: 1000, // High rank-weighted support
          nays: 0,
        };
      } else {
        // Regular governance uses token-weighted conviction voting
        tally = {
          ayes: (totalIssuance - 1n).toString(),
          nays: '0',
          support: (totalIssuance - 1n).toString(),
        };
      }

      // Convert to JSON format expected by Chopsticks (lowercase enum variant)
      const modifiedRefInfo = {
        ongoing: {
          track: ongoingData.track,
          origin: originForStorage,
          proposal: proposalForStorage,
          enactment: enactmentForStorage, // Execute immediately after confirmation
          submitted: ongoingData.submitted,
          submission_deposit: ongoingData.submission_deposit,
          decision_deposit: ongoingData.decision_deposit,
          deciding: {
            since: decidingSince,
            confirming: decidingConfirming,
          },
          tally,
          in_queue: ongoingData.in_queue || false,
          alarm: [currentBlock + 1, [currentBlock + 1, 0]], // Set alarm to trigger at next block
        },
      };

      // Update referendum storage using the correct pallet
      const palletNameForStorage = this.getReferendaPalletName();
      const referendumStorageUpdate = {
        [palletNameForStorage]: {
          ReferendumInfoFor: [[[referendum.id], modifiedRefInfo]],
        },
      };

      this.logger.debug(
        `Sending storage update to ${palletNameForStorage} pallet in Chopsticks: ${JSON.stringify(modifiedRefInfo, null, 2)}`
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
        const tally = ongoing.tally;
        const deciding = ongoing.deciding;

        this.logger.succeedSpinner('Referendum modification verified');
        this.logger.info(`✓ Enactment: ${JSON.stringify(enactment)}`);
        this.logger.info(
          `✓ Tally: ${JSON.stringify(tally, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`
        );
        this.logger.info(`✓ Deciding: ${deciding ? JSON.stringify(deciding) : 'null'}`);
      } else {
        this.logger.failSpinner(
          `Failed to verify - referendum is ${verifyRefInfo?.type || 'unknown'} state`
        );
      }

      // Move nudgeReferendum scheduled call to next block BEFORE creating a block
      // Otherwise the block will process the referendum and remove the scheduled calls
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

      // Check for execution results - pass scheduledBlock to verify task identity
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
   * Get the appropriate block numbers for scheduling based on chain type
   * Returns relay chain blocks for main governance on parachains, otherwise parachain blocks
   */
  private async getSchedulingBlocks(): Promise<{ currentBlock: number; targetBlock: number }> {
    const parachainBlock = Number(await this.api.query.System.Number.getValue());
    let currentBlock = parachainBlock;
    let targetBlock = parachainBlock + 1;

    // Only main governance on parachains uses relay chain block numbers
    // Fellowship governance uses parachain's own block numbers
    if (!this.isFellowship) {
      const lastRelayBlockQuery = (this.api.query as any)?.ParachainSystem
        ?.LastRelayChainBlockNumber;
      if (typeof lastRelayBlockQuery?.getValue === 'function') {
        try {
          const relayBlock = await lastRelayBlockQuery.getValue();
          if (relayBlock !== undefined && relayBlock !== null) {
            const relayBlockNumber = Number(relayBlock);
            if (!Number.isNaN(relayBlockNumber)) {
              // For main governance on parachains, use relay chain block numbers
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
   * Move scheduled call to next block
   * Similar to moveScheduledCallTo from the polkadot-js snippet
   * Returns the block number where the call was scheduled
   */
  private async moveScheduledCallToNextBlock(
    referendumId: number,
    callType: 'nudge' | 'execute',
    proposalHash?: string
  ): Promise<number> {
    const { targetBlock } = await this.getSchedulingBlocks();

    this.logger.debug(`Searching for ${callType} call (referendum ${referendumId}) in scheduler`);

    // Get ALL scheduler agenda entries at once (like the example)
    const agendaEntries = await (this.api.query.Scheduler as any).Agenda.getEntries();

    this.logger.debug(`Found ${agendaEntries.length} total agenda entries`);

    let found = false;

    // Iterate through all agenda entries
    for (const entry of agendaEntries) {
      const { keyArgs, value: agendaItems } = entry;

      if (!agendaItems || agendaItems.length === 0) {
        continue;
      }

      // Check each scheduled item in this agenda
      for (const scheduledEntry of agendaItems) {
        if (!scheduledEntry) continue;

        const call = scheduledEntry.call;
        if (!call) continue;

        // Check if this is the call we're looking for
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

          // Log call details for verification
          const callInfo = this.getCallInfo(call);
          this.logger.info(`📋 Scheduling ${callType} call:`);
          this.logger.info(`   From block: ${keyArgs[0]}`);
          this.logger.info(`   To block: ${targetBlock}`);
          this.logger.info(`   Call type: ${callInfo.type}`);
          if (callInfo.hex) {
            this.logger.info(
              `   Call hex: ${callInfo.hex.substring(0, 100)}${callInfo.hex.length > 100 ? '...' : ''}`
            );
          }

          // Convert agenda items to Chopsticks storage format
          const convertedAgenda = this.convertAgendaToStorageFormat(agendaItems);

          // Move this entire agenda to the target block
          await this.chopsticks.setStorageBatch({
            Scheduler: {
              Agenda: [
                [[keyArgs[0]], null], // Clear old location
                [[targetBlock], convertedAgenda], // Set at new location
              ],
            },
          });

          // Handle lookup if present
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

    // Should never reach here, but TypeScript needs a return
    return targetBlock;
  }

  /**
   * Get call information including hex representation
   */
  private getCallInfo(call: any): { type: string; hex?: string; hash?: string } {
    if (!call) {
      return { type: 'unknown' };
    }

    if (call.type === 'Inline' && call.value) {
      let hexValue = '';
      const inlineValue = call.value;

      // Try to get hex representation
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

  /**
   * Check if a scheduler item is a proposal execution call
   */
  private isProposalExecutionCall(call: any, proposalHash?: string): boolean {
    try {
      if (!call) {
        return false;
      }

      // Check for Lookup call with matching hash
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
            this.logger.debug(`✓ Found Lookup call matching proposal hash: ${proposalHash}`);
          }
          return matches;
        }
        return !proposalHash; // If no hash provided, match any Lookup
      }

      // Check for Inline call
      // For Inline proposals, proposalHash is actually the call data (hex string)
      if (call.type === 'Inline' || call.inline) {
        const inlineValue = call.type === 'Inline' ? call.value : call.inline;

        if (!proposalHash) {
          this.logger.debug('Found Inline call (no hash to verify against)');
          return true;
        }

        // Try to extract hex representation of the inline call
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
          // If it's an object, might be decoded call - convert to string for comparison
          callDataHex = JSON.stringify(inlineValue);
        }

        // Compare with proposal hash (which is the call data for Inline proposals)
        const matches =
          callDataHex === proposalHash || callDataHex.toLowerCase() === proposalHash.toLowerCase();

        if (matches) {
          this.logger.debug(
            `✓ Found Inline call matching proposal call data: ${proposalHash.substring(0, 66)}...`
          );
        } else {
          this.logger.debug(
            `Inline call data ${callDataHex.substring(0, 66)}... doesn't match proposal ${proposalHash.substring(0, 66)}...`
          );
        }

        return matches;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check if a call data is a nudgeReferendum call for the given referendum ID
   */
  private async isNudgeReferendumCall(callData: any, referendumId: number): Promise<boolean> {
    try {
      const palletName = this.getReferendaPalletName();

      // Check various possible structures for the call
      if (callData?.type === 'Inline' && callData?.value) {
        const inlineBytes = callData.value;

        // Try to decode using txFromCallData
        try {
          const decoded = await this.api.txFromCallData(inlineBytes);

          // Check if it's a [Fellowship]Referenda.nudge_referendum call
          if (decoded?.decodedCall?.type === palletName) {
            const callValue = decoded.decodedCall.value;
            if (callValue?.type === 'nudge_referendum' || callValue?.type === 'nudgeReferendum') {
              // Check the referendum ID argument
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
          // If decode fails, continue to other checks
          this.logger.debug(`Failed to decode inline call: ${decodeError}`);
        }

        // Check if the inline call is already decoded and has pallet/method info
        if (inlineBytes?.type === palletName || inlineBytes?.pallet === palletName) {
          const callValue = inlineBytes.value || inlineBytes;
          if (
            callValue?.type === 'nudge_referendum' ||
            callValue?.method === 'nudge_referendum' ||
            callValue?.type === 'nudgeReferendum' ||
            callValue?.method === 'nudgeReferendum'
          ) {
            // Check the referendum ID argument
            const args = callValue.value || callValue.args;
            if (args) {
              const refId = args.ref_index || args.refIndex || args[0];
              if (refId === referendumId || Number(refId) === referendumId) {
                return true;
              }
            }
            // If we can't extract the ID, assume it's a match (we'll verify later)
            return true;
          }
        }

        // Also check direct method name on value
        if (
          inlineBytes?.method === 'nudge_referendum' ||
          inlineBytes?.method === 'nudgeReferendum'
        ) {
          return true;
        }
      }

      // Check if it's a direct call object
      if (callData?.method === 'nudgeReferendum' || callData?.method === 'nudge_referendum') {
        return true;
      }

      // Check polkadot-api format
      if (
        callData?.value?.type === 'nudgeReferendum' ||
        callData?.value?.type === 'nudge_referendum'
      ) {
        return true;
      }

      // Check pallet.method format
      if (callData?.type === palletName || callData?.pallet === palletName) {
        const callValue = callData.value || callData;
        if (callValue?.type === 'nudge_referendum' || callValue?.type === 'nudgeReferendum') {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check execution results from events
   */
  private checkExecutionResults(
    events: any[],
    referendumId: number,
    expectedBlock?: number
  ): { executionSucceeded: boolean; errors?: string[] } {
    const extrinsicFailures = events.filter(
      (e) => e.section === 'System' && e.method === 'ExtrinsicFailed'
    );
    const extrinsicFailureMessages = extrinsicFailures.map(
      (e) => `ExtrinsicFailed: ${this.formatDispatchError(e.data)}`
    );

    // Log all events individually
    this.logger.info(`Events in block:`);
    events.forEach((e) => {
      this.logger.info(`  • ${e.section}.${e.method}`);

      // Show event data in verbose mode
      if (this.logger.isVerbose() && e.data) {
        const serialized = this.serializeEventData(e.data);
        this.logger.debug(`    Data: ${JSON.stringify(serialized, null, 2)}`);
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

    // Check for Scheduler.Dispatched events
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

        // Log all dispatched tasks for visibility
        if (task && Array.isArray(task)) {
          const taskBlock = Number(task[0]);
          const taskIndex = Number(task[1]);
          const resultStatus = this.interpretDispatchResult(result).outcome;
          this.logger.info(
            `Scheduler.Dispatched: task [${taskBlock}, ${taskIndex}], result: ${resultStatus}`
          );
        }

        // Verify the task matches the expected block if provided
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
            `✓ Verified Scheduler.Dispatched for task [${taskBlock}, ${taskIndex}] matches expected proposal execution block`
          );
        }

        const parsedResult = this.interpretDispatchResult(result);

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

    // No Scheduler.Dispatched event means the referendum was not executed
    const errorMsg =
      expectedBlock !== undefined
        ? `No Scheduler.Dispatched event found for block ${expectedBlock} - proposal execution did not happen`
        : 'No Scheduler.Dispatched event found - referendum was not executed';

    return {
      executionSucceeded: false,
      errors: [errorMsg],
    };
  }

  private interpretDispatchResult(result: any): {
    outcome: 'success' | 'failure' | 'unknown';
    message?: string;
  } {
    if (result === null || result === undefined) {
      return { outcome: 'unknown' };
    }

    if (typeof result === 'boolean') {
      return { outcome: result ? 'success' : 'failure' };
    }

    if (typeof result === 'string') {
      const lowered = result.toLowerCase();
      if (lowered === 'ok' || lowered === 'success') {
        return { outcome: 'success' };
      }
      if (['err', 'error', 'fail', 'failure'].includes(lowered)) {
        return { outcome: 'failure', message: 'Scheduler dispatch returned error' };
      }
    }

    if (typeof result === 'object') {
      if ('success' in result && typeof result.success === 'boolean') {
        return {
          outcome: result.success ? 'success' : 'failure',
          message: result.success
            ? undefined
            : this.formatDispatchError(result.value ?? result.error ?? result.err),
        };
      }

      if ('isOk' in result && typeof (result as any).isOk === 'boolean') {
        const isOk = (result as any).isOk;
        if (isOk) {
          return { outcome: 'success' };
        }
        const errVal =
          typeof (result as any).asErr === 'function'
            ? (result as any).asErr()
            : (result as any).asErr;
        return { outcome: 'failure', message: this.formatDispatchError(errVal) };
      }

      if ('ok' in result && typeof (result as any).ok === 'boolean') {
        return {
          outcome: (result as any).ok ? 'success' : 'failure',
          message: (result as any).ok ? undefined : this.formatDispatchError((result as any).err),
        };
      }

      if ('Ok' in result && result.Ok !== undefined) {
        return { outcome: 'success' };
      }

      if ('Err' in result) {
        return { outcome: 'failure', message: this.formatDispatchError(result.Err) };
      }

      const type = (result.type || result.__kind || result.kind || '').toString();
      if (type) {
        const loweredType = type.toLowerCase();
        if (loweredType === 'ok' || loweredType === 'success') {
          return { outcome: 'success' };
        }
        if (['err', 'error', 'fail', 'failure'].includes(loweredType)) {
          return {
            outcome: 'failure',
            message: this.formatDispatchError(result.value ?? result.error ?? result.err),
          };
        }
      }
    }

    return { outcome: 'unknown' };
  }

  private formatDispatchError(error: any): string {
    if (error === null || error === undefined) {
      return 'Unknown dispatch error';
    }

    if (typeof error === 'string') {
      return error;
    }

    if (typeof error === 'boolean') {
      return error ? 'true' : 'false';
    }

    if (typeof error === 'object') {
      if (Array.isArray(error)) {
        return error.map((entry) => this.formatDispatchError(entry)).join(', ');
      }

      if ('type' in error && typeof (error as any).type === 'string') {
        const payload =
          (error as any).value ?? (error as any).error ?? (error as any).err ?? (error as any).data;
        if (payload !== undefined) {
          return `${(error as any).type}: ${JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`;
        }
        return (error as any).type;
      }

      if ('Module' in error) {
        return `Module error: ${JSON.stringify(error.Module, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`;
      }

      if ('module' in error) {
        return `Module error: ${JSON.stringify(error.module, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`;
      }

      if ('token' in error) {
        return `Token error: ${JSON.stringify(error.token)}`;
      }

      if ('value' in error) {
        return JSON.stringify(error.value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
      }

      return JSON.stringify(error, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    }

    return String(error);
  }

  /**
   * Test voting on a referendum by pre-funding Alice account and casting a vote
   */
  private async testVoting(referendum: ReferendumInfo): Promise<void> {
    this.logger.section('Testing Referendum Voting');

    // Create Alice account from keyring
    const keyring = new Keyring({ type: 'sr25519' });
    const alice = keyring.addFromUri('//Alice');
    const aliceAddress = alice.address;

    this.logger.info(`Alice address: ${aliceAddress}`);

    // Step 1: Pre-fund Alice account
    await this.preFundAccount(aliceAddress);

    // Step 2: Get referendum state before vote
    const beforeVote = await this.getReferendumState(referendum.id);
    this.logger.info('Referendum state before vote:');
    if (beforeVote) {
      this.logger.info(`  Ayes: ${beforeVote.ayes?.toString() || 'N/A'}`);
      this.logger.info(`  Nays: ${beforeVote.nays?.toString() || 'N/A'}`);
      this.logger.info(`  Support: ${beforeVote.support?.toString() || 'N/A'}`);
    }

    // Step 3: Cast a vote
    await this.castVote(referendum.id, alice, true, 1000000000000n); // Vote aye with 1 DOT (10 decimals)

    // Step 4: Verify vote was counted
    const afterVote = await this.getReferendumState(referendum.id);
    this.logger.info('Referendum state after vote:');
    if (afterVote) {
      this.logger.info(`  Ayes: ${afterVote.ayes?.toString() || 'N/A'}`);
      this.logger.info(`  Nays: ${afterVote.nays?.toString() || 'N/A'}`);
      this.logger.info(`  Support: ${afterVote.support?.toString() || 'N/A'}`);

      // Check if vote was counted
      if (beforeVote && afterVote.ayes !== undefined && beforeVote.ayes !== undefined) {
        const ayesDiff = afterVote.ayes - beforeVote.ayes;
        if (ayesDiff > 0n) {
          this.logger.success(
            `Vote successfully counted! Ayes increased by ${ayesDiff.toString()}`
          );
        } else {
          this.logger.warn('Vote may not have been counted - ayes did not increase');
        }
      }
    }
  }

  /**
   * Pre-fund an account with balance via setStorage
   */
  private async preFundAccount(address: string): Promise<void> {
    this.logger.startSpinner('Pre-funding Alice account...');

    // Fund with 1000 DOT (assuming 10 decimals)
    const amount = 1000n * 10n ** 10n;

    // Set the account balance via storage
    // Balances.Account storage format: {data: {free: amount, reserved: 0, ...}, ...}
    const accountData = {
      data: {
        free: amount.toString(),
        reserved: '0',
        frozen: '0',
        flags: '0',
      },
      nonce: 0,
      consumers: 0,
      providers: 1,
      sufficients: 0,
    };

    // Use setStorageBatch with proper key format for Map storage
    const storageUpdate = {
      Balances: {
        Account: [
          [
            [address], // Key must be wrapped in array for Map storage
            accountData,
          ],
        ],
      },
    };

    await this.chopsticks.setStorageBatch(storageUpdate);
    this.logger.succeedSpinner(`Alice account funded with ${amount / 10n ** 10n} tokens`);

    // Verify the balance was set
    const balance = await this.api.query.Balances.Account.getValue(address);
    this.logger.debug(`Verified balance: ${JSON.stringify(balance?.data?.free || 'N/A')}`);
  }

  /**
   * Cast a vote on a referendum
   */
  private async castVote(
    referendumId: number,
    account: any,
    aye: boolean,
    balance: bigint
  ): Promise<void> {
    this.logger.startSpinner(`Casting ${aye ? 'aye' : 'nay'} vote with balance ${balance}...`);

    try {
      // Create a polkadot-api compatible signer from keyring account
      const signer = getPolkadotSigner(account.publicKey, 'Sr25519', account.sign);

      // Create the vote transaction
      // ConvictionVoting.vote(poll_index, vote)
      // Vote encoding: bit 7 = aye/nay, bits 0-6 = conviction (0 = None)
      const voteValue = aye ? 0b10000000 : 0; // 128 for aye, 0 for nay (with None conviction)

      const voteTx = this.api.tx.ConvictionVoting.vote({
        poll_index: referendumId,
        vote: {
          type: 'Standard',
          value: {
            vote: voteValue,
            balance: balance,
          },
        },
      });

      this.logger.debug(`Vote transaction created`);

      // Sign and submit the transaction
      voteTx.signAndSubmit(signer);

      this.logger.debug(`Transaction signed and submitted to pool`);

      // Create a new block to include the transaction
      await this.chopsticks.newBlock();
      await this.chopsticks.newBlock();

      this.logger.succeedSpinner('Vote transaction submitted and block created');

      // Get the current block number and check events
      const currentBlock = Number(await this.api.query.System.Number.getValue());
      const events = await this.getBlockEvents(currentBlock);

      // Look for ConvictionVoting.Voted event
      const voteEvents = events.filter(
        (e) => e.section === 'ConvictionVoting' && e.method === 'Voted'
      );
      if (voteEvents.length > 0) {
        this.logger.success('Vote event found in block');
      } else {
        this.logger.warn('No ConvictionVoting.Voted event found');
      }

      // Check for any errors
      const failedEvents = events.filter(
        (e) => e.section === 'System' && e.method === 'ExtrinsicFailed'
      );
      if (failedEvents.length > 0) {
        this.logger.warn('Transaction may have failed - ExtrinsicFailed event detected');
      }
    } catch (error) {
      this.logger.failSpinner('Failed to cast vote');
      this.logger.error(`Vote error: ${error}`);
      throw error;
    }
  }

  /**
   * Get the current state of a referendum
   */
  private async getReferendumState(
    referendumId: number
  ): Promise<{ ayes?: bigint; nays?: bigint; support?: bigint } | null> {
    try {
      const refInfo = await this.api.query.Referenda.ReferendumInfoFor.getValue(referendumId);

      if (!refInfo || !refInfo.value) {
        return null;
      }

      // Handle polkadot-api format: {type: "Ongoing", value: {tally: {ayes, nays, support}}}
      if (refInfo.type === 'Ongoing' && refInfo.value?.tally) {
        const tally = refInfo.value.tally;
        return {
          ayes: typeof tally.ayes === 'bigint' ? tally.ayes : BigInt(tally.ayes || 0),
          nays: typeof tally.nays === 'bigint' ? tally.nays : BigInt(tally.nays || 0),
          support: typeof tally.support === 'bigint' ? tally.support : BigInt(tally.support || 0),
        };
      }

      return null;
    } catch (error) {
      this.logger.debug(`Failed to get referendum state: ${error}`);
      return null;
    }
  }

  /**
   * Execute a pre-execution call via Scheduler before the main referendum
   */
  private async executePreCall(callHex: string, originString?: string): Promise<void> {
    this.logger.section('Executing Pre-Call');

    // Validate and format hex string
    const preCallHex = callHex.startsWith('0x') ? callHex : `0x${callHex}`;
    this.logger.debug(`Pre-call hex: ${preCallHex.substring(0, 66)}...`);

    // Parse origin string
    const preOrigin = originString ? this.parseOriginString(originString) : { System: 'Root' };
    this.logger.info(`Pre-call origin: ${JSON.stringify(preOrigin)}`);

    // Get the next block number to schedule execution
    const currentBlock = await this.api.query.System.Number.getValue();
    let nextBlock = Number(currentBlock) + 1;

    // Check if we're on a parachain for main governance
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

    // Build storage update for the pre-call
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

    // Create a block to execute the pre-call
    this.logger.startSpinner('Creating block to execute pre-call...');
    await this.chopsticks.newBlock();
    const executionBlock = Number(await this.api.query.System.Number.getValue());
    this.logger.succeedSpinner(`Pre-call executed at block ${executionBlock}`);

    // Check if the pre-call succeeded by looking at events
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
        this.logger.warn(
          `Pre-call dispatch error: ${this.formatDispatchError(dispatchResult.value)}`
        );
      } else {
        this.logger.warn('Pre-call dispatch result unclear');
      }
    } else {
      this.logger.warn('No Scheduler.Dispatched event found for pre-call');
    }
  }

  /**
   * Parse origin string into Chopsticks format
   * Examples:
   *   "Root" -> { System: 'Root' }
   *   "WhitelistedCaller" -> { Origins: 'WhitelistedCaller' }
   *   "Origins.Treasurer" -> { Origins: 'Treasurer' }
   *   "FellowshipOrigins.Fellows" -> { FellowshipOrigins: 'Fellows' }
   */
  private parseOriginString(originString: string): any {
    // Handle simple cases like "Root"
    if (originString === 'Root') {
      return { System: 'Root' };
    }

    // Handle dot notation like "Origins.Treasurer" or "FellowshipOrigins.Fellows"
    if (originString.includes('.')) {
      const [palletOrType, variant] = originString.split('.');
      return { [palletOrType]: variant };
    }

    // Handle common single-word origins by mapping them to Origins pallet
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

    // Default: assume it's a System origin variant
    this.logger.warn(`Unknown origin format "${originString}", treating as System origin`);
    return { System: originString };
  }

  private getOriginForTrack(trackName: string, referendumOrigin: any): any {
    // Map common tracks to their appropriate origins
    // For most governance tracks, we use the Origins enum with the track name
    const trackOriginMap: Record<string, any> = {
      root: { System: 'Root' },
      whitelisted_caller: { Origins: 'WhitelistedCaller' },
      staking_admin: { Origins: 'StakingAdmin' },
      treasurer: { Origins: 'Treasurer' },
      lease_admin: { Origins: 'LeaseAdmin' },
      fellowship_admin: { Origins: 'FellowshipAdmin' },
      general_admin: { Origins: 'GeneralAdmin' },
      auction_admin: { Origins: 'AuctionAdmin' },
      referendum_canceller: { Origins: 'ReferendumCanceller' },
      referendum_killer: { Origins: 'ReferendumKiller' },
      small_tipper: { Origins: 'SmallTipper' },
      big_tipper: { Origins: 'BigTipper' },
      small_spender: { Origins: 'SmallSpender' },
      medium_spender: { Origins: 'MediumSpender' },
      big_spender: { Origins: 'BigSpender' },
    };

    // If we have a predefined mapping, use it
    if (trackName in trackOriginMap) {
      return trackOriginMap[trackName];
    }

    // Try to use the origin from the referendum itself if available
    if (referendumOrigin) {
      // Convert polkadot-api format to Chopsticks format
      // polkadot-api: {"type":"FellowshipOrigins","value":{"type":"Fellows"}}
      // Chopsticks: { FellowshipOrigins: 'Fellows' }
      return this.convertOriginToChopsticksFormat(referendumOrigin);
    }

    // Default to root for unknown tracks (may fail if the call requires specific origin)
    this.logger.warn(`Unknown track "${trackName}", defaulting to Root origin`);
    return { System: 'Root' };
  }

  /**
   * Convert polkadot-api origin format to Chopsticks storage format
   */
  private convertOriginToChopsticksFormat(origin: any): any {
    if (!origin || typeof origin !== 'object') {
      return origin;
    }

    // Handle polkadot-api format: {type: "EnumVariant", value: ...}
    if ('type' in origin && 'value' in origin) {
      const outerVariant = origin.type;
      const innerValue = origin.value;

      // If innerValue is also an object with type, recursively extract it
      if (innerValue && typeof innerValue === 'object' && 'type' in innerValue) {
        return {
          [outerVariant]: innerValue.type,
        };
      }

      // Otherwise use the value directly
      return {
        [outerVariant]: innerValue,
      };
    }

    // Already in correct format
    return origin;
  }

  /**
   * Convert origin to storage format (lowercase enum for Chopsticks)
   */
  private convertOriginToStorageFormat(origin: any): any {
    if (!origin || typeof origin !== 'object') {
      return origin;
    }

    // Handle polkadot-api format: {type: "EnumVariant", value: ...}
    if ('type' in origin && 'value' in origin) {
      const outerVariant = origin.type.toLowerCase();
      const innerValue = origin.value;

      // If innerValue is also an object with type (nested enum)
      if (innerValue && typeof innerValue === 'object' && 'type' in innerValue) {
        return {
          [outerVariant]: innerValue.type,
        };
      }

      // Otherwise use the value directly
      return {
        [outerVariant]: innerValue,
      };
    }

    // Already in correct format
    return origin;
  }

  /**
   * Convert proposal to storage format
   */
  private convertProposalToStorageFormat(proposal: any): any {
    if (!proposal || typeof proposal !== 'object') {
      return proposal;
    }

    // Handle polkadot-api format: {type: "Lookup", value: {hash: ..., len: ...}}
    if ('type' in proposal && 'value' in proposal) {
      const proposalType = proposal.type.toLowerCase();

      if (proposalType === 'lookup') {
        // Convert hash if it's a Binary object
        let hashValue = proposal.value.hash;
        if (hashValue && typeof hashValue === 'object' && 'asHex' in hashValue) {
          hashValue = hashValue.asHex();
        }

        return {
          lookup: {
            hash: hashValue,
            len: proposal.value.len,
          },
        };
      } else if (proposalType === 'inline') {
        // Handle inline proposals
        let inlineValue = proposal.value;
        if (inlineValue && typeof inlineValue === 'object' && 'asHex' in inlineValue) {
          inlineValue = inlineValue.asHex();
        }

        return {
          inline: inlineValue,
        };
      }

      // Generic conversion
      return {
        [proposalType]: proposal.value,
      };
    }

    // Already in correct format
    return proposal;
  }

  /**
   * Convert agenda items from PAPI format to Chopsticks storage format
   */
  private convertAgendaToStorageFormat(agendaItems: any[]): any[] {
    if (!Array.isArray(agendaItems)) {
      return agendaItems;
    }

    return agendaItems.map((item) => {
      if (!item) return item;

      const converted: any = {};

      // Convert call enum (Inline/Lookup/Legacy)
      if (item.call) {
        converted.call = this.convertCallToStorageFormat(item.call);
      }

      // Copy other fields
      if (item.maybeId !== undefined) converted.maybeId = item.maybeId;
      if (item.priority !== undefined) converted.priority = item.priority;
      if (item.maybePeriodic !== undefined) converted.maybePeriodic = item.maybePeriodic;
      if (item.origin !== undefined) {
        converted.origin = this.convertOriginToStorageFormat(item.origin);
      }

      return converted;
    });
  }

  /**
   * Convert call enum to storage format
   */
  private convertCallToStorageFormat(call: any): any {
    if (!call || typeof call !== 'object') {
      return call;
    }

    // Handle polkadot-api format: {type: "Inline", value: ...}
    if ('type' in call && 'value' in call) {
      const callType = call.type.toLowerCase();

      if (callType === 'inline') {
        // For inline, the value might be Binary - convert to hex if needed
        let inlineValue = call.value;
        if (inlineValue && typeof inlineValue === 'object') {
          if ('asHex' in inlineValue && typeof inlineValue.asHex === 'function') {
            inlineValue = inlineValue.asHex();
          } else if ('toHex' in inlineValue && typeof inlineValue.toHex === 'function') {
            inlineValue = inlineValue.toHex();
          }
        }
        return {
          inline: inlineValue,
        };
      } else if (callType === 'lookup') {
        // Convert hash if it's a Binary object
        let hashValue = call.value.hash;
        if (hashValue && typeof hashValue === 'object') {
          if ('asHex' in hashValue && typeof hashValue.asHex === 'function') {
            hashValue = hashValue.asHex();
          } else if ('toHex' in hashValue && typeof hashValue.toHex === 'function') {
            hashValue = hashValue.toHex();
          }
        }
        return {
          lookup: {
            hash: hashValue,
            len: call.value.len,
          },
        };
      } else if (callType === 'legacy') {
        return {
          legacy: call.value,
        };
      }

      // Generic conversion
      return {
        [callType]: call.value,
      };
    }

    // Already in correct format
    return call;
  }

  private async getBlockEvents(blockNumber: number): Promise<any[]> {
    try {
      // Get events from the specified block
      const blockHash = await this.api.query.System.BlockHash.getValue(blockNumber);

      if (!blockHash) {
        this.logger.warn(`No block hash found for block ${blockNumber}`);
        return [];
      }

      // Get events from current state (should be the block we just created)
      const events = await this.api.query.System.Events.getValue();

      this.logger.debug(`Raw events count: ${events?.length || 0}`);

      if (!events || events.length === 0) {
        return [];
      }

      // Parse events based on polkadot-api structure
      return events.map((e: any) => {
        // polkadot-api events have a structure like { type: "PalletName", value: { type: "EventName", value: {...} } }
        let section = 'unknown';
        let method = 'unknown';
        let data = e;

        if (e.type) {
          section = e.type;
          if (e.value && e.value.type) {
            method = e.value.type;
            data = e.value.value || e.value;
          }
        } else if (e.event) {
          // Fallback for different structure
          section = e.event.type || e.event.section || 'unknown';
          method = e.event.value?.type || e.event.method || 'unknown';
          data = e.event.value || e.event.data;
        }

        return { section, method, data };
      });
    } catch (error) {
      this.logger.warn(`Failed to get events for block ${blockNumber}: ${error}`);
      return [];
    }
  }

  /**
   * Serialize event data, converting Uint8Arrays and other binary data to hex strings
   */
  private serializeEventData(data: any): any {
    if (data === null || data === undefined) {
      return data;
    }

    // Handle Uint8Array
    if (data instanceof Uint8Array) {
      return '0x' + Buffer.from(data).toString('hex');
    }

    // Handle Buffer
    if (Buffer.isBuffer(data)) {
      return '0x' + data.toString('hex');
    }

    // Handle polkadot-api FixedSizeBinary and similar types (check for asHex property)
    if (typeof data === 'object' && 'asHex' in data) {
      try {
        // asHex might be a function or a getter
        const hex = typeof data.asHex === 'function' ? data.asHex() : data.asHex;
        if (hex !== undefined && hex !== null) {
          return hex;
        }
        // Fallback to asBytes if asHex doesn't work
        if ('asBytes' in data) {
          const bytes = typeof data.asBytes === 'function' ? data.asBytes() : data.asBytes;
          if (bytes instanceof Uint8Array) {
            return '0x' + Buffer.from(bytes).toString('hex');
          }
        }
      } catch (e) {
        // Ignore errors, fall through to other methods
      }
    }

    // Handle objects with toHex method
    if (typeof data === 'object' && typeof data.toHex === 'function') {
      return data.toHex();
    }

    // Handle objects with toU8a method (convert to Uint8Array then to hex)
    if (typeof data === 'object' && typeof data.toU8a === 'function') {
      const u8a = data.toU8a();
      return '0x' + Buffer.from(u8a).toString('hex');
    }

    // Handle objects with toString that might give us useful info
    if (typeof data === 'object' && typeof data.toString === 'function') {
      const str = data.toString();
      // If toString gives us a hex string, use it
      if (str.startsWith('0x')) {
        return str;
      }
    }

    // Handle arrays
    if (Array.isArray(data)) {
      return data.map((item) => this.serializeEventData(item));
    }

    // Handle array-like objects (objects with numeric keys)
    if (typeof data === 'object' && !Array.isArray(data)) {
      // Check if it's an array-like object (has numeric keys like 0, 1, 2...)
      const keys = Object.keys(data);
      const isArrayLike = keys.length > 0 && keys.every((k) => !isNaN(Number(k)));

      if (isArrayLike) {
        // Convert to array and serialize as bytes
        const bytes: number[] = [];
        for (let i = 0; i < keys.length; i++) {
          if (data[i] !== undefined) {
            bytes.push(data[i]);
          }
        }
        if (bytes.length > 0) {
          return '0x' + Buffer.from(bytes).toString('hex');
        }
      }
    }

    // Handle plain objects
    if (typeof data === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = this.serializeEventData(value);
      }
      return result;
    }

    // Handle bigint
    if (typeof data === 'bigint') {
      return data.toString();
    }

    return data;
  }
}
