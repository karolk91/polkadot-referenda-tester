import { describe, expect, it, vi } from 'vitest';
import { FELLOWSHIP, GOVERNANCE } from '../referendum/referenda-kind';
import { simulateReferendum } from '../referendum/simulation-runner';
import { createFakeChain, createTestLogger } from './helpers';

const APPROVED = { type: 'Approved', value: [1000, undefined, undefined] };

describe('simulateReferendum', () => {
  it('existing referendum without any submitted extrinsic', async () => {
    const { api, chopsticks } = createFakeChain({ referendumInfo: { 1944: APPROVED } });

    const result = await simulateReferendum(
      {
        target: { api, manager: chopsticks },
        source: { kind: 'existing', id: 1944 },
        kind: GOVERNANCE,
      },
      createTestLogger()
    );

    expect(result).toEqual({ referendumId: 1944, events: [] });
    expect(
      api.txFromCallData,
      'a second referendum would change the chain state that the test examines'
    ).not.toHaveBeenCalled();
  });

  it('simulation of the referendum that the submitted call creates', async () => {
    const { api, chopsticks } = createFakeChain({ fellowshipReferendumInfo: { 612: APPROVED } });
    vi.mocked(api.query.FellowshipReferenda.ReferendumCount.getValue)
      .mockResolvedValueOnce(612)
      .mockResolvedValueOnce(613);
    vi.mocked(api.txFromCallData).mockResolvedValue({
      create: vi.fn(async () => new Uint8Array([0x01])),
      decodedCall: { type: 'FellowshipReferenda', value: { type: 'submit' } },
      getEncodedData: vi.fn(),
    });

    const result = await simulateReferendum(
      {
        target: { api, manager: chopsticks },
        source: { kind: 'create', submitCall: '0xaabb' },
        kind: FELLOWSHIP,
      },
      createTestLogger()
    );

    expect(api.txFromCallData).toHaveBeenCalledWith(new Uint8Array([0xaa, 0xbb]));
    expect(
      result.referendumId,
      'the new referendum takes the referendum count before the submission as its index'
    ).toBe(612);
  });
});
