import { describe, expect, it, vi } from 'vitest';
import type {
  BridgeChain,
  BridgeKusamaSide,
  BridgePolkadotSide,
} from '../services/bridge-connector';
import { BridgeVerifier } from '../services/bridge-verifier';
import type { SubstrateApi } from '../types/substrate-api';
import type { ParsedEvent } from '../utils/event-serializer';
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

// Verifier no longer scans chain state — it consumes a pre-collected event map.
// `makeChain` only needs to expose System.Number for the block-number log line.
function makeChain(label: string, blockNumber: number): BridgeChain {
  const api = {
    query: {
      System: {
        Number: { getValue: vi.fn().mockResolvedValue(blockNumber) },
      },
    },
  } as unknown as SubstrateApi;
  return {
    label,
    api,
    manager: {} as unknown as BridgeChain['manager'],
    client: {} as unknown as BridgeChain['client'],
  };
}

function collected(...entries: Array<[string, ParsedEvent[]]>): Map<string, ParsedEvent[]> {
  return new Map(entries);
}

const HAPPY_BHP_EVENTS: ParsedEvent[] = [
  {
    section: 'BridgeKusamaMessages',
    method: 'MessageAccepted',
    data: { lane: '0x00000000', nonce: 1 },
  },
];
const HAPPY_BHK_EVENTS: ParsedEvent[] = [
  { section: 'BridgePolkadotMessages', method: 'MessagesReceived', data: {} },
  { section: 'XcmpQueue', method: 'XcmpMessageSent', data: {} },
  { section: 'System', method: 'ExtrinsicSuccess', data: {} },
];
const HAPPY_AHK_EVENTS: ParsedEvent[] = [
  { section: 'MessageQueue', method: 'Processed', data: { success: true, weight_used: {} } },
];

const polkadot = {
  collectives: makeChain('Collectives', 1),
  ahp: makeChain('AHP', 1),
  bhp: makeChain('BHP', 5),
} as unknown as BridgePolkadotSide;
const kusama = {
  ahk: makeChain('AHK', 3),
  bhk: makeChain('BHK', 4),
} as unknown as BridgeKusamaSide;

