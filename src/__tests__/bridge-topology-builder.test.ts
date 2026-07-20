import { describe, expect, it, vi } from 'vitest';
import {
  type AdditionalBridgeChain,
  BridgeTopologyBuilder,
  type BridgeTopologyConfig,
  classifyAdditionalBridgeChains,
  KUSAMA_SIDE_KEYS,
  POLKADOT_SIDE_KEYS,
} from '../services/bridge-topology-builder';
import type { ChainInfo } from '../services/chain-registry';
import type { ParsedEndpoint } from '../utils/chain-endpoint-parser';
import type { Logger } from '../utils/logger';

function createSilentLogger(): Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    isVerbose: () => false,
    startSpinner: vi.fn(),
    succeedSpinner: vi.fn(),
    failSpinner: vi.fn(),
    updateSpinner: vi.fn(),
    stopSpinner: vi.fn(),
    section: vi.fn(),
    table: vi.fn(),
  } as unknown as Logger;
}

const COLLECTIVES = { url: 'wss://polkadot-collectives-rpc.polkadot.io', block: 100 };
const AHP = { url: 'wss://polkadot-asset-hub-rpc.polkadot.io', block: 200 };
const BHP = { url: 'wss://polkadot-bridge-hub-rpc.polkadot.io', block: 300 };
const AHK = { url: 'wss://kusama-asset-hub-rpc.polkadot.io', block: 50 };
const BHK = { url: 'wss://kusama-bridge-hub-rpc.polkadot.io' };

function makeBuilder(overrides: Partial<BridgeTopologyConfig> = {}): BridgeTopologyBuilder {
  return new BridgeTopologyBuilder(createSilentLogger(), {
    collectives: COLLECTIVES,
    assetHubPolkadot: AHP,
    bridgeHubPolkadot: BHP,
    assetHubKusama: AHK,
    bridgeHubKusama: BHK,
    ...overrides,
  });
}

