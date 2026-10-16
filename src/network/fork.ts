import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { connectParachains, connectVertical, environment } from '@acala-network/chopsticks-core';
import { type NetworkContext, setupContextWithConfig } from '@acala-network/chopsticks-testing';
import type { PolkadotClient } from 'polkadot-api';
import type { SubstrateApi } from '../types/substrate-api';
import type { ForkConfig } from '../utils/chopsticks-config';
import type { Logger } from '../utils/logger';
import { createApiForChain, createPolkadotClient } from './chain-client';
import { type ChainInfo, type ChainKind, getChainInfo } from './chain-identity';
import { ChopsticksManager } from './chopsticks-manager';
import type { PostTestChain } from './post-test-runner';

export interface Fork {
  manager: ChopsticksManager;
  client: PolkadotClient;
  api: SubstrateApi;
  info: ChainInfo;
}

export interface ForkSpec {
  key: string;
  config: ForkConfig;
  kind: ChainKind;
}

async function spawnForks(specs: ForkSpec[]): Promise<Map<string, NetworkContext>> {
  const relays = specs.filter((spec) => spec.kind === 'relay');
  if (relays.length > 1) {
    throw new Error(
      `Only one relay chain per network is possible, got: ${relays.map((relay) => relay.key).join(', ')}`
    );
  }
  const contexts = new Map(
    await Promise.all(
      specs.map(async (spec): Promise<[string, NetworkContext]> => {
        if (spec.config.db) mkdirSync(path.dirname(spec.config.db), { recursive: true });
        return [spec.key, await setupContextWithConfig(spec.config)];
      })
    )
  );
  const parachains = specs
    .filter((spec) => spec.kind === 'parachain')
    .map((spec) => contexts.get(spec.key)!.chain);
  if (relays.length === 1) {
    const relay = contexts.get(relays[0].key)!.chain;
    for (const parachain of parachains) {
      await connectVertical(relay, parachain);
    }
  }
  if (parachains.length > 0) {
    await connectParachains(parachains, environment.DISABLE_AUTO_HRMP);
  }
  if (specs.some((spec) => spec.config['wasm-override'])) {
    for (let round = 0; round < 2; round++) {
      for (const context of contexts.values()) {
        await context.dev.newBlock();
      }
    }
  }
  return contexts;
}

async function connectFork(
  context: NetworkContext,
  endpoint: string,
  logger: Logger
): Promise<Fork> {
  const manager = new ChopsticksManager(logger, context);
  const client = createPolkadotClient(context.url);
  const api = createApiForChain(client);
  await manager.waitForChainReady(api);
  return { manager, client, api, info: await getChainInfo(api, endpoint) };
}

export async function chainForks(specs: ForkSpec[], logger: Logger): Promise<Map<string, Fork>> {
  const contexts = await spawnForks(specs);
  return new Map(
    await Promise.all(
      specs.map(
        async (spec): Promise<[string, Fork]> => [
          spec.key,
          await connectFork(contexts.get(spec.key)!, spec.config.endpoint, logger),
        ]
      )
    )
  );
}

export interface ForkWithLabel {
  label: string;
  fork: Fork;
}

export function forksWithLabels(forks: Map<string, Fork>, prefix = ''): ForkWithLabel[] {
  return [...forks].map(([key, fork]) => ({ label: `${prefix}${key} (${fork.info.label})`, fork }));
}

export async function shutdownForks(
  forks: ForkWithLabel[],
  cleanup: boolean,
  logger: Logger
): Promise<void> {
  for (const { fork } of forks) {
    try {
      fork.client.destroy();
    } catch {
      logger.debug(`Client destroy for ${fork.info.label} failed`);
    }
  }
  if (cleanup) {
    await Promise.all(forks.map(({ fork }) => fork.manager.cleanup()));
    return;
  }

  logger.info(`\n${'='.repeat(70)}`);
  logger.info('Chopsticks networks are paused for manual examination');
  for (const { label, fork } of forks) {
    logger.info(`  ${label} at ${fork.manager.context.url}`);
  }
  logger.info('Press Ctrl+C to exit');
  logger.info('='.repeat(70));
  await Promise.all(
    forks.map(async ({ label, fork }) => {
      try {
        await fork.manager.pause();
      } catch (error) {
        logger.warn(`Failed to pause ${label}: ${(error as Error).message}`);
      }
    })
  );
}

export function postTestChain(fork: Fork): PostTestChain {
  return {
    label: fork.info.label,
    specName: fork.info.specName,
    network: fork.info.network,
    kind: fork.info.kind,
    wsEndpoint: fork.manager.context.url,
    chain: fork.manager.context.chain,
  };
}
