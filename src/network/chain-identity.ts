import { getWsProvider } from 'polkadot-api/ws';
import type { SubstrateApi } from '../types/substrate-api';
import { type ChainNetwork, isNetworkName, networkFromText } from '../utils/networks';

export type ChainKind = 'relay' | 'parachain';

export interface ChainInfo {
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
  const { spec_name } = await api.constants.System.Version();
  return buildChainInfoFromSpecName(spec_name, endpoint);
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
const KNOWN_SPEC_NAMES = new Map<string, ChainNetwork>([
  ['statemint', 'polkadot'],
  ['collectives', 'polkadot'],
  ['statemine', 'kusama'],
  ['encointer-parachain', 'kusama'],
]);

function specNameLabel(specName: string): string {
  return specName.toLowerCase().replace(/_/g, '-');
}

export function lookupNetworkFromSpecName(specName: string): ChainNetwork {
  const label = specNameLabel(specName);
  return KNOWN_SPEC_NAMES.get(label) ?? networkFromText(label);
}

export function buildChainInfoFromSpecName(specName: string, endpoint: string): ChainInfo {
  const label = specNameLabel(specName);
  return {
    label,
    endpoint,
    network: lookupNetworkFromSpecName(specName),
    kind: isNetworkName(label) ? 'relay' : 'parachain',
    specName,
  };
}

const chainInfoByEndpoint = new Map<string, Promise<ChainInfo>>();

/**
 * Read the full {@link ChainInfo} (network + kind + label) for an endpoint from its runtime
 * `spec_name`, via a single legacy `state_getRuntimeVersion` RPC ({@link fetchRuntimeSpecName})
 * instead of a full polkadot-api client. This works against full nodes, chopsticks forks and
 * legacy-only endpoints, such as a subway caching/failover proxy that implements the old JSON-RPC
 * but not the new `chainHead_*` API that `createClient` requires. Used by all pre-fork chain
 * detection and by the bridged-scenario path to classify `--additional-chains`.
 *
 * @throws if the endpoint cannot be reached or the runtime-version read fails.
 */
export function fetchChainInfoFromEndpoint(endpoint: string): Promise<ChainInfo> {
  const cached = chainInfoByEndpoint.get(endpoint);
  if (cached) return cached;
  const info = fetchRuntimeSpecName(endpoint).then((specName) =>
    buildChainInfoFromSpecName(specName, endpoint)
  );
  chainInfoByEndpoint.set(endpoint, info);
  info.catch(() => chainInfoByEndpoint.delete(endpoint));
  return info;
}

/**
 * Read a chain's runtime `specName` via a single legacy `state_getRuntimeVersion` JSON-RPC
 * call over a bare polkadot-api ws provider, deliberately NOT `createClient`. `createClient`
 * requires the new `chainHead_*`/`chainSpec_*` JSON-RPC spec; a legacy-only endpoint (for example
 * a subway caching/failover proxy) returns "Method not found" for `chainHead_v1_follow`, which
 * puts `createClient` into a reconnect loop with no backoff. Every node implements the old
 * `state_getRuntimeVersion`, so this works against full nodes, chopsticks forks and proxies. The
 * socket is always torn down before the promise settles.
 *
 * @throws if the endpoint cannot be reached, the RPC errors, or no response arrives in time.
 */
function fetchRuntimeSpecName(endpoint: string, timeoutMs = 20000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let connection: { disconnect: () => void } | undefined;
    let done = false;
    // Tear the socket down before settling. `resolve`/`reject` are already idempotent, so this
    // only guards the teardown.
    const cleanup = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        connection?.disconnect();
      } catch {
        // ignore teardown errors
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out reading runtime version from ${endpoint}`));
    }, timeoutMs);
    try {
      const provider = getWsProvider(endpoint);
      // polkadot-api's provider delivers already-parsed JSON-RPC messages and `send` takes a request
      // object (both were raw strings before polkadot-api v2).
      const conn = provider((msg) => {
        if (msg.id !== 1) return;
        if ('error' in msg && msg.error) {
          cleanup();
          reject(new Error(msg.error.message || 'state_getRuntimeVersion failed'));
        } else if ('result' in msg) {
          const result = msg.result as { specName?: string } | undefined;
          cleanup();
          resolve(String(result?.specName ?? 'unknown'));
        }
      });
      connection = conn;
      conn.send({ jsonrpc: '2.0', id: 1, method: 'state_getRuntimeVersion', params: [] });
    } catch (error) {
      cleanup();
      reject(error as Error);
    }
  });
}
