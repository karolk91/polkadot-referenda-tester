import type { Binary } from '@polkadot-api/substrate-bindings';
import type { PolkadotSigner } from 'polkadot-api';

// --- Storage entry types (mirrors polkadot-api's unsafe API shapes) ---

interface StorageValue<T> {
  getValue(...args: unknown[]): Promise<T>;
}

interface StorageMap<K, V> {
  getValue(key: K, ...args: unknown[]): Promise<V | undefined>;
}

interface StorageEntries<K, V> {
  getValue(key: K, ...args: unknown[]): Promise<V | undefined>;
  getEntries(...args: unknown[]): Promise<Array<{ keyArgs: unknown[]; value: V }>>;
}

// --- Referendum types ---

export interface ReferendumOngoing {
  track: number;
  origin: unknown;
  proposal: ScheduledCall;
  enactment: unknown;
  submitted: number;
  submission_deposit: { who: string; amount: bigint } | undefined;
  decision_deposit: { who: string; amount: bigint } | undefined;
  deciding: { since: number; confirming: number | undefined } | undefined;
  tally: GovernanceTally | FellowshipTally;
  in_queue: boolean;
  alarm: [number, [number, number]] | undefined;
}

export interface GovernanceTally {
  ayes: bigint;
  nays: bigint;
  support: bigint;
}

export interface FellowshipTally {
  bare_ayes: bigint;
  ayes: bigint;
  nays: bigint;
}

export interface ReferendumInfo {
  type: string;
  value: ReferendumOngoing | unknown;
}

// --- Scheduler types ---

export type ScheduledCall = {
  type: string;
  value: unknown;
};

export interface ScheduledEntry {
  call: ScheduledCall;
  maybeId: Uint8Array | undefined;
  origin: unknown;
  priority?: number;
  maybePeriodic?: unknown;
  [key: string]: unknown;
}

// --- Transaction type (returned by txFromCallData) ---

export interface DecodedTransaction {
  sign(from: PolkadotSigner, ...args: unknown[]): Promise<string>;
  decodedCall: { type: string; value: { type: string; value?: { index?: number } } };
  getEncodedData(): Binary;
}

// --- Runtime version ---

export interface RuntimeVersion {
  spec_name?: string;
  specName?: string;
  spec_version?: number;
  [key: string]: unknown;
}

// --- Track info: [trackId, { name, ... }] ---

export type TrackInfo = [number, { name: string; [key: string]: unknown }];

// --- Referenda pallet interface (shared by Referenda + FellowshipReferenda) ---

export interface ReferendaPallet {
  ReferendumInfoFor: StorageMap<number, ReferendumInfo>;
  ReferendumCount: StorageValue<number>;
}

// --- System event (kept loose — parsed via parseBlockEvent()) ---

export interface SystemEvent {
  type: string;
  value: unknown;
  [key: string]: unknown;
}

// --- The main API interface ---

export interface SubstrateApi {
  query: {
    System: {
      Number: StorageValue<number>;
      Events: StorageValue<SystemEvent[]>;
    };
    Referenda: ReferendaPallet;
    FellowshipReferenda: ReferendaPallet;
    Scheduler: {
      Agenda: StorageEntries<number, ScheduledEntry[]>;
      Lookup: StorageMap<Uint8Array, [number, number]>;
    };
    Balances: {
      TotalIssuance: StorageValue<bigint>;
    };
    ParachainSystem?: {
      LastRelayChainBlockNumber: StorageValue<number>;
    };
  };
  constants: {
    System: {
      Version(): Promise<RuntimeVersion>;
    };
    Referenda: {
      Tracks(): Promise<TrackInfo[]>;
    };
    FellowshipReferenda: {
      Tracks(): Promise<TrackInfo[]>;
    };
  };
  txFromCallData(callData: Binary): Promise<DecodedTransaction>;
}
