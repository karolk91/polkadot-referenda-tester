import { classifyAdditionalBridgeChains } from '../services/bridge-topology-builder';
import type { ChainNetwork } from '../services/chain-registry';
import { fetchNetworkFromEndpoint } from '../services/chain-registry';
import { NetworkCoordinator } from '../services/network-coordinator';
import type { TestOptions } from '../types';
import {
  inferNetworkFromUrl,
  parseEndpoint,
  parseMultipleEndpoints,
} from '../utils/chain-endpoint-parser';
import { Logger } from '../utils/logger';

/**
 * Resolve a chain's network the cheapest way possible: first try URL substring
 * inference (no I/O, works for mainnet `*.polkadot.io` hostnames), and fall back to
 * a brief WebSocket connect that reads runtime `spec_name`. The fallback is what
 * makes bridged-scenario detection work for local zombienet URLs whose hostname
 * carries no network token.
 *
 * The input is the same form the user provides via `--*-chain-url`: either a raw
 * URL, a `url,block` pair, or a path to a chopsticks YAML config. We feed it
 * through `parseEndpoint` first so only the bare URL reaches `inferNetworkFromUrl`
 * (otherwise `,7` etc. would confuse the substring matcher) and only the bare URL
 * reaches `fetchNetworkFromEndpoint` (otherwise polkadot-api would hang trying to
 * resolve a host like `127.0.0.1:50054,7`).
 *
 * Errors during the connect fallback are swallowed and reported as `'unknown'` so
 * routing decisions remain deterministic from CLI input alone — callers that
 * actually depend on the resolution should surface the resulting `'unknown'` as a
 * validation error.
 */
async function resolveNetwork(input: string): Promise<ChainNetwork> {
  let bareUrl: string;
  try {
    bareUrl = parseEndpoint(input).url;
  } catch {
    return 'unknown';
  }
  const inferred = inferNetworkFromUrl(bareUrl);
  if (inferred !== 'unknown') return inferred;
  try {
    return await fetchNetworkFromEndpoint(bareUrl);
  } catch {
    return 'unknown';
  }
}

/**
 * Canonical public-RPC endpoints we default to when the user doesn't supply explicit
 * URLs for the bridge infrastructure parachains. Users can still override via CLI
 * if they want a fork at a specific block or custom YAML config.
 */
const DEFAULT_BRIDGE_URLS = {
  assetHubPolkadot: 'wss://polkadot-asset-hub-rpc.polkadot.io',
  bridgeHubPolkadot: 'wss://polkadot-bridge-hub-rpc.polkadot.io',
  bridgeHubKusama: 'wss://kusama-bridge-hub-rpc.polkadot.io',
} as const;

/**
 * Detects the bridged-fellowship scenario by resolving each chain's network with
 * URL substring inference first, then a brief runtime-metadata read if needed.
 * The rule is: fellowship runs on a Polkadot-network chain (Polkadot Collectives)
 * while the governance referendum runs on a Kusama-network chain (Kusama Asset
 * Hub). When the user points both at the same network, this is the regular
 * single-network multi-chain flow.
 */
export async function isBridgedScenario(options: TestOptions): Promise<boolean> {
  if (!options.fellowshipChainUrl || !options.governanceChainUrl) return false;
  const [fellowshipNet, governanceNet] = await Promise.all([
    resolveNetwork(options.fellowshipChainUrl),
    resolveNetwork(options.governanceChainUrl),
  ]);
  // Currently supported: Polkadot fellowship → Kusama governance.
  return fellowshipNet === 'polkadot' && governanceNet === 'kusama';
}

/**
 * Returns true when fellowship-chain-url and governance-chain-url resolve to
 * *different* networks (any cross-network combination). Used to surface
 * unsupported directions (e.g. Kusama fellowship → Polkadot governance) as an
 * explicit error rather than letting the non-bridge path mis-handle them.
 */
