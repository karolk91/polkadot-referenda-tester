import type { ParsedEndpoint } from '../utils/chain-endpoint-parser';
import { buildChopsticksChainConfig, type StorageInjection } from '../utils/chopsticks-config';
import type { Logger } from '../utils/logger';
import { type ChainInfo, fetchChainInfoFromEndpoint } from './chain-identity';
import type { ForkSpec } from './fork';

const RUNTIME_LOG_LEVEL = 0;

export interface SingleConsensusEndpoints {
  governance?: ParsedEndpoint;
  fellowship?: ParsedEndpoint;
  additional: ParsedEndpoint[];
}

export interface DetectedChain {
  endpoint: ParsedEndpoint;
  info: ChainInfo;
}

export interface DetectedChains {
  governance?: DetectedChain;
  fellowship?: DetectedChain;
  additional: DetectedChain[];
}

export interface TopologyInjections {
  governance?: StorageInjection;
  fellowship?: StorageInjection;
}

export interface SingleConsensusTopology {
  specs: ForkSpec[];
  governanceKey?: string;
  fellowshipKey?: string;
  additional: Array<{ key: string; chain: DetectedChain }>;
}

export async function detectChains(
  endpoints: SingleConsensusEndpoints,
  logger: Logger
): Promise<DetectedChains> {
  logger.startSpinner('Detecting chain types...');
  const detect = async (endpoint: ParsedEndpoint): Promise<DetectedChain> => ({
    endpoint,
    info: await fetchChainInfoFromEndpoint(endpoint.url),
  });
  const [governance, fellowship, additional] = await Promise.all([
    endpoints.governance && detect(endpoints.governance),
    endpoints.fellowship && detect(endpoints.fellowship),
    Promise.all(endpoints.additional.map(detect)),
  ]);
  logger.succeedSpinner('Chain types detected');
  if (governance) logger.info(`Governance: ${governance.info.label} (${governance.info.kind})`);
  if (fellowship) logger.info(`Fellowship: ${fellowship.info.label} (${fellowship.info.kind})`);
  return { governance, fellowship, additional };
}

function isSameChain(first: DetectedChain, second: DetectedChain): boolean {
  return first.endpoint.url === second.endpoint.url || first.info.label === second.info.label;
}

function forkSpec(key: string, chain: DetectedChain, injection?: StorageInjection): ForkSpec {
  return {
    key,
    kind: chain.info.kind,
    config: buildChopsticksChainConfig(chain.endpoint, {
      injection,
      runtimeLogLevel: RUNTIME_LOG_LEVEL,
    }),
  };
}

export function singleConsensusTopology(
  chains: DetectedChains,
  injections: TopologyInjections,
  logger: Logger
): SingleConsensusTopology {
  const { governance, fellowship } = chains;
  const networkChains: DetectedChain[] = [];
  const specs: ForkSpec[] = [];
  let governanceKey: string | undefined;
  let fellowshipKey: string | undefined;

  if (governance && fellowship && isSameChain(governance, fellowship)) {
    specs.push(forkSpec('governance', governance, injections.fellowship ?? injections.governance));
    networkChains.push(governance);
    governanceKey = 'governance';
    fellowshipKey = 'governance';
  } else {
    if (governance) {
      specs.push(forkSpec('governance', governance, injections.governance));
      networkChains.push(governance);
      governanceKey = 'governance';
    }
    if (fellowship) {
      specs.push(forkSpec('fellowship', fellowship, injections.fellowship));
      networkChains.push(fellowship);
      fellowshipKey = 'fellowship';
    }
  }

  const additional: Array<{ key: string; chain: DetectedChain }> = [];
  for (const [index, chain] of chains.additional.entries()) {
    if (networkChains.some((other) => isSameChain(other, chain))) {
      logger.debug(`Skipping ${chain.info.label}: already in the network`);
      continue;
    }
    if (chain.info.kind === 'relay' && specs.some((spec) => spec.kind === 'relay')) {
      logger.warn(
        `Skipping relay chain ${chain.info.label}: the network already has a relay chain`
      );
      continue;
    }
    const key = `additional_${index}`;
    specs.push(forkSpec(key, chain));
    networkChains.push(chain);
    additional.push({ key, chain });
    logger.debug(`Adding ${chain.info.label} (${chain.info.kind}) to the network as ${key}`);
  }

  return { specs, governanceKey, fellowshipKey, additional };
}
