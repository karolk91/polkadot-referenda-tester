import { blockNumber } from '../network/chain-client';
import type { ChopsticksManager } from '../network/chopsticks-manager';
import type { FetchedReferendum, PreCall, SimulationResult, TaskAddress } from '../types';
import type { ReferendumOngoing, SubstrateApi } from '../types/substrate-api';
import { blockEvents, isEvent, type ParsedEvent, printEvents } from '../utils/events';
import { stringify } from '../utils/json';
import type { Logger } from '../utils/logger';
import { enactmentTaskName } from '../utils/scheduler-task-name';
import { toPolkadotJsJson } from '../utils/storage-format-converter';
import { executionFailures } from './execution-result-checker';
import { executePreCall } from './pre-call';
import type { ReferendaKind } from './referenda-kind';
import { SchedulerManager, scheduledTaskAddress, taskAddress } from './scheduler-manager';

const MAX_EXTRA_BLOCKS = 2;

export function passingReferendumInfo(
  ongoing: ReferendumOngoing,
  totalIssuance: bigint,
  alarmBlock: number,
  kind: ReferendaKind
): unknown {
  return toPolkadotJsJson({
    type: 'Ongoing',
    value: {
      ...ongoing,
      enactment: { type: 'After', value: 0 },
      deciding: { since: alarmBlock - 2, confirming: alarmBlock - 2 },
      tally: kind.passingTally(totalIssuance),
      in_queue: false,
      alarm: [alarmBlock, [alarmBlock, 0]],
    },
  });
}

export class ReferendumSimulator {
  private readonly scheduler: SchedulerManager;

  constructor(
    private readonly logger: Logger,
    private readonly chopsticks: ChopsticksManager,
    private readonly api: SubstrateApi,
    private readonly kind: ReferendaKind
  ) {
    this.scheduler = new SchedulerManager(logger, chopsticks, api);
  }

  async simulate(referendum: FetchedReferendum, preCall?: PreCall): Promise<SimulationResult> {
    if (referendum.status === 'enacted') {
      this.logger.info(
        `Referendum #${referendum.id} is approved and its scheduled enactment has already executed - skipping simulation`
      );
      return { outcome: 'already-enacted', events: [] };
    }

    this.logger.section(
      referendum.status === 'approved'
        ? 'Simulating Referendum Execution (Pre-Approved, Move Enactment Forward)'
        : 'Simulating Referendum Execution (Force Approval Strategy)'
    );
    if (preCall) {
      await executePreCall(
        preCall,
        { api: this.api, chopsticks: this.chopsticks, scheduler: this.scheduler },
        this.logger
      );
    }
    const enactment =
      referendum.status === 'approved' ? referendum.enactment : await this.approve(referendum.id);
    return this.executeEnactment(referendum.id, enactment);
  }

  private async approve(referendumId: number): Promise<TaskAddress> {
    const alarm = await this.applyPassingState(referendumId);

    const nudgeBlock = await this.scheduler.nextAgendaBlock();
    this.logger.startSpinner('Scheduling nudgeReferendum for next block...');
    await this.scheduler.scheduleNudge(this.kind, referendumId, alarm, nudgeBlock);
    this.logger.succeedSpinner('nudgeReferendum scheduled');

    this.logger.startSpinner('Creating block to trigger referendum nudge...');
    await this.chopsticks.newBlock();
    this.logger.succeedSpinner('Referendum nudged');

    const { palletName } = this.kind;
    const isApproval = (event: ParsedEvent) =>
      (isEvent(event, palletName, 'Confirmed') || isEvent(event, palletName, 'Approved')) &&
      Number((event.data as { index?: unknown } | null)?.index) === referendumId;
    const events = await this.eventsWithExtraBlocks(
      (blockEvents) => blockEvents.some(isApproval),
      `Referendum #${referendumId} not yet confirmed in this block (scheduler may have postponed the nudge past a session change) — building another block`
    );
    if (!events.some(isApproval)) {
      throw new Error(
        `Referendum #${referendumId} was not confirmed or approved after nudge. ` +
          `Expected ${palletName}.Confirmed or ${palletName}.Approved events for it but found: ` +
          events.map((event) => `${event.section}.${event.method}`).join(', ')
      );
    }
    this.logger.info(`✓ Referendum #${referendumId} confirmed and approved in nudge block`);

    const enactment = await scheduledTaskAddress(
      this.api,
      enactmentTaskName(referendumId),
      this.logger
    );
    if (!enactment) {
      throw new Error(
        `Referendum #${referendumId} was approved but its enactment task is not in the scheduler`
      );
    }
    return enactment;
  }

