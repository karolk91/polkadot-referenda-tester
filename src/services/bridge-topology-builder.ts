import { BuildBlockMode } from '@acala-network/chopsticks-core';
import * as path from 'path';
import type { ParsedEndpoint } from '../utils/chain-endpoint-parser';
import type { Logger } from '../utils/logger';
import { ALICE_ACCOUNT_INJECTION, FELLOWSHIP_STORAGE_INJECTION } from '../utils/storage-constants';
import { type ChainInfo, type ChainKind, fetchChainInfoFromEndpoint } from './chain-registry';

/**
 * Network keys used in each side's `setupNetworks` call. The relay key MUST be
 * `polkadot` or `kusama` (lowercase) so that chopsticks-testing's `setupNetworks`
 * picks it as the relay (`chopsticks/packages/utils/src/index.ts:194`).
 */
export const POLKADOT_SIDE_KEYS = {
  collectives: 'collectives',
  assetHub: 'assetHubPolkadot',
  bridgeHub: 'bridgeHubPolkadot',
} as const;

export const KUSAMA_SIDE_KEYS = {
  assetHub: 'assetHubKusama',
  bridgeHub: 'bridgeHubKusama',
} as const;

export interface BridgeTopologyConfig {
  /** Polkadot Collectives — where the Fellowship referendum runs. Mandatory. */
  collectives: ParsedEndpoint;
  /** Polkadot Asset Hub — where `InitiateTransfer { preserve_origin: true }` executes. */
  assetHubPolkadot: ParsedEndpoint;
  /** Polkadot Bridge Hub — where `pallet_xcm_bridge_hub::ExportXcm` runs. */
  bridgeHubPolkadot: ParsedEndpoint;
  /** Kusama Asset Hub — final destination of the bridged XCM. */
  assetHubKusama: ParsedEndpoint;
  /** Kusama Bridge Hub — where the actual `pallet_bridge_messages` dispatch runs. */
  bridgeHubKusama: ParsedEndpoint;
  /** Whether to inject Alice as fellow + funds on Collectives. */
  injectFellowshipStorage?: boolean;
  /** Whether to inject Alice's funded account on AHP (e.g. for fellowship-create flow). */
  injectAliceOnAssetHubPolkadot?: boolean;
  /** Whether to inject Alice's funded account on AHK (required when the AHK public referendum runs). */
  injectAliceOnAssetHubKusama?: boolean;
  /**
   * Whether to inject Alice's funded account on BHK. Required for receive_messages_proof
   * submission — chopsticks's `mock-signature-host` only waves through signature
   * verification, but the runtime's transaction-payment hook still deducts fees from
   * the signer's account. Alice has zero balance in live BHK production state.
   */
  injectAliceOnBridgeHubKusama?: boolean;
  /**
   * Extra Polkadot-network chains (from `--additional-chains`) to spawn and monitor on
   * the Polkadot side, e.g. the relay or non-bridge system parachains. Classified by
   * {@link classifyAdditionalBridgeChains}. A `relay`-kind entry takes the reserved
   * `polkadot` key (enabling relay-HRMP wiring); parachains get `extra_<n>` keys.
   */
  additionalPolkadot?: AdditionalBridgeChain[];
  /** Extra Kusama-network chains to spawn and monitor on the Kusama side. See {@link additionalPolkadot}. */
  additionalKusama?: AdditionalBridgeChain[];
}

/**
 * An extra chain pulled from `--additional-chains` and routed onto one side of the
 * bridged topology. `kind` decides the chopsticks key (`relay` → the side's reserved
 * relay key; `parachain` → an `extra_<n>` key); `label` is for log lines.
 */
export interface AdditionalBridgeChain {
  endpoint: ParsedEndpoint;
  kind: ChainKind;
  label: string;
}

/**
 * Builds two `setupNetworks` configs — one per relay — for bridged tests.
 *
 * Two separate calls are required because chopsticks-testing's `setupNetworks` picks a
 * single key matching `polkadot|kusama` as the relay and HRMP-wires every other parachain
 * to it. Mixing two relays in one call is not supported.
 */
export class BridgeTopologyBuilder {
  private logger: Logger;
  private config: BridgeTopologyConfig;

  constructor(logger: Logger, config: BridgeTopologyConfig) {
    this.logger = logger;
    this.config = config;
  }

