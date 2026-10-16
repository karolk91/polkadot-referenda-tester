import type { ParsedEndpoint } from '../utils/chain-endpoint-parser';
import { buildChopsticksChainConfig, type StorageInjection } from '../utils/chopsticks-config';
import type { Logger } from '../utils/logger';
import { type ChainInfo, type ChainKind, fetchChainInfoFromEndpoint } from './chain-identity';
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
  additionalKeys: string[];
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

export function forkSpec(
  key: string,
  endpoint: ParsedEndpoint,
  kind: ChainKind,
  options: { injection?: StorageInjection; runtimeLogLevel: number }
): ForkSpec {
  return { key, kind, config: buildChopsticksChainConfig(endpoint, options) };
}

export function additionalForkSpecs(
  additional: DetectedChain[],
  hasRelay: boolean,
  runtimeLogLevel: number,
  logger: Logger
): ForkSpec[] {
  const specs: ForkSpec[] = [];
  let relayPresent = hasRelay;
  for (const [index, chain] of additional.entries()) {
    if (chain.info.kind === 'relay') {
      if (relayPresent) {
        logger.warn(
          `Skipping relay chain ${chain.info.label}: the network already has a relay chain`
        );
        continue;
      }
      relayPresent = true;
    }
    const key = `additional_${index}`;
    specs.push(forkSpec(key, chain.endpoint, chain.info.kind, { runtimeLogLevel }));
    logger.debug(`Adding ${chain.info.label} (${chain.info.kind}) to the network as ${key}`);
  }
  return specs;
}

export function singleConsensusTopology(
  chains: DetectedChains,
  injections: TopologyInjections,
  logger: Logger
): SingleConsensusTopology {
  const { governance, fellowship } = chains;
  const networkChains: DetectedChain[] = [];
  const specs: ForkSpec[] = [];
  const primarySpec = (key: string, chain: DetectedChain, injection?: StorageInjection) => {
    specs.push(
      forkSpec(key, chain.endpoint, chain.info.kind, {
        injection,
        runtimeLogLevel: RUNTIME_LOG_LEVEL,
      })
    );
    networkChains.push(chain);
    return key;
  };
  let governanceKey: string | undefined;
  let fellowshipKey: string | undefined;
  if (governance && fellowship && isSameChain(governance, fellowship)) {
    governanceKey = primarySpec(
      'governance',
      governance,
      injections.fellowship ?? injections.governance
    );
    fellowshipKey = governanceKey;
  } else {
    if (governance) governanceKey = primarySpec('governance', governance, injections.governance);
    if (fellowship) fellowshipKey = primarySpec('fellowship', fellowship, injections.fellowship);
  }

  const additional: DetectedChain[] = [];
  for (const chain of chains.additional) {
    if (networkChains.some((other) => isSameChain(other, chain))) {
      logger.debug(`Skipping ${chain.info.label}: already in the network`);
      continue;
    }
    networkChains.push(chain);
    additional.push(chain);
  }
  const additionalSpecs = additionalForkSpecs(
    additional,
    specs.some((spec) => spec.kind === 'relay'),
    RUNTIME_LOG_LEVEL,
    logger
  );
  return {
    specs: [...specs, ...additionalSpecs],
    governanceKey,
    fellowshipKey,
    additionalKeys: additionalSpecs.map((spec) => spec.key),
  };
}
