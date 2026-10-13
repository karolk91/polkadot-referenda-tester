import { describe, expect, it, vi } from 'vitest';
import type { BridgeKusamaSide, BridgePolkadotSide } from '../bridge/bridge-pump';
import { verifyBridgeDelivery } from '../bridge/bridge-verifier';
import { ForkEventLog } from '../bridge/fork-event-log';
import type { Fork } from '../network/fork';
import type { EventRecord } from '../types/substrate-api';
import { createTestLogger, eventRecord } from './helpers';

function fakeFork(label: string): Fork {
  return {
    manager: { newBlock: vi.fn(async () => {}) },
    api: { query: { System: { Number: { getValue: vi.fn(async () => 5) }, Events: {} } } },
    info: { label },
  } as unknown as Fork;
}

const polkadot: BridgePolkadotSide = {
  collectives: fakeFork('collectives-polkadot'),
  assetHub: fakeFork('asset-hub-polkadot'),
  bridgeHub: fakeFork('bridge-hub-polkadot'),
  additional: [],
};
const kusama: BridgeKusamaSide = {
  assetHub: fakeFork('asset-hub-kusama'),
  bridgeHub: fakeFork('bridge-hub-kusama'),
  additional: [],
};

const ACCEPTED = [eventRecord('BridgeKusamaMessages', 'MessageAccepted', { nonce: 1 })];
const RECEIVED = [
  eventRecord('BridgePolkadotMessages', 'MessagesReceived', {}),
  eventRecord('XcmpQueue', 'XcmpMessageSent', { message_hash: '0x01' }),
];
const PROCESSED = [
  eventRecord('MessageQueue', 'Processed', { id: '0x01', success: true }),
  eventRecord('Whitelist', 'CallWhitelisted', { call_hash: '0x02' }),
];

interface DeliveryEvents {
  polkadotBridgeHub?: EventRecord[];
  kusamaBridgeHub?: EventRecord[];
  kusamaAssetHub?: EventRecord[];
}

async function verify(events: DeliveryEvents) {
  const logger = createTestLogger();
  const log = new ForkEventLog();
  const forkEvents: Array<[Fork, EventRecord[]]> = [
    [polkadot.bridgeHub, events.polkadotBridgeHub ?? ACCEPTED],
    [kusama.bridgeHub, events.kusamaBridgeHub ?? RECEIVED],
    [kusama.assetHub, events.kusamaAssetHub ?? PROCESSED],
  ];
  for (const [fork, records] of forkEvents) {
    fork.api.query.System.Events.getValue = vi.fn(async () => records);
    await log.advance(fork);
  }
  const failures = await verifyBridgeDelivery(polkadot, kusama, log, logger);
  return { failures, logger };
}

describe('verifyBridgeDelivery', () => {
  it('no failure for a delivery with every marker event', async () => {
    const { failures, logger } = await verify({});

    expect(failures).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('failure for each missing or failed delivery stage', async () => {
    const cases: Array<[DeliveryEvents, RegExp]> = [
      [{ polkadotBridgeHub: [] }, /bridge-hub-polkadot: .*MessageAccepted/],
      [{ kusamaBridgeHub: [] }, /bridge-hub-kusama: .*MessagesReceived/],
      [
        {
          kusamaBridgeHub: [...RECEIVED, eventRecord('System', 'ExtrinsicFailed', {})],
        },
        /bridge-hub-kusama: 1 ExtrinsicFailed/,
      ],
      [
        { kusamaAssetHub: [eventRecord('MessageQueue', 'Processed', { success: false })] },
        /asset-hub-kusama: 1 MessageQueue.Processed\{success:false\}/,
      ],
    ];
    for (const [events, failure] of cases) {
      const { failures } = await verify(events);
      expect(
        failures.join('\n'),
        'a bridged referendum without a delivery is a failed test'
      ).toMatch(failure);
    }
  });

  it('warning without failure for an executed XCM without Whitelist.CallWhitelisted', async () => {
    const { failures, logger } = await verify({
      kusamaAssetHub: [eventRecord('MessageQueue', 'Processed', { id: '0x01', success: true })],
    });

    expect(failures).toEqual([]);
    expect(
      logger.warn,
      'a Transact can fail inside a successfully processed XCM message'
    ).toHaveBeenCalledWith(expect.stringContaining('No Whitelist.CallWhitelisted'));
  });
});
