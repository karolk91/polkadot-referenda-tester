import { describe, expect, it, vi } from 'vitest';
import { ExecutionResultChecker } from '../services/execution-result-checker';
import type { ParsedEvent } from '../utils/event-serializer';
import type { Logger } from '../utils/logger';

/** Minimal logger stub that satisfies the Logger interface without producing output. */
function createSilentLogger(): Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    isVerbose: () => false,
    startSpinner: vi.fn(),
    succeedSpinner: vi.fn(),
    failSpinner: vi.fn(),
    updateSpinner: vi.fn(),
    stopSpinner: vi.fn(),
    section: vi.fn(),
    table: vi.fn(),
  } as unknown as Logger;
}

function makeDispatchedEvent(
  taskBlock: number,
  taskIndex: number,
  resultType: 'Ok' | 'Err'
): ParsedEvent {
  return {
    section: 'Scheduler',
    method: 'Dispatched',
    data: {
      value: {
        task: [taskBlock, taskIndex],
        result: { type: resultType },
      },
    },
  };
}

function makeDispatchedEventWithId(
  taskBlock: number,
  taskIndex: number,
  resultType: 'Ok' | 'Err',
  id: Uint8Array | string
): ParsedEvent {
  return {
    section: 'Scheduler',
    method: 'Dispatched',
    data: {
      value: {
        task: [taskBlock, taskIndex],
        id,
        result: { type: resultType },
      },
    },
  };
}

function makeDispatchedEventWithoutTask(resultType: 'Ok' | 'Err'): ParsedEvent {
  return {
    section: 'Scheduler',
    method: 'Dispatched',
    data: {
      value: {
        result: { type: resultType },
      },
    },
  };
}

