import { type BridgeHandle, connectBridgeHubs } from '@acala-network/chopsticks-testing';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { fromHex, toHex } from '@polkadot-api/utils';
import type { PolkadotClient } from 'polkadot-api';
import type { SubstrateApi } from '../types/substrate-api';
import {
  type BridgePayloadCodec,
  buildBridgePayloadCodec,
  type DecodedBridgeMessage,
} from '../utils/bridge-payload';
import { getBlockEvents, type ParsedEvent, serializeEventData } from '../utils/event-serializer';
import { stringify } from '../utils/json';
import type { Logger } from '../utils/logger';
import type { ChopsticksManager } from './chopsticks-manager';

/**
 * One Bridge Hub chain inside the test topology. Mirrors what `network-coordinator`
 * builds via `adoptBridgeChain`.
 */
export interface BridgeChain {
  manager: ChopsticksManager;
  api: SubstrateApi;
  /** polkadot-api client (used by other services for raw RPC calls / metadata). */
  client: PolkadotClient;
  /** Human-friendly label for log lines (e.g. "BridgeHubPolkadot"). */
  label: string;
}

export interface BridgePolkadotSide {
  collectives: BridgeChain;
  ahp: BridgeChain;
  bhp: BridgeChain;
  /**
   * Extra Polkadot-side chains from `--additional-chains` (relay + non-bridge system
   * parachains). The pump advances them each round so any UMP/DMP/HRMP addressed to
   * them is processed (and their events are collected) instead of queueing forever.
   */
  extras?: BridgeChain[];
}

export interface BridgeKusamaSide {
  ahk: BridgeChain;
  bhk?: BridgeChain;
  /** Extra Kusama-side chains from `--additional-chains`. See {@link BridgePolkadotSide.extras}. */
  extras?: BridgeChain[];
}

export interface BridgeConnectorOptions {
  /** Maximum pump rounds before giving up. Default 8. */
  maxRounds?: number;
  /**
   * After this many consecutive rounds with no new outbound messages, the connector
   * considers the bridge drained and returns. Default 2.
   */
  quietRounds?: number;
}

/**
 * One delivered/observed bridge message captured by the connector.
 */
export interface SeenBridgeMessage {
  /** SCALE-encoded lane id as hex (LegacyLaneId is `[u8; 4]`). */
  laneHex: string;
  nonce: bigint;
  rawPayloadHex: string;
  decoded?: DecodedBridgeMessage;
  /** Filled in when decoding throws (codec mismatch / wire-format drift). */
  decodeError?: string;
}

/**
 * Report returned by `pumpUntilQuiet`. The chopsticks bridge handle delivers messages
 * to BHK in the background while we drive Polkadot-side blocks, so every message counted
 * here (`totalSeen`, grouped in `byLane`) was both observed on BHP and delivered to BHK.
 */
export interface BridgePumpReport {
  totalSeen: number;
  rounds: number;
  byLane: Map<string, SeenBridgeMessage[]>;
}

/**
 * Per-chain outcome of {@link BridgeConnector.settleDownstream}. `matched` is true once
 * the chain has *processed* one of the fan-out's outbound messages (a `MessageQueue.Processed`
 * whose `id` is in the expected set) — the call-agnostic completion signal. `rounds` is how
 * many blocks we had to build before it matched (or the cap, if it never did).
 */
export interface DownstreamSettleResult {
  matched: boolean;
  rounds: number;
}

/**
 * Collect the identifiers of every outbound XCM in `events`, so the downstream settle can
 * wait for the matching inbound `MessageQueue.Processed` on each target. Gathers both
 * `message_id` topics (`PolkadotXcm.Sent`) and `message_hash` blob hashes
 * (`*.UpwardMessageSent` / `XcmpQueue.XcmpMessageSent`): a destination's
 * `MessageQueue.Processed.id` keys on the enqueued blob hash for some transports and on the
 * topic for others, so we accept either — whichever a given runtime uses, the id is in this
 * set. All ids are lowercased for case-insensitive matching.
 */