describe('BridgeVerifier', () => {
  it('passes when all happy-path markers fire on BHP/BHK/AHK', async () => {
    const v = new BridgeVerifier(createSilentLogger(), { printEvents: false });
    const result = await v.verify(
      polkadot,
      kusama,
      collected(['BHP', HAPPY_BHP_EVENTS], ['BHK', HAPPY_BHK_EVENTS], ['AHK', HAPPY_AHK_EVENTS])
    );

    expect(result.overallPass).toBe(true);
    expect(result.failureReasons).toEqual([]);
    expect(result.bhp.markers.messageAccepted).toBe(1);
    expect(result.bhk?.markers.messagesReceived).toBe(1);
    expect(result.bhk?.markers.xcmpMessageSent).toBe(1);
    expect(result.ahk.markers.messageQueueProcessedSuccess).toBe(1);
    expect(result.ahk.markers.messageQueueProcessedFailure).toBe(0);
  });

  it('fails when AHK MessageQueue.Processed reports success:false', async () => {
    const v = new BridgeVerifier(createSilentLogger(), { printEvents: false });
    const failedAhk: ParsedEvent[] = [
      { section: 'MessageQueue', method: 'Processed', data: { success: false } },
    ];
    const result = await v.verify(
      polkadot,
      kusama,
      collected(['BHP', HAPPY_BHP_EVENTS], ['BHK', HAPPY_BHK_EVENTS], ['AHK', failedAhk])
    );

    expect(result.overallPass).toBe(false);
    expect(result.failureReasons.join('\n')).toMatch(/success:false/i);
  });

  it('fails when BHK does not emit MessagesReceived', async () => {
    const v = new BridgeVerifier(createSilentLogger(), { printEvents: false });
    const result = await v.verify(
      polkadot,
      kusama,
      collected(['BHP', HAPPY_BHP_EVENTS], ['BHK', []], ['AHK', HAPPY_AHK_EVENTS])
    );

    expect(result.overallPass).toBe(false);
    expect(result.failureReasons.join('\n')).toMatch(/MessagesReceived/);
  });

  it('fails when BHK has an ExtrinsicFailed (extrinsic dispatch failed)', async () => {
    const v = new BridgeVerifier(createSilentLogger(), { printEvents: false });
    const failedBhk: ParsedEvent[] = [
      { section: 'BridgePolkadotMessages', method: 'MessagesReceived', data: {} },
      { section: 'System', method: 'ExtrinsicFailed', data: { error: 'BadProof' } },
    ];
    const result = await v.verify(
      polkadot,
      kusama,
      collected(['BHP', HAPPY_BHP_EVENTS], ['BHK', failedBhk], ['AHK', HAPPY_AHK_EVENTS])
    );

    expect(result.overallPass).toBe(false);
    expect(result.failureReasons.join('\n')).toMatch(/ExtrinsicFailed/);
  });

  it('fails when BHP did not emit MessageAccepted (no outbound bridge message)', async () => {
    const v = new BridgeVerifier(createSilentLogger(), { printEvents: false });
    const result = await v.verify(
      polkadot,
      kusama,
      collected(['BHP', []], ['BHK', HAPPY_BHK_EVENTS], ['AHK', HAPPY_AHK_EVENTS])
    );

    expect(result.overallPass).toBe(false);
    expect(result.failureReasons.join('\n')).toMatch(/MessageAccepted/);
  });

  it('handles the success-nested-under-value shape on the Processed event', async () => {
    const v = new BridgeVerifier(createSilentLogger(), { printEvents: false });
    const altAhk: ParsedEvent[] = [
      // Some polkadot-api decodes wrap event data in `{ type, value: { success: true, ... } }`.
      { section: 'MessageQueue', method: 'Processed', data: { value: { success: true } } },
    ];
    const result = await v.verify(
      polkadot,
      kusama,
      collected(['BHP', HAPPY_BHP_EVENTS], ['BHK', HAPPY_BHK_EVENTS], ['AHK', altAhk])
    );

    expect(result.overallPass).toBe(true);
    expect(result.ahk.markers.messageQueueProcessedSuccess).toBe(1);
  });

  it('omits BHK probe when bhk is absent from topology', async () => {
    const v = new BridgeVerifier(createSilentLogger(), { printEvents: false });
    const kusamaNoBhk = {
      ahk: makeChain('AHK', 3),
    } as unknown as BridgeKusamaSide;
    const result = await v.verify(
      polkadot,
      kusamaNoBhk,
      collected(['BHP', HAPPY_BHP_EVENTS], ['AHK', HAPPY_AHK_EVENTS])
    );

    expect(result.bhk).toBeUndefined();
    expect(result.bhp.markers.messageAccepted).toBe(1);
    expect(result.ahk.markers.messageQueueProcessedSuccess).toBe(1);
    expect(result.overallPass).toBe(true);
  });

  it('honors custom pallet names', async () => {
    const v = new BridgeVerifier(createSilentLogger(), {
      printEvents: false,
      outboundPalletName: 'CustomOutboundPallet',
      destMessagesPalletName: 'CustomDestPallet',
    });
    const bhpEvents: ParsedEvent[] = [
      { section: 'CustomOutboundPallet', method: 'MessageAccepted', data: {} },
    ];
    const bhkEvents: ParsedEvent[] = [
      { section: 'CustomDestPallet', method: 'MessagesReceived', data: {} },
    ];
    const result = await v.verify(
      polkadot,
      kusama,
      collected(['BHP', bhpEvents], ['BHK', bhkEvents], ['AHK', HAPPY_AHK_EVENTS])
    );

    expect(result.overallPass).toBe(true);
    expect(result.bhp.markers.messageAccepted).toBe(1);
    expect(result.bhk?.markers.messagesReceived).toBe(1);
  });
});
