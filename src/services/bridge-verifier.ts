import { displayChainEvents, type ParsedEvent } from '../utils/event-serializer';
import { stringify } from '../utils/json';
import type { Logger } from '../utils/logger';
import type { BridgeChain, BridgeKusamaSide, BridgePolkadotSide } from './bridge-connector';

/**
 * Result of verifying the on-chain side effects of a Tier-4 bridge delivery.
 *
 * Aggregates per-chain event probes for the canonical happy path:
 *   1. BHP emits `<outboundPallet>.MessageAccepted` when the referendum's XCM is
 *      processed and the bridge payload is queued on the outbound lane (already
 *      happens in Phase 1; this just confirms it).
 *   2. BHK emits `<destMessagesPallet>.MessagesReceived` after our submitted
 *      `receive_messages_proof` extrinsic dispatches, and `XcmpQueue.XcmpMessageSent`
 *      when the bridge dispatcher forwards the unwrapped XCM to AHK via sibling XCMP.
 *   3. AHK emits `MessageQueue.Processed { success: true }` when the incoming XCMP
 *      message is executed.
 *
 * The user-supplied call (e.g. `pallet_whitelist.whitelist_call`) will produce its
 * own event on AHK (`Whitelist.CallWhitelisted`, etc.); the verifier surfaces the
 * full event list so callers can inspect.
 */
export interface BridgeVerificationResult {
  bhp: ChainProbe;
  bhk?: ChainProbe;
  ahk: ChainProbe;
  /** True iff all required markers (MessageAccepted, MessagesReceived, MessageQueue.Processed:success) fired. */
  overallPass: boolean;
  /** Filled when `overallPass` is false; describes which marker is missing. */
  failureReasons: string[];
}

export interface ChainProbe {
  label: string;
  blockNumber: number;
  events: ParsedEvent[];
  /** Counts of bridge-relevant event kinds. */
  markers: BridgeMarkers;
}

export interface BridgeMarkers {
  messageAccepted: number; // BHP (outbound pallet)
  messagesReceived: number; // BHK (dest messages pallet)
  xcmpMessageSent: number; // BHK XcmpQueue
  messageQueueProcessedSuccess: number; // AHK MessageQueue
  messageQueueProcessedFailure: number; // AHK MessageQueue
  extrinsicFailed: number; // any chain — bridge dispatch shouldn't fail
}

export interface BridgeVerifierOptions {
  /** BHP outbound pallet name (default: `BridgeKusamaMessages`). */
  outboundPalletName?: string;
  /** BHK inbound pallet name (default: `BridgePolkadotMessages`). */
  destMessagesPalletName?: string;
  /** Whether to also print all events for each chain. Default: true. */
  printEvents?: boolean;
}

/**
 * Reads events from BHP / BHK / AHK after a bridge delivery and reports whether the
 * happy-path markers fired. Designed to run AFTER `BridgeConnector.deliverPrepared()`
 * has completed (so BHK has dispatched and AHK has processed the inbound XCMP).
 */
export class BridgeVerifier {
  private readonly logger: Logger;
  private readonly outboundPalletName: string;
  private readonly destMessagesPalletName: string;
  private readonly printEvents: boolean;

  constructor(logger: Logger, options: BridgeVerifierOptions = {}) {
    this.logger = logger;
    this.outboundPalletName = options.outboundPalletName ?? 'BridgeKusamaMessages';
    this.destMessagesPalletName = options.destMessagesPalletName ?? 'BridgePolkadotMessages';
    this.printEvents = options.printEvents ?? true;
  }

  /**
   * Verify against an event log the BridgeConnector accumulated while building blocks.
   * Keyed by chain.label, so the verifier doesn't have to re-scan historical chain
   * state (which is slow/unreliable against chopsticks forks).
   */
  async verify(
    polkadot: BridgePolkadotSide,
    kusama: BridgeKusamaSide,
    collectedEvents: Map<string, ParsedEvent[]>
  ): Promise<BridgeVerificationResult> {
    this.logger.section('Bridge Delivery Verification');

    const bhpProbe = await this.probeChain(polkadot.bhp, collectedEvents);
    const ahkProbe = await this.probeChain(kusama.ahk, collectedEvents);
    const bhkProbe = kusama.bhk ? await this.probeChain(kusama.bhk, collectedEvents) : undefined;

    if (this.printEvents) {
      displayChainEvents(bhpProbe.label, bhpProbe.blockNumber, bhpProbe.events, this.logger);
      this.logger.info('');
      if (bhkProbe) {
        displayChainEvents(bhkProbe.label, bhkProbe.blockNumber, bhkProbe.events, this.logger);
        this.logger.info('');
      }
      displayChainEvents(ahkProbe.label, ahkProbe.blockNumber, ahkProbe.events, this.logger);
      this.logger.info('');
    }

    const failureReasons: string[] = [];
    if (bhpProbe.markers.messageAccepted === 0) {
      failureReasons.push(
        `${bhpProbe.label}: expected at least one ${this.outboundPalletName}.MessageAccepted event but saw none`
      );
    }
    if (bhkProbe) {
      if (bhkProbe.markers.messagesReceived === 0) {
        failureReasons.push(
          `${bhkProbe.label}: expected at least one ${this.destMessagesPalletName}.MessagesReceived event but saw none — receive_messages_proof did not dispatch`
        );
      }
      if (bhkProbe.markers.extrinsicFailed > 0) {
        failureReasons.push(
          `${bhkProbe.label}: ${bhkProbe.markers.extrinsicFailed} ExtrinsicFailed event(s) — likely the receive_messages_proof call failed`
        );
      }
    }
    if (ahkProbe.markers.messageQueueProcessedSuccess === 0) {
      failureReasons.push(
        `${ahkProbe.label}: expected at least one MessageQueue.Processed{success:true} event but saw none`
      );
    }
    if (ahkProbe.markers.messageQueueProcessedFailure > 0) {
      failureReasons.push(
        `${ahkProbe.label}: ${ahkProbe.markers.messageQueueProcessedFailure} MessageQueue.Processed{success:false} event(s) — XCM execution failed on AHK`
      );
    }

    const overallPass = failureReasons.length === 0;
    this.logSummary({ bhp: bhpProbe, bhk: bhkProbe, ahk: ahkProbe, overallPass, failureReasons });

    return { bhp: bhpProbe, bhk: bhkProbe, ahk: ahkProbe, overallPass, failureReasons };
  }