export function collectOutboundXcmIds(
  events: Array<{ section: string; method: string; data: unknown }>
): Set<string> {
  const ids = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0) ids.add(v.toLowerCase());
  };
  for (const e of events) {
    const data = serializeEventData(e.data) as { message_id?: unknown; message_hash?: unknown };
    if (e.section === 'PolkadotXcm' && e.method === 'Sent') add(data?.message_id);
    if (e.method === 'UpwardMessageSent' || e.method === 'XcmpMessageSent') add(data?.message_hash);
  }
  return ids;
}

const ALICE_DEFAULT_BALANCE = 1_000_000_000_000_000n;

/**
 * Drives a fellowship-style cross-bridge scenario: Polkadot side (Collectives → AHP →
 * BHP) emits an outbound bridge message via XCM; chopsticks's built-in
 * `connectBridgeHubs` relays it to BHK; BHK's `pallet_bridge_messages` dispatches the
 * carried XCM onward to AHK via XCMP.
 *
 * Replaces the previous ~750 LOC manual relayer (proof builder + receive_messages_proof
 * encoder + ParasInfo/ImportedParaHeads writer) with a thin orchestration layer over
 * chopsticks's `connectBridgeHubs` (chopsticks-testing >= the version with bridge
 * support).
 *
 * What this class still owns:
 *   - Pump cadence: advance Collectives → AHP → BHP, then build the BHK block that applies the
 *     pushed delivery, then AHK — each round until quiet. The event-driven connector builds NO
 *     blocks of its own; it only pushes proofs to the pools and reacts to the heads we produce.
 *   - Per-chain event collection for the verifier
 *   - Human-readable telemetry: decoding BHP's outbound bridge messages for logs
 *   - Funding Alice on BOTH hubs so the relayer can pay receive_messages_proof fees on BHK and
 *     receive_messages_delivery_proof fees on BHP
 *
 * What chopsticks now owns:
 *   - Subscribing to BHP + BHK heads, fetching state proofs, writing ImportedParaHeads, and
 *     pushing receive_messages_proof (to BHK) / receive_messages_delivery_proof (to BHP) into the
 *     pools — our blocks apply them
 */
export class BridgeConnector {
  private readonly logger: Logger;
  private readonly polkadot: BridgePolkadotSide;
  readonly kusama: BridgeKusamaSide;
  private readonly maxRounds: number;
  private readonly quietRounds: number;
  private payloadCodec: BridgePayloadCodec | null = null;

  /** Chopsticks bridge handle (subscribes to BHP outbound, delivers on BHK). */
  private bridgeHandle: BridgeHandle | null = null;
  /** polkadot.js APIs we constructed ourselves for connectBridgeHubs. */
  private bhpApi: ApiPromise | null = null;
  private bhkApi: ApiPromise | null = null;

  /** Map from lane key (hex) -> highest nonce already seen, so we don't re-log. */
  private readonly delivered = new Map<string, bigint>();
  /** Events collected per chain, populated as we build blocks. Consumed by the verifier. */
  private readonly collectedEvents = new Map<string, ParsedEvent[]>();

  constructor(
    logger: Logger,
    polkadot: BridgePolkadotSide,
    kusama: BridgeKusamaSide,
    options: BridgeConnectorOptions = {}
  ) {
    this.logger = logger;
    this.polkadot = polkadot;
    this.kusama = kusama;
    this.maxRounds = options.maxRounds ?? 8;
    this.quietRounds = options.quietRounds ?? 2;
  }

