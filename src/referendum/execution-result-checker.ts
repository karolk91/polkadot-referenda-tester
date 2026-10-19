import type { HexString } from 'polkadot-api';
import type { TaskAddress } from '../types';
import { isEvent, type ParsedEvent } from '../utils/events';
import { stringify } from '../utils/json';
import type { Logger } from '../utils/logger';

export interface ExpectedTask extends TaskAddress {
  id?: HexString;
}

interface SchedulerDispatched {
  task: [number, number];
  id: HexString | undefined;
  result: { success: true; value?: unknown } | { success: false; value: unknown };
}

function dispatchErrorText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'type' in error) {
    const { type, value } = error as { type: unknown; value?: unknown };
    return value === undefined ? String(type) : `${String(type)}.${dispatchErrorText(value)}`;
  }
  return stringify(error);
}

function isExpectedDispatch(dispatch: SchedulerDispatched, expectedTask: ExpectedTask): boolean {
  const [block, index] = dispatch.task;
  const isIdMatch = !expectedTask.id || !dispatch.id || dispatch.id === expectedTask.id;
  return block === expectedTask.block && index === expectedTask.index && isIdMatch;
}

export function extrinsicFailureMessages(events: ParsedEvent[]): string[] {
  return events
    .filter((event) => isEvent(event, 'System', 'ExtrinsicFailed'))
    .map(
      (event) =>
        `ExtrinsicFailed: ${dispatchErrorText((event.data as { dispatch_error: unknown }).dispatch_error)}`
    );
}

function logScheduledFutureTasks(events: ParsedEvent[], logger: Logger): void {
  for (const event of events.filter((candidate) => isEvent(candidate, 'Scheduler', 'Scheduled'))) {
    const { when } = event.data as { when: number };
    logger.info(
      `Note: Proposal scheduled a future task at block ${when} (this is from the proposal content, not the referendum enactment)`
    );
  }
}

export function executionFailures(
  events: ParsedEvent[],
  expectedTask: ExpectedTask,
  logger: Logger
): string[] {
  logScheduledFutureTasks(events, logger);
  const dispatches = events
    .filter((event) => isEvent(event, 'Scheduler', 'Dispatched'))
    .map((event) => event.data as SchedulerDispatched);
  for (const dispatch of dispatches) {
    logger.info(
      `Scheduler.Dispatched: task [${dispatch.task.join(', ')}], id: ${dispatch.id ?? 'none'}, result: ${dispatch.result.success ? 'success' : 'failure'}`
    );
  }
  const expectedDispatches = dispatches.filter((dispatch) =>
    isExpectedDispatch(dispatch, expectedTask)
  );
  const failures = [
    ...expectedDispatches.flatMap((dispatch) =>
      dispatch.result.success ? [] : [dispatchErrorText(dispatch.result.value)]
    ),
    ...extrinsicFailureMessages(events),
  ];
  if (failures.length > 0) return failures;
  if (expectedDispatches.length === 0) {
    return [
      `No Scheduler.Dispatched event found for block ${expectedTask.block} - proposal execution did not happen`,
    ];
  }
  logger.info(
    `✓ Verified Scheduler.Dispatched for task [${expectedTask.block}, ${expectedTask.index}] matches expected proposal execution`
  );
  return [];
}
