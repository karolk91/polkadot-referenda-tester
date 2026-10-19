import type { HexString } from 'polkadot-api';
import { describe, expect, it } from 'vitest';
import { type ExpectedTask, executionFailures } from '../referendum/execution-result-checker';
import type { ParsedEvent } from '../utils/events';
import { createTestLogger } from './helpers';

const OUR_TASK_ID = `0x${'aa'.repeat(32)}` as HexString;
const OTHER_TASK_ID = `0x${'bb'.repeat(32)}` as HexString;

function dispatched(fields: {
  task: [number, number];
  id?: HexString;
  result?: unknown;
}): ParsedEvent {
  return {
    section: 'Scheduler',
    method: 'Dispatched',
    data: { result: { success: true, value: undefined }, ...fields },
  };
}

const FAILED_RESULT = {
  success: false,
  value: { type: 'Module', value: { type: 'Preimage', value: { type: 'Unavailable' } } },
};

function check(events: ParsedEvent[], expectedTask: ExpectedTask): string[] {
  return executionFailures(events, expectedTask, createTestLogger());
}

describe('executionFailures', () => {
  it('no failure for the expected dispatch', () => {
    expect(check([dispatched({ task: [100, 0] })], { block: 100, index: 0 })).toEqual([]);
  });

  it('dispatch error path for a failed expected dispatch', () => {
    expect(
      check([dispatched({ task: [100, 0], result: FAILED_RESULT })], { block: 100, index: 0 }),
      'the error must name the pallet and the error of the failed call'
    ).toEqual(['Module.Preimage.Unavailable']);
  });

  it('failure without any Scheduler.Dispatched event', () => {
    expect(check([], { block: 100, index: 0 })).toEqual([
      'No Scheduler.Dispatched event found for block 100 - proposal execution did not happen',
    ]);
  });

  it('failure for an unrelated task at the expected block or a task at another block', () => {
    for (const task of [
      [200, 3],
      [999, 0],
    ] as Array<[number, number]>) {
      expect(
        check([dispatched({ task })], { block: 200, index: 0 }),
        'another task succeeding does not prove the proposal executed'
      ).toHaveLength(1);
    }
  });

  it('failure for our failed dispatch next to an unrelated successful dispatch', () => {
    const events = [
      dispatched({ task: [200, 0], result: FAILED_RESULT }),
      dispatched({ task: [200, 1] }),
    ];
    expect(check(events, { block: 200, index: 0 })).toEqual(['Module.Preimage.Unavailable']);
  });

  it('failure for an ExtrinsicFailed event in the block, with its dispatch error', () => {
    const extrinsicFailed: ParsedEvent = {
      section: 'System',
      method: 'ExtrinsicFailed',
      data: { dispatch_error: { type: 'BadOrigin' }, dispatch_info: { weight: 1 } },
    };
    expect(
      check([dispatched({ task: [200, 0] }), extrinsicFailed], { block: 200, index: 0 })
    ).toEqual(['ExtrinsicFailed: BadOrigin']);
  });

  it('task id match and mismatch', () => {
    const expected = { block: 200, index: 0, id: OUR_TASK_ID };
    expect(check([dispatched({ task: [200, 0], id: OUR_TASK_ID })], expected)).toEqual([]);
    expect(
      check([dispatched({ task: [200, 0], id: OTHER_TASK_ID })], expected),
      'a different task name means a different task'
    ).toHaveLength(1);
  });

  it('dispatch without a task id at the expected block and index', () => {
    expect(
      check([dispatched({ task: [200, 0] })], { block: 200, index: 0, id: OUR_TASK_ID }),
      'anonymous tasks carry no id'
    ).toEqual([]);
  });
});
