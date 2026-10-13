import {
  type ChainInfo,
  type ChainKind,
  fetchChainInfoFromEndpoint,
} from '../network/chain-identity';
import type { ForkSpec } from '../network/fork';
import type { ParsedEndpoint } from '../utils/chain-endpoint-parser';
import { buildChopsticksChainConfig, type StorageInjection } from '../utils/chopsticks-config';
import type { Logger } from '../utils/logger';

const BRIDGE_RUNTIME_LOG_LEVEL = 4;

export interface BridgeEndpoints {
  /** Polkadot Collectives — where the Fellowship referendum runs. */
  collectives: ParsedEndpoint;
  /** Polkadot Asset Hub — where `InitiateTransfer { preserve_origin: true }` executes. */
  assetHubPolkadot: ParsedEndpoint;
  /** Polkadot Bridge Hub — where `pallet_xcm_bridge_hub::ExportXcm` runs. */
  bridgeHubPolkadot: ParsedEndpoint;
  /** Kusama Asset Hub — final destination of the bridged XCM. */
  assetHubKusama: ParsedEndpoint;
  /** Kusama Bridge Hub — where the actual `pallet_bridge_messages` dispatch runs. */
  bridgeHubKusama: ParsedEndpoint;
  additionalPolkadot: AdditionalBridgeChain[];
  additionalKusama: AdditionalBridgeChain[];
}

export type BridgeRole = Exclude<keyof BridgeEndpoints, 'additionalPolkadot' | 'additionalKusama'>;

export interface BridgeInjections {
  fellowshipStorageOnCollectives: boolean;
  aliceOnAssetHubKusama: boolean;
}

export interface AdditionalBridgeChain {
  endpoint: ParsedEndpoint;
  kind: ChainKind;
  label: string;
}

export interface BridgeSideSpecs {
  specs: ForkSpec[];
  additionalKeys: string[];
}

function sideSpecs(
  cores: Array<{ key: BridgeRole; endpoint: ParsedEndpoint; injection?: StorageInjection }>,
  additional: AdditionalBridgeChain[],
  logger: Logger
): BridgeSideSpecs {
  const config = (endpoint: ParsedEndpoint, injection?: StorageInjection) =>
    buildChopsticksChainConfig(endpoint, { injection, runtimeLogLevel: BRIDGE_RUNTIME_LOG_LEVEL });
  const specs: ForkSpec[] = cores.map(({ key, endpoint, injection }) => ({
    key,
    kind: 'parachain',
    config: config(endpoint, injection),
  }));
  const additionalKeys: string[] = [];
  for (const [index, chain] of additional.entries()) {
    if (chain.kind === 'relay' && specs.some((spec) => spec.kind === 'relay')) {
      logger.warn(`Skipping additional relay ${chain.label}: this side already has a relay chain`);
      continue;
    }
    const key = `additional_${index}`;
    specs.push({ key, kind: chain.kind, config: config(chain.endpoint) });
    additionalKeys.push(key);
    logger.debug(`Bridged topology: monitoring ${chain.label} (${chain.kind}) as key '${key}'`);
  }
  return { specs, additionalKeys };
}

export function polkadotSideSpecs(
  endpoints: BridgeEndpoints,
  injections: BridgeInjections,
  logger: Logger
): BridgeSideSpecs {
  return sideSpecs(
    [
      {
        key: 'collectives',
        endpoint: endpoints.collectives,
        injection: injections.fellowshipStorageOnCollectives ? 'fellowship' : undefined,
      },
      { key: 'assetHubPolkadot', endpoint: endpoints.assetHubPolkadot },
      {
        key: 'bridgeHubPolkadot',
        endpoint: endpoints.bridgeHubPolkadot,
        injection: 'alice-account',
      },
    ],
    endpoints.additionalPolkadot,
    logger
  );
}

export function kusamaSideSpecs(
  endpoints: BridgeEndpoints,
  injections: BridgeInjections,
  logger: Logger
): BridgeSideSpecs {
  return sideSpecs(
    [
      {
        key: 'assetHubKusama',
        endpoint: endpoints.assetHubKusama,
        injection: injections.aliceOnAssetHubKusama ? 'alice-account' : undefined,
      },
      { key: 'bridgeHubKusama', endpoint: endpoints.bridgeHubKusama, injection: 'alice-account' },
    ],
    endpoints.additionalKusama,
    logger
  );
}

export async function classifyAdditionalBridgeChains(
  additional: ParsedEndpoint[],
  coreEndpoints: ParsedEndpoint[],
  logger: Logger,
  resolve: (url: string) => Promise<ChainInfo> = fetchChainInfoFromEndpoint
): Promise<{ polkadot: AdditionalBridgeChain[]; kusama: AdditionalBridgeChain[] }> {
  const polkadot: AdditionalBridgeChain[] = [];
  const kusama: AdditionalBridgeChain[] = [];
  if (additional.length === 0) return { polkadot, kusama };

  const lookup = (endpoint: ParsedEndpoint): Promise<ChainInfo | Error> =>
    resolve(endpoint.url).catch((error: Error) => error);
  const [coreInfos, additionalInfos] = await Promise.all([
    Promise.all(coreEndpoints.map(lookup)),
    Promise.all(additional.map(lookup)),
  ]);
  const topologyUrls = new Set(coreEndpoints.map((endpoint) => endpoint.url));
  const topologyLabels = new Set(
    coreInfos.flatMap((info) => (info instanceof Error ? [] : [info.label]))
  );

  for (const [index, endpoint] of additional.entries()) {
    const info = additionalInfos[index];
    if (info instanceof Error) {
      logger.warn(
        `Skipping additional chain ${endpoint.url}: chain info lookup failed: ${info.message}`
      );
      continue;
    }
    if (topologyUrls.has(endpoint.url) || topologyLabels.has(info.label)) {
      logger.debug(
        `Skipping additional chain ${info.label} (${endpoint.url}): already in the topology`
      );
      continue;
    }
    topologyUrls.add(endpoint.url);
    topologyLabels.add(info.label);
    const entry: AdditionalBridgeChain = { endpoint, kind: info.kind, label: info.label };
    if (info.network === 'polkadot') {
      polkadot.push(entry);
    } else if (info.network === 'kusama') {
      kusama.push(entry);
    } else {
      logger.warn(
        `Skipping additional chain ${info.label} (${endpoint.url}): network '${info.network}' is not part of the Polkadot↔Kusama bridge topology`
      );
    }
  }

  logger.debug(
    `Classified additional bridge chains: ${polkadot.length} polkadot-side, ${kusama.length} kusama-side`
  );
  return { polkadot, kusama };
}
