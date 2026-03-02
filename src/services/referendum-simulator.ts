import type { ReferendumInfo, SimulationResult } from '../types';
import type { ReferendaPallet, ReferendumOngoing, SubstrateApi } from '../types/substrate-api';
import { formatDispatchError } from '../utils/dispatch-result';
import { type ParsedEvent, parseBlockEvent } from '../utils/event-serializer';
import { toHexString } from '../utils/hex';
import { stringify } from '../utils/json';
import type { Logger } from '../utils/logger';
import {
  convertOriginToStorageFormat,
  convertProposalToStorageFormat,
} from '../utils/storage-format-converter';
import { getReferendaPallet, getReferendaPalletName } from './chain-registry';
import type { ChopsticksManager } from './chopsticks-manager';
import { ExecutionResultChecker } from './execution-result-checker';
import { SchedulerManager } from './scheduler-manager';

/** Arbitrary high number of voters for fellowship passing tally */
const FELLOWSHIP_PASSING_BARE_AYES = 100;
/** High rank-weighted support for fellowship passing tally */
const FELLOWSHIP_PASSING_AYES = 1000;

/** Known governance origin variants */
const GOVERNANCE_ORIGINS = new Set([
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
]);

export class ReferendumSimulator {
  private logger: Logger;
  private chopsticks: ChopsticksManager;
  private api: SubstrateApi;
  private isFellowship: boolean;
  private scheduler: SchedulerManager;
  private resultChecker: ExecutionResultChecker;

  constructor(
    logger: Logger,
    chopsticks: ChopsticksManager,
    api: SubstrateApi,
    isFellowship: boolean = false
  ) {
    this.logger = logger;
    this.chopsticks = chopsticks;
    this.api = api;
    this.isFellowship = isFellowship;
    this.scheduler = new SchedulerManager(logger, chopsticks, api, isFellowship);
    this.resultChecker = new ExecutionResultChecker(logger);
  }

  private getReferendaPalletName(): string {
    return getReferendaPalletName(this.isFellowship);
  }

  private getReferendaPalletQuery(): ReferendaPallet {
    return getReferendaPallet(this.api, this.isFellowship);
  }

