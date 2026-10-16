import type { HexString } from 'polkadot-api';
import { vi } from 'vitest';
import { DEFAULT_BRIDGE_URLS, type TestOptions } from '../commands/test-options';
import type { ChainInfo, ChainKind } from '../network/chain-identity';
import type { ChopsticksManager } from '../network/chopsticks-manager';
import type { Fork } from '../network/fork';
import type { ReferendumStep } from '../types';
import type { EventRecord, ScheduledEntry, SubstrateApi } from '../types/substrate-api';
import type { Logger } from '../utils/logger';
import type { ChainNetwork } from '../utils/networks';

export function createTestLogger(): Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    section: vi.fn(),
    isVerbose: () => false,
    startSpinner: vi.fn(),
    succeedSpinner: vi.fn(),
    failSpinner: vi.fn(),
  } as unknown as Logger;
}

export function chainInfo(
  label: string,
  network: ChainNetwork,
  kind: ChainKind,
  endpoint = `wss://${label}`
): ChainInfo {
  return { label, specName: label, endpoint, network, kind };
}

export function testOptions(overrides: Partial<TestOptions> = {}): TestOptions {
  return {
    assetHubPolkadotUrl: DEFAULT_BRIDGE_URLS.assetHubPolkadot,
    bridgeHubPolkadotUrl: DEFAULT_BRIDGE_URLS.bridgeHubPolkadot,
    bridgeHubKusamaUrl: DEFAULT_BRIDGE_URLS.bridgeHubKusama,
    bridgePumpRounds: 8,
    cleanup: true,
    verbose: false,
    ...overrides,
  };
}

export function governanceStep(id: number, postTest?: string): ReferendumStep {
  return {
    referenda: { kind: 'governance', governance: { kind: 'existing', id } },
    ...(postTest && { postTest: { module: postTest } }),
  };
}

export function fellowshipStep(id: number): ReferendumStep {
  return { referenda: { kind: 'fellowship', fellowship: { kind: 'existing', id } } };
}

export interface FakeForkParts {
  newBlock?: () => Promise<void>;
  query?: Record<string, unknown>;
  client?: Record<string, unknown>;
}

export function fakeFork(label: string, parts: FakeForkParts = {}): Fork {
  return {
    manager: {
      newBlock: vi.fn(parts.newBlock ?? (async () => {})),
      context: { url: `ws://${label}`, chain: {} },
    },
    client: parts.client ?? {},
    api: {
      query: {
        System: {
          Number: { getValue: vi.fn(async () => 5) },
          Events: { getValue: vi.fn(async () => []) },
        },
        ...parts.query,
      },
    },
    info: chainInfo(label, 'polkadot', 'parachain'),
  } as unknown as Fork;
}

export const NUDGE_CALL = new Uint8Array([0x3e, 0x07]);

export function mockNudgeDecoder(
  api: SubstrateApi,
  palletName: string,
  referendumId: number
): void {
  vi.mocked(api.txFromCallData).mockImplementation(async (callData: Uint8Array) => ({
    decodedCall: {
      type: callData === NUDGE_CALL ? palletName : 'System',
      value: { type: 'nudge_referendum', value: { index: referendumId } },
    },
    create: vi.fn(),
    getEncodedData: vi.fn(),
  }));
}

export type Agenda = Array<ScheduledEntry | undefined>;

export interface FakeChainState {
  blockNumber?: number;
  incompleteSince?: number;
  agenda?: Record<number, Agenda>;
  lookup?: Record<HexString, [number, number]>;
  referendumInfo?: Record<number, unknown>;
  fellowshipReferendumInfo?: Record<number, unknown>;
}

export interface StorageWrite {
  pallet: string;
  item: string;
  key: unknown[];
  value: unknown;
}

function fixedSizeKey(key: unknown): HexString {
  if (typeof key !== 'string') {
    throw new Error(`SizedBytes key of type ${typeof key} instead of HexString`);
  }
  return key as HexString;
}

export function createFakeChain(state: FakeChainState = {}) {
  const agenda = state.agenda ?? {};
  const lookup = state.lookup ?? {};
  const writes: StorageWrite[] = [];

  const api = {
    query: {
      System: {
        Number: { getValue: vi.fn(async () => state.blockNumber ?? 1000) },
        Events: { getValue: vi.fn(async () => [] as unknown[]) },
      },
      Scheduler: {
        Agenda: {
          getValue: vi.fn(async (block: number) => agenda[block]),
          getEntries: vi.fn(async () =>
            Object.entries(agenda).map(([block, value]) => ({ keyArgs: [Number(block)], value }))
          ),
        },
        Lookup: {
          getValue: vi.fn(async (name: unknown) => lookup[fixedSizeKey(name)]),
        },
        IncompleteSince: { getValue: vi.fn(async () => state.incompleteSince) },
      },
      Balances: {
        TotalIssuance: { getValue: vi.fn(async () => 1_000_000n) },
      },
      Referenda: {
        ReferendumInfoFor: {
          getValue: vi.fn(async (id: number) => state.referendumInfo?.[id]),
        },
        ReferendumCount: { getValue: vi.fn(async () => 0) },
      },
      FellowshipReferenda: {
        ReferendumInfoFor: {
          getValue: vi.fn(async (id: number) => state.fellowshipReferendumInfo?.[id]),
        },
        ReferendumCount: { getValue: vi.fn(async () => 0) },
      },
    },
    txFromCallData: vi.fn(),
  } as unknown as SubstrateApi;

  const chopsticks = {
    newBlock: vi.fn(async () => {
      state.blockNumber = (state.blockNumber ?? 1000) + 1;
      if (state.incompleteSince !== undefined) state.incompleteSince += 1;
    }),
    setStorageBatch: vi.fn(async (updates: Record<string, Record<string, unknown[]>>) => {
      for (const [pallet, items] of Object.entries(updates)) {
        for (const [item, entries] of Object.entries(items)) {
          for (const [key, value] of entries as Array<[unknown[], unknown]>) {
            writes.push({ pallet, item, key, value });
          }
        }
      }
    }),
  } as unknown as ChopsticksManager;

  return { api, chopsticks, writes };
}

export function storageWrite(
  writes: StorageWrite[],
  pallet: string,
  item: string,
  key: unknown[]
): unknown {
  const write = writes.findLast(
    (candidate) =>
      candidate.pallet === pallet &&
      candidate.item === item &&
      JSON.stringify(candidate.key) === JSON.stringify(key)
  );
  if (!write) {
    throw new Error(`no ${pallet}.${item} write for key ${JSON.stringify(key)}`);
  }
  return write.value;
}

export function eventRecord(section: string, method: string, value: unknown): EventRecord {
  return {
    phase: { type: 'Initialization', value: undefined },
    event: { type: section, value: { type: method, value } },
    topics: [],
  };
}

export function scheduledTask(fields: Partial<ScheduledEntry> = {}): ScheduledEntry {
  return {
    maybe_id: undefined,
    priority: 63,
    call: { type: 'Inline', value: new Uint8Array([0x00, 0x00]) },
    maybe_periodic: undefined,
    origin: { type: 'system', value: { type: 'Root', value: undefined } },
    ...fields,
  };
}
