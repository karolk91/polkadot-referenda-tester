import { describe, expect, it, vi } from 'vitest';
import { FELLOWSHIP, GOVERNANCE } from '../referendum/referenda-kind';
import { passingReferendumInfo, ReferendumSimulator } from '../referendum/referendum-simulator';
import type { EventRecord, ReferendumOngoing } from '../types/substrate-api';
import { enactmentTaskName } from '../utils/scheduler-task-name';
import {
  createFakeChain,
  createTestLogger,
  eventRecord,
  type FakeChainState,
  mockNudgeDecoder,
  NUDGE_CALL,
  scheduledTask,
  storageWrite,
} from './helpers';

const REFERENDUM_ID = 7;
const ENACTMENT_TASK_NAME = enactmentTaskName(REFERENDUM_ID);

const ONGOING: ReferendumOngoing = {
  track: 0,
  origin: { type: 'Origins', value: { type: 'Treasurer', value: undefined } },
  proposal: { type: 'Lookup', value: { hash: '0x1234', len: 50 } },
  enactment: { type: 'After', value: 100 },
  submitted: 900,
  submission_deposit: { who: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY', amount: 10n },
  decision_deposit: undefined,
  deciding: undefined,
  tally: { ayes: 0n, nays: 0n, support: 0n },
  in_queue: true,
  alarm: [2000, [2000, 0]],
};

function dispatched(task: [number, number], id: string | undefined, success = true) {
  return eventRecord('Scheduler', 'Dispatched', {
    task,
    id,
    result: success
      ? { success: true, value: undefined }
      : { success: false, value: { type: 'BadOrigin' } },
  });
}

function simulatorFor(state: FakeChainState, eventsPerBlock: EventRecord[][]) {
  const chain = createFakeChain(state);
  const events = vi.mocked(chain.api.query.System.Events.getValue);
  for (const blockEvents of eventsPerBlock) {
    events.mockResolvedValueOnce(blockEvents);
  }
  mockNudgeDecoder(chain.api, 'Referenda', REFERENDUM_ID);
  return {
    ...chain,
    simulator: new ReferendumSimulator(createTestLogger(), chain.chopsticks, chain.api, GOVERNANCE),
  };
}

describe('passingReferendumInfo', () => {
  const info = passingReferendumInfo(ONGOING, 1_000_000n, 1501, GOVERNANCE) as {
    Ongoing: Record<string, unknown>;
  };

  it('governance tally with ayes and support just below total issuance', () => {
    expect(info.Ongoing.tally, 'support above the track threshold passes any curve').toEqual({
      ayes: '999999',
      nays: '0',
      support: '999999',
    });
  });

  it('fellowship tally with rank-weighted ayes', () => {
    const fellowshipInfo = passingReferendumInfo(ONGOING, 1_000_000n, 1501, FELLOWSHIP) as {
      Ongoing: Record<string, unknown>;
    };
    expect(fellowshipInfo.Ongoing.tally).toEqual({ bare_ayes: 100, ayes: 1000, nays: 0 });
  });

  it('immediate enactment, confirmation already started, track queue left', () => {
    expect(info.Ongoing).toMatchObject({
      enactment: { After: 0 },
      deciding: { since: 1499, confirming: 1499 },
      in_queue: false,
      alarm: [1501, [1501, 0]],
    });
  });

  it('origin, proposal and deposits in the dev_setStorage shape', () => {
    expect(info.Ongoing).toMatchObject({
      origin: { Origins: { Treasurer: null } },
      proposal: { Lookup: { hash: '0x1234', len: 50 } },
      submission_deposit: { amount: '10' },
      decision_deposit: null,
    });
  });
});

describe('ReferendumSimulator.simulate', () => {
  it('enacted referendum without any storage write', async () => {
    const { simulator, writes } = simulatorFor({}, []);
    expect(await simulator.simulate({ status: 'enacted', id: REFERENDUM_ID })).toEqual({
      outcome: 'already-enacted',
      events: [],
    });
    expect(writes).toEqual([]);
  });

  it('approved referendum: enactment task moved to the next block and checked by name', async () => {
    const { simulator, writes } = simulatorFor(
      { blockNumber: 1000, agenda: { 99999: [scheduledTask({ maybe_id: ENACTMENT_TASK_NAME })] } },
      [[dispatched([1001, 0], ENACTMENT_TASK_NAME)]]
    );

    const result = await simulator.simulate({
      status: 'approved',
      id: REFERENDUM_ID,
      enactment: { block: 99999, index: 0 },
    });

    expect(result.outcome).toBe('executed');
    expect(storageWrite(writes, 'Scheduler', 'Agenda', [1001])).toMatchObject([
      { maybe_id: ENACTMENT_TASK_NAME },
    ]);
    expect(
      writes.some((write) => write.item === 'ReferendumInfoFor'),
      'an approved referendum needs no forced tally'
    ).toBe(false);
  });

  it('pre-call after the tasks already scheduled at its block', async () => {
    const { simulator, writes } = simulatorFor(
      {
        blockNumber: 1000,
        agenda: {
          1001: [scheduledTask({ priority: 1 })],
          99999: [scheduledTask({ maybe_id: ENACTMENT_TASK_NAME })],
        },
      },
      [[dispatched([1001, 1], undefined)], [dispatched([1002, 0], ENACTMENT_TASK_NAME)]]
    );

    await simulator.simulate(
      { status: 'approved', id: REFERENDUM_ID, enactment: { block: 99999, index: 0 } },
      { call: '0x0102', origin: 'Root' }
    );

    const preCallAgenda = writes.find(
      (write) => write.item === 'Agenda' && JSON.stringify(write.key) === '[1001]'
    )?.value;
    expect(preCallAgenda, 'a pre-call must not delete tasks scheduled at its block').toMatchObject([
      { priority: 1 },
      { call: { Inline: '0x0102' }, origin: { System: 'Root' } },
    ]);
  });

  it('ongoing referendum: passing state, alarm moved, enactment executed', async () => {
    const { simulator, writes } = simulatorFor(
      {
        blockNumber: 1000,
        referendumInfo: { [REFERENDUM_ID]: { type: 'Ongoing', value: ONGOING } },
        agenda: {
          2000: [scheduledTask({ call: { type: 'Inline', value: NUDGE_CALL } })],
          3000: [scheduledTask({ maybe_id: ENACTMENT_TASK_NAME })],
        },
        lookup: { [ENACTMENT_TASK_NAME]: [3000, 0] },
      },
      [
        [eventRecord('Referenda', 'Confirmed', { index: REFERENDUM_ID })],
        [dispatched([1003, 0], ENACTMENT_TASK_NAME)],
      ]
    );

    const result = await simulator.simulate({ status: 'ongoing', id: REFERENDUM_ID });

    expect(result.outcome).toBe('executed');
    expect(storageWrite(writes, 'Referenda', 'ReferendumInfoFor', [REFERENDUM_ID])).toMatchObject({
      Ongoing: { tally: { ayes: '999999' } },
    });
    expect(storageWrite(writes, 'Scheduler', 'Agenda', [2000]), 'alarm moved out').toEqual([null]);
    expect(storageWrite(writes, 'Scheduler', 'Lookup', [ENACTMENT_TASK_NAME])).toEqual([1003, 0]);
  });

  it('confirmation of another referendum in the nudge block', async () => {
    const otherConfirmation = eventRecord('Referenda', 'Confirmed', { index: 8 });
    const { simulator } = simulatorFor(
      {
        blockNumber: 1000,
        referendumInfo: { [REFERENDUM_ID]: { type: 'Ongoing', value: ONGOING } },
        agenda: { 2000: [scheduledTask({ call: { type: 'Inline', value: NUDGE_CALL } })] },
      },
      [[otherConfirmation], [otherConfirmation], [otherConfirmation]]
    );

    await expect(simulator.simulate({ status: 'ongoing', id: REFERENDUM_ID })).rejects.toThrow(
      `Referendum #${REFERENDUM_ID} was not confirmed`
    );
  });

  it('enactment at the next agenda block of a scheduler with relay block numbers', async () => {
    const { simulator, writes } = simulatorFor(
      {
        blockNumber: 1000,
        incompleteSince: 5001,
        agenda: { 99999: [scheduledTask({ maybe_id: ENACTMENT_TASK_NAME })] },
      },
      [[dispatched([5001, 0], ENACTMENT_TASK_NAME)]]
    );

    const result = await simulator.simulate({
      status: 'approved',
      id: REFERENDUM_ID,
      enactment: { block: 99999, index: 0 },
    });

    expect(result.outcome).toBe('executed');
    expect(
      storageWrite(writes, 'Scheduler', 'Agenda', [5001]),
      'Asset Hub keys its agenda by relay block number, not by its own block number'
    ).toMatchObject([{ maybe_id: ENACTMENT_TASK_NAME }]);
  });

  it('extra block when the scheduler postpones the enactment', async () => {
    const { simulator, chopsticks } = simulatorFor(
      { blockNumber: 1000, agenda: { 99999: [scheduledTask({ maybe_id: ENACTMENT_TASK_NAME })] } },
      [[], [dispatched([1001, 0], ENACTMENT_TASK_NAME)]]
    );

    const result = await simulator.simulate({
      status: 'approved',
      id: REFERENDUM_ID,
      enactment: { block: 99999, index: 0 },
    });

    expect(
      result.outcome,
      'session-change work can starve the scheduler and delay the task by a block'
    ).toBe('executed');
    expect(chopsticks.newBlock).toHaveBeenCalledTimes(2);
  });

  it('failure when the enactment never dispatches', async () => {
    const { simulator } = simulatorFor(
      { blockNumber: 1000, agenda: { 99999: [scheduledTask({ maybe_id: ENACTMENT_TASK_NAME })] } },
      [[], [], []]
    );

    await expect(
      simulator.simulate({
        status: 'approved',
        id: REFERENDUM_ID,
        enactment: { block: 99999, index: 0 },
      })
    ).rejects.toThrow(
      `Referendum #${REFERENDUM_ID} execution failed: No Scheduler.Dispatched event found for block 1001 - proposal execution did not happen`
    );
  });
});