async function isCrossNetworkScenario(options: TestOptions): Promise<boolean> {
  if (!options.fellowshipChainUrl || !options.governanceChainUrl) return false;
  const [fellowshipNet, governanceNet] = await Promise.all([
    resolveNetwork(options.fellowshipChainUrl),
    resolveNetwork(options.governanceChainUrl),
  ]);
  if (fellowshipNet === 'unknown' || governanceNet === 'unknown') return false;
  return fellowshipNet !== governanceNet;
}

export async function validateOptions(options: TestOptions): Promise<void> {
  if (options.referendum && options.callToCreateGovernanceReferendum) {
    throw new Error(
      'Cannot specify both --referendum (existing ID) and --call-to-create-governance-referendum (create new). Use one or the other.'
    );
  }

  if (options.fellowship && options.callToCreateFellowshipReferendum) {
    throw new Error(
      'Cannot specify both --fellowship (existing ID) and --call-to-create-fellowship-referendum (create new). Use one or the other.'
    );
  }

  const hasGovernanceRef = !!(options.referendum || options.callToCreateGovernanceReferendum);
  const hasFellowshipRef = !!(options.fellowship || options.callToCreateFellowshipReferendum);

  if (!hasGovernanceRef && !hasFellowshipRef) {
    throw new Error(
      'At least one referendum must be specified (--referendum, --fellowship) or created (--call-to-create-governance-referendum, --call-to-create-fellowship-referendum)'
    );
  }

  if (await isBridgedScenario(options)) {
    if (!hasFellowshipRef) {
      throw new Error(
        'Bridged scenario (Polkadot fellowship → Kusama governance) requires a fellowship referendum (--fellowship or --call-to-create-fellowship-referendum)'
      );
    }
    if (options.assetHubKusamaUrl && options.assetHubKusamaUrl !== options.governanceChainUrl) {
      throw new Error(
        `--asset-hub-kusama-url (${options.assetHubKusamaUrl}) must match --governance-chain-url (${options.governanceChainUrl}) when bridged — they refer to the same chain.`
      );
    }
    if (options.bridgePumpRounds !== undefined) {
      const n = parseInt(options.bridgePumpRounds, 10);
      if (Number.isNaN(n) || n <= 0) {
        throw new Error(`Invalid --bridge-pump-rounds: ${options.bridgePumpRounds}`);
      }
    }
  } else if (await isCrossNetworkScenario(options)) {
    // The user pointed fellowship and governance at chains on DIFFERENT networks
    // but in a combination the tool doesn't currently support (only Polkadot
    // fellowship → Kusama governance is implemented). Fail loudly rather than
    // letting the non-bridge path mis-route them.
    throw new Error(
      'Unsupported direction: only "Polkadot fellowship → Kusama governance" is currently supported. ' +
        'Got fellowship-chain-url + governance-chain-url on different networks in a reversed/unsupported combination. ' +
        'Either use the supported direction or run both referenda on the same network.'
    );
  }
}

