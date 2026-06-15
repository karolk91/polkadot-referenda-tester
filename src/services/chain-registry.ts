import type { PolkadotClient } from 'polkadot-api';
import { createClient } from 'polkadot-api';
import { withPolkadotSdkCompat } from 'polkadot-api/polkadot-sdk-compat';
import { getWsProvider } from 'polkadot-api/ws-provider/node';
import type { ReferendaPallet, SubstrateApi } from '../types/substrate-api';

export type ChainNetwork = 'polkadot' | 'kusama' | 'paseo' | 'westend' | 'rococo' | 'unknown';
export type ChainKind = 'relay' | 'parachain';

export interface ChainInfo {
  id: string;
  label: string;
  endpoint: string;
  network: ChainNetwork;
  kind: ChainKind;
  specName: string;
}

/**
 * Get chain information from runtime metadata.
 * Uses system.version.specName to accurately identify the chain.
 */
export async function getChainInfo(api: SubstrateApi, endpoint: string): Promise<ChainInfo> {
  const systemVersion = await api.constants.System.Version();
  const specName: string = systemVersion.spec_name || systemVersion.specName || 'unknown';

  return buildChainInfoFromSpecName(specName, endpoint);
}

/**
 * Static lookup table for system parachains whose runtime spec_name doesn't encode
 * the network. Substring inference works for chains like `bridge-hub-polkadot` but
 * fails on legacy names like `statemint` (Polkadot AH), `statemine` (Kusama AH),
 * and `collectives` (Polkadot Collectives) — these chains pre-date the rebrand and
 * the runtimes still report their original spec_name. Without this table,
 * post-connect runtime-metadata inference returns `'unknown'` for exactly the chains
 * the bridged-scenario routing decision depends on.
 *
 * Keep the values lowercase; the lookup normalizes the key.
 */
const KNOWN_SPEC_NAMES: Record<string, ChainNetwork> = {
  // Polkadot ecosystem
  polkadot: 'polkadot',
  statemint: 'polkadot',
  collectives: 'polkadot',
  'bridge-hub-polkadot': 'polkadot',
  'people-polkadot': 'polkadot',
  'coretime-polkadot': 'polkadot',
  // Kusama ecosystem
  kusama: 'kusama',
  statemine: 'kusama',
  'bridge-hub-kusama': 'kusama',
  'people-kusama': 'kusama',
  'coretime-kusama': 'kusama',
  'encointer-parachain': 'kusama',
};

/**
 * Resolve a chain's network from its runtime spec_name. Consults the
 * [`KNOWN_SPEC_NAMES`] table first to catch legacy / network-agnostic names
 * (statemint, statemine, collectives, encointer-parachain), then falls back to
 * substring inference for compound names like `bridge-hub-polkadot`.
 */
export function lookupNetworkFromSpecName(specName: string): ChainNetwork {
  const lower = specName.toLowerCase().replace(/_/g, '-');
  if (lower in KNOWN_SPEC_NAMES) {
    return KNOWN_SPEC_NAMES[lower];
  }
  if (lower.includes('polkadot')) return 'polkadot';
  if (lower.includes('kusama')) return 'kusama';
  if (lower.includes('paseo')) return 'paseo';
  if (lower.includes('westend')) return 'westend';
  if (lower.includes('rococo')) return 'rococo';
  return 'unknown';
}

/**
 * Build ChainInfo from specName
 */
export function buildChainInfoFromSpecName(specName: string, endpoint: string): ChainInfo {
  const network = lookupNetworkFromSpecName(specName);

  // Determine kind from specName.
  // Relay chains report a bare network name (`polkadot`, `kusama`, etc.); everything
  // else is treated as a parachain.
  const lower = specName.toLowerCase();
  const isRelay = ['polkadot', 'kusama', 'paseo', 'westend', 'rococo'].includes(lower);
  const kind: ChainKind = isRelay ? 'relay' : 'parachain';

  // Create a clean label from specName
  const label = specName.toLowerCase().replace(/_/g, '-');

  return {
    id: label,
    label,
    endpoint,
    network,
    kind,
    specName,
  };
}

/**
 * Open a transient client, read `System::Version::specName`, and return the resolved
 * network. Always destroys the client, even on error. Intended for callers that need
 * the network ahead of any chopsticks spawn (e.g. routing decisions in
 * `validateOptions`) when URL substring inference yields `'unknown'`.
 *
 * @throws if the endpoint cannot be reached or the metadata read fails.
 */
export async function fetchNetworkFromEndpoint(endpoint: string): Promise<ChainNetwork> {
  return (await fetchChainInfoFromEndpoint(endpoint)).network;
}

/**
 * Open a transient client, read runtime metadata, and return the full {@link ChainInfo}
 * (network + kind + label). Always destroys the client, even on error. Used by the
 * bridged-scenario path to classify `--additional-chains` (network for side-routing,
 * kind to skip relays, label for identity-based dedup against the core bridge chains).
 *
 * @throws if the endpoint cannot be reached or the metadata read fails.
 */
export async function fetchChainInfoFromEndpoint(endpoint: string): Promise<ChainInfo> {
  const client = createPolkadotClient(endpoint);
  try {
    const api = createApiForChain(client);
    return await getChainInfo(api, endpoint);
  } finally {
    client.destroy();
  }
}

/**
 * Create a polkadot-api client connected to the given WebSocket endpoint.
 */
export function createPolkadotClient(endpoint: string): PolkadotClient {
  return createClient(withPolkadotSdkCompat(getWsProvider(endpoint)));
}

/**
 * Creates an API instance using unsafe API (always).
 * We don't use typed descriptors - unsafe API works for all chains.
 */
export function createApiForChain(client: PolkadotClient): SubstrateApi {
  if (typeof client.getUnsafeApi === 'function') {
    return client.getUnsafeApi() as unknown as SubstrateApi;
  }

  throw new Error('Unable to create unsafe API instance from client');
}

/**
 * Returns the referenda pallet name based on fellowship flag.
 */
export function getReferendaPalletName(isFellowship: boolean): string {
  return isFellowship ? 'FellowshipReferenda' : 'Referenda';
}

/**
 * Get the referenda pallet query accessor from the API.
 */
export function getReferendaPallet(api: SubstrateApi, isFellowship: boolean): ReferendaPallet {
  return isFellowship ? api.query.FellowshipReferenda : api.query.Referenda;
}
