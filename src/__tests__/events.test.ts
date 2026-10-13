import { describe, expect, it, vi } from 'vitest';
import { blockEvents } from '../utils/events';
import { stringify } from '../utils/json';
import { createFakeChain, eventRecord } from './helpers';

describe('blockEvents', () => {
  it('pallet, event name and fields of each event record', async () => {
    const { api } = createFakeChain();
    vi.mocked(api.query.System.Events.getValue).mockResolvedValue([
      eventRecord('Scheduler', 'Dispatched', { task: [5, 0], id: undefined }),
      eventRecord('System', 'ExtrinsicSuccess', { dispatch_info: {} }),
    ]);

    expect(await blockEvents(api)).toEqual([
      { section: 'Scheduler', method: 'Dispatched', data: { task: [5, 0], id: undefined } },
      { section: 'System', method: 'ExtrinsicSuccess', data: { dispatch_info: {} } },
    ]);
  });
});

describe('stringify', () => {
  it('bytes as hex and big integers as decimal strings', () => {
    expect(
      stringify({ call: new Uint8Array([0x00, 0x07]), amount: 10n ** 20n }),
      'verbose event output contains call bytes and balances above 2^53'
    ).toBe('{"call":"0x0007","amount":"100000000000000000000"}');
  });
});
