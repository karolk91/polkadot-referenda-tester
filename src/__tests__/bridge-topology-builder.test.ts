import { describe, expect, it, vi } from 'vitest';
import {
  type AdditionalBridgeChain,
  type BridgeEndpoints,
  type BridgeInjections,
  classifyAdditionalBridgeChains,
  kusamaSideSpecs,
  polkadotSideSpecs,
} from '../bridge/bridge-topology-builder';
import type { ChainInfo } from '../network/chain-identity';
import type { ForkSpec } from '../network/fork';
import type { ParsedEndpoint } from '../utils/chain-endpoint-parser';
import { createTestLogger } from './helpers';

const ENDPOINTS: BridgeEndpoints = {
  collectives: { url: 'wss://polkadot-collectives-rpc.polkadot.io', block: 100 },
  assetHubPolkadot: { url: 'wss://polkadot-asset-hub-rpc.polkadot.io', block: 200 },
  bridgeHubPolkadot: { url: 'wss://polkadot-bridge-hub-rpc.polkadot.io', block: 300 },
  assetHubKusama: { url: 'wss://kusama-asset-hub-rpc.polkadot.io', block: 50 },
  bridgeHubKusama: { url: 'wss://kusama-bridge-hub-rpc.polkadot.io' },
  additionalPolkadot: [],
  additionalKusama: [],
};

const NO_CREATIONS: BridgeInjections = {
  fellowshipStorageOnCollectives: false,
  aliceOnAssetHubKusama: false,
};

function specByKey(specs: ForkSpec[], key: string): ForkSpec {
  const spec = specs.find((candidate) => candidate.key === key);
  if (!spec) throw new Error(`no fork spec for ${key}`);
  return spec;
}

function bothSides(endpoints: BridgeEndpoints, injections: BridgeInjections): ForkSpec[] {
  const logger = createTestLogger();
  return [
    ...polkadotSideSpecs(endpoints, injections, logger).specs,
    ...kusamaSideSpecs(endpoints, injections, logger).specs,
  ];
}

function relay(url: string, label: string): AdditionalBridgeChain {
  return { endpoint: { url }, kind: 'relay', label };
}

function parachain(url: string, label: string): AdditionalBridgeChain {
  return { endpoint: { url }, kind: 'parachain', label };
}

