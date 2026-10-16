import { describe, expect, it, vi } from 'vitest';
import { fetchReferendum } from '../referendum/referenda-fetcher';
import { FELLOWSHIP, GOVERNANCE, type ReferendaKind } from '../referendum/referenda-kind';
import { enactmentTaskName } from '../utils/scheduler-task-name';
import { createFakeChain, createTestLogger, type FakeChainState, scheduledTask } from './helpers';

const ENACTMENT_TASK_NAME = enactmentTaskName(1886);
const APPROVED = { type: 'Approved', value: [12345, undefined, undefined] };

function fetchFrom(state: FakeChainState, referendumId: number, kind: ReferendaKind = GOVERNANCE) {
  const { api } = createFakeChain(state);
  return fetchReferendum(api, referendumId, kind, createTestLogger());
}

describe('fetchReferendum', () => {
  it('ongoing referendum', async () => {
    expect(await fetchFrom({ referendumInfo: { 7: { type: 'Ongoing', value: {} } } }, 7)).toEqual({
      status: 'ongoing',
      id: 7,
    });
  });

  it('fellowship referendum from the FellowshipReferenda pallet', async () => {
    expect(
      await fetchFrom(
        { fellowshipReferendumInfo: { 7: { type: 'Ongoing', value: {} } } },
        7,
        FELLOWSHIP
      )
    ).toEqual({ status: 'ongoing', id: 7 });
  });

  it('approved referendum with the address of its enactment task', async () => {
    expect(
      await fetchFrom(
        { referendumInfo: { 1886: APPROVED }, lookup: { [ENACTMENT_TASK_NAME]: [99999, 0] } },
        1886
      ),
      'pallet-referenda schedules the enactment as a task with a name derived from the index'
    ).toEqual({ status: 'approved', id: 1886, enactment: { block: 99999, index: 0 } });
  });

  it('approved referendum with the enactment task from an agenda scan', async () => {
    const { api } = createFakeChain({
      referendumInfo: { 1886: APPROVED },
      agenda: { 88888: [scheduledTask(), scheduledTask({ maybe_id: ENACTMENT_TASK_NAME })] },
    });
    vi.mocked(api.query.Scheduler.Lookup.getValue).mockRejectedValue(
      new Error('Incompatible runtime entry')
    );
    expect(await fetchReferendum(api, 1886, GOVERNANCE, createTestLogger())).toEqual({
      status: 'approved',
      id: 1886,
      enactment: { block: 88888, index: 1 },
    });
  });

  it('enacted referendum: approved without a scheduled enactment', async () => {
    expect(await fetchFrom({ referendumInfo: { 1886: APPROVED } }, 1886)).toEqual({
      status: 'enacted',
      id: 1886,
    });
  });

  it('error for a referendum that cannot execute any more', async () => {
    await expect(
      fetchFrom(
        { referendumInfo: { 5: { type: 'Rejected', value: [1, undefined, undefined] } } },
        5
      )
    ).rejects.toThrow(
      'Referendum #5 is rejected; only ongoing or approved referenda can be simulated'
    );
  });

  it('error for a missing referendum', async () => {
    await expect(fetchFrom({}, 5)).rejects.toThrow('Referendum #5 not found in Referenda pallet');
  });
});
