import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BRIDGE_URLS, type TestOptions } from '../commands/test-options';
import { planRun } from '../commands/test-referendum';
import { type ChainInfo, fetchChainInfoFromEndpoint } from '../network/chain-identity';
import { createTestLogger } from './helpers';

vi.mock('../network/chain-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../network/chain-identity')>()),
  fetchChainInfoFromEndpoint: vi.fn(),
}));

const POLKADOT_COLLECTIVES = 'wss://polkadot-collectives-rpc.polkadot.io';
const POLKADOT_ASSET_HUB = 'wss://polkadot-asset-hub-rpc.polkadot.io';
const KUSAMA_ASSET_HUB = 'wss://kusama-asset-hub-rpc.polkadot.io';
const KUSAMA_COLLECTIVES = 'wss://kusama-collectives-rpc.polkadot.io';

const RUN_DEFAULTS: TestOptions = {
  assetHubPolkadotUrl: DEFAULT_BRIDGE_URLS.assetHubPolkadot,
  bridgeHubPolkadotUrl: DEFAULT_BRIDGE_URLS.bridgeHubPolkadot,
  bridgeHubKusamaUrl: DEFAULT_BRIDGE_URLS.bridgeHubKusama,
  bridgePumpRounds: 8,
  cleanup: true,
  verbose: false,
};

const BOTH_REFERENDA = {
  callToCreateFellowshipReferendum: '0xdeadbeef',
  callToCreateGovernanceReferendum: '0xfeedface',
};

function plan(options: Partial<TestOptions>) {
  return planRun({ ...RUN_DEFAULTS, ...options }, createTestLogger());
}

describe('planRun', () => {
  beforeEach(() => {
    vi.mocked(fetchChainInfoFromEndpoint).mockReset();
    vi.mocked(fetchChainInfoFromEndpoint).mockRejectedValue(new Error('offline'));
  });

  it('bridged plan for Polkadot fellowship and Kusama governance, with default hub URLs', async () => {
    const result = await plan({
      fellowshipChainUrl: POLKADOT_COLLECTIVES,
      governanceChainUrl: KUSAMA_ASSET_HUB,
      bridgePumpRounds: 12,
      ...BOTH_REFERENDA,
    });

    expect(result.kind).toBe('bridged');
    if (result.kind !== 'bridged') return;
    expect(result.endpoints.collectives.url).toBe(POLKADOT_COLLECTIVES);
    expect(result.endpoints.assetHubKusama.url).toBe(KUSAMA_ASSET_HUB);
    expect(result.endpoints.assetHubPolkadot.url).toBe(DEFAULT_BRIDGE_URLS.assetHubPolkadot);
    expect(result.endpoints.bridgeHubPolkadot.url).toBe(DEFAULT_BRIDGE_URLS.bridgeHubPolkadot);
    expect(result.endpoints.bridgeHubKusama.url).toBe(DEFAULT_BRIDGE_URLS.bridgeHubKusama);
    expect(result.maxPumpRounds).toBe(12);
  });

  it('bridged plan with explicit hub URLs', async () => {
    const result = await plan({
      fellowshipChainUrl: POLKADOT_COLLECTIVES,
      governanceChainUrl: KUSAMA_ASSET_HUB,
      assetHubPolkadotUrl: 'ws://127.0.0.1:9000',
      bridgeHubPolkadotUrl: 'ws://127.0.0.1:9001',
      bridgeHubKusamaUrl: 'ws://127.0.0.1:9002,42',
      ...BOTH_REFERENDA,
    });

    expect(result.kind === 'bridged' && result.endpoints).toMatchObject({
      assetHubPolkadot: { url: 'ws://127.0.0.1:9000' },
      bridgeHubPolkadot: { url: 'ws://127.0.0.1:9001' },
      bridgeHubKusama: { url: 'ws://127.0.0.1:9002', block: 42 },
    });
  });

  it('network from the runtime for URLs without a network name', async () => {
    const networks: Record<string, ChainInfo['network']> = {
      'wss://collectives.example.com': 'polkadot',
      'wss://asset-hub.example.com': 'kusama',
    };
    vi.mocked(fetchChainInfoFromEndpoint).mockImplementation(async (url) => ({
      label: url,
      endpoint: url,
      network: networks[url],
      kind: 'parachain',
      specName: url,
    }));

    const result = await plan({
      fellowshipChainUrl: 'wss://collectives.example.com',
      governanceChainUrl: 'wss://asset-hub.example.com',
      ...BOTH_REFERENDA,
    });

    expect(result.kind, 'local zombienet URLs do not contain a network name').toBe('bridged');
  });

  it('single-consensus plan for both chains on one network or on an unknown network', async () => {
    for (const fellowshipChainUrl of [POLKADOT_COLLECTIVES, 'wss://local-devnet.example.com']) {
      const result = await plan({
        fellowshipChainUrl,
        governanceChainUrl: POLKADOT_ASSET_HUB,
        ...BOTH_REFERENDA,
      });
      expect(result.kind).toBe('single');
    }
  });

  it('only the chains of the referenda in the single-consensus plan', async () => {
    const result = await plan({
      fellowshipChainUrl: POLKADOT_COLLECTIVES,
      governanceChainUrl: POLKADOT_ASSET_HUB,
      referendum: '1',
    });

    expect(result.kind === 'single' && result.endpoints).toEqual({
      governance: { url: POLKADOT_ASSET_HUB },
      fellowship: undefined,
      additional: [],
    });
  });

  it('error for Kusama fellowship and Polkadot governance', async () => {
    await expect(
      plan({
        fellowshipChainUrl: KUSAMA_COLLECTIVES,
        governanceChainUrl: POLKADOT_ASSET_HUB,
        ...BOTH_REFERENDA,
      })
    ).rejects.toThrow(/Unsupported direction/);
  });

  it('error for a bridged run without a fellowship referendum', async () => {
    await expect(
      plan({
        fellowshipChainUrl: POLKADOT_COLLECTIVES,
        governanceChainUrl: KUSAMA_ASSET_HUB,
        callToCreateGovernanceReferendum: '0xfeedface',
      })
    ).rejects.toThrow(/requires a fellowship referendum/);
  });

  it('error for a referendum without the URL of its chain', async () => {
    await expect(
      plan({ fellowshipChainUrl: POLKADOT_COLLECTIVES, referendum: '1' })
    ).rejects.toThrow('--governance-chain-url is required when testing a governance referendum');
    await expect(plan({ governanceChainUrl: POLKADOT_ASSET_HUB, fellowship: '1' })).rejects.toThrow(
      '--fellowship-chain-url is required when testing a fellowship referendum'
    );
  });
});