  /**
   * Build the Polkadot-side `setupNetworks` config.
   * Includes (optionally) the relay, Collectives, AHP, and BHP.
   */
  buildPolkadotSide(): {
    networkConfig: Record<string, unknown>;
    keys: typeof POLKADOT_SIDE_KEYS;
  } {
    const networkConfig: Record<string, unknown> = {};

    networkConfig[POLKADOT_SIDE_KEYS.collectives] = this.buildConfig(
      this.config.collectives.url,
      this.config.collectives.block,
      this.config.injectFellowshipStorage ? 'fellowship' : undefined,
      this.config.collectives.baseConfig
    );
    networkConfig[POLKADOT_SIDE_KEYS.assetHub] = this.buildConfig(
      this.config.assetHubPolkadot.url,
      this.config.assetHubPolkadot.block,
      this.config.injectAliceOnAssetHubPolkadot ? 'alice-account' : undefined,
      this.config.assetHubPolkadot.baseConfig
    );
    networkConfig[POLKADOT_SIDE_KEYS.bridgeHub] = this.buildConfig(
      this.config.bridgeHubPolkadot.url,
      this.config.bridgeHubPolkadot.block,
      undefined,
      this.config.bridgeHubPolkadot.baseConfig
    );

    this.appendAdditionalChains(networkConfig, this.config.additionalPolkadot ?? [], 'polkadot');

    this.logger.debug(`Polkadot-side topology: ${Object.keys(networkConfig).join(', ')}`);

    return { networkConfig, keys: POLKADOT_SIDE_KEYS };
  }

  /**
   * Build the Kusama-side `setupNetworks` config.
   * Includes (optionally) the relay, AHK, and BHK.
   */
  buildKusamaSide(): {
    networkConfig: Record<string, unknown>;
    keys: typeof KUSAMA_SIDE_KEYS;
  } {
    const networkConfig: Record<string, unknown> = {};

    networkConfig[KUSAMA_SIDE_KEYS.assetHub] = this.buildConfig(
      this.config.assetHubKusama.url,
      this.config.assetHubKusama.block,
      this.config.injectAliceOnAssetHubKusama ? 'alice-account' : undefined,
      this.config.assetHubKusama.baseConfig
    );
    networkConfig[KUSAMA_SIDE_KEYS.bridgeHub] = this.buildConfig(
      this.config.bridgeHubKusama.url,
      this.config.bridgeHubKusama.block,
      this.config.injectAliceOnBridgeHubKusama ? 'alice-account' : undefined,
      this.config.bridgeHubKusama.baseConfig
    );

    this.appendAdditionalChains(networkConfig, this.config.additionalKusama ?? [], 'kusama');

    this.logger.debug(`Kusama-side topology: ${Object.keys(networkConfig).join(', ')}`);

    return { networkConfig, keys: KUSAMA_SIDE_KEYS };
  }

  /**
   * Append `--additional-chains` entries to one side's `setupNetworks` config.
   *
   * The relay (if any) takes the reserved lowercase relay key (`polkadot`/`kusama`) so
   * chopsticks-testing wires it as the relay and HRMP-connects the side's parachains to
   * it; at most one relay per side is honoured (a second is skipped with a warning, since
   * `setupNetworks` only recognises a single relay key). Parachains take `extra_<n>` keys
   * that never collide with the reserved core keys (collectives, assetHub, bridgeHub).
   */
  private appendAdditionalChains(
    networkConfig: Record<string, unknown>,
    chains: AdditionalBridgeChain[],
    relayKey: 'polkadot' | 'kusama'
  ): void {
    let relayClaimed = relayKey in networkConfig;
    let paraIndex = 0;
    for (const chain of chains) {
      let key: string;
      if (chain.kind === 'relay') {
        if (relayClaimed) {
          this.logger.warn(
            `Skipping additional relay ${chain.label}: the ${relayKey} side already has a relay (setupNetworks supports one relay per side)`
          );
          continue;
        }
        key = relayKey;
        relayClaimed = true;
      } else {
        key = `extra_${paraIndex++}`;
      }
      networkConfig[key] = this.buildConfig(
        chain.endpoint.url,
        chain.endpoint.block,
        undefined,
        chain.endpoint.baseConfig
      );
      this.logger.debug(
        `Bridged topology: monitoring ${chain.label} (${chain.kind}) as key '${key}'`
      );
    }
  }

