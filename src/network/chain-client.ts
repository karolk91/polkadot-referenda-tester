import { createClient, type PolkadotClient } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws';
import type { SubstrateApi } from '../types/substrate-api';

export function createPolkadotClient(endpoint: string): PolkadotClient {
  return createClient(getWsProvider(endpoint));
}

export function createApiForChain(client: PolkadotClient): SubstrateApi {
  return client.getUnsafeApi() as unknown as SubstrateApi;
}

export async function blockNumber(api: SubstrateApi): Promise<number> {
  return Number(await api.query.System.Number.getValue());
}
