import { describe, expect, it } from 'vitest';
import { buildChainInfoFromSpecName, lookupNetworkFromSpecName } from '../services/chain-registry';

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

  // Legacy / network-agnostic spec_names that substring inference alone cannot
  // resolve. These come straight from the production system-parachain runtimes
  // (polkadot-fellows/runtimes v2.2.1) and are the chains the bridged-scenario
  // routing decision actually depends on.
  it('resolves statemint to polkadot (Polkadot Asset Hub legacy spec_name)', () => {
    const info = buildChainInfoFromSpecName('statemint', 'wss://ahp.example');
    expect(info.network).toBe('polkadot');
    expect(info.kind).toBe('parachain');
  });

  it('resolves statemine to kusama (Kusama Asset Hub legacy spec_name)', () => {
    const info = buildChainInfoFromSpecName('statemine', 'wss://ahk.example');
    expect(info.network).toBe('kusama');
    expect(info.kind).toBe('parachain');
  });

  it('resolves bare "collectives" to polkadot (Polkadot Collectives spec_name)', () => {
    const info = buildChainInfoFromSpecName('collectives', 'wss://coll.example');
    expect(info.network).toBe('polkadot');
    expect(info.kind).toBe('parachain');
  });

  it('resolves encointer-parachain to kusama', () => {
    const info = buildChainInfoFromSpecName('encointer-parachain', 'wss://enc.example');
    expect(info.network).toBe('kusama');
  });

  it('resolves people-polkadot / people-kusama to their respective networks', () => {
    expect(buildChainInfoFromSpecName('people-polkadot', 'wss://').network).toBe('polkadot');
    expect(buildChainInfoFromSpecName('people-kusama', 'wss://').network).toBe('kusama');
  });
});

describe('lookupNetworkFromSpecName', () => {
  it('matches known legacy parachain names via the static table', () => {
    expect(lookupNetworkFromSpecName('statemint')).toBe('polkadot');
    expect(lookupNetworkFromSpecName('statemine')).toBe('kusama');
    expect(lookupNetworkFromSpecName('collectives')).toBe('polkadot');
    expect(lookupNetworkFromSpecName('encointer-parachain')).toBe('kusama');
  });

  it('normalizes underscores to dashes when matching the table', () => {
    expect(lookupNetworkFromSpecName('bridge_hub_polkadot')).toBe('polkadot');
  });

  it('falls back to substring inference for unknown compound names', () => {
    // Not in the table but the substring `polkadot` is present.
    expect(lookupNetworkFromSpecName('my-fork-polkadot-runtime')).toBe('polkadot');
  });

  it('returns unknown for truly unrecognized names', () => {
    expect(lookupNetworkFromSpecName('random-devnet')).toBe('unknown');
  });
});