  /**
   * Idempotent one-time setup:
   *   1. Load BHP metadata for the payload codec (so we can decode + log bridge messages).
   *   2. If BHK is in the topology: fund Alice's BHK account, construct polkadot.js
   *      APIs for both bridge hubs, wire `connectBridgeHubs` to start the relay.
   */
  async setUp(): Promise<void> {
    if (this.payloadCodec === null) {
      this.logger.startSpinner('Loading Bridge Hub metadata for payload codec...');
      const rawMetadataHex = await this.polkadot.bhp.client._request<string, [number?]>(
        'state_getMetadata',
        []
      );
      this.payloadCodec = buildBridgePayloadCodec(rawMetadataHex);
      this.logger.succeedSpinner(
        `Bridge payload codec loaded from ${this.polkadot.bhp.label} metadata`
      );
    }

    if (!this.kusama.bhk) {
      this.logger.debug('BridgeConnector.setUp: BHK not in topology; running in observe-only mode');
      return;
    }

    if (this.bridgeHandle !== null) return; // already wired

    const alice = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');

    // Real Polkadot/Kusama bridge-hub forks don't have Alice funded by default. The relayer pays
    // receive_messages_proof fees on BHK (delivery) AND receive_messages_delivery_proof fees on BHP
    // (confirmation), so fund Alice on both hubs.
    const fundAlice = {
      System: {
        Account: [[[alice.address], { providers: 1, data: { free: ALICE_DEFAULT_BALANCE } }]],
      },
    };
    await Promise.all([
      this.kusama.bhk.manager.setStorageBatch(fundAlice),
      this.polkadot.bhp.manager.setStorageBatch(fundAlice),
    ]);

    // connectBridgeHubs expects polkadot.js ApiPromise instances. Construct them
    // against the chopsticks WS endpoints we already have.
    const bhpUrl = this.polkadot.bhp.manager.getContext().ws.endpoint;
    const bhkUrl = this.kusama.bhk.manager.getContext().ws.endpoint;
    this.logger.startSpinner('Connecting bridge relayer (Polkadot → Kusama)...');
    const [bhpApi, bhkApi] = await Promise.all([
      ApiPromise.create({ provider: new WsProvider(bhpUrl, 3_000), noInitWarn: true }),
      ApiPromise.create({ provider: new WsProvider(bhkUrl, 3_000), noInitWarn: true }),
    ]);
    this.bhpApi = bhpApi;
    this.bhkApi = bhkApi;
    this.bridgeHandle = await connectBridgeHubs(this.bhpApi, this.bhkApi, { signer: alice });
    this.logger.succeedSpinner(`Bridge relayer connected (signer=${alice.address})`);
  }

  /**
   * Drive Polkadot-side blocks until no new outbound bridge messages appear for
   * `quietRounds` consecutive rounds, or until `maxRounds` is reached. The chopsticks
   * bridge handle delivers messages to BHK asynchronously in the background.
   */
  async pumpUntilQuiet(): Promise<BridgePumpReport> {
    if (this.payloadCodec === null) await this.setUp();

    const byLane = new Map<string, SeenBridgeMessage[]>();
    let totalSeen = 0;
    let consecutiveQuiet = 0;
    let round = 0;

    for (; round < this.maxRounds; round++) {
      this.logger.debug(
        `Bridge pump round ${round + 1}/${this.maxRounds} (quiet streak ${consecutiveQuiet})`
      );

      // Polkadot side: produce the outbound bridge message (if any).
      await this.advanceAndCollect(this.polkadot.collectives);
      await this.advanceAndCollect(this.polkadot.ahp);
      await this.advanceAndCollect(this.polkadot.bhp);

      // Advance the Polkadot-side monitor chains (relay + extra parachains) so any
      // UMP/DMP/HRMP destined for them is delivered rather than left queued.
      for (const extra of this.polkadot.extras ?? []) {
        await this.advanceAndCollect(extra);
      }

      // Give the chopsticks bridge subscription a moment to react to the new BHP head: it pushes
      // receive_messages_proof into BHK's pool. The event-driven connector builds no blocks, so
      // nothing is applied yet — we build the BHK block ourselves next.
      await new Promise((r) => setTimeout(r, 500));

      // Kusama side: BUILD the BHK block that applies the pushed delivery, and collect its events
      // (MessagesReceived, RewardRegistered, and the XcmpQueue.XcmpMessageSent that routes to AHK).
      // Building this block also re-triggers the connector on the resulting BHK head, which pushes
      // the matching receive_messages_delivery_proof into BHP's pool (applied next round's BHP block).
      // If the push hasn't landed in BHK's pool yet, this block is empty and the next round delivers.
      if (this.kusama.bhk) await this.advanceAndCollect(this.kusama.bhk);

      // Build an AHK block so the auto-HRMP-routed inbound message is processed
      // (MessageQueue.Processed{success:true} fires here if the bridged Transact
      // succeeds).
      await this.advanceAndCollect(this.kusama.ahk);

      // Advance the Kusama-side monitor chains (relay + extra parachains) for the same
      // reason as the Polkadot side above.
      for (const extra of this.kusama.extras ?? []) {
        await this.advanceAndCollect(extra);
      }

      const newMessages = await this.collectNewOutbound();
      if (newMessages.length === 0) {
        if (++consecutiveQuiet >= this.quietRounds) {
          this.logger.debug(`Bridge pump quiesced after ${consecutiveQuiet} idle rounds`);
          break;
        }
        continue;
      }

      consecutiveQuiet = 0;
      totalSeen += newMessages.length;
      for (const msg of newMessages) {
        const list = byLane.get(msg.laneHex) ?? [];
        list.push(msg);
        byLane.set(msg.laneHex, list);
        this.logOne(msg);
      }
    }

    return { totalSeen, rounds: round + 1, byLane };
  }

