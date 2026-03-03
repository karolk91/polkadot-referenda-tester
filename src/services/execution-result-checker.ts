import { formatDispatchError, interpretDispatchResult } from '../utils/dispatch-result';
import { type ParsedEvent, serializeEventData } from '../utils/event-serializer';
import { stringify } from '../utils/json';
import type { Logger } from '../utils/logger';

export class ExecutionResultChecker {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  checkExecutionResults(
    events: ParsedEvent[],
    expectedBlock?: number
  ): { executionSucceeded: boolean; errors?: string[] } {
    const { extrinsicFailureMessages } = this.logBlockEvents(events);

    this.logScheduledFutureTasks(events);

    const dispatchedEvents = events.filter(
      (blockEvent) => blockEvent.section === 'Scheduler' && blockEvent.method === 'Dispatched'
    );
    this.logger.debug(`Found ${dispatchedEvents.length} Scheduler.Dispatched events`);

    return this.interpretResults(dispatchedEvents, extrinsicFailureMessages, expectedBlock);
  }

  private logBlockEvents(events: ParsedEvent[]): { extrinsicFailureMessages: string[] } {
    const extrinsicFailures = events.filter(
      (blockEvent) => blockEvent.section === 'System' && blockEvent.method === 'ExtrinsicFailed'
    );
    const extrinsicFailureMessages = extrinsicFailures.map(
      (blockEvent) => `ExtrinsicFailed: ${formatDispatchError(blockEvent.data)}`
    );

    this.logger.info('Events in block:');
    for (const blockEvent of events) {
      this.logger.info(`  \u2022 ${blockEvent.section}.${blockEvent.method}`);
      if (this.logger.isVerbose() && blockEvent.data) {
        const serialized = serializeEventData(blockEvent.data);
        this.logger.debug(`    Data: ${stringify(serialized, 2)}`);
      }
    }

    return { extrinsicFailureMessages };
  }

  private logScheduledFutureTasks(events: ParsedEvent[]): void {
    const scheduledEvents = events.filter(
      (blockEvent) => blockEvent.section === 'Scheduler' && blockEvent.method === 'Scheduled'
    );
    for (const scheduledEvent of scheduledEvents) {
      const eventData = scheduledEvent.data as Record<string, unknown> | undefined;
      const eventValue = eventData?.value as Record<string, unknown> | undefined;
      const whenBlock = eventValue?.when || eventData?.when;
      if (whenBlock) {
        this.logger.info(
          `Note: Proposal scheduled a future task at block ${whenBlock} (this is from the proposal content, not the referendum enactment)`
        );
      }
    }
  }

  private interpretResults(
    dispatchedEvents: ParsedEvent[],
    extrinsicFailureMessages: string[],
    expectedBlock?: number
  ): { executionSucceeded: boolean; errors?: string[] } {
    if (dispatchedEvents.length > 0) {
      const { successful, failed } = this.classifyDispatches(dispatchedEvents, expectedBlock);

      if (successful.length > 0 && failed.length === 0 && extrinsicFailureMessages.length === 0) {
        return { executionSucceeded: true };
      }

      if (failed.length > 0 || extrinsicFailureMessages.length > 0) {
        const errors = failed.map((dispatch) => dispatch.message || 'Scheduler dispatch failed');
        errors.push(...extrinsicFailureMessages);
        return { executionSucceeded: false, errors };
      }
    }

    if (extrinsicFailureMessages.length > 0) {
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

  private classifyDispatches(
    dispatchedEvents: ParsedEvent[],
    expectedBlock?: number
  ): { successful: ParsedEvent[]; failed: Array<{ event: ParsedEvent; message?: string }> } {
    const successful: ParsedEvent[] = [];
    const failed: Array<{ event: ParsedEvent; message?: string }> = [];

    for (const dispatchEvent of dispatchedEvents) {
      const dataRecord = dispatchEvent.data as Record<string, unknown> | undefined;
      const eventValue = (dataRecord?.value || dispatchEvent.data) as
        | Record<string, unknown>
        | undefined;
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
        successful.push(dispatchEvent);
      } else if (parsedResult.outcome === 'failure') {
        failed.push({ event: dispatchEvent, message: parsedResult.message });
      }
    }

    return { successful, failed };
  }
}
