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
export async function getChainInfo(api: any, endpoint: string): Promise<ChainInfo> {
  try {
    // Get runtime version to extract specName
    const systemVersion = await api.constants.System.Version();
    const specName: string = systemVersion.spec_name || systemVersion.specName || 'unknown';

    return buildChainInfoFromSpecName(specName, endpoint);
  } catch {
    // Fallback to unknown if we can't read specName
    return {
      id: 'unknown',
      label: 'unknown',
      endpoint,
      network: 'unknown',
      kind: 'parachain',
      specName: 'unknown',
    };
  }
}

/**
 * Build ChainInfo from specName
 */
export function buildChainInfoFromSpecName(specName: string, endpoint: string): ChainInfo {
  const lower = specName.toLowerCase();

  // Determine network from specName
  let network: ChainNetwork = 'unknown';
  if (lower.includes('polkadot')) {
    network = 'polkadot';
  } else if (lower.includes('kusama')) {
    network = 'kusama';
  } else if (lower.includes('paseo')) {
    network = 'paseo';
  } else if (lower.includes('westend')) {
    network = 'westend';
  } else if (lower.includes('rococo')) {
    network = 'rococo';
  }

  // Determine kind from specName
  // Relay chains have simple names like "polkadot", "kusama", "westend"
  // Parachains have compound names like "statemint", "asset-hub-polkadot", "collectives-polkadot"
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
 * Creates an API instance using unsafe API (always).
 * We don't use typed descriptors - unsafe API works for all chains.
 */
export function createApiForChain(client: any): any {
  if (typeof client.getUnsafeApi === 'function') {
    return client.getUnsafeApi();
  }

  throw new Error('Unable to create unsafe API instance from client');
}