  /** Per-chain ParsedEvent log accumulated across every block the connector built. */
  getCollectedEvents(): Map<string, ParsedEvent[]> {
    return this.collectedEvents;
  }

  /**
   * Build a few blocks on each given chain so any queued inbound XCM is delivered and
   * processed, collecting the resulting events. Used after the second-half AHK public
   * referendum dispatches its `authorize_upgrade` fan-out: chopsticks-testing's
   * `connectParachains`/`connectVertical` wiring puts the HRMP/UMP messages on each
   * target's inbound queue when AHK builds its dispatch block, but those targets only
   * *process* them (emitting `MessageQueue.Processed` + `System.UpgradeAuthorized`) when
   * a block is built on them — which nothing else does outside the bridge pump.
   *
   * The 500ms settle between rounds mirrors `pumpUntilQuiet`, giving the cross-chain
   * subscriptions time to deliver before the next round builds the processing block.
   *
   * Rather than advancing a fixed number of rounds and hoping (which raced: a target's
   * `MessageQueue.Processed` could land one block past the window, yielding a false
   * "no event"), this waits per chain until that chain *processes one of the fan-out's
   * own messages*. `expectedMessageIds` is the set of outbound XCM identifiers the source
   * emitted (both `message_id` topics and `message_hash` blob hashes — see
   * `collectOutboundXcmIds` on the coordinator); a chain is settled once it emits a
   * `MessageQueue.Processed` whose `id` is in that set. This is call-agnostic: it keys on
   * delivery+processing of the dispatched message, not on what the message happened to do
   * (upgrade, spend, config, …). Chains that never match within `maxRounds` are reported
   * as such (an honest timeout) instead of silently passing.
   *
   * If `expectedMessageIds` is empty (the dispatched call emitted no identifiable XCM),
   * falls back to the previous fixed-round advance so callers keep working.
   */
  async settleDownstream(
    chains: BridgeChain[],
    expectedMessageIds: Set<string>,
    opts: { maxRounds?: number; settleMs?: number } = {}
  ): Promise<Map<string, DownstreamSettleResult>> {
    const maxRounds = opts.maxRounds ?? this.maxRounds;
    const settleMs = opts.settleMs ?? 500;
    const results = new Map<string, DownstreamSettleResult>(
      chains.map((c) => [c.label, { matched: false, rounds: 0 }])
    );
    if (chains.length === 0) return results;

    if (expectedMessageIds.size === 0) {
      // No identifiable outbound messages to wait on — advance a few rounds so any
      // queued work still gets a chance to process, then return (all unmatched).
      const fallbackRounds = Math.min(3, maxRounds);
      this.logger.debug(
        `Downstream settle: no expected message ids; falling back to ${fallbackRounds} fixed round(s)`
      );
      for (let r = 0; r < fallbackRounds; r++) {
        for (const chain of chains) await this.advanceAndCollect(chain);
        await new Promise((res) => setTimeout(res, settleMs));
      }
      return results;
    }

    const pending = new Map(chains.map((c) => [c.label, c]));
    for (let round = 0; round < maxRounds && pending.size > 0; round++) {
      this.logger.debug(
        `Downstream settle round ${round + 1}/${maxRounds}, ${pending.size} chain(s) still pending`
      );
      for (const [label, chain] of [...pending]) {
        await this.advanceAndCollect(chain);
        if (this.hasProcessedExpected(label, expectedMessageIds)) {
          results.set(label, { matched: true, rounds: round + 1 });
          pending.delete(label);
          this.logger.debug(
            `Downstream settle: ${label} processed expected message in round ${round + 1}`
          );
        }
      }
      if (pending.size === 0) break;
      await new Promise((res) => setTimeout(res, settleMs));
    }
    for (const label of pending.keys()) {
      results.set(label, { matched: false, rounds: maxRounds });
    }
    return results;
  }

