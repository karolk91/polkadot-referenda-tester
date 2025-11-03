import { setupNetworks } from '@acala-network/chopsticks-testing';
import type { Config } from '@acala-network/chopsticks/dist/esm/schema/index.js';
import { BuildBlockMode } from '@acala-network/chopsticks-core';
import { ChopsticksConfig } from '../types';
import { Logger } from '../utils/logger';
import * as path from 'path';

export class ChopsticksManager {
  private logger: Logger;
  private context: any = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  static fromExistingContext(logger: Logger, context: any): ChopsticksManager {
    const manager = new ChopsticksManager(logger);
    manager.setContext(context);
    return manager;
  }

  async setup(config: ChopsticksConfig): Promise<any> {
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

      const chopsticsConfig: Config = {
        endpoint: config.endpoint,
        db: config.db || path.join(process.cwd(), '.chopsticks-db'),
        'build-block-mode': buildBlockMode,
        'mock-signature-host': config['mock-signature-host'] !== false,
        'allow-unresolved-imports': config['allow-unresolved-imports'] !== false,
        'runtime-log-level': config['runtime-log-level'] ?? 0,
        ...(config.port && { port: config.port }),
        ...(config.block && { block: config.block }),
      } as Config;

      this.logger.debug(`Chopsticks config: ${JSON.stringify(chopsticsConfig, null, 2)}`);

      // Setup the network using setupNetworks
      const networks = await setupNetworks({
        polkadot: chopsticsConfig,
      });

      this.context = networks.polkadot;

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

  async newBlock(): Promise<void> {
    if (!this.context) {
      throw new Error('Chopsticks context not initialized');
    }

    this.logger.debug('Creating new block...');
    await this.context.dev.newBlock();
  }

  async setStorage(module: string, item: string, key: any, value: any): Promise<void> {
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

  async setStorageBatch(updates: Record<string, any>): Promise<void> {
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

  async waitForChainReady(api: any, maxAttempts = 10, delayMs = 500): Promise<void> {
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

  getContext(): any {
    if (!this.context) {
      throw new Error('Chopsticks context not initialized');
    }
    return this.context;
  }

  setContext(context: any): void {
    this.context = context;
  }

  async pause(): Promise<void> {
    if (!this.context) {
      throw new Error('Chopsticks context not initialized');
    }

    this.logger.debug('Pausing Chopsticks instance...');

    if (typeof this.context.pause === 'function') {
      return this.context.pause();
    } else {
      this.logger.warn('pause() method not available on context');
    }
  }

  async cleanup(): Promise<void> {
    if (this.context) {
      this.logger.debug('Cleaning up Chopsticks context...');
      if (typeof this.context.teardown === 'function') {
        await this.context.teardown();
      } else if (typeof this.context.close === 'function') {
        await this.context.close();
      }
      this.context = null;
      this.logger.success('Chopsticks cleanup complete');
    }
  }
}