describe('BridgeTopologyBuilder', () => {
  describe('buildPolkadotSide()', () => {
    it('produces a config with the three Polkadot parachains under the expected keys', () => {
      const builder = makeBuilder();
      const { networkConfig, keys } = builder.buildPolkadotSide();
      expect(Object.keys(networkConfig).sort()).toEqual(
        [
          POLKADOT_SIDE_KEYS.collectives,
          POLKADOT_SIDE_KEYS.assetHub,
          POLKADOT_SIDE_KEYS.bridgeHub,
        ].sort()
      );
      expect(keys).toBe(POLKADOT_SIDE_KEYS);
    });

    it('does NOT include a relay key — the shortcut path never spawns the relay', () => {
      const builder = makeBuilder();
      const { networkConfig } = builder.buildPolkadotSide();
      expect(networkConfig).not.toHaveProperty('polkadot');
    });

    it('passes through fork blocks for each parachain', () => {
      const builder = makeBuilder();
      const { networkConfig } = builder.buildPolkadotSide();
      const collectivesCfg = networkConfig[POLKADOT_SIDE_KEYS.collectives] as Record<
        string,
        unknown
      >;
      const ahpCfg = networkConfig[POLKADOT_SIDE_KEYS.assetHub] as Record<string, unknown>;
      const bhpCfg = networkConfig[POLKADOT_SIDE_KEYS.bridgeHub] as Record<string, unknown>;
      expect(collectivesCfg.block).toBe(100);
      expect(ahpCfg.block).toBe(200);
      expect(bhpCfg.block).toBe(300);
    });

    it('injects fellowship storage on Collectives when requested', () => {
      const builder = makeBuilder({ injectFellowshipStorage: true });
      const { networkConfig } = builder.buildPolkadotSide();
      const collectivesCfg = networkConfig[POLKADOT_SIDE_KEYS.collectives] as Record<
        string,
        unknown
      >;
      expect(collectivesCfg).toHaveProperty('import-storage');
      const inj = collectivesCfg['import-storage'] as Record<string, unknown>;
      expect(inj).toHaveProperty('FellowshipCollective');
    });

    it('does not inject any storage by default', () => {
      const builder = makeBuilder();
      const { networkConfig } = builder.buildPolkadotSide();
      const collectivesCfg = networkConfig[POLKADOT_SIDE_KEYS.collectives] as Record<
        string,
        unknown
      >;
      expect(collectivesCfg).not.toHaveProperty('import-storage');
    });

    it('marks each chain config with manual block-mode and signature host mock', () => {
      const builder = makeBuilder();
      const { networkConfig } = builder.buildPolkadotSide();
      for (const key of Object.values(POLKADOT_SIDE_KEYS)) {
        const cfg = networkConfig[key] as Record<string, unknown>;
        // BuildBlockMode.Manual is a TS enum value ('Manual'); chopsticks accepts it.
        expect(String(cfg['build-block-mode']).toLowerCase()).toBe('manual');
        expect(cfg['mock-signature-host']).toBe(true);
      }
    });
  });

  describe('buildKusamaSide()', () => {
    it('produces a config with AHK + BHK under the expected keys', () => {
      const builder = makeBuilder();
      const { networkConfig, keys } = builder.buildKusamaSide();
      expect(Object.keys(networkConfig).sort()).toEqual(
        [KUSAMA_SIDE_KEYS.assetHub, KUSAMA_SIDE_KEYS.bridgeHub].sort()
      );
      expect(keys).toBe(KUSAMA_SIDE_KEYS);
    });

    it('does NOT include a relay key — the shortcut path never spawns the Kusama relay', () => {
      const builder = makeBuilder();
      const { networkConfig } = builder.buildKusamaSide();
      expect(networkConfig).not.toHaveProperty('kusama');
    });

    it('passes through fork blocks for parachains', () => {
      const builder = makeBuilder();
      const { networkConfig } = builder.buildKusamaSide();
      const ahkCfg = networkConfig[KUSAMA_SIDE_KEYS.assetHub] as Record<string, unknown>;
      expect(ahkCfg.block).toBe(50);
    });

    it('injects Alice funded account on AHK when requested (needed for AHK public referendum)', () => {
      const builder = makeBuilder({ injectAliceOnAssetHubKusama: true });
      const { networkConfig } = builder.buildKusamaSide();
      const ahkCfg = networkConfig[KUSAMA_SIDE_KEYS.assetHub] as Record<string, unknown>;
      expect(ahkCfg).toHaveProperty('import-storage');
      const inj = ahkCfg['import-storage'] as Record<string, unknown>;
      // ALICE_ACCOUNT_INJECTION writes a System.Account entry for Alice.
      expect(inj).toHaveProperty('System');
    });

    it('does not inject Alice on AHK by default', () => {
      const builder = makeBuilder();
      const { networkConfig } = builder.buildKusamaSide();
      const ahkCfg = networkConfig[KUSAMA_SIDE_KEYS.assetHub] as Record<string, unknown>;
      expect(ahkCfg).not.toHaveProperty('import-storage');
    });
  });

  it('Polkadot- and Kusama-side network configs have disjoint chain keys', () => {
    const builder = makeBuilder();
    const polkadot = builder.buildPolkadotSide();
    const kusama = builder.buildKusamaSide();
    expect(Object.keys(polkadot.networkConfig)).not.toEqual(
      expect.arrayContaining(Object.keys(kusama.networkConfig))
    );
  });

  describe('additional-chains routing', () => {
    const relay = (url: string): AdditionalBridgeChain => ({
      endpoint: { url },
      kind: 'relay',
      label: url.includes('kusama') ? 'kusama' : 'polkadot',
    });
    const para = (url: string, label: string): AdditionalBridgeChain => ({
      endpoint: { url },
      kind: 'parachain',
      label,
    });

    it('places a Kusama relay under the reserved `kusama` key and parachains under `extra_<n>`', () => {
      const builder = makeBuilder({
        additionalKusama: [
          relay('wss://kusama-rpc.example'),
          para('wss://encointer.example', 'encointer-parachain'),
          para('wss://coretime-kusama.example', 'coretime-kusama'),
        ],
      });
      const { networkConfig } = builder.buildKusamaSide();
      expect(Object.keys(networkConfig).sort()).toEqual(
        [
          KUSAMA_SIDE_KEYS.assetHub,
          KUSAMA_SIDE_KEYS.bridgeHub,
          'kusama',
          'extra_0',
          'extra_1',
        ].sort()
      );
      expect((networkConfig.kusama as Record<string, unknown>).endpoint).toBe(
        'wss://kusama-rpc.example'
      );
    });

    it('routes Polkadot-side additional parachains onto the Polkadot side only', () => {
      const builder = makeBuilder({
        additionalPolkadot: [para('wss://people-polkadot.example', 'people-polkadot')],
      });
      const { networkConfig } = builder.buildPolkadotSide();
      expect(networkConfig).toHaveProperty('extra_0');
      expect(networkConfig).not.toHaveProperty('kusama');
    });

    it('honours only one relay per side (a second relay is dropped)', () => {
      const builder = makeBuilder({
        additionalKusama: [relay('wss://kusama-rpc.a'), relay('wss://kusama-rpc.b')],
      });
      const { networkConfig } = builder.buildKusamaSide();
      const relayKeys = Object.keys(networkConfig).filter((k) => k === 'kusama');
      expect(relayKeys).toHaveLength(1);
      expect(networkConfig).not.toHaveProperty('extra_0');
    });
  });
});

