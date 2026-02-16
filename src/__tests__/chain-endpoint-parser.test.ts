import { describe, it, expect } from 'vitest';
import { parseEndpoint, parseMultipleEndpoints } from '../utils/chain-endpoint-parser';

describe('parseEndpoint', () => {
  it('parses a plain URL', () => {
    expect(parseEndpoint('wss://polkadot.io')).toEqual({ url: 'wss://polkadot.io' });
  });

  it('parses URL with block number', () => {
    expect(parseEndpoint('wss://polkadot.io,12345')).toEqual({
      url: 'wss://polkadot.io',
      block: 12345,
    });
  });

  it('trims whitespace', () => {
    expect(parseEndpoint('  wss://polkadot.io , 999  ')).toEqual({
      url: 'wss://polkadot.io',
      block: 999,
    });
  });

  it('throws on empty input', () => {
    expect(() => parseEndpoint('')).toThrow('cannot be empty');
    expect(() => parseEndpoint('   ')).toThrow('cannot be empty');
  });

  it('throws on invalid block number', () => {
    expect(() => parseEndpoint('wss://polkadot.io,abc')).toThrow('Invalid block number');
  });

  it('throws on negative block number', () => {
    expect(() => parseEndpoint('wss://polkadot.io,-1')).toThrow('Invalid block number');
  });

  it('throws on too many commas', () => {
    expect(() => parseEndpoint('wss://polkadot.io,123,456')).toThrow('Invalid endpoint format');
  });
});

describe('parseMultipleEndpoints', () => {
  it('returns empty array for empty input', () => {
    expect(parseMultipleEndpoints('')).toEqual([]);
    expect(parseMultipleEndpoints('   ')).toEqual([]);
  });

  it('parses single URL', () => {
    expect(parseMultipleEndpoints('wss://chain1.io')).toEqual([{ url: 'wss://chain1.io' }]);
  });

  it('parses multiple URLs', () => {
    expect(parseMultipleEndpoints('wss://chain1.io,wss://chain2.io')).toEqual([
      { url: 'wss://chain1.io' },
      { url: 'wss://chain2.io' },
    ]);
  });

  it('parses URL with block then another URL', () => {
    expect(parseMultipleEndpoints('wss://chain1.io,12345,wss://chain2.io')).toEqual([
      { url: 'wss://chain1.io', block: 12345 },
      { url: 'wss://chain2.io' },
    ]);
  });

  it('parses multiple URLs each with blocks', () => {
    expect(parseMultipleEndpoints('wss://chain1.io,100,wss://chain2.io,200')).toEqual([
      { url: 'wss://chain1.io', block: 100 },
      { url: 'wss://chain2.io', block: 200 },
    ]);
  });

  it('throws on non-URL at start', () => {
    expect(() => parseMultipleEndpoints('notaurl')).toThrow('Expected URL');
  });
});
