import { describe, expect, it, vi } from 'vitest';
import { ForkEventLog } from '../bridge/fork-event-log';
import { outboundXcmIds, processDownstreamMessages } from '../bridge/xcm-delivery';
import type { Fork } from '../network/fork';
import type { EventRecord } from '../types/substrate-api';
import type { ParsedEvent } from '../utils/events';
import { eventRecord } from './helpers';

function scriptedFork(label: string, eventsPerBlock: EventRecord[][]): Fork {
  let blockCount = 0;
  return {
    manager: {
      newBlock: vi.fn(async () => {
        blockCount++;
      }),
    },
    api: {
      query: {
        System: { Events: { getValue: vi.fn(async () => eventsPerBlock[blockCount - 1] ?? []) } },
      },
    },
    info: { label },
  } as unknown as Fork;
}

function processed(id: string): EventRecord {
  return eventRecord('MessageQueue', 'Processed', { id, success: true });
}

function event(section: string, method: string, data: unknown): ParsedEvent {
  return { section, method, data };
}

const MESSAGE_ID = '0xabc123';
const NO_DELAY = { roundDelayMs: 0 };

describe('outboundXcmIds', () => {
  it('lowercase message_id of PolkadotXcm.Sent and message_hash of UMP and XCMP events', () => {
    const ids = outboundXcmIds([
      event('PolkadotXcm', 'Sent', { message_id: '0xTOPIC' }),
      event('ParachainSystem', 'UpwardMessageSent', { message_hash: '0xUMP' }),
      event('XcmpQueue', 'XcmpMessageSent', { message_hash: '0xHRMP' }),
    ]);

    expect(
      [...ids].sort(),
      'a destination reports either the topic id or the blob hash in MessageQueue.Processed'
    ).toEqual(['0xhrmp', '0xtopic', '0xump']);
  });

  it('no id from unrelated events or events without an id field', () => {
    const ids = outboundXcmIds([
      event('System', 'UpgradeAuthorized', { code_hash: '0xdead' }),
      event('PolkadotXcm', 'Sent', {}),
      event('Balances', 'Transfer', { amount: 1 }),
    ]);

    expect(ids.size).toBe(0);
  });
});

describe('processDownstreamMessages', () => {
  it('processed delivery with the round of the first matching MessageQueue.Processed', async () => {
    const relay = scriptedFork('relay', [[], [processed(MESSAGE_ID)]]);

    const deliveries = await processDownstreamMessages(
      [relay],
      new Set([MESSAGE_ID]),
      new ForkEventLog(),
      { maxRounds: 8, ...NO_DELAY }
    );

    expect(deliveries.get(relay)).toEqual({ kind: 'processed', rounds: 2 });
  });

  it('case-insensitive id match', async () => {
    const bridgeHub = scriptedFork('bridge-hub', [[processed('0xDEADBEEF')]]);

    const deliveries = await processDownstreamMessages(
      [bridgeHub],
      new Set(['0xdeadbeef']),
      new ForkEventLog(),
      { maxRounds: 8, ...NO_DELAY }
    );

    expect(deliveries.get(bridgeHub)?.kind).toBe('processed');
  });

  it('timeout after the maximum rounds for unrelated processed messages', async () => {
    const relay = scriptedFork('relay', [[processed('0xother1')], [processed('0xother2')], []]);

    const deliveries = await processDownstreamMessages(
      [relay],
      new Set([MESSAGE_ID]),
      new ForkEventLog(),
      { maxRounds: 3, ...NO_DELAY }
    );

    expect(
      deliveries.get(relay),
      'a message from another sender must not count as delivery of the referendum XCM'
    ).toEqual({ kind: 'timeout', rounds: 3 });
    expect(relay.manager.newBlock).toHaveBeenCalledTimes(3);
  });

  it('no more blocks on a fork after its delivery', async () => {
    const fast = scriptedFork('fast', [[processed(MESSAGE_ID)]]);
    const slow = scriptedFork('slow', [[], [], [processed(MESSAGE_ID)]]);

    const deliveries = await processDownstreamMessages(
      [fast, slow],
      new Set([MESSAGE_ID]),
      new ForkEventLog(),
      { maxRounds: 8, ...NO_DELAY }
    );

    expect(deliveries.get(fast)).toEqual({ kind: 'processed', rounds: 1 });
    expect(deliveries.get(slow)).toEqual({ kind: 'processed', rounds: 3 });
    expect(
      vi.mocked(fast.manager.newBlock),
      'each extra block build costs seconds of run time'
    ).toHaveBeenCalledTimes(1);
    expect(slow.manager.newBlock).toHaveBeenCalledTimes(3);
  });
});