describe('classifyAdditionalBridgeChains', () => {
  const ep = (url: string): ParsedEndpoint => ({ url });
  const info = (
    network: ChainInfo['network'],
    kind: ChainInfo['kind'],
    label: string,
    endpoint: string
  ): ChainInfo => ({ id: label, label, endpoint, network, kind, specName: label });

  // The five core bridge chains, by URL.
  const CORE = [
    ep('wss://collectives.dot'),
    ep('wss://ahp.dot'),
    ep('wss://bhp.dot'),
    ep('wss://ahk.ksm'), // governance / AHK
    ep('wss://bhk.ksm'),
  ];

  // Resolver maps a URL to its chain identity. Two URLs resolve to the SAME AHK chain
  // identity (statemine) to exercise identity-based dedup across differing hosts.
  const resolve = async (url: string): Promise<ChainInfo> => {
    const table: Record<string, ChainInfo> = {
      'wss://collectives.dot': info('polkadot', 'parachain', 'collectives', url),
      'wss://ahp.dot': info('polkadot', 'parachain', 'statemint', url),
      'wss://bhp.dot': info('polkadot', 'parachain', 'bridge-hub-polkadot', url),
      'wss://ahk.ksm': info('kusama', 'parachain', 'statemine', url),
      'wss://bhk.ksm': info('kusama', 'parachain', 'bridge-hub-kusama', url),
      // additional chains
      'wss://kusama-rpc.dwellir': info('kusama', 'relay', 'kusama', url),
      'wss://encointer.dwellir': info('kusama', 'parachain', 'encointer-parachain', url),
      'wss://ahk-other-host.dwellir': info('kusama', 'parachain', 'statemine', url), // == AHK
      'wss://people-polkadot.dot': info('polkadot', 'parachain', 'people-polkadot', url),
    };
    if (!table[url]) throw new Error(`unreachable: ${url}`);
    return table[url];
  };

  it('routes chains to the correct side and keeps the relay', async () => {
    const { polkadot, kusama } = await classifyAdditionalBridgeChains(
      [
        ep('wss://kusama-rpc.dwellir'),
        ep('wss://encointer.dwellir'),
        ep('wss://people-polkadot.dot'),
      ],
      CORE,
      createSilentLogger(),
      resolve
    );
    expect(kusama.map((c) => c.label).sort()).toEqual(['encointer-parachain', 'kusama']);
    expect(kusama.find((c) => c.label === 'kusama')?.kind).toBe('relay');
    expect(polkadot.map((c) => c.label)).toEqual(['people-polkadot']);
  });

  it('dedups a core chain reached via a different host (AHK identity match)', async () => {
    const { kusama } = await classifyAdditionalBridgeChains(
      [ep('wss://ahk-other-host.dwellir'), ep('wss://encointer.dwellir')],
      CORE,
      createSilentLogger(),
      resolve
    );
    // AHK (statemine) is a core chain → dropped despite the different URL; only encointer remains.
    expect(kusama.map((c) => c.label)).toEqual(['encointer-parachain']);
  });

  it('dedups a core chain reached via the exact same URL', async () => {
    const { kusama } = await classifyAdditionalBridgeChains(
      [ep('wss://ahk.ksm'), ep('wss://encointer.dwellir')],
      CORE,
      createSilentLogger(),
      resolve
    );
    expect(kusama.map((c) => c.label)).toEqual(['encointer-parachain']);
  });

  it('skips chains it cannot resolve and chains off the polkadot/kusama networks', async () => {
    const logger = createSilentLogger();
    const offNetwork = async (url: string): Promise<ChainInfo> => {
      if (url === 'wss://paseo.rpc') return info('paseo', 'relay', 'paseo', url);
      throw new Error('boom');
    };
    const { polkadot, kusama } = await classifyAdditionalBridgeChains(
      [ep('wss://paseo.rpc'), ep('wss://dead.rpc')],
      [],
      logger,
      offNetwork
    );
    expect(polkadot).toHaveLength(0);
    expect(kusama).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });
});