  /**
   * True if the chain's collected events contain a `MessageQueue.Processed` whose `id`
   * matches one of the expected outbound message identifiers. Scans the full accumulated
   * log each call (idempotent — once a match exists it stays), so the caller can poll it
   * after each block.
   */
  private hasProcessedExpected(label: string, expectedMessageIds: Set<string>): boolean {
    const events = this.collectedEvents.get(label) ?? [];
    for (const e of events) {
      if (e.section !== 'MessageQueue' || e.method !== 'Processed') continue;
      const data = serializeEventData(e.data) as { id?: unknown };
      const id = typeof data?.id === 'string' ? data.id.toLowerCase() : undefined;
      if (id && expectedMessageIds.has(id)) return true;
    }
    return false;
  }

  /** Tear down the bridge handle + polkadot.js connections. Safe to call multiple times. */
  async teardown(): Promise<void> {
    if (this.bridgeHandle) {
      await this.bridgeHandle.disconnect();
      this.bridgeHandle = null;
    }
    if (this.bhpApi) {
      await this.bhpApi.disconnect();
      this.bhpApi = null;
    }
    if (this.bhkApi) {
      await this.bhkApi.disconnect();
      this.bhkApi = null;
    }
  }

  private async advanceAndCollect(
    chain: BridgeChain,
    opts?: { transactions?: string[] }
  ): Promise<void> {
    await chain.manager.newBlock(opts);
    await this.captureCurrentEvents(chain);
  }

  /**
   * Read `System.Events` from the chain's current head and append to the collector,
   * without building a new block. Used to capture events from blocks built by
   * external machinery (chopsticks's bridge handle in particular).
   */
  private async captureCurrentEvents(chain: BridgeChain): Promise<void> {
    let events: ParsedEvent[] = [];
    try {
      events = await getBlockEvents(chain.api.query.System.Events, this.logger);
    } catch (error) {
      this.logger.debug(
        `captureCurrentEvents: failed for ${chain.label}: ${(error as Error).message}`
      );
    }
    const existing = this.collectedEvents.get(chain.label) ?? [];
    existing.push(...events);
    this.collectedEvents.set(chain.label, existing);
  }

