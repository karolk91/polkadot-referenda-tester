import { type ChainInfo, fetchChainInfoFromEndpoint } from '../network/chain-identity';
import {
  additionalForkSpecs,
  type DetectedChain,
  forkSpec,
} from '../network/chain-topology-builder';
import type { ForkSpec } from '../network/fork';
import type { ParsedEndpoint } from '../utils/chain-endpoint-parser';
import type { StorageInjection } from '../utils/chopsticks-config';
import type { Logger } from '../utils/logger';
import type { ReferendumRoles } from '../utils/referendum-steps';

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
  additionalPolkadot: DetectedChain[];
  additionalKusama: DetectedChain[];
}

export type BridgeRole = Exclude<keyof BridgeEndpoints, 'additionalPolkadot' | 'additionalKusama'>;

export interface BridgeSideSpecs {
  specs: ForkSpec[];
  additionalKeys: string[];
}

function sideSpecs(
  cores: Array<{ key: BridgeRole; endpoint: ParsedEndpoint; injection?: StorageInjection }>,
  additional: DetectedChain[],
  logger: Logger
): BridgeSideSpecs {
  const coreSpecs = cores.map(({ key, endpoint, injection }) =>
    forkSpec(key, endpoint, 'parachain', { injection, runtimeLogLevel: BRIDGE_RUNTIME_LOG_LEVEL })
  );
  const additionalSpecs = additionalForkSpecs(additional, false, BRIDGE_RUNTIME_LOG_LEVEL, logger);
  return {
    specs: [...coreSpecs, ...additionalSpecs],
    additionalKeys: additionalSpecs.map((spec) => spec.key),
  };
}

export function polkadotSideSpecs(
  endpoints: BridgeEndpoints,
  creations: ReferendumRoles,
  logger: Logger
): BridgeSideSpecs {
  return sideSpecs(
    [
      {
        key: 'collectives',
        endpoint: endpoints.collectives,
        injection: creations.fellowship ? 'fellowship' : undefined,
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
  creations: ReferendumRoles,
  logger: Logger
): BridgeSideSpecs {
  return sideSpecs(
    [
      {
        key: 'assetHubKusama',
        endpoint: endpoints.assetHubKusama,
        injection: creations.governance ? 'alice-account' : undefined,
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
): Promise<{ polkadot: DetectedChain[]; kusama: DetectedChain[] }> {
  const polkadot: DetectedChain[] = [];
  const kusama: DetectedChain[] = [];
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
    const chain: DetectedChain = { endpoint, info };
    if (info.network === 'polkadot') {
      polkadot.push(chain);
    } else if (info.network === 'kusama') {
      kusama.push(chain);
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
