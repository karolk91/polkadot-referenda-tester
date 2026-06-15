import { describe, expect, it, vi } from 'vitest';
import {
  type BridgeChain,
  BridgeConnector,
  type BridgeKusamaSide,
  type BridgePolkadotSide,
  collectOutboundXcmIds,
} from '../services/bridge-connector';
import type { SubstrateApi } from '../types/substrate-api';
import type { Logger } from '../utils/logger';

function createSilentLogger() {
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

type RawEvent = { section: string; method: string; data: unknown };

/**
 * A fan-out target whose blocks emit a scripted batch of events per round. `eventsPerRound[i]`
 * is the delta of events surfaced by the i-th `newBlock()` (the connector accumulates them).
 * `newBlock` is a spy so tests can assert how many blocks were built.
 */
function makeFanoutChain(label: string, eventsPerRound: RawEvent[][]): BridgeChain {
  let round = 0;
  const getValue = vi.fn().mockImplementation(async () => {
    const evs = eventsPerRound[round] ?? [];
    round += 1;
    return evs;
  });
  const newBlock = vi.fn().mockResolvedValue(undefined);
  return {
    label,
    api: {
      query: { System: { Events: { getValue } } },
    } as unknown as SubstrateApi,
    manager: { newBlock } as unknown as BridgeChain['manager'],
    client: {} as unknown as BridgeChain['client'],
  };
}

function processed(id: string): RawEvent {
  return { section: 'MessageQueue', method: 'Processed', data: { id, success: true } };
}

/** settleDownstream only needs collectedEvents + advanceAndCollect; the sides can be stubs. */
function makeConnector(logger: Logger): BridgeConnector {
  return new BridgeConnector(
    logger,
    {} as unknown as BridgePolkadotSide,
    {} as unknown as BridgeKusamaSide,
    { maxRounds: 8 }
  );
}

const EXPECTED = '0xabc123';

describe('collectOutboundXcmIds', () => {
  it('extracts message_id from PolkadotXcm.Sent', () => {
    const ids = collectOutboundXcmIds([
      { section: 'PolkadotXcm', method: 'Sent', data: { message_id: '0xAAA' } },
    ]);
    expect(ids.has('0xaaa')).toBe(true); // lowercased
  });

  it('extracts message_hash from UpwardMessageSent and XcmpMessageSent', () => {
    const ids = collectOutboundXcmIds([
      { section: 'ParachainSystem', method: 'UpwardMessageSent', data: { message_hash: '0xUMP' } },
      { section: 'XcmpQueue', method: 'XcmpMessageSent', data: { message_hash: '0xHRMP' } },
    ]);
    expect(ids.has('0xump')).toBe(true);
    expect(ids.has('0xhrmp')).toBe(true);
  });

  it('collects both topic id and blob hash for the same destination (belt-and-suspenders)', () => {
    // A single UMP destination surfaces a topic via PolkadotXcm.Sent AND a blob hash via
    // UpwardMessageSent; we accept either so matching is robust to the runtime's convention.
    const ids = collectOutboundXcmIds([
      { section: 'PolkadotXcm', method: 'Sent', data: { message_id: '0xtopic' } },
      { section: 'ParachainSystem', method: 'UpwardMessageSent', data: { message_hash: '0xblob' } },
    ]);
    expect([...ids].sort()).toEqual(['0xblob', '0xtopic']);
  });

  it('ignores unrelated events and missing identifier fields', () => {
    const ids = collectOutboundXcmIds([
      { section: 'System', method: 'UpgradeAuthorized', data: { code_hash: '0xdead' } },
      { section: 'PolkadotXcm', method: 'Sent', data: {} }, // no message_id
      { section: 'Balances', method: 'Transfer', data: { amount: 1 } },
    ]);
    expect(ids.size).toBe(0);
  });
});

describe('BridgeConnector.settleDownstream', () => {
  it('matches a chain once it processes an expected message, recording the round', async () => {
    const connector = makeConnector(createSilentLogger());
    // Empty in round 1, the expected Processed event arrives in round 2 (delivery lag).
    const chain = makeFanoutChain('relay', [[], [processed(EXPECTED)]]);

    const results = await connector.settleDownstream([chain], new Set([EXPECTED]), { settleMs: 0 });

    expect(results.get('relay')).toEqual({ matched: true, rounds: 2 });
  });

  it('matches case-insensitively and on a blob-hash-keyed id', async () => {
    const connector = makeConnector(createSilentLogger());
    // The expected set holds a lowercase hash; the Processed event reports it upper-cased.
    const chain = makeFanoutChain('bridge-hub', [[processed('0xDEADBEEF')]]);

    const results = await connector.settleDownstream([chain], new Set(['0xdeadbeef']), {
      settleMs: 0,
    });

    expect(results.get('bridge-hub')?.matched).toBe(true);
  });

  it('reports an honest timeout when the expected message never processes', async () => {
    const connector = makeConnector(createSilentLogger());
    // Always empty: the message is never delivered/processed within the cap.
    const chain = makeFanoutChain('stuck', [[], [], []]);

    const results = await connector.settleDownstream([chain], new Set([EXPECTED]), {
      maxRounds: 3,
      settleMs: 0,
    });

    expect(results.get('stuck')).toEqual({ matched: false, rounds: 3 });
    expect(chain.manager.newBlock).toHaveBeenCalledTimes(3);
  });

  it('does not count an unrelated processed message as a match', async () => {
    const connector = makeConnector(createSilentLogger());
    // Processes a DIFFERENT message every round — the stale-count trap the old code fell into.
    const chain = makeFanoutChain('relay', [[processed('0xother1')], [processed('0xother2')]]);

    const results = await connector.settleDownstream([chain], new Set([EXPECTED]), {
      maxRounds: 2,
      settleMs: 0,
    });

    expect(results.get('relay')?.matched).toBe(false);
  });

  it('settles chains independently and stops early once all have matched', async () => {
    const connector = makeConnector(createSilentLogger());
    const fast = makeFanoutChain('fast', [[processed(EXPECTED)]]); // round 1
    const slow = makeFanoutChain('slow', [[], [], [processed(EXPECTED)]]); // round 3

    const results = await connector.settleDownstream([fast, slow], new Set([EXPECTED]), {
      maxRounds: 8,
      settleMs: 0,
    });

    expect(results.get('fast')).toEqual({ matched: true, rounds: 1 });
    expect(results.get('slow')).toEqual({ matched: true, rounds: 3 });
    // fast matched in round 1, so it is not advanced again; slow takes 3 blocks.
    expect(fast.manager.newBlock).toHaveBeenCalledTimes(1);
    expect(slow.manager.newBlock).toHaveBeenCalledTimes(3);
  });

  it('falls back to a fixed advance (all unmatched) when there are no expected ids', async () => {
    const connector = makeConnector(createSilentLogger());
    const chain = makeFanoutChain('relay', [[], [], [], []]);

    const results = await connector.settleDownstream([chain], new Set(), { settleMs: 0 });

    expect(results.get('relay')).toEqual({ matched: false, rounds: 0 });
    // Fallback advances min(3, maxRounds) blocks so any queued work still gets processed.
    expect(chain.manager.newBlock).toHaveBeenCalledTimes(3);
  });

  it('returns an empty result map for no chains', async () => {
    const connector = makeConnector(createSilentLogger());
    const results = await connector.settleDownstream([], new Set([EXPECTED]), { settleMs: 0 });
    expect(results.size).toBe(0);
  });
});