  /**
   * Scan BHP's `BridgeKusamaMessages.OutboundLanes` and return any newly-emitted
   * messages this pump round saw. Pure telemetry — the chopsticks relayer is what
   * actually delivers them to BHK.
   */
  private async collectNewOutbound(): Promise<SeenBridgeMessage[]> {
    const pallet = (this.polkadot.bhp.api.query as any).BridgeKusamaMessages;
    if (!pallet?.OutboundLanes) return [];

    let laneEntries: Array<{ keyArgs: unknown[]; value: unknown }> = [];
    try {
      laneEntries = await pallet.OutboundLanes.getEntries();
    } catch (error) {
      this.logger.warn(`Failed to read OutboundLanes: ${(error as Error).message}`);
      return [];
    }

    const out: SeenBridgeMessage[] = [];
    for (const entry of laneEntries) {
      const laneId = entry.keyArgs[0];
      const laneHex = stringifyLane(laneId);
      if (!laneHex) continue;
      const data = entry.value as {
        latest_generated_nonce?: bigint | number;
        latest_received_nonce?: bigint | number;
      };
      if (!data) continue;
      const latestGenerated = BigInt(data.latest_generated_nonce ?? 0);
      const latestReceived = BigInt(data.latest_received_nonce ?? 0);
      const lastSeen = this.delivered.get(laneHex) ?? latestReceived;
      for (let nonce = lastSeen + 1n; nonce <= latestGenerated; nonce++) {
        let payload: unknown;
        try {
          payload = await pallet.OutboundMessages.getValue({ lane_id: laneId, nonce });
        } catch (error) {
          this.logger.warn(
            `Failed to read OutboundMessages[(${laneHex}, ${nonce})]: ${(error as Error).message}`
          );
          continue;
        }
        if (payload === undefined || payload === null) continue;
        out.push(this.makeSeen(laneHex, nonce, payload));
        this.delivered.set(laneHex, nonce);
      }
    }
    return out;
  }

  private makeSeen(laneHex: string, nonce: bigint, payload: unknown): SeenBridgeMessage {
    const rawBytes = extractPayloadBytes(payload);
    const rawPayloadHex = rawBytes ? toHex(rawBytes) : '0x';
    const seen: SeenBridgeMessage = { laneHex, nonce, rawPayloadHex };
    if (!this.payloadCodec) {
      seen.decodeError = 'payload codec not initialized';
      return seen;
    }
    if (!rawBytes) {
      seen.decodeError = 'payload bytes unavailable';
      return seen;
    }
    try {
      seen.decoded = this.payloadCodec.decode(rawBytes);
    } catch (error) {
      seen.decodeError = (error as Error).message;
    }
    return seen;
  }

  private logOne(msg: SeenBridgeMessage): void {
    const head = `\u{1F309} ${this.polkadot.bhp.label}: bridge message ${msg.laneHex} #${msg.nonce}`;
    this.logger.info(head);
    if (msg.decoded) {
      this.logger.info(`   universalDest = ${stringify(msg.decoded.universalDest)}`);
      this.logger.info(`   payload size = ${(msg.rawPayloadHex.length - 2) / 2} bytes`);
      this.logger.debug(`   message = ${stringify(msg.decoded.message, 2)}`);
    } else {
      this.logger.warn(`   decode failed: ${msg.decodeError ?? 'unknown error'}`);
      this.logger.debug(
        `   raw payload (${msg.rawPayloadHex.length / 2 - 1} bytes): ${msg.rawPayloadHex}`
      );
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function stringifyLane(laneId: unknown): string | null {
  if (laneId instanceof Uint8Array) return toHex(laneId);
  if (typeof laneId === 'string') return laneId.startsWith('0x') ? laneId : `0x${laneId}`;
  if (laneId && typeof (laneId as any).asBytes === 'function')
    return toHex((laneId as any).asBytes());
  return null;
}

function extractPayloadBytes(payload: unknown): Uint8Array | null {
  if (payload instanceof Uint8Array) return payload;
  if (payload && typeof (payload as any).asBytes === 'function') return (payload as any).asBytes();
  if (typeof payload === 'string' && payload.startsWith('0x')) return fromHex(payload);
  return null;
}