  private async probeChain(
    chain: BridgeChain,
    collectedEvents: Map<string, ParsedEvent[]>
  ): Promise<ChainProbe> {
    const latest = Number(await chain.api.query.System.Number.getValue());
    const events = collectedEvents.get(chain.label) ?? [];
    const markers: BridgeMarkers = {
      messageAccepted: 0,
      messagesReceived: 0,
      xcmpMessageSent: 0,
      messageQueueProcessedSuccess: 0,
      messageQueueProcessedFailure: 0,
      extrinsicFailed: 0,
    };
    accumulateMarkers(markers, events, this.outboundPalletName, this.destMessagesPalletName);
    return { label: chain.label, blockNumber: latest, events, markers };
  }

  private logSummary(result: BridgeVerificationResult): void {
    const lines: string[] = [];
    lines.push(`  ${result.bhp.label}:`);
    lines.push(
      `    ${this.outboundPalletName}.MessageAccepted = ${result.bhp.markers.messageAccepted}`
    );
    if (result.bhk) {
      lines.push(`  ${result.bhk.label}:`);
      lines.push(
        `    ${this.destMessagesPalletName}.MessagesReceived = ${result.bhk.markers.messagesReceived}`
      );
      lines.push(`    XcmpQueue.XcmpMessageSent = ${result.bhk.markers.xcmpMessageSent}`);
      lines.push(`    System.ExtrinsicFailed = ${result.bhk.markers.extrinsicFailed}`);
    }
    lines.push(`  ${result.ahk.label}:`);
    lines.push(
      `    MessageQueue.Processed{success:true} = ${result.ahk.markers.messageQueueProcessedSuccess}`
    );
    lines.push(
      `    MessageQueue.Processed{success:false} = ${result.ahk.markers.messageQueueProcessedFailure}`
    );

    if (result.overallPass) {
      this.logger.success('Bridge delivery verified — all happy-path markers fired:');
      for (const line of lines) this.logger.info(line);
    } else {
      this.logger.error('Bridge delivery did NOT pass verification:');
      for (const line of lines) this.logger.info(line);
      this.logger.info('');
      this.logger.error('Failure reasons:');
      for (const reason of result.failureReasons) this.logger.error(`  - ${reason}`);
    }
  }
}

function countMarkers(
  events: ParsedEvent[],
  outboundPalletName: string,
  destMessagesPalletName: string
): BridgeMarkers {
  const m: BridgeMarkers = {
    messageAccepted: 0,
    messagesReceived: 0,
    xcmpMessageSent: 0,
    messageQueueProcessedSuccess: 0,
    messageQueueProcessedFailure: 0,
    extrinsicFailed: 0,
  };
  accumulateMarkers(m, events, outboundPalletName, destMessagesPalletName);
  return m;
}

function accumulateMarkers(
  m: BridgeMarkers,
  events: ParsedEvent[],
  outboundPalletName: string,
  destMessagesPalletName: string
): void {
  for (const e of events) {
    if (e.section === outboundPalletName && e.method === 'MessageAccepted') {
      m.messageAccepted++;
    }
    if (e.section === destMessagesPalletName && e.method === 'MessagesReceived') {
      m.messagesReceived++;
    }
    if (e.section === 'XcmpQueue' && e.method === 'XcmpMessageSent') {
      m.xcmpMessageSent++;
    }
    if (e.section === 'MessageQueue' && e.method === 'Processed') {
      if (isProcessedSuccess(e.data)) m.messageQueueProcessedSuccess++;
      else m.messageQueueProcessedFailure++;
    }
    if (e.section === 'System' && e.method === 'ExtrinsicFailed') {
      m.extrinsicFailed++;
    }
  }
}

/**
 * `MessageQueue.Processed` event data shape: `{ id, origin, weight_used, success }`.
 * polkadot-api gives us a parsed object; sometimes the shape can vary across runtimes,
 * so we accept several common keys. Unknown shape → assume failure (conservative).
 */
function isProcessedSuccess(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.success === 'boolean') return obj.success;
  // Some runtimes nest the value under `value` (polkadot-api Enum-like layout).
  const value = obj.value as Record<string, unknown> | undefined;
  if (value && typeof value.success === 'boolean') return value.success;
  // Final attempt: stringify and look for the literal — last-resort coarse check.
  const serialized = stringify(data);
  return /"success"\s*:\s*true/.test(serialized);
}
