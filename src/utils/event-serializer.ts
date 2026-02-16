import { Logger } from './logger';

export interface ParsedEvent {
  section: string;
  method: string;
  data: any;
}

/**
 * Serialize event data, converting Uint8Arrays and other binary data to hex strings.
 * Handles polkadot-api Binary types, Buffer, Uint8Array, BigInt, and nested structures.
 */
export function serializeEventData(data: any): any {
  if (data === null || data === undefined) {
    return data;
  }

  // Handle Uint8Array
  if (data instanceof Uint8Array) {
    return '0x' + Buffer.from(data).toString('hex');
  }

  // Handle Buffer
  if (Buffer.isBuffer(data)) {
    return '0x' + data.toString('hex');
  }

  // Handle polkadot-api FixedSizeBinary and similar types (check for asHex property)
  if (typeof data === 'object' && 'asHex' in data) {
    try {
      const hex = typeof data.asHex === 'function' ? data.asHex() : data.asHex;
      if (hex !== undefined && hex !== null) {
        return hex;
      }
      if ('asBytes' in data) {
        const bytes = typeof data.asBytes === 'function' ? data.asBytes() : data.asBytes;
        if (bytes instanceof Uint8Array) {
          return '0x' + Buffer.from(bytes).toString('hex');
        }
      }
    } catch {
      // Fall through to other methods
    }
  }

  // Handle objects with toHex method
  if (typeof data === 'object' && typeof data.toHex === 'function') {
    return data.toHex();
  }

  // Handle objects with toU8a method (convert to Uint8Array then to hex)
  if (typeof data === 'object' && typeof data.toU8a === 'function') {
    const u8a = data.toU8a();
    return '0x' + Buffer.from(u8a).toString('hex');
  }

  // Handle objects with toString that might give us useful info
  if (typeof data === 'object' && typeof data.toString === 'function') {
    const str = data.toString();
    if (str.startsWith('0x')) {
      return str;
    }
  }

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map((item) => serializeEventData(item));
  }

  // Handle array-like objects (objects with numeric keys)
  if (typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data);
    const isArrayLike = keys.length > 0 && keys.every((k) => !isNaN(Number(k)));

    if (isArrayLike) {
      const bytes: number[] = [];
      for (let i = 0; i < keys.length; i++) {
        if (data[i] !== undefined) {
          bytes.push(data[i]);
        }
      }
      if (bytes.length > 0) {
        return '0x' + Buffer.from(bytes).toString('hex');
      }
    }
  }

  // Handle plain objects
  if (typeof data === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = serializeEventData(value);
    }
    return result;
  }

  // Handle bigint
  if (typeof data === 'bigint') {
    return data.toString();
  }

  return data;
}

/**
 * Parse a raw block event into a normalized { section, method, data } structure.
 * Handles both polkadot-api direct format and wrapped event format.
 */
export function parseBlockEvent(event: any): ParsedEvent {
  let section = 'unknown';
  let method = 'unknown';
  let data: any = null;

  // polkadot-api direct format: { type: "PalletName", value: { type: "EventName", value: {...} } }
  if (event.type && typeof event.type === 'string') {
    section = event.type;
    if (event.value && event.value.type) {
      method = event.value.type;
      data = event.value.value || event.value;
    } else {
      data = event.value;
    }
  }

  // Wrapped format: { event: { type: ..., value: ... } }
  if (section === 'unknown' && event.event) {
    if (typeof event.event.type === 'string') {
      section = event.event.type;
    }
    if (event.event.value && typeof event.event.value.type === 'string') {
      method = event.event.value.type;
      data = event.event.value.value;
    }
    // Legacy section/method on event.event
    if (section === 'unknown' && event.event.section) {
      section = String(event.event.section);
    }
    if (method === 'unknown' && event.event.method) {
      method = String(event.event.method);
    }
    if (data === null) {
      data = event.event.value || event.event.data;
    }
  }

  // Final fallback: direct section/method properties
  if (section === 'unknown' && event.section) {
    section = String(event.section);
  }
  if (method === 'unknown' && event.method) {
    method = String(event.method);
  }

  return { section, method, data };
}

/**
 * Display chain events with a label and block number.
 * Shared display logic used by NetworkCoordinator for post-execution event display.
 */
export function displayChainEvents(
  label: string,
  blockNumber: number | bigint,
  events: any[] | null | undefined,
  logger: Logger
): void {
  logger.info(`\u{1F4E1} ${label} (Block #${blockNumber})`);

  if (events && Array.isArray(events)) {
    events.forEach((event: any) => {
      const parsed = parseBlockEvent(event);
      logger.info(`  \u2022 ${parsed.section}.${parsed.method}`);

      if (logger.isVerbose() && parsed.data) {
        const serialized = serializeEventData(parsed.data);
        logger.debug(`    Data: ${JSON.stringify(serialized, null, 2)}`);
      }
    });
  } else {
    logger.info(`  No events found`);
  }
}