export async function testReferendum(options: TestOptions): Promise<void> {
  const logger = new Logger(options.verbose);
  const cleanupEnabled = options.cleanup !== false;

  try {
    await validateOptions(options);

    const hasGovernanceRef = !!(options.referendum || options.callToCreateGovernanceReferendum);
    const hasFellowshipRef = !!(options.fellowship || options.callToCreateFellowshipReferendum);

    if (hasGovernanceRef && !options.governanceChainUrl) {
      throw new Error('--governance-chain-url is required when testing a governance referendum');
    }

    if (hasFellowshipRef && !options.fellowshipChainUrl) {
      throw new Error('--fellowship-chain-url is required when testing a fellowship referendum');
    }

    const governanceParsed = options.governanceChainUrl
      ? parseEndpoint(options.governanceChainUrl)
      : undefined;

    const fellowshipParsed = options.fellowshipChainUrl
      ? parseEndpoint(options.fellowshipChainUrl)
      : undefined;

    const additionalChainsParsed = options.additionalChains
      ? parseMultipleEndpoints(options.additionalChains)
      : [];

    const mainRefId = options.referendum ? parseInt(options.referendum, 10) : undefined;
    if (mainRefId !== undefined && Number.isNaN(mainRefId)) {
      throw new Error(`Invalid referendum ID: ${options.referendum}`);
    }

    const fellowshipRefId = options.fellowship ? parseInt(options.fellowship, 10) : undefined;
    if (fellowshipRefId !== undefined && Number.isNaN(fellowshipRefId)) {
      throw new Error('Invalid fellowship referendum ID');
    }

    if (hasFellowshipRef) {
      logger.section('Polkadot Referenda Tester (Fellowship Mode)');
    } else {
      logger.section('Polkadot Referenda Tester');
    }

    const coordinator = new NetworkCoordinator(logger, {
      governance: governanceParsed?.url,
      governanceBlock: governanceParsed?.block,
      governanceBaseConfig: governanceParsed?.baseConfig,
      fellowship: fellowshipParsed?.url,
      fellowshipBlock: fellowshipParsed?.block,
      fellowshipBaseConfig: fellowshipParsed?.baseConfig,
      additionalChains: additionalChainsParsed,
    });

    if (await isBridgedScenario(options)) {
      // Bridged fellowship → Kusama governance path:
      //   1. spawn Polkadot side + Kusama side (relays come from --additional-chains),
      //   2. run fellowship referendum on Collectives (bridges whitelist_call to AHK),
      //   3. drive BridgeConnector to deliver the bridged message and verify CallWhitelisted on AHK,
      //   4. if --call-to-create-governance-referendum is also supplied, run the AHK public
      //      whitelistedcaller referendum so the whitelisted call actually dispatches.
      const collectivesParsed = fellowshipParsed!; // validated by isBridgedScenario
      // --asset-hub-kusama-url is allowed but redundant; we default it from --governance-chain-url
      // when bridged (both name the same AHK chain).
      const ahkEndpoint = options.assetHubKusamaUrl
        ? parseEndpoint(options.assetHubKusamaUrl)
        : governanceParsed!;
      // AHP / BHP / BHK URLs default to the canonical polkadot.io public RPCs when
      // not explicitly provided. Users override the flag if they want a different
      // host, a specific fork block, or a chopsticks YAML config.
      const bridgeEndpoints = {
        collectives: collectivesParsed,
        assetHubPolkadot: parseEndpoint(
          options.assetHubPolkadotUrl ?? DEFAULT_BRIDGE_URLS.assetHubPolkadot
        ),
        bridgeHubPolkadot: parseEndpoint(
          options.bridgeHubPolkadotUrl ?? DEFAULT_BRIDGE_URLS.bridgeHubPolkadot
        ),
        assetHubKusama: ahkEndpoint,
        bridgeHubKusama: parseEndpoint(
          options.bridgeHubKusamaUrl ?? DEFAULT_BRIDGE_URLS.bridgeHubKusama
        ),
      };
      // Route any --additional-chains onto the correct side (relay + system parachains),
      // deduping against the five core bridge chains by chain identity (not raw URL).
      const { polkadot: additionalPolkadot, kusama: additionalKusama } =
        await classifyAdditionalBridgeChains(
          additionalChainsParsed,
          [
            bridgeEndpoints.collectives,
            bridgeEndpoints.assetHubPolkadot,
            bridgeEndpoints.bridgeHubPolkadot,
            bridgeEndpoints.assetHubKusama,
            bridgeEndpoints.bridgeHubKusama,
          ],
          logger
        );
      await coordinator.testFellowshipBridged(fellowshipRefId, mainRefId, cleanupEnabled, options, {
        ...bridgeEndpoints,
        additionalPolkadot,
        additionalKusama,
      });
    } else {
      await coordinator.testWithFellowship(mainRefId, fellowshipRefId, cleanupEnabled, options);
    }

    if (cleanupEnabled) {
      logger.success('\n\u2713 Workflow completed');
      process.exit(0);
    }
  } catch (error) {
    logger.error('Test execution failed', error as Error);
    process.exit(1);
  }
}
