import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgePump } from '../bridge/bridge-pump';
import { ForkEventLog } from '../bridge/fork-event-log';
import type { Fork } from '../network/fork';
import { createTestLogger } from './helpers';

vi.mock('../utils/bridge-payload', () => ({
  buildBridgePayloadCodec: () => ({ decode: () => ({ universalDest: {}, message: {} }) }),
}));

const LANE = '0x00000001';

function fakeFork(label: string, query: Record<string, unknown> = {}): Fork {
  return {
    manager: { newBlock: vi.fn(async () => {}) },
    client: { _request: vi.fn(async () => '0x') },
    api: { query: { System: { Events: { getValue: vi.fn(async () => []) } }, ...query } },
    info: { label },
  } as unknown as Fork;
}

function bridgeHubWithGeneratedNonces(nonces: number[]): Fork {
  let round = 0;
  return fakeFork('bridge-hub-polkadot', {
    BridgeKusamaMessages: {
      OutboundLanes: {
        getEntries: vi.fn(async () => {
          const generated = nonces[Math.min(round, nonces.length - 1)];
          round++;
          return [
            {
              keyArgs: [LANE],
              value: { latest_generated_nonce: BigInt(generated), latest_received_nonce: 0n },
            },
          ];
        }),
      },
      OutboundMessages: { getValue: vi.fn(async () => new Uint8Array([1, 2, 3])) },
    },
  });
}

async function pumpReport(bridgeHub: Fork, maxRounds: number) {
  const logger = createTestLogger();
  const pump = await BridgePump.create(
    logger,
    {
      collectives: fakeFork('collectives-polkadot'),
      assetHub: fakeFork('asset-hub-polkadot'),
      bridgeHub,
      additional: [],
    },
    {
      assetHub: fakeFork('asset-hub-kusama'),
      bridgeHub: fakeFork('bridge-hub-kusama'),
      additional: [],
    },
    maxRounds
  );
  const report = pump.pumpUntilQuiet(new ForkEventLog());
  await vi.runAllTimersAsync();
  return report;
}

describe('BridgePump.pumpUntilQuiet', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('each outbound message counted once, stop after two rounds without a new message', async () => {
    const bridgeHub = bridgeHubWithGeneratedNonces([2, 2, 2, 2]);

    expect(
      await pumpReport(bridgeHub, 8),
      'a message stays in OutboundMessages until confirmed, so later rounds see it again'
    ).toEqual({ messageCount: 2, laneCount: 1, rounds: 3 });
  });

  it('stop at the maximum rounds while new messages keep arriving', async () => {
    const bridgeHub = bridgeHubWithGeneratedNonces([1, 2, 3, 4, 5, 6]);

    expect(
      await pumpReport(bridgeHub, 4),
      'the report gives the rounds the pump built, not one more'
    ).toEqual({ messageCount: 4, laneCount: 1, rounds: 4 });
  });
});
