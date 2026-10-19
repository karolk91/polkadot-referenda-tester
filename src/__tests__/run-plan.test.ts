import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BRIDGE_URLS, type TestOptions } from '../commands/test-options';
import { planRun } from '../commands/test-referendum';
import { type ChainInfo, fetchChainInfoFromEndpoint } from '../network/chain-identity';
import { chainInfo, createTestLogger, testOptions } from './helpers';

vi.mock('../network/chain-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../network/chain-identity')>()),
  fetchChainInfoFromEndpoint: vi.fn(),
}));

const POLKADOT_COLLECTIVES = 'wss://polkadot-collectives-rpc.polkadot.io';
const POLKADOT_ASSET_HUB = 'wss://polkadot-asset-hub-rpc.polkadot.io';
const KUSAMA_ASSET_HUB = 'wss://kusama-asset-hub-rpc.polkadot.io';
const KUSAMA_COLLECTIVES = 'wss://kusama-collectives-rpc.polkadot.io';
const LOCAL_COLLECTIVES = 'ws://127.0.0.1:9100';
const LOCAL_ASSET_HUB = 'ws://127.0.0.1:9200';
const LOCAL_DEVNET = 'ws://127.0.0.1:9300';

const CHAIN_INFO_BY_URL: Record<string, ChainInfo> = {
  [POLKADOT_COLLECTIVES]: chainInfo('collectives', 'polkadot', 'parachain', POLKADOT_COLLECTIVES),
  [POLKADOT_ASSET_HUB]: chainInfo('statemint', 'polkadot', 'parachain', POLKADOT_ASSET_HUB),
  [KUSAMA_ASSET_HUB]: chainInfo('statemine', 'kusama', 'parachain', KUSAMA_ASSET_HUB),
  [KUSAMA_COLLECTIVES]: chainInfo('collectives-kusama', 'kusama', 'parachain', KUSAMA_COLLECTIVES),
  [LOCAL_COLLECTIVES]: chainInfo('collectives', 'polkadot', 'parachain', LOCAL_COLLECTIVES),
  [LOCAL_ASSET_HUB]: chainInfo('statemine', 'kusama', 'parachain', LOCAL_ASSET_HUB),
  [LOCAL_DEVNET]: chainInfo('devnet', 'unknown', 'parachain', LOCAL_DEVNET),
};

const BOTH_REFERENDA = {
  callToCreateFellowshipReferendum: '0xdeadbeef',
  callToCreateGovernanceReferendum: '0xfeedface',
};

function plan(options: Partial<TestOptions>) {
  return planRun(testOptions(options), createTestLogger());
}

describe('planRun', () => {
  beforeEach(() => {
    vi.mocked(fetchChainInfoFromEndpoint).mockReset();
    vi.mocked(fetchChainInfoFromEndpoint).mockImplementation(async (url) => {
      const info = CHAIN_INFO_BY_URL[url];
      if (!info) throw new Error(`offline: ${url}`);
      return info;
    });
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

  it('network from the runtime of each chain', async () => {
    const result = await plan({
      fellowshipChainUrl: LOCAL_COLLECTIVES,
      governanceChainUrl: LOCAL_ASSET_HUB,
      ...BOTH_REFERENDA,
    });

    expect(result.kind, 'local zombienet URLs do not contain a network name').toBe('bridged');
  });

  it('single-consensus plan for both chains on one network or on an unknown network', async () => {
    for (const fellowshipChainUrl of [POLKADOT_COLLECTIVES, LOCAL_DEVNET]) {
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

  it('no chain lookup for a run with one chain', async () => {
    await plan({ governanceChainUrl: 'ws://127.0.0.1:1', referendum: '1' });

    expect(fetchChainInfoFromEndpoint).not.toHaveBeenCalled();
  });

  it('error for an unreachable chain', async () => {
    await expect(
      plan({
        fellowshipChainUrl: 'ws://127.0.0.1:1',
        governanceChainUrl: POLKADOT_ASSET_HUB,
        ...BOTH_REFERENDA,
      }),
      'the chain identity decides the scenario, so the plan cannot guess it from the URL'
    ).rejects.toThrow('offline: ws://127.0.0.1:1');
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
