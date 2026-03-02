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
import { toHexString } from '../utils/hex';
import { getReferendaPalletName } from './chain-registry';

/** Arbitrary high number of voters for fellowship passing tally */
const FELLOWSHIP_PASSING_BARE_AYES = 100;
/** High rank-weighted support for fellowship passing tally */
const FELLOWSHIP_PASSING_AYES = 1000;

/** Known governance origin variants for parseOriginString */
const GOVERNANCE_ORIGINS = [
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

  private getReferendaPalletName(): string {
    return getReferendaPalletName(this.isFellowship);
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
    if (preExecutionOptions?.preCall) {
      await this.executePreCall(preExecutionOptions.preCall, preExecutionOptions.preOrigin);
    }

    try {
      await this.applyPassingState(referendum);
      const { events, executionBlock, scheduledBlock } =
        await this.scheduleAndExecuteProposal(referendum);

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

  private async applyPassingState(referendum: ReferendumInfo): Promise<void> {
    this.logger.startSpinner('Forcing referendum to passing state...');

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

    const totalIssuance = await this.api.query.Balances.TotalIssuance.getValue();
    this.logger.debug(`Total issuance: ${totalIssuance}`);

    const { currentBlock } = await this.getSchedulingBlocks();

    const modifiedRefInfo = this.buildPassingReferendumStorage(
      refInfo.value,
      totalIssuance,
      currentBlock
    );

    const referendumStorageUpdate = {
      [palletName]: {
        ReferendumInfoFor: [[[referendum.id], modifiedRefInfo]],
      },
    };

    this.logger.debug(
      `Sending storage update to ${palletName} pallet in Chopsticks: ${stringify(modifiedRefInfo, 2)}`
    );
    await this.chopsticks.setStorageBatch(referendumStorageUpdate);
    this.logger.succeedSpinner('Referendum state updated to passing');

    await this.chopsticks.newBlock();
    await this.verifyReferendumModification(referendum.id, palletName);
  }

  private async scheduleAndExecuteProposal(referendum: ReferendumInfo): Promise<{
    events: ParsedEvent[];
    executionBlock: number;
    scheduledBlock: number;
  }> {
    this.logger.startSpinner('Moving nudgeReferendum to next block...');
    await this.moveScheduledCallToNextBlock(referendum.id, 'nudge');
    this.logger.succeedSpinner('nudgeReferendum moved');

    this.logger.startSpinner('Creating block to trigger referendum nudge...');
    await this.chopsticks.newBlock();
    this.logger.succeedSpinner('Referendum nudged');

    this.logger.startSpinner('Moving proposal execution to next block...');
    const proposalHash = referendum.proposal.hash;
    this.logger.debug(`Looking for proposal execution with hash: ${proposalHash}`);
    const scheduledBlock = await this.moveScheduledCallToNextBlock(
      referendum.id,
      'execute',
      proposalHash
    );
    this.logger.succeedSpinner(`Proposal execution scheduled at block ${scheduledBlock}`);

    this.logger.startSpinner('Creating block to execute proposal...');
    await this.chopsticks.newBlock();

    const executionBlock = Number(await this.api.query.System.Number.getValue());
    this.logger.succeedSpinner(`Proposal executed at block ${executionBlock}`);

    const events = await this.getBlockEvents(executionBlock);

    return { events, executionBlock, scheduledBlock };
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
   * Build the modified referendum storage that forces it into a passing state
   * with immediate enactment.
   */
  private buildPassingReferendumStorage(
    ongoingData: any,
    totalIssuance: bigint,
    currentBlock: number
  ): any {
    const originForStorage = convertOriginToStorageFormat(ongoingData.origin);
    const proposalForStorage = convertProposalToStorageFormat(ongoingData.proposal);

    const decidingSince = currentBlock - 1;
    const decidingConfirming = currentBlock - 1;

    this.logger.debug('Setting referendum enactment to execute immediately (after: 0 blocks)');

    let tally: any;
    if (this.isFellowship) {
      tally = {
        bare_ayes: FELLOWSHIP_PASSING_BARE_AYES,
        ayes: FELLOWSHIP_PASSING_AYES,
        nays: 0,
      };
    } else {
      tally = {
        ayes: (totalIssuance - 1n).toString(),
        nays: '0',
        support: (totalIssuance - 1n).toString(),
      };
    }

    return {
      ongoing: {
        track: ongoingData.track,
        origin: originForStorage,
        proposal: proposalForStorage,
        enactment: { after: 0 },
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
  }

  private async verifyReferendumModification(
    referendumId: number,
    palletName: string
  ): Promise<void> {
    this.logger.startSpinner('Verifying referendum modification...');
    const verifyRefInfo = await (this.api.query as any)[palletName].ReferendumInfoFor.getValue(
      referendumId
    );

    if (verifyRefInfo && verifyRefInfo.type === 'Ongoing') {
      const ongoing = verifyRefInfo.value;
      this.logger.succeedSpinner('Referendum modification verified');
      this.logger.info(`\u2713 Enactment: ${stringify(ongoing.enactment)}`);
      this.logger.info(`\u2713 Tally: ${stringify(ongoing.tally)}`);
      this.logger.info(
        `\u2713 Deciding: ${ongoing.deciding ? stringify(ongoing.deciding) : 'null'}`
      );
    } else {
      this.logger.failSpinner(
        `Failed to verify - referendum is ${verifyRefInfo?.type || 'unknown'} state`
      );
    }
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

  private async findMatchingScheduledCall(
    referendumId: number,
    callType: 'nudge' | 'execute',
    proposalHash?: string
  ): Promise<{ keyArgs: any; agendaItems: any[]; scheduledEntry: any } | null> {
    this.logger.debug(`Searching for ${callType} call (referendum ${referendumId}) in scheduler`);

    const agendaEntries = await (this.api.query.Scheduler as any).Agenda.getEntries();
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

  private getCallInfo(call: any): { type: string; hex?: string; hash?: string } {
    if (!call) {
      return { type: 'unknown' };
    }

    if (call.type === 'Inline' && call.value) {
      return {
        type: 'Inline',
        hex: toHexString(call.value) || undefined,
      };
    }

    if (call.type === 'Lookup' || (call.lookup && call.value)) {
      const lookupData = call.type === 'Lookup' ? call.value : call.lookup;
      return {
        type: 'Lookup',
        hash: (lookupData?.hash ? toHexString(lookupData.hash) : undefined) || undefined,
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
          const callHash = toHexString(lookupData.hash) ?? String(lookupData.hash);
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

        const callDataHex =
          toHexString(inlineValue) ??
          (inlineValue && typeof inlineValue === 'object' ? stringify(inlineValue) : '');

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
      // Covers pre-decoded objects from Chopsticks with various shapes
      return this.matchNudgeFromProperties(callData, palletName);
    } catch (error) {
      this.logger.debug(`Error checking nudge call: ${error}`);
      return false;
    }
  }

  private isNudgeMethod(name: string | undefined): boolean {
    return name === 'nudge_referendum' || name === 'nudgeReferendum';
  }

  private matchNudgeFromProperties(obj: any, palletName: string): boolean {
    if (!obj) return false;

    // Direct method property
    if (this.isNudgeMethod(obj.method) || this.isNudgeMethod(obj.value?.type)) {
      return true;
    }

    // Pallet-scoped: { type: "Referenda", value: { type: "nudge_referendum" } }
    if ((obj.type === palletName || obj.pallet === palletName) && obj.value) {
      if (this.isNudgeMethod(obj.value.type) || this.isNudgeMethod(obj.value.method)) {
        return true;
      }
    }

    // Inline wrapper: check the inner value's properties
    if (obj.type === 'Inline' && obj.value) {
      return this.matchNudgeFromProperties(obj.value, palletName);
    }

    return false;
  }

  private classifyDispatches(
    dispatchedEvents: ParsedEvent[],
    expectedBlock?: number
  ): { successful: ParsedEvent[]; failed: Array<{ event: ParsedEvent; message?: string }> } {
    const successful: ParsedEvent[] = [];
    const failed: Array<{ event: ParsedEvent; message?: string }> = [];

    for (const e of dispatchedEvents) {
      const eventValue = e.data?.value || e.data;
      const task = eventValue?.task;
      const result = eventValue?.result;
      const parsedResult = interpretDispatchResult(result);

      if (task && Array.isArray(task)) {
        const taskBlock = Number(task[0]);
        const taskIndex = Number(task[1]);
        this.logger.info(
          `Scheduler.Dispatched: task [${taskBlock}, ${taskIndex}], result: ${parsedResult.outcome}`
        );

        if (expectedBlock !== undefined && taskBlock !== expectedBlock) {
          this.logger.debug(
            `Skipping Scheduler.Dispatched for task [${taskBlock}, ${taskIndex}] - doesn't match expected block ${expectedBlock}`
          );
          continue;
        }

        if (expectedBlock !== undefined) {
          this.logger.info(
            `\u2713 Verified Scheduler.Dispatched for task [${taskBlock}, ${taskIndex}] matches expected proposal execution block`
          );
        }
      }

      if (parsedResult.outcome === 'success') {
        successful.push(e);
      } else if (parsedResult.outcome === 'failure') {
        failed.push({ event: e, message: parsedResult.message });
      }
    }

    return { successful, failed };
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
    for (const e of events) {
      this.logger.info(`  \u2022 ${e.section}.${e.method}`);
      if (this.logger.isVerbose() && e.data) {
        const serialized = serializeEventData(e.data);
        this.logger.debug(`    Data: ${stringify(serialized, 2)}`);
      }
    }

    // Check if proposal scheduled future tasks (common with Treasury proposals)
    const scheduledEvents = events.filter(
      (e) => e.section === 'Scheduler' && e.method === 'Scheduled'
    );
    for (const e of scheduledEvents) {
      const whenBlock = e.data?.value?.when || e.data?.when;
      if (whenBlock) {
        this.logger.info(
          `Note: Proposal scheduled a future task at block ${whenBlock} (this is from the proposal content, not the referendum enactment)`
        );
      }
    }

    const dispatchedEvents = events.filter(
      (e) => e.section === 'Scheduler' && e.method === 'Dispatched'
    );
    this.logger.debug(`Found ${dispatchedEvents.length} Scheduler.Dispatched events`);

    if (dispatchedEvents.length > 0) {
      const { successful, failed } = this.classifyDispatches(dispatchedEvents, expectedBlock);

      if (successful.length > 0 && failed.length === 0 && extrinsicFailures.length === 0) {
        return { executionSucceeded: true };
      }

      if (failed.length > 0 || extrinsicFailures.length > 0) {
        const errors = failed.map((d) => d.message || 'Scheduler dispatch failed');
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

    const { targetBlock: nextBlock } = await this.getSchedulingBlocks();

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

    if (GOVERNANCE_ORIGINS.includes(originString)) {
      return { Origins: originString };
    }

    this.logger.warn(`Unknown origin format "${originString}", treating as System origin`);
    return { System: originString };
  }

  private async getBlockEvents(blockNumber: number): Promise<ParsedEvent[]> {
    try {
      const events = await this.api.query.System.Events.getValue();

      this.logger.debug(`Raw events count for block ${blockNumber}: ${events?.length || 0}`);

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
