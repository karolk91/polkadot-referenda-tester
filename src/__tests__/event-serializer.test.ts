import { describe, it, expect } from 'vitest';
import { serializeEventData, parseBlockEvent } from '../utils/event-serializer';

describe('serializeEventData', () => {
  it('returns null/undefined as-is', () => {
    expect(serializeEventData(null)).toBeNull();
    expect(serializeEventData(undefined)).toBeUndefined();
  });

  it('converts Uint8Array to hex string', () => {
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(serializeEventData(data)).toBe('0xdeadbeef');
  });

  it('converts Buffer to hex string', () => {
    const data = Buffer.from([0xca, 0xfe]);
    expect(serializeEventData(data)).toBe('0xcafe');
  });

  it('handles objects with asHex function', () => {
    const data = { asHex: () => '0xabcd' };
    expect(serializeEventData(data)).toBe('0xabcd');
  });

  it('handles objects with asHex method', () => {
    const data = { asHex: () => '0x1234' };
    expect(serializeEventData(data)).toBe('0x1234');
  });

  it('falls back to toU8a when asHex throws', () => {
    const data = {
      asHex: () => { throw new Error('no hex'); },
      toU8a: () => new Uint8Array([0xff]),
    };
    expect(serializeEventData(data)).toBe('0xff');
  });

  it('handles objects with toHex method', () => {
    const data = { toHex: () => '0xbeef' };
    expect(serializeEventData(data)).toBe('0xbeef');
  });

  it('handles objects with toU8a method', () => {
    const data = { toU8a: () => new Uint8Array([0x01, 0x02]) };
    expect(serializeEventData(data)).toBe('0x0102');
  });

  it('handles objects with hex-returning toString', () => {
    const data = { toString: () => '0xfeed' };
    expect(serializeEventData(data)).toBe('0xfeed');
  });

  it('serializes arrays recursively', () => {
    const data = [new Uint8Array([0xaa]), 'hello', 42n];
    expect(serializeEventData(data)).toEqual(['0xaa', 'hello', '42']);
  });

  it('converts array-like objects to hex', () => {
    const data = { 0: 0xde, 1: 0xad };
    expect(serializeEventData(data)).toBe('0xdead');
  });

  it('serializes plain objects recursively', () => {
    const data = { amount: 1000n, hash: new Uint8Array([0xab]) };
    expect(serializeEventData(data)).toEqual({ amount: '1000', hash: '0xab' });
  });

  it('converts bigint to string', () => {
    expect(serializeEventData(42n)).toBe('42');
    expect(serializeEventData(0n)).toBe('0');
  });

  it('passes primitives through unchanged', () => {
    expect(serializeEventData(42)).toBe(42);
    expect(serializeEventData('hello')).toBe('hello');
    expect(serializeEventData(true)).toBe(true);
  });

  it('handles deeply nested structures', () => {
    const data = {
      outer: {
        inner: {
          value: 123n,
          bytes: new Uint8Array([0x01]),
        },
      },
    };
    expect(serializeEventData(data)).toEqual({
      outer: {
        inner: {
          value: '123',
          bytes: '0x01',
        },
      },
    });
  });
});

describe('parseBlockEvent', () => {
  it('parses polkadot-api direct format', () => {
    const event = {
      type: 'System',
      value: {
        type: 'ExtrinsicSuccess',
        value: { weight: 100 },
      },
    };
    const parsed = parseBlockEvent(event);
    expect(parsed.section).toBe('System');
    expect(parsed.method).toBe('ExtrinsicSuccess');
    expect(parsed.data).toEqual({ weight: 100 });
  });

  it('parses wrapped event format', () => {
    const event = {
      event: {
        type: 'Balances',
        value: {
          type: 'Transfer',
          value: { from: 'Alice', to: 'Bob', amount: 100 },
        },
      },
    };
    const parsed = parseBlockEvent(event);
    expect(parsed.section).toBe('Balances');
    expect(parsed.method).toBe('Transfer');
    expect(parsed.data).toEqual({ from: 'Alice', to: 'Bob', amount: 100 });
  });

  it('parses legacy section/method format', () => {
    const event = {
      section: 'Scheduler',
      method: 'Dispatched',
    };
    const parsed = parseBlockEvent(event);
    expect(parsed.section).toBe('Scheduler');
    expect(parsed.method).toBe('Dispatched');
  });

  it('handles event with event.section and event.method (legacy wrapped)', () => {
    const event = {
      event: {
        section: 'Treasury',
        method: 'Proposed',
        data: { index: 5 },
      },
    };
    const parsed = parseBlockEvent(event);
    expect(parsed.section).toBe('Treasury');
    expect(parsed.method).toBe('Proposed');
  });

  it('returns unknown for unrecognized structure', () => {
    const event = { foo: 'bar' };
    const parsed = parseBlockEvent(event);
    expect(parsed.section).toBe('unknown');
    expect(parsed.method).toBe('unknown');
  });

  it('handles type-only event without nested value', () => {
    const event = { type: 'System', value: 42 };
    const parsed = parseBlockEvent(event);
    expect(parsed.section).toBe('System');
    expect(parsed.method).toBe('unknown');
    expect(parsed.data).toBe(42);
  });
});