  private async executeEnactment(
    referendumId: number,
    enactment: TaskAddress
  ): Promise<SimulationResult> {
    const executionBlock = await this.scheduler.nextAgendaBlock();
    this.logger.startSpinner('Moving proposal execution to next block...');
    const task = await this.scheduler.moveTask(enactment, executionBlock);
    this.logger.succeedSpinner(`Proposal execution scheduled at block ${task.block}`);

    this.logger.startSpinner('Creating block to execute proposal...');
    await this.chopsticks.newBlock();
    const events = await this.eventsWithExtraBlocks(
      (blockEvents) => blockEvents.some((event) => isEvent(event, 'Scheduler', 'Dispatched')),
      'No Scheduler.Dispatched event in the execution block (scheduler may have postponed the task past a session change) — building another block'
    );
    this.logger.succeedSpinner(`Proposal executed at block ${await blockNumber(this.api)}`);

    printEvents('Execution events:', events, this.logger);
    const failures = executionFailures(
      events,
      { ...task, id: enactmentTaskName(referendumId) },
      this.logger
    );
    if (failures.length > 0) {
      throw new Error(`Referendum #${referendumId} execution failed: ${failures.join('; ')}`);
    }
    return { outcome: 'executed', events };
  }

  private async eventsWithExtraBlocks(
    isComplete: (events: ParsedEvent[]) => boolean,
    extraBlockMessage: string
  ): Promise<ParsedEvent[]> {
    const events = await blockEvents(this.api);
    for (
      let extraBlocks = 0;
      extraBlocks < MAX_EXTRA_BLOCKS && !isComplete(events);
      extraBlocks++
    ) {
      this.logger.info(extraBlockMessage);
      await this.chopsticks.newBlock();
      events.push(...(await blockEvents(this.api)));
    }
    return events;
  }

  private async applyPassingState(referendumId: number): Promise<TaskAddress | undefined> {
    this.logger.startSpinner('Forcing referendum to passing state...');
    const { palletName } = this.kind;
    const referendaPallet = this.kind.pallet(this.api);
    const info = await referendaPallet.ReferendumInfoFor.getValue(referendumId);
    if (info?.type !== 'Ongoing') {
      throw new Error(
        `Referendum ${referendumId} is not in Ongoing state in ${palletName} (current state: ${info?.type ?? 'missing'})`
      );
    }

    const [totalIssuance, alarmBlock] = await Promise.all([
      this.api.query.Balances.TotalIssuance.getValue(),
      this.scheduler.nextAgendaBlock(),
    ]);
    const passingInfo = passingReferendumInfo(info.value, totalIssuance, alarmBlock, this.kind);
    this.logger.debug(
      `Sending storage update to ${palletName} pallet in Chopsticks: ${stringify(passingInfo, 2)}`
    );
    await this.chopsticks.setStorageBatch({
      [palletName]: { ReferendumInfoFor: [[[referendumId], passingInfo]] },
    });
    this.logger.succeedSpinner('Referendum state updated to passing');
    await this.chopsticks.newBlock();

    const updatedInfo = await referendaPallet.ReferendumInfoFor.getValue(referendumId);
    if (updatedInfo?.type === 'Ongoing') {
      this.logger.info(`✓ Enactment: ${stringify(updatedInfo.value.enactment)}`);
      this.logger.info(`✓ Tally: ${stringify(updatedInfo.value.tally)}`);
      this.logger.info(`✓ Deciding: ${stringify(updatedInfo.value.deciding ?? null)}`);
    } else {
      this.logger.warn(`Referendum is in ${updatedInfo?.type ?? 'unknown'} state after the update`);
    }
    return info.value.alarm && taskAddress(info.value.alarm[1]);
  }
}
