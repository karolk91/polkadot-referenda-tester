import { describe, expect, it } from 'vitest';
import { isNetworkName, networkFromText } from '../utils/networks';

describe('networkFromText', () => {
  it.each([
    ['wss://polkadot-collectives-rpc.polkadot.io', 'polkadot'],
    ['wss://polkadot-asset-hub-rpc.polkadot.io', 'polkadot'],
    ['wss://rpc.polkadot.io', 'polkadot'],
    ['wss://kusama-asset-hub-rpc.polkadot.io', 'kusama'],
    ['wss://kusama-bridge-hub-rpc.polkadot.io', 'kusama'],
    ['wss://paseo-rpc.dwellir.com', 'paseo'],
    ['wss://westend-rpc.polkadot.io', 'westend'],
    ['wss://rococo-rpc.polkadot.io', 'rococo'],
    ['wss://node.example.com', 'unknown'],
    ['bridge-hub-kusama', 'kusama'],
    ['asset-hub-polkadot', 'polkadot'],
  ])('network of %s', (text, expected) => {
    expect(
      networkFromText(text),
      'public RPCs of every network are hosted under *.polkadot.io, so the host must not decide'
    ).toBe(expected);
  });

  it('network of upper-case text', () => {
    expect(networkFromText('WSS://KUSAMA-ASSET-HUB.NODE.IO')).toBe('kusama');
  });
});

describe('isNetworkName', () => {
  it('bare network name only', () => {
    expect(isNetworkName('westend'), 'relay chains report the bare network name as spec_name').toBe(
      true
    );
    expect(isNetworkName('asset-hub-westend')).toBe(false);
    expect(isNetworkName('unknown')).toBe(false);
  });
});
