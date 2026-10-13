import { toHex } from '@polkadot-api/utils';

export function stringify(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_, entry) => {
      if (typeof entry === 'bigint') return entry.toString();
      if (entry instanceof Uint8Array) return toHex(entry);
      return entry;
    },
    space
  );
}
