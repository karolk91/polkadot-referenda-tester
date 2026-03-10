import { toHexString } from './hex';
import { stringify } from './json';
import type { Logger } from './logger';

export interface ParsedEvent {
  section: string;
  method: string;
  data: unknown;
}

/**
 * Attempt to convert a value to a hex string if it's a binary-like type.
 * Handles Uint8Array, Buffer, polkadot-api Binary/FixedSizeBinary, and objects
 * with a hex-producing toString().
 *
 * Returns the hex string if the value is binary-like, undefined otherwise.
 */
function tryConvertToHex(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }

  const hex = toHexString(data);

  // Native binary types
  if (hex !== undefined && (data instanceof Uint8Array || Buffer.isBuffer(data))) {
    return hex;
  }

  // polkadot-api Binary/FixedSizeBinary types (have asHex/toHex/toU8a)
  if ('asHex' in data || 'toHex' in data || 'toU8a' in data) {
    if (hex !== undefined) return hex;
  }

  // Objects with hex-producing toString
  if (typeof (data as Record<string, unknown>).toString === 'function') {
    const str = (data as Record<string, unknown>).toString() as string;
    if (str.startsWith('0x')) {
      return str;
    }
  }

  return undefined;
}

/**
 * Serialize event data, converting Uint8Arrays and other binary data to hex strings.
 * Handles polkadot-api Binary types, Buffer, Uint8Array, BigInt, and nested structures.
 */
export function serializeEventData(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  const hexResult = tryConvertToHex(data);
  if (hexResult !== undefined) {
    return hexResult;
  }

  if (Array.isArray(data)) {
    return data.map((item: unknown) => serializeEventData(item));
  }

  // Handle array-like objects (objects with numeric keys)
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const keys = Object.keys(record);
    const isArrayLike = keys.length > 0 && keys.every((k) => !Number.isNaN(Number(k)));

    if (isArrayLike) {
      const bytes: number[] = [];
      for (let i = 0; i < keys.length; i++) {
        if (record[i] !== undefined) {
          bytes.push(record[i] as number);
        }
      }
      if (bytes.length > 0) {
        return `0x${Buffer.from(bytes).toString('hex')}`;
      }
    }
  }

  if (typeof data === 'object' && data !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = serializeEventData(value);
    }
    return result;
  }

  if (typeof data === 'bigint') {
    return data.toString();
  }

  return data;
}

/**
 * Parse a raw block event into a normalized { section, method, data } structure.
 * Handles both polkadot-api direct format and wrapped event format.
 */
export function parseBlockEvent(event: unknown): ParsedEvent {
  let section = 'unknown';
  let method = 'unknown';
  let data: unknown = null;

  if (!event || typeof event !== 'object') {
    return { section, method, data };
  }

  const eventRecord = event as Record<string, unknown>;

  // polkadot-api direct format: { type: "PalletName", value: { type: "EventName", value: {...} } }
  if (eventRecord.type && typeof eventRecord.type === 'string') {
    section = eventRecord.type;
    const value = eventRecord.value as Record<string, unknown> | undefined;
    if (value?.type) {
      method = value.type as string;
      data = value.value || value;
    } else {
      data = eventRecord.value;
    }
  }

  // Wrapped format: { event: { type: ..., value: ... } }
  if (section === 'unknown' && eventRecord.event) {
    const inner = eventRecord.event as Record<string, unknown>;
    if (typeof inner.type === 'string') {
      section = inner.type;
    }
    const innerValue = inner.value as Record<string, unknown> | undefined;
    if (innerValue && typeof innerValue.type === 'string') {
      method = innerValue.type;
      data = innerValue.value;
    }
    // Legacy section/method on event.event
    if (section === 'unknown' && inner.section) {
      section = String(inner.section);
    }
    if (method === 'unknown' && inner.method) {
      method = String(inner.method);
    }
    if (data === null) {
      data = inner.value || inner.data;
    }
  }

  // Final fallback: direct section/method properties
  if (section === 'unknown' && eventRecord.section) {
    section = String(eventRecord.section);
  }
  if (method === 'unknown' && eventRecord.method) {
    method = String(eventRecord.method);
  }

  return { section, method, data };
}

/**
 * Retrieve and parse all events from the current block.
 * Shared utility used by simulator, creator, and coordinator.
 */
export async function getBlockEvents(
  eventsQuery: { getValue(): Promise<unknown[]> },
  logger?: Logger
): Promise<ParsedEvent[]> {
  try {
    const events = await eventsQuery.getValue();

    if (!events || events.length === 0) {
      return [];
    }

    return events.map((rawEvent) => parseBlockEvent(rawEvent));
  } catch (error) {
    if (logger) {
      logger.warn(`Failed to get block events: ${error}`);
    }
    return [];
  }
}

/**
 * Display chain events with a label and block number.
 * Shared display logic used by NetworkCoordinator for post-execution event display.
 */
export function displayChainEvents(
  label: string,
  blockNumber: number | bigint,
  events: unknown[] | null | undefined,
  logger: Logger
): void {
  logger.info(`\u{1F4E1} ${label} (Block #${blockNumber})`);

  if (events && Array.isArray(events)) {
    events.forEach((event: unknown) => {
      const parsed = parseBlockEvent(event);
      logger.info(`  \u2022 ${parsed.section}.${parsed.method}`);

      if (logger.isVerbose() && parsed.data) {
        const serialized = serializeEventData(parsed.data);
        logger.debug(`    Data: ${stringify(serialized, 2)}`);
      }
    });
  } else {
    logger.info(`  No events found`);
  }
}
