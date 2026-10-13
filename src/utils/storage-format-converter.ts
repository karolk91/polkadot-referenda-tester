import { toHex } from '@polkadot-api/utils';

function isEnumValue(value: object): value is { type: string; value?: unknown } {
  return (
    typeof (value as { type?: unknown }).type === 'string' &&
    Object.keys(value).every((key) => key === 'type' || key === 'value')
  );
}

export function toPolkadotJsJson(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return toHex(value);
  if (Array.isArray(value)) return value.map(toPolkadotJsJson);
  if (value === null || typeof value !== 'object') return value;
  if (isEnumValue(value)) return { [value.type]: toPolkadotJsJson(value.value) };
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, toPolkadotJsJson(field)])
  );
}