describe('bridge side specs', () => {
  it('core chains of each side at the requested blocks, without a relay', () => {
    const logger = createTestLogger();
    const polkadot = polkadotSideSpecs(ENDPOINTS, NO_CREATIONS, logger);
    const kusama = kusamaSideSpecs(ENDPOINTS, NO_CREATIONS, logger);

    expect(polkadot.specs.map((spec) => [spec.key, spec.kind, spec.config.block])).toEqual([
      ['collectives', 'parachain', 100],
      ['assetHubPolkadot', 'parachain', 200],
      ['bridgeHubPolkadot', 'parachain', 300],
    ]);
    expect(kusama.specs.map((spec) => [spec.key, spec.kind, spec.config.block])).toEqual([
      ['assetHubKusama', 'parachain', 50],
      ['bridgeHubKusama', 'parachain', undefined],
    ]);
    expect(polkadot.additionalKeys).toEqual([]);
    expect(kusama.additionalKeys).toEqual([]);
  });

  it('manual block building and mock signatures on every fork', () => {
    for (const spec of bothSides(ENDPOINTS, NO_CREATIONS)) {
      expect(
        String(spec.config['build-block-mode']).toLowerCase(),
        'the tool builds every block itself to control the scheduler'
      ).toBe('manual');
      expect(spec.config['mock-signature-host'], 'Alice signs with a fake signature').toBe(true);
    }
  });

  it('Alice funded on both Bridge Hubs', () => {
    const specs = bothSides(ENDPOINTS, NO_CREATIONS);
    for (const key of ['bridgeHubPolkadot', 'bridgeHubKusama']) {
      expect(
        specByKey(specs, key).config['import-storage'],
        'the relayer signs delivery and confirmation transactions with Alice and pays their fees'
      ).toHaveProperty('System.Account');
    }
  });

  it('storage injections only for referendum creations', () => {
    const plain = bothSides(ENDPOINTS, NO_CREATIONS);
    expect(specByKey(plain, 'collectives').config).not.toHaveProperty('import-storage');
    expect(specByKey(plain, 'assetHubKusama').config).not.toHaveProperty('import-storage');

    const creations = bothSides(ENDPOINTS, {
      fellowshipStorageOnCollectives: true,
      aliceOnAssetHubKusama: true,
    });
    expect(
      specByKey(creations, 'collectives').config['import-storage'],
      'Alice submits the fellowship referendum as a ranked fellow'
    ).toHaveProperty('FellowshipCollective.Members');
    expect(
      specByKey(creations, 'assetHubKusama').config['import-storage'],
      'Alice pays the submission deposit of the governance referendum'
    ).toHaveProperty('System.Account');
  });

  it('additional chains on their own side, with at most one relay per side', () => {
    const logger = createTestLogger();
    const endpoints: BridgeEndpoints = {
      ...ENDPOINTS,
      additionalPolkadot: [parachain('wss://people-polkadot.example', 'people-polkadot')],
      additionalKusama: [
        relay('wss://kusama-rpc.a', 'kusama'),
        parachain('wss://encointer.example', 'encointer-parachain'),
        relay('wss://kusama-rpc.b', 'kusama'),
      ],
    };
    const polkadot = polkadotSideSpecs(endpoints, NO_CREATIONS, logger);
    const kusama = kusamaSideSpecs(endpoints, NO_CREATIONS, logger);

    expect(
      polkadot.additionalKeys.map((key) => specByKey(polkadot.specs, key).config.endpoint)
    ).toEqual(['wss://people-polkadot.example']);
    expect(
      kusama.additionalKeys.map((key) => {
        const spec = specByKey(kusama.specs, key);
        return [spec.config.endpoint, spec.kind];
      }),
      'every parachain fork of a side connects to the one relay fork of that side'
    ).toEqual([
      ['wss://kusama-rpc.a', 'relay'],
      ['wss://encointer.example', 'parachain'],
    ]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe('classifyAdditionalBridgeChains', () => {
  const endpoint = (url: string): ParsedEndpoint => ({ url });
  const chainInfo = (
    network: ChainInfo['network'],
    kind: ChainInfo['kind'],
    label: string,
    url: string
  ): ChainInfo => ({ label, endpoint: url, network, kind, specName: label });

  const CORE_ENDPOINTS = [
    endpoint('wss://collectives.dot'),
    endpoint('wss://ahp.dot'),
    endpoint('wss://bhp.dot'),
    endpoint('wss://ahk.ksm'),
    endpoint('wss://bhk.ksm'),
  ];

  const CHAIN_INFO_BY_URL: Record<string, ChainInfo> = {
    'wss://collectives.dot': chainInfo(
      'polkadot',
      'parachain',
      'collectives',
      'wss://collectives.dot'
    ),
    'wss://ahp.dot': chainInfo('polkadot', 'parachain', 'statemint', 'wss://ahp.dot'),
    'wss://bhp.dot': chainInfo('polkadot', 'parachain', 'bridge-hub-polkadot', 'wss://bhp.dot'),
    'wss://ahk.ksm': chainInfo('kusama', 'parachain', 'statemine', 'wss://ahk.ksm'),
    'wss://bhk.ksm': chainInfo('kusama', 'parachain', 'bridge-hub-kusama', 'wss://bhk.ksm'),
    'wss://kusama-rpc.dwellir': chainInfo('kusama', 'relay', 'kusama', 'wss://kusama-rpc.dwellir'),
    'wss://encointer.dwellir': chainInfo(
      'kusama',
      'parachain',
      'encointer-parachain',
      'wss://encointer.dwellir'
    ),
    'wss://ahk-other-host.dwellir': chainInfo(
      'kusama',
      'parachain',
      'statemine',
      'wss://ahk-other-host.dwellir'
    ),
    'wss://people-polkadot.dot': chainInfo(
      'polkadot',
      'parachain',
      'people-polkadot',
      'wss://people-polkadot.dot'
    ),
  };

  const chainInfoLookup = async (url: string): Promise<ChainInfo> => {
    const info = CHAIN_INFO_BY_URL[url];
    if (!info) throw new Error(`unreachable: ${url}`);
    return info;
  };

  it('side and kind of each additional chain', async () => {
    const { polkadot, kusama } = await classifyAdditionalBridgeChains(
      [
        endpoint('wss://kusama-rpc.dwellir'),
        endpoint('wss://encointer.dwellir'),
        endpoint('wss://people-polkadot.dot'),
      ],
      CORE_ENDPOINTS,
      createTestLogger(),
      chainInfoLookup
    );

    expect(kusama.map((chain) => [chain.label, chain.kind])).toEqual([
      ['kusama', 'relay'],
      ['encointer-parachain', 'parachain'],
    ]);
    expect(polkadot.map((chain) => chain.label)).toEqual(['people-polkadot']);
  });

  it('no second fork of a core chain, at the same URL or on another host', async () => {
    for (const duplicate of ['wss://ahk.ksm', 'wss://ahk-other-host.dwellir']) {
      const { kusama } = await classifyAdditionalBridgeChains(
        [endpoint(duplicate), endpoint('wss://encointer.dwellir')],
        CORE_ENDPOINTS,
        createTestLogger(),
        chainInfoLookup
      );
      expect(
        kusama.map((chain) => chain.label),
        'a second fork of Kusama Asset Hub would not see the bridged XCM'
      ).toEqual(['encointer-parachain']);
    }
  });

  it('warnings instead of chains without chain info or outside Polkadot and Kusama', async () => {
    const logger = createTestLogger();
    const paseoOnly = async (url: string): Promise<ChainInfo> => {
      if (url === 'wss://paseo.rpc') return chainInfo('paseo', 'relay', 'paseo', url);
      throw new Error('connection refused');
    };

    const { polkadot, kusama } = await classifyAdditionalBridgeChains(
      [endpoint('wss://paseo.rpc'), endpoint('wss://dead.rpc')],
      [],
      logger,
      paseoOnly
    );

    expect(polkadot).toEqual([]);
    expect(kusama).toEqual([]);
    expect(vi.mocked(logger.warn).mock.calls.map(([message]) => message)).toEqual([
      "Skipping additional chain paseo (wss://paseo.rpc): network 'paseo' is not part of the Polkadot↔Kusama bridge topology",
      'Skipping additional chain wss://dead.rpc: chain info lookup failed: connection refused',
    ]);
  });
});
