/**
 * Convert a value to a hex string, handling the various polkadot-api
 * binary types (Binary, FixedSizeBinary, Uint8Array, Buffer, etc.)
 *
 * Returns undefined if the value cannot be converted.
 */
export function toHexString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value.startsWith('0x') ? value : `0x${value}`;
  }

  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }

  if (Buffer.isBuffer(value)) {
    return `0x${value.toString('hex')}`;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    if (typeof obj.asHex === 'function') {
      try {
        const hex = obj.asHex();
        if (hex !== undefined && hex !== null) return String(hex);
      } catch {
        // fall through
      }
    }

    if (typeof obj.toHex === 'function') {
      try {
        return String(obj.toHex());
      } catch {
        // fall through
      }
    }

    if (typeof obj.toU8a === 'function') {
      try {
        const u8a = obj.toU8a();
        return `0x${Buffer.from(u8a).toString('hex')}`;
      } catch {
        // fall through
      }
    }
  }

  return undefined;
}
