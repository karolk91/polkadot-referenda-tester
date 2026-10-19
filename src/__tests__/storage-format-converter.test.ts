import { describe, expect, it } from 'vitest';
import { toPolkadotJsJson } from '../utils/storage-format-converter';
import { scheduledTask } from './helpers';

describe('toPolkadotJsJson', () => {
  it('enum value as an object with the variant as its only key', () => {
    expect(
      toPolkadotJsJson({ type: 'Origins', value: { type: 'Treasurer', value: undefined } }),
      'dev_setStorage builds values with polkadot.js, which reads enums as { Variant: value }'
    ).toEqual({ Origins: { Treasurer: null } });
  });

  it('unit enum variant without a value field', () => {
    expect(toPolkadotJsJson({ type: 'Root' })).toEqual({ Root: null });
  });

  it('byte array as hex', () => {
    expect(toPolkadotJsJson(new Uint8Array([0xde, 0xad]))).toBe('0xdead');
  });

  it('missing optional value as null', () => {
    expect(toPolkadotJsJson(undefined), 'polkadot.js reads null as Option::None').toBeNull();
  });

  it('u128 as a decimal string', () => {
    expect(toPolkadotJsJson(10n ** 30n)).toBe('1000000000000000000000000000000');
  });

  it('scheduled task with its field names and nested values', () => {
    const task = scheduledTask({
      maybe_id: '0xabcd',
      maybe_periodic: [10, 3],
      call: { type: 'Lookup', value: { hash: '0x1234', len: 50 } },
    });
    expect(toPolkadotJsJson([task, undefined])).toEqual([
      {
        maybe_id: '0xabcd',
        priority: 63,
        call: { Lookup: { hash: '0x1234', len: 50 } },
        maybe_periodic: [10, 3],
        origin: { system: { Root: null } },
      },
      null,
    ]);
  });
});
