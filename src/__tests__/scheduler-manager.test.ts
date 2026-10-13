import type { HexString } from 'polkadot-api';
import { describe, expect, it, vi } from 'vitest';
import { FELLOWSHIP, GOVERNANCE } from '../referendum/referenda-kind';
import { SchedulerManager, scheduledTaskAddress } from '../referendum/scheduler-manager';
import {
  createFakeChain,
  createTestLogger,
  type FakeChainState,
  scheduledTask,
  storageWrite,
} from './helpers';

const TASK_NAME = `0x${'ab'.repeat(32)}` as HexString;
const OTHER_TASK_NAME = `0x${'cd'.repeat(32)}` as HexString;

function schedulerFor(state: FakeChainState) {
  const chain = createFakeChain(state);
  const scheduler = new SchedulerManager(createTestLogger(), chain.chopsticks, chain.api);
  return { ...chain, scheduler };
}

describe('scheduledTaskAddress', () => {
  it('address from Scheduler.Lookup', async () => {
    const { api } = createFakeChain({ lookup: { [TASK_NAME]: [99999, 2] } });
    expect(
      await scheduledTaskAddress(api, TASK_NAME, createTestLogger()),
      'polkadot-api 3 encodes the [u8; 32] task name key from a hex string'
    ).toEqual({ block: 99999, index: 2 });
  });

  it('address from an agenda scan when Scheduler.Lookup cannot be read', async () => {
    const { api } = createFakeChain({
      agenda: {
        88888: [
          scheduledTask({ maybe_id: OTHER_TASK_NAME }),
          scheduledTask({ maybe_id: TASK_NAME }),
        ],
      },
    });
    vi.mocked(api.query.Scheduler.Lookup.getValue).mockRejectedValue(
      new Error('Incompatible runtime entry')
    );
    expect(await scheduledTaskAddress(api, TASK_NAME, createTestLogger())).toEqual({
      block: 88888,
      index: 1,
    });
  });

  it('no address for a task that is not scheduled', async () => {
    const { api } = createFakeChain({});
    expect(await scheduledTaskAddress(api, TASK_NAME, createTestLogger())).toBeUndefined();
  });
});

describe('SchedulerManager.moveTask', () => {
  it('task name, period and other tasks of the target block after a move', async () => {
    const { scheduler, writes } = schedulerFor({
      agenda: {
        100: [scheduledTask({ maybe_id: TASK_NAME, maybe_periodic: [10, 3] })],
        51: [scheduledTask({ priority: 1 })],
      },
    });

    const target = await scheduler.moveTask({ block: 100, index: 0 }, 51);

    expect(target).toEqual({ block: 51, index: 1 });
    const targetAgenda = storageWrite(writes, 'Scheduler', 'Agenda', [51]) as Array<
      Record<string, unknown>
    >;
    expect(targetAgenda, 'tasks already scheduled at the target block must still run').toHaveLength(
      2
    );
    expect(targetAgenda[0].priority).toBe(1);
    expect(targetAgenda[1].maybe_id, 'the task name identifies the enactment').toBe(TASK_NAME);
    expect(targetAgenda[1].maybe_periodic, 'a periodic task must stay periodic').toEqual([10, 3]);
    expect(
      storageWrite(writes, 'Scheduler', 'Lookup', [TASK_NAME]),
      'the scheduler finds a task by name through Lookup'
    ).toEqual([51, 1]);
  });

  it('positions of the other tasks of the source block after a move', async () => {
    const { scheduler, writes } = schedulerFor({
      agenda: {
        100: [
          scheduledTask({ priority: 1 }),
          scheduledTask({ maybe_id: TASK_NAME }),
          scheduledTask({ maybe_id: OTHER_TASK_NAME }),
        ],
      },
    });

    await scheduler.moveTask({ block: 100, index: 1 }, 51);

    const sourceAgenda = storageWrite(writes, 'Scheduler', 'Agenda', [100]) as Array<Record<
      string,
      unknown
    > | null>;
    expect(sourceAgenda).toHaveLength(3);
    expect(sourceAgenda[1]).toBeNull();
    expect(
      sourceAgenda[2]?.maybe_id,
      'Scheduler.Lookup addresses tasks by index, so the indices must not shift'
    ).toBe(OTHER_TASK_NAME);
  });

  it('no storage write for a task already at the target block', async () => {
    const { scheduler, writes } = schedulerFor({ agenda: { 51: [scheduledTask()] } });
    expect(await scheduler.moveTask({ block: 51, index: 0 }, 51)).toEqual({ block: 51, index: 0 });
    expect(writes).toEqual([]);
  });

  it('error for an empty slot', async () => {
    const { scheduler } = schedulerFor({ agenda: { 100: [undefined] } });
    await expect(scheduler.moveTask({ block: 100, index: 0 }, 51)).rejects.toThrow(
      'No scheduled task at [100, 0]'
    );
  });
});