describe('ExecutionResultChecker', () => {
  // ═══════════════════════════════════════════════════════════════════════
  // Baseline: verify the checker works for the happy path
  // ═══════════════════════════════════════════════════════════════════════

  it('reports success when the expected dispatch succeeds', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());
    const events = [makeDispatchedEvent(100, 0, 'Ok')];
    const result = checker.checkExecutionResults(events, 100, 0);
    expect(result.executionSucceeded).toBe(true);
  });

  it('reports failure when the expected dispatch fails', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());
    const events = [makeDispatchedEvent(100, 0, 'Err')];
    const result = checker.checkExecutionResults(events, 100, 0);
    expect(result.executionSucceeded).toBe(false);
  });

  it('reports failure when no dispatched events exist', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());
    const result = checker.checkExecutionResults([], 100, 0);
    expect(result.executionSucceeded).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Trick scenario 1: Unrelated dispatch at expected block, our proposal missing
  //
  // Our proposal was supposed to be at task [200, 0] but wasn't scheduled.
  // An unrelated runtime task at [200, 3] succeeded instead.
  // The checker should NOT report success — it wasn't our proposal.
  // ═══════════════════════════════════════════════════════════════════════

  it('rejects success from unrelated dispatch at same block (different task index)', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());

    // Only an unrelated task at index 3 dispatched — our proposal at index 0 is absent
    const events = [makeDispatchedEvent(200, 3, 'Ok')];

    // We expect our task at index 0, but only index 3 dispatched
    const result = checker.checkExecutionResults(events, 200, 0);

    expect(result.executionSucceeded).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Trick scenario 2: Dispatch event without task field bypasses block filter
  //
  // If a Scheduler.Dispatched event doesn't have a parseable task array,
  // the block filter is never applied. An Ok result should NOT be accepted
  // when we have expected coordinates to verify against.
  // ═══════════════════════════════════════════════════════════════════════

  it('rejects dispatch events with no task field even when result is Ok', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());

    // Dispatch event with Ok result but no task coordinates
    const events = [makeDispatchedEventWithoutTask('Ok')];

    const result = checker.checkExecutionResults(events, 200, 0);

    expect(result.executionSucceeded).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Trick scenario 3: Unknown dispatch result silently dropped
  //
  // If interpretDispatchResult returns "unknown", the event is not classified
  // as either successful or failed. The error message should mention the
  // uninterpretable result, not claim no event was found.
  // ═══════════════════════════════════════════════════════════════════════

  it('reports a clear error when dispatch result is uninterpretable', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());

    const events: ParsedEvent[] = [
      {
        section: 'Scheduler',
        method: 'Dispatched',
        data: {
          value: {
            task: [200, 0],
            result: { type: 'SomethingWeird' },
          },
        },
      },
    ];

    const result = checker.checkExecutionResults(events, 200, 0);

    expect(result.executionSucceeded).toBe(false);
    expect(result.errors).toBeDefined();
    // Error should mention uninterpretable result, not "No event found"
    expect(result.errors![0]).not.toContain('No Scheduler.Dispatched event found');
    expect(result.errors![0]).toContain('could not be interpreted');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Trick scenario 4: Multiple dispatches — one ours fails, unrelated succeeds
  //
  // This scenario IS correctly handled (failed.length > 0 → failure).
  // Included as a regression guard.
  // ═══════════════════════════════════════════════════════════════════════

  it('reports failure when our dispatch fails even if another succeeds at same block', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());
    const events = [
      makeDispatchedEvent(200, 0, 'Err'), // Our proposal fails
      makeDispatchedEvent(200, 1, 'Ok'), // Unrelated task succeeds
    ];
    const result = checker.checkExecutionResults(events, 200, 0);
    expect(result.executionSucceeded).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Trick scenario 5: Dispatch from wrong block is correctly filtered
  //
  // Regression guard — this IS handled correctly.
  // ═══════════════════════════════════════════════════════════════════════

  it('ignores dispatches from non-matching blocks', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());
    const events = [
      makeDispatchedEvent(999, 0, 'Ok'), // Wrong block
    ];
    const result = checker.checkExecutionResults(events, 200, 0);
    expect(result.executionSucceeded).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Backwards compatibility: no expectedTaskIndex still works
  // ═══════════════════════════════════════════════════════════════════════

  it('accepts any task index when expectedTaskIndex is not provided', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());
    const events = [makeDispatchedEvent(200, 5, 'Ok')];
    // No expectedTaskIndex — should match any index at the expected block
    const result = checker.checkExecutionResults(events, 200);
    expect(result.executionSucceeded).toBe(true);
  });

  it('accepts dispatch without task when no expected coordinates given', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());
    const events = [makeDispatchedEventWithoutTask('Ok')];
    // No expectedBlock or expectedTaskIndex — loose mode
    const result = checker.checkExecutionResults(events);
    expect(result.executionSucceeded).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Task ID verification: Scheduler.Dispatched carries an `id` field
  // that links the dispatch to a specific scheduled task (e.g. a referendum).
  // ═══════════════════════════════════════════════════════════════════════

  it('accepts dispatch when event id matches expected task id', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());
    const taskId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
    const events = [makeDispatchedEventWithId(200, 0, 'Ok', taskId)];
    const result = checker.checkExecutionResults(events, 200, 0, taskId);
    expect(result.executionSucceeded).toBe(true);
  });

  it('rejects dispatch when event id does not match expected task id', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());
    const expectedId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
    const wrongId = new Uint8Array([99, 99, 99, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
    const events = [makeDispatchedEventWithId(200, 0, 'Ok', wrongId)];
    const result = checker.checkExecutionResults(events, 200, 0, expectedId);
    expect(result.executionSucceeded).toBe(false);
  });

  it('accepts dispatch when event has no id but expected id is provided (graceful)', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());
    const expectedId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
    // Event has matching block/index but no id — still accepted (id is optional in runtime)
    const events = [makeDispatchedEvent(200, 0, 'Ok')];
    const result = checker.checkExecutionResults(events, 200, 0, expectedId);
    expect(result.executionSucceeded).toBe(true);
  });

  it('accepts dispatch when no expected id is provided even if event has id', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());
    const eventId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
    const events = [makeDispatchedEventWithId(200, 0, 'Ok', eventId)];
    // No expectedTaskId — should not filter by id
    const result = checker.checkExecutionResults(events, 200, 0);
    expect(result.executionSucceeded).toBe(true);
  });

  it('rejects unrelated dispatch with different id even at correct block and index', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());
    const ourId = new Uint8Array(32).fill(0xAA);
    const theirId = new Uint8Array(32).fill(0xBB);
    // Same block, same index, but different task id — this is NOT our dispatch
    const events = [makeDispatchedEventWithId(200, 0, 'Ok', theirId)];
    const result = checker.checkExecutionResults(events, 200, 0, ourId);
    expect(result.executionSucceeded).toBe(false);
  });

  it('handles id comparison with hex string format from event', () => {
    const checker = new ExecutionResultChecker(createSilentLogger());
    const expectedId = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // Event id as hex string (some runtimes serialize it this way)
    const events = [makeDispatchedEventWithId(200, 0, 'Ok', '0xaabbccdd00000000000000000000000000000000000000000000000000000000')];
    const result = checker.checkExecutionResults(events, 200, 0, expectedId);
    expect(result.executionSucceeded).toBe(true);
  });
});