  async simulate(
    referendum: ReferendumInfo,
    preExecutionOptions?: { preCall?: string; preOrigin?: string }
  ): Promise<SimulationResult> {
    const result: SimulationResult = {
      referendumId: referendum.id,
      executionSucceeded: false,
      events: [],
    };

    try {
      if (referendum.status === 'approved') {
        this.logger.info(`Referendum #${referendum.id} is already approved - skipping simulation`);
        return {
          referendumId: referendum.id,
          executionSucceeded: true,
          events: [],
          blockExecuted: 0,
        };
      }

      this.logger.section('Simulating Referendum Execution (Force Approval Strategy)');

      const executionResult = await this.forceReferendumExecution(referendum, preExecutionOptions);

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

  private async forceReferendumExecution(
    referendum: ReferendumInfo,
    preExecutionOptions?: { preCall?: string; preOrigin?: string }
  ): Promise<{
    executionSucceeded: boolean;
    events: ParsedEvent[];
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

      const { executionSucceeded, errors } = this.resultChecker.checkExecutionResults(
        events,
        scheduledBlock
      );

      return {
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
    const palletQuery = this.getReferendaPalletQuery();
    const refInfo = await palletQuery.ReferendumInfoFor.getValue(referendum.id);

    if (!refInfo) {
      throw new Error(
        `Referendum ${referendum.id} not found in ${palletName} pallet in Chopsticks instance`
      );
    }

    if (refInfo.type !== 'Ongoing') {
      this.logger.info(
        `Referendum ${referendum.id} is in state: ${refInfo.type} (expected: Ongoing)`
      );

      if (refInfo.type === 'Approved') {
        this.logger.info(
          'Referendum already approved in Chopsticks fork, attempting to execute scheduled call...'
        );
        this.logger.succeedSpinner('Referendum already approved \u2014 skipping state update');
        return;
      }

      throw new Error(
        `Referendum ${referendum.id} is not in Ongoing state (current state: ${refInfo.type})`
      );
    }

    const totalIssuance = await this.api.query.Balances.TotalIssuance.getValue();
    this.logger.debug(`Total issuance: ${totalIssuance}`);

    const { currentBlock } = await this.scheduler.getSchedulingBlocks();

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
    await this.verifyReferendumModification(referendum.id);
  }

  private async scheduleAndExecuteProposal(referendum: ReferendumInfo): Promise<{
    events: ParsedEvent[];
    executionBlock: number;
    scheduledBlock: number;
  }> {
    this.logger.startSpinner('Moving nudgeReferendum to next block...');
    await this.scheduler.moveScheduledCallToNextBlock(referendum.id, 'nudge');
    this.logger.succeedSpinner('nudgeReferendum moved');

    this.logger.startSpinner('Creating block to trigger referendum nudge...');
    await this.chopsticks.newBlock();
    this.logger.succeedSpinner('Referendum nudged');

    this.logger.startSpinner('Moving proposal execution to next block...');
    const proposalHash = referendum.proposal.hash;
    this.logger.debug(`Looking for proposal execution with hash: ${proposalHash}`);
    const scheduledBlock = await this.scheduler.moveScheduledCallToNextBlock(
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

  private buildPassingReferendumStorage(
    ongoingData: ReferendumOngoing,
    totalIssuance: bigint,
    currentBlock: number
  ): Record<string, unknown> {
    const originForStorage = convertOriginToStorageFormat(ongoingData.origin);
    const proposalForStorage = convertProposalToStorageFormat(ongoingData.proposal);

    const decidingSince = currentBlock - 1;
    const decidingConfirming = currentBlock - 1;

    this.logger.debug('Setting referendum enactment to execute immediately (after: 0 blocks)');

    let tally: Record<string, unknown>;
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

  private async verifyReferendumModification(referendumId: number): Promise<void> {
    this.logger.startSpinner('Verifying referendum modification...');
    const palletQuery = this.getReferendaPalletQuery();
    const verifyRefInfo = await palletQuery.ReferendumInfoFor.getValue(referendumId);

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

  private async executePreCall(callHex: string, originString?: string): Promise<void> {
    this.logger.section('Executing Pre-Call');

    const preCallHex = toHexString(callHex) as string;
    this.logger.debug(`Pre-call hex: ${preCallHex.substring(0, 66)}...`);

    const preOrigin = originString ? this.parseOriginString(originString) : { System: 'Root' };
    this.logger.info(`Pre-call origin: ${stringify(preOrigin)}`);

    const { targetBlock: nextBlock } = await this.scheduler.getSchedulingBlocks();

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
      (blockEvent) => blockEvent.section === 'Scheduler' && blockEvent.method === 'Dispatched'
    );

    if (schedulerDispatched.length > 0) {
      const lastDispatch = schedulerDispatched[schedulerDispatched.length - 1];
      const lastData = lastDispatch.data as Record<string, unknown> | undefined;
      const lastValue = lastData?.value as Record<string, unknown> | undefined;
      const dispatchResult = lastValue?.result as Record<string, unknown> | undefined;

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

  private parseOriginString(originString: string): Record<string, string> {
    if (originString === 'Root') {
      return { System: 'Root' };
    }

    if (originString.includes('.')) {
      const [palletOrType, variant] = originString.split('.');
      return { [palletOrType]: variant };
    }

    if (GOVERNANCE_ORIGINS.has(originString)) {
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

      return events.map((rawEvent) => parseBlockEvent(rawEvent));
    } catch (error) {
      this.logger.warn(`Failed to get events for block ${blockNumber}: ${error}`);
      return [];
    }
  }
}