describe('SchedulerManager.appendInlineCall', () => {
  it('inline call after the tasks of the target block', async () => {
    const { scheduler, writes } = schedulerFor({
      agenda: { 51: [scheduledTask({ priority: 1 })] },
    });

    const address = await scheduler.appendInlineCall('0x0102', { system: 'Root' }, 51);

    expect(address).toEqual({ block: 51, index: 1 });
    const targetAgenda = storageWrite(writes, 'Scheduler', 'Agenda', [51]) as Array<
      Record<string, unknown>
    >;
    expect(targetAgenda[0].priority, 'a pre-call must not delete scheduled tasks').toBe(1);
    expect(targetAgenda[1]).toMatchObject({
      call: { Inline: '0x0102' },
      origin: { system: 'Root' },
    });
  });
});

describe('SchedulerManager.scheduleNudge', () => {
  const NUDGE_CALL = new Uint8Array([0x3e, 0x07]);

  function withNudgeDecoder(api: ReturnType<typeof createFakeChain>['api'], pallet: string) {
    vi.mocked(api.txFromCallData).mockImplementation(async (callData: Uint8Array) => ({
      decodedCall: {
        type: callData === NUDGE_CALL ? pallet : 'System',
        value: { type: 'nudge_referendum', value: { index: 7 } },
      },
      create: vi.fn(),
      getEncodedData: vi.fn(),
    }));
  }

  it('alarm of the referendum moved to the target block', async () => {
    const { scheduler, writes, api } = schedulerFor({
      agenda: { 200: [scheduledTask({ call: { type: 'Inline', value: NUDGE_CALL } })] },
    });
    withNudgeDecoder(api, 'Referenda');

    expect(await scheduler.scheduleNudge(GOVERNANCE, 7, 51)).toEqual({ block: 51, index: 0 });
    expect(storageWrite(writes, 'Scheduler', 'Agenda', [200])).toEqual([null]);
  });

  it('Root nudge for a referendum without an alarm', async () => {
    const { scheduler, writes, api } = schedulerFor({ agenda: { 51: [scheduledTask()] } });
    withNudgeDecoder(api, 'Referenda');
    const nudgeReferendum = vi.fn(() => ({
      getEncodedData: async () => new Uint8Array([0x3e, 0x09]),
    }));
    (api as unknown as { tx: unknown }).tx = { Referenda: { nudge_referendum: nudgeReferendum } };

    expect(
      await scheduler.scheduleNudge(GOVERNANCE, 7, 51),
      'a queued referendum has no alarm, so the tool schedules the nudge itself'
    ).toEqual({ block: 51, index: 1 });
    expect(nudgeReferendum).toHaveBeenCalledWith({ index: 7 });
    expect(storageWrite(writes, 'Scheduler', 'Agenda', [51])).toMatchObject([
      {},
      { call: { Inline: '0x3e09' }, origin: { system: 'Root' } },
    ]);
  });

  it('alarm search in the FellowshipReferenda pallet for a fellowship referendum', async () => {
    const { scheduler, api } = schedulerFor({
      agenda: { 200: [scheduledTask({ call: { type: 'Inline', value: NUDGE_CALL } })] },
    });
    withNudgeDecoder(api, 'FellowshipReferenda');
    expect(await scheduler.scheduleNudge(FELLOWSHIP, 7, 51)).toEqual({ block: 51, index: 0 });
  });
});

describe('SchedulerManager.nextAgendaBlock', () => {
  it('Scheduler.IncompleteSince, in the block numbers of the scheduler', async () => {
    const { scheduler } = schedulerFor({ blockNumber: 100, incompleteSince: 5001 });
    expect(
      await scheduler.nextAgendaBlock(),
      'the next block services the agendas from IncompleteSince; Asset Hub keys them by relay block number'
    ).toBe(5001);
  });

  it('next local block without Scheduler.IncompleteSince', async () => {
    const { scheduler } = schedulerFor({ blockNumber: 100 });
    expect(
      await scheduler.nextAgendaBlock(),
      'a scheduler without IncompleteSince services the agenda of the next local block'
    ).toBe(101);
  });
});
