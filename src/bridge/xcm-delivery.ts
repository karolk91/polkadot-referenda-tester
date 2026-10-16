import type { Fork } from '../network/fork';
import { delay } from '../utils/delay';
import { isEvent, type ParsedEvent } from '../utils/events';
import type { ForkEventLog } from './fork-event-log';

export type DownstreamDelivery =
  | { kind: 'processed'; rounds: number }
  | { kind: 'timeout'; rounds: number };

function lowercaseHex(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.toLowerCase() : undefined;
}

export function outboundXcmIds(events: ParsedEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    const data = event.data as { message_id?: unknown; message_hash?: unknown } | null;
    const id = isEvent(event, 'PolkadotXcm', 'Sent')
      ? lowercaseHex(data?.message_id)
      : event.method === 'UpwardMessageSent' || event.method === 'XcmpMessageSent'
        ? lowercaseHex(data?.message_hash)
        : undefined;
    if (id) ids.add(id);
  }
  return ids;
}

function processedMessageIds(events: ParsedEvent[]): string[] {
  return events
    .filter((event) => isEvent(event, 'MessageQueue', 'Processed'))
    .map((event) => lowercaseHex((event.data as { id?: unknown } | null)?.id))
    .filter((id): id is string => id !== undefined);
}

export async function processDownstreamMessages(
  forks: Fork[],
  messageIds: Set<string>,
  log: ForkEventLog,
  options: { maxRounds: number; roundDelayMs: number }
): Promise<Map<Fork, DownstreamDelivery>> {
  const deliveries = new Map<Fork, DownstreamDelivery>();
  let pending = forks;
  for (let round = 1; round <= options.maxRounds && pending.length > 0; round++) {
    for (const fork of pending) {
      await log.advance(fork);
      if (processedMessageIds(log.events(fork)).some((id) => messageIds.has(id))) {
        deliveries.set(fork, { kind: 'processed', rounds: round });
      }
    }
    pending = pending.filter((fork) => !deliveries.has(fork));
    if (pending.length > 0) {
      await delay(options.roundDelayMs);
    }
  }
  for (const fork of pending) {
    deliveries.set(fork, { kind: 'timeout', rounds: options.maxRounds });
  }
  return deliveries;
}
