import type { Config } from '@acala-network/chopsticks/dist/esm/schema/index.js';
import { BuildBlockMode } from '@acala-network/chopsticks-core';
import { setupNetworks } from '@acala-network/chopsticks-testing';
import * as path from 'path';
import type { ChopsticksConfig } from '../types';
import type { SubstrateApi } from '../types/substrate-api';
import type { Logger } from '../utils/logger';

const CHAIN_READY_MAX_ATTEMPTS = 10;
const CHAIN_READY_DELAY_MS = 500;

/** Minimal interface for the Chopsticks network context returned by setupNetworks */
export interface ChopsticksContext {
  ws: { endpoint: string };
  dev: {
    newBlock(params?: { transactions?: string[] }): Promise<unknown>;
    setStorage(updates: unknown): Promise<unknown>;
    timeTravel(timestamp: string | number): Promise<unknown>;
    setHead?(hashOrNumber: string | number): Promise<unknown>;
  };
  chain?: { port?: number; head?: { number: number } };
  head?: { number: number };
  pause?(): Promise<unknown>;
  teardown?(): Promise<void>;
  close?(): Promise<void>;
}

export class ChopsticksManager {
  private logger: Logger;
  private context: ChopsticksContext | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  static fromExistingContext(logger: Logger, context: ChopsticksContext): ChopsticksManager {
    const manager = new ChopsticksManager(logger);
    manager.setContext(context);
    return manager;
  }

  async setup(config: ChopsticksConfig, networkKey?: string): Promise<ChopsticksContext> {
    try {
      this.logger.startSpinner('Starting Chopsticks local environment...');

      // Build config for setupNetworks
      // Map string build-block-mode to enum
      let buildBlockMode = BuildBlockMode.Instant;
      if (config['build-block-mode'] === 'instant') {
        buildBlockMode = BuildBlockMode.Instant;
      } else if (config['build-block-mode'] === 'batch') {
        buildBlockMode = BuildBlockMode.Batch;
      } else if (config['build-block-mode'] === 'manual') {
        buildBlockMode = BuildBlockMode.Manual;
      }

      const chopsticksConfig: Config = {
        endpoint: config.endpoint,
        db: config.db || path.join(process.cwd(), '.chopsticks-db'),
        'build-block-mode': buildBlockMode,
        'mock-signature-host': config['mock-signature-host'] !== false,
        'allow-unresolved-imports': config['allow-unresolved-imports'] !== false,
        'runtime-log-level': config['runtime-log-level'] ?? 0,
        ...(config.port && { port: config.port }),
        ...(config.block && { block: config.block }),
        ...(config['import-storage'] && { 'import-storage': config['import-storage'] }),
      } as Config;

      this.logger.debug(`Chopsticks config: ${JSON.stringify(chopsticksConfig, null, 2)}`);

      // Use the provided networkKey or default to "chain".
      // For relay chains, the key should match the network name (e.g. "kusama", "polkadot")
      // so that setupNetworks correctly identifies it as a relay and skips connectParachains.
      const key = networkKey || 'chain';
      const networks = await setupNetworks({
        [key]: chopsticksConfig,
      });

      this.context = networks[key] as unknown as ChopsticksContext;

      const endpoint = this.context.ws.endpoint;
      this.logger.succeedSpinner(`Chopsticks started at ${endpoint}`);
      this.logger.success(`Connected to: ${config.endpoint}`);

      if (config.block) {
        this.logger.info(`Forked from block: ${config.block}`);
      }

      return this.context;
    } catch (error) {
      this.logger.failSpinner('Failed to start Chopsticks');
      throw error;
    }
  }

  async newBlock(params?: { transactions?: string[] }): Promise<void> {
    if (!this.context) {
      throw new Error('Chopsticks context not initialized');
    }

    if (params?.transactions) {
      this.logger.debug(`Creating new block with ${params.transactions.length} transaction(s)...`);
    } else {
      this.logger.debug('Creating new block...');
    }

    // dev.newBlock() can resolve before the block is fully finalized in newer
    // Chopsticks versions. We record the head before, call newBlock, then poll
    // until the head actually advances — guaranteeing subsequent storage reads
    // see the new block's state.
    const chain = this.context.chain ?? this.context;
    const headBefore = chain.head?.number as number | undefined;

    await this.context.dev.newBlock(params);

    // If we can read the chain head, wait until it actually advances
    if (headBefore !== undefined) {
      const maxWait = 10_000; // 10s safety cap
      const pollInterval = 100;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        const headNow = chain.head?.number;
        if (headNow !== undefined && headNow > headBefore) {
          break;
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }
    }
  }

  async setStorage(module: string, item: string, key: unknown, value: unknown): Promise<void> {
    if (!this.context) {
      throw new Error('Chopsticks context not initialized');
    }

    this.logger.debug(`Setting storage: ${module}.${item}`);
    await this.context.dev.setStorage({
      [module]: {
        [item]: [[key, value]],
      },
    });
  }

  async setStorageBatch(updates: Record<string, unknown>): Promise<void> {
    if (!this.context) {
      throw new Error('Chopsticks context not initialized');
    }

    this.logger.debug(`Setting batch storage updates`);
    await this.context.dev.setStorage(updates);
  }

  async timeTravel(timestamp: number): Promise<void> {
    if (!this.context) {
      throw new Error('Chopsticks context not initialized');
    }

    this.logger.debug(`Time traveling to timestamp: ${timestamp}`);
    await this.context.dev.timeTravel(timestamp);
  }

  async waitForChainReady(
    api: SubstrateApi,
    maxAttempts = CHAIN_READY_MAX_ATTEMPTS,
    delayMs = CHAIN_READY_DELAY_MS
  ): Promise<void> {
    this.logger.debug('Waiting for chain to be ready...');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Try to read the current block number
        const header = await api.query.System.Number.getValue();
        const blockNumber = Number(header);

        this.logger.debug(`Chain ready at block #${blockNumber}`);
        return;
      } catch (error) {
        if (attempt === maxAttempts) {
          throw new Error(`Chain not ready after ${maxAttempts} attempts: ${error}`);
        }

        this.logger.debug(`Chain not ready yet (attempt ${attempt}/${maxAttempts}), retrying...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  getContext(): ChopsticksContext {
    if (!this.context) {
      throw new Error('Chopsticks context not initialized');
    }
    return this.context;
  }

  setContext(context: ChopsticksContext): void {
    this.context = context;
  }

  async pause(): Promise<void> {
    if (!this.context) {
      throw new Error('Chopsticks context not initialized');
    }

    this.logger.debug('Pausing Chopsticks instance...');

    if (this.context.pause) {
      await this.context.pause();
    } else {
      this.logger.warn('pause() method not available on context');
    }
  }

  async cleanup(): Promise<void> {
    if (this.context) {
      this.logger.debug('Cleaning up Chopsticks context...');
      if (this.context.teardown) {
        await this.context.teardown();
      } else if (this.context.close) {
        await this.context.close();
      }
      this.context = null;
      this.logger.success('Chopsticks cleanup complete');
    }
  }
}
