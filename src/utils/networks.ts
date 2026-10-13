export const NETWORKS_IN_MATCH_ORDER = [
  'kusama',
  'paseo',
  'westend',
  'rococo',
  'polkadot',
] as const;

export type ChainNetwork = (typeof NETWORKS_IN_MATCH_ORDER)[number] | 'unknown';

export function networkFromText(text: string): ChainNetwork {
  const lowercaseText = text.toLowerCase();
  return NETWORKS_IN_MATCH_ORDER.find((network) => lowercaseText.includes(network)) ?? 'unknown';
}

export function isNetworkName(name: string): boolean {
  return (NETWORKS_IN_MATCH_ORDER as readonly string[]).includes(name);
}
