import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  inferNetworkFromUrl,
  parseEndpoint,
  parseMultipleEndpoints,
} from '../utils/chain-endpoint-parser';

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

  it('treats a non-URL non-numeric token as a config-file path and errors if it does not exist', () => {
    // The token has no `://`, so the parser treats it as a YAML path. Since the file
    // doesn't exist, parseChopsticksConfigFile surfaces a clear error.
    expect(() => parseMultipleEndpoints('notaurl')).toThrow(/looks like a path/);
  });
});

describe('inferNetworkFromUrl', () => {
  it.each([
    ['wss://polkadot-collectives-rpc.polkadot.io', 'polkadot'],
    ['wss://polkadot-asset-hub-rpc.polkadot.io', 'polkadot'],
    ['wss://polkadot-bridge-hub-rpc.polkadot.io', 'polkadot'],
    ['wss://rpc.polkadot.io', 'polkadot'],
    ['wss://kusama-asset-hub-rpc.polkadot.io', 'kusama'],
    ['wss://kusama-bridge-hub-rpc.polkadot.io', 'kusama'],
    ['wss://kusama-rpc.polkadot.io', 'kusama'],
    ['wss://paseo-rpc.dwellir.com', 'paseo'],
    ['wss://westend-rpc.polkadot.io', 'westend'],
    ['wss://rococo-rpc.polkadot.io', 'rococo'],
    ['wss://node.example.com', 'unknown'],
  ])('classifies %s → %s', (url, expected) => {
    expect(inferNetworkFromUrl(url)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(inferNetworkFromUrl('WSS://KUSAMA-ASSET-HUB.NODE.IO')).toBe('kusama');
  });
});

describe('parseEndpoint chopsticks-config-file form', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'prt-endpoint-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  function writeYaml(filename: string, content: string): string {
    const full = join(tmp, filename);
    writeFileSync(full, content);
    return full;
  }

  it('loads endpoint + block + extras from a YAML file', () => {
    const file = writeYaml(
      'bhk.yml',
      `endpoint: wss://kusama-bridge-hub-rpc.polkadot.io
block: 12345
wasm-override: ./runtimes/debug/bridge_hub_kusama_runtime.compact.compressed.wasm
runtime-log-level: 4
`
    );
    const parsed = parseEndpoint(file);
    expect(parsed.url).toBe('wss://kusama-bridge-hub-rpc.polkadot.io');
    expect(parsed.block).toBe(12345);
    expect(parsed.baseConfig).toEqual({
      'wasm-override': './runtimes/debug/bridge_hub_kusama_runtime.compact.compressed.wasm',
      'runtime-log-level': 4,
    });
  });

  it('returns empty baseConfig when YAML has only endpoint', () => {
    const file = writeYaml('plain.yml', 'endpoint: wss://example.com\n');
    const parsed = parseEndpoint(file);
    expect(parsed.url).toBe('wss://example.com');
    expect(parsed.block).toBeUndefined();
    expect(parsed.baseConfig).toEqual({});
  });

  it('rejects YAML without an endpoint field', () => {
    const file = writeYaml('no-endpoint.yml', 'block: 1\n');
    expect(() => parseEndpoint(file)).toThrow(/missing a string "endpoint:"/);
  });

  it('rejects YAML when block is non-numeric', () => {
    const file = writeYaml(
      'bad-block.yml',
      `endpoint: wss://example.com
block: "not-a-number"
`
    );
    expect(() => parseEndpoint(file)).toThrow(/must be a non-negative integer/);
  });

  it('rejects a path that does not exist', () => {
    expect(() => parseEndpoint('/no/such/file.yml')).toThrow(/does not exist/);
  });

  it('mixed list (URL + config-file) works in parseMultipleEndpoints', () => {
    const file = writeYaml(
      'mixed.yml',
      `endpoint: wss://kusama-bridge-hub-rpc.polkadot.io
wasm-override: /tmp/bhk.wasm
`
    );
    const list = parseMultipleEndpoints(`wss://chain1.io,100,${file}`);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ url: 'wss://chain1.io', block: 100 });
    expect(list[1].url).toBe('wss://kusama-bridge-hub-rpc.polkadot.io');
    expect(list[1].baseConfig).toEqual({ 'wasm-override': '/tmp/bhk.wasm' });
  });
});
