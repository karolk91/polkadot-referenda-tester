import { describe, it, expect } from 'vitest';
import { buildChainInfoFromSpecName } from '../services/chain-registry';

describe('buildChainInfoFromSpecName', () => {
  it('identifies polkadot relay chain', () => {
    const info = buildChainInfoFromSpecName('polkadot', 'wss://polkadot.io');
    expect(info.network).toBe('polkadot');
    expect(info.kind).toBe('relay');
    expect(info.label).toBe('polkadot');
  });

  it('identifies kusama relay chain', () => {
    const info = buildChainInfoFromSpecName('kusama', 'wss://kusama.io');
    expect(info.network).toBe('kusama');
    expect(info.kind).toBe('relay');
  });

  it('identifies westend relay chain', () => {
    const info = buildChainInfoFromSpecName('westend', 'wss://westend.io');
    expect(info.network).toBe('westend');
    expect(info.kind).toBe('relay');
  });

  it('identifies paseo relay chain', () => {
    const info = buildChainInfoFromSpecName('paseo', 'wss://paseo.io');
    expect(info.network).toBe('paseo');
    expect(info.kind).toBe('relay');
  });

  it('identifies rococo relay chain', () => {
    const info = buildChainInfoFromSpecName('rococo', 'wss://rococo.io');
    expect(info.network).toBe('rococo');
    expect(info.kind).toBe('relay');
  });

  it('identifies polkadot parachain by specName', () => {
    const info = buildChainInfoFromSpecName('collectives-polkadot', 'wss://collectives.io');
    expect(info.network).toBe('polkadot');
    expect(info.kind).toBe('parachain');
    expect(info.label).toBe('collectives-polkadot');
  });

  it('identifies kusama parachain', () => {
    const info = buildChainInfoFromSpecName('asset-hub-kusama', 'wss://asset-hub-kusama.io');
    expect(info.network).toBe('kusama');
    expect(info.kind).toBe('parachain');
  });

  it('handles unknown specName', () => {
    const info = buildChainInfoFromSpecName('my-custom-chain', 'wss://custom.io');
    expect(info.network).toBe('unknown');
    expect(info.kind).toBe('parachain');
    expect(info.label).toBe('my-custom-chain');
  });

  it('normalizes underscores to dashes in label', () => {
    const info = buildChainInfoFromSpecName('asset_hub_polkadot', 'wss://example.io');
    expect(info.label).toBe('asset-hub-polkadot');
  });

  it('preserves endpoint in result', () => {
    const endpoint = 'wss://polkadot-rpc.dwellir.com';
    const info = buildChainInfoFromSpecName('polkadot', endpoint);
    expect(info.endpoint).toBe(endpoint);
  });

  it('preserves specName in result', () => {
    const info = buildChainInfoFromSpecName('Polkadot', 'wss://example.io');
    expect(info.specName).toBe('Polkadot');
    // Network detection is case-insensitive
    expect(info.network).toBe('polkadot');
  });
});