  /**
   * Per-chain Chopsticks config. Mirrors `ChainTopologyBuilder.buildConfig` with
   * the same defaults; bridge-specific tests don't need anything different yet.
   */
  buildConfig(
    endpoint: string,
    block?: number,
    storageInjection?: 'fellowship' | 'alice-account',
    userBaseConfig?: Record<string, unknown>
  ): Record<string, unknown> {
    // Layer order (highest precedence last wins):
    //   1. tool defaults — db, runtime-log-level
    //   2. user's YAML baseConfig — runtime-log-level override, wasm-override, etc.
    //   3. tool-mandatory test-harness settings — build-block-mode/mock-signature-host
    //      cannot be disabled by the user
    //   4. explicit endpoint / block from the URL flag (always win)
    //   5. import-storage — deep-merged: user's + tool's storage-injection combined
    //
    // To use the fellows debug runtime (so `runtime-log-level=4` surfaces `log::*`),
    // point the corresponding `--*-url` at a chopsticks YAML config that sets
    // `wasm-override: ./runtimes/debug/<chain>_runtime.compact.compressed.wasm`.
    const toolDefaults: Record<string, unknown> = {
      db: path.join(process.cwd(), '.chopsticks-db'),
      'runtime-log-level': 4,
    };

    const mandatory: Record<string, unknown> = {
      endpoint,
      'build-block-mode': BuildBlockMode.Manual,
      'mock-signature-host': true,
      'allow-unresolved-imports': true,
    };
    if (block !== undefined) {
      mandatory.block = block;
    }

    const config: Record<string, unknown> = {
      ...toolDefaults,
      ...(userBaseConfig ?? {}),
      ...mandatory,
    };

    // Storage-injection merges with whatever the user's YAML put under import-storage.
    const injected =
      storageInjection === 'fellowship'
        ? FELLOWSHIP_STORAGE_INJECTION
        : storageInjection === 'alice-account'
          ? ALICE_ACCOUNT_INJECTION
          : undefined;
    if (injected) {
      const existing =
        (userBaseConfig?.['import-storage'] as Record<string, unknown> | undefined) ?? {};
      config['import-storage'] = mergeImportStorage(existing, injected as Record<string, unknown>);
    }

    return config;
  }
}

/**
 * Shallow-merge two `import-storage` blocks (pallet-name → value). When both inputs
 * have the same pallet, the tool's injection wins for that pallet (so test mechanics
 * — e.g. funding Alice — are never silently disabled by a user-provided YAML).
 *
 * Deeper field-level merges (e.g. multiple entries on the same `Account` map) aren't
 * attempted — if the user needs richer control, they can put everything in their YAML
 * and skip the tool's `storageInjection`.
 */
function mergeImportStorage(
  user: Record<string, unknown>,
  tool: Record<string, unknown>
): Record<string, unknown> {
  return { ...user, ...tool };
}

/**
 * Classify `--additional-chains` for the bridged scenario: resolve each chain's
 * network (which side it belongs to), kind (relay vs parachain → key assignment),
 * and label, then drop any that duplicate one of the five core bridge chains.
 *
 * Dedup is by chain *identity*, not raw URL: `--governance-chain-url` and the
 * skill's default AHK point at the same chain on different hosts
 * (`kusama-asset-hub-rpc.polkadot.io` vs `asset-hub-kusama-rpc.n.dwellir.com`), so a
 * URL-string compare alone would double-spawn AHK. We compare `network:label` (derived
 * from runtime `spec_name`) as well as the bare URL.
 *
 * Chains on a network other than polkadot/kusama have no place in the topology and are
 * skipped with a warning. The `resolve` parameter is injectable for testing.
 */
export async function classifyAdditionalBridgeChains(
  additional: ParsedEndpoint[],
  coreEndpoints: ParsedEndpoint[],
  logger: Logger,
  resolve: (url: string) => Promise<ChainInfo> = fetchChainInfoFromEndpoint
): Promise<{ polkadot: AdditionalBridgeChain[]; kusama: AdditionalBridgeChain[] }> {
  const polkadot: AdditionalBridgeChain[] = [];
  const kusama: AdditionalBridgeChain[] = [];
  if (additional.length === 0) return { polkadot, kusama };

  // Build the dedup sets from the core chains' identities (+ their URLs).
  const coreUrls = new Set(coreEndpoints.map((e) => e.url));
  const coreIdentities = new Set<string>();
  await Promise.all(
    coreEndpoints.map(async (e) => {
      try {
        const info = await resolve(e.url);
        coreIdentities.add(`${info.network}:${info.label}`);
      } catch (err) {
        logger.debug(`Could not resolve core chain ${e.url} for dedup: ${(err as Error).message}`);
      }
    })
  );

  for (const endpoint of additional) {
    if (coreUrls.has(endpoint.url)) {
      logger.debug(`Skipping additional chain ${endpoint.url}: same URL as a core bridge chain`);
      continue;
    }
    let info: ChainInfo;
    try {
      info = await resolve(endpoint.url);
    } catch (err) {
      logger.warn(
        `Skipping additional chain ${endpoint.url}: could not resolve chain info (${(err as Error).message})`
      );
      continue;
    }
    const identity = `${info.network}:${info.label}`;
    if (coreIdentities.has(identity)) {
      logger.debug(
        `Skipping additional chain ${info.label} (${endpoint.url}): already in the bridge topology as ${identity}`
      );
      continue;
    }
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
