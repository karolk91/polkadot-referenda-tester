import type { Enum, HexString, SS58String } from 'polkadot-api';
import type { TxCreator } from 'polkadot-api/tx-creator';

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

type WhoAmount = { who: SS58String; amount: bigint };

export interface ReferendumOngoing {
  track: number;
  origin: unknown;
  proposal: ScheduledCall;
  enactment: unknown;
  submitted: number;
  submission_deposit: WhoAmount | undefined;
  decision_deposit: WhoAmount | undefined;
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

export type RawReferendumInfo = Enum<{
  Ongoing: ReferendumOngoing;
  Approved: [number, WhoAmount | undefined, WhoAmount | undefined];
  Rejected: [number, WhoAmount | undefined, WhoAmount | undefined];
  Cancelled: [number, WhoAmount | undefined, WhoAmount | undefined];
  TimedOut: [number, WhoAmount | undefined, WhoAmount | undefined];
  Killed: number;
}>;

// --- Scheduler types ---

export type ScheduledCall = Enum<{
  Legacy: { hash: HexString };
  Inline: Uint8Array;
  Lookup: { hash: HexString; len: number };
}>;

export interface ScheduledEntry {
  maybe_id: HexString | undefined;
  priority: number;
  call: ScheduledCall;
  maybe_periodic: [number, number] | undefined;
  origin: unknown;
}

// --- Transaction type (returned by txFromCallData) ---

export interface DecodedTransaction {
  create(creator: TxCreator, ...args: unknown[]): Promise<Uint8Array>;
  decodedCall: { type: string; value: { type: string; value?: { index?: number } } };
  getEncodedData(): Promise<Uint8Array>;
}

// --- Runtime version ---

export interface RuntimeVersion {
  spec_name: string;
  spec_version: number;
}

// --- Referenda pallet interface (shared by Referenda + FellowshipReferenda) ---

export interface ReferendaPallet {
  ReferendumInfoFor: StorageEntries<number, RawReferendumInfo>;
  ReferendumCount: StorageValue<number>;
}

export interface EventRecord {
  phase: { type: string; value?: unknown };
  event: { type: string; value: { type: string; value?: unknown } };
  topics: unknown[];
}

// --- The main API interface ---

export interface SubstrateApi {
  query: {
    System: {
      Number: StorageValue<number>;
      Events: StorageValue<EventRecord[]>;
    };
    Referenda: ReferendaPallet;
    FellowshipReferenda: ReferendaPallet;
    Scheduler: {
      Agenda: StorageEntries<number, Array<ScheduledEntry | undefined>>;
      Lookup: StorageMap<HexString, [number, number]>;
      IncompleteSince: StorageValue<number | undefined>;
    };
    Balances: {
      TotalIssuance: StorageValue<bigint>;
    };
  };
  constants: {
    System: {
      Version(): Promise<RuntimeVersion>;
    };
  };
  tx: Record<
    string,
    Record<string, (args: Record<string, unknown>) => { getEncodedData(): Promise<Uint8Array> }>
  >;
  txFromCallData(callData: Uint8Array): Promise<DecodedTransaction>;
}
