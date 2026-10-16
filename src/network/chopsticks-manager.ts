import type { NetworkContext } from '@acala-network/chopsticks-testing';
import type { SubstrateApi } from '../types/substrate-api';
import { delay } from '../utils/delay';
import type { Logger } from '../utils/logger';
import { blockNumber } from './chain-client';

const CHAIN_READY_MAX_ATTEMPTS = 10;
const CHAIN_READY_DELAY_MS = 500;

export class ChopsticksManager {
  constructor(
    private readonly logger: Logger,
    readonly context: NetworkContext
  ) {}

  async newBlock(params?: { transactions?: string[] }): Promise<void> {
    this.logger.debug(
      params?.transactions
        ? `Creating new block with ${params.transactions.length} transaction(s)...`
        : 'Creating new block...'
    );
    await this.context.dev.newBlock(params);
  }

  async setStorageBatch(updates: Record<string, unknown>): Promise<void> {
    this.logger.debug('Setting batch storage updates');
    await this.context.dev.setStorage(
      updates as Parameters<NetworkContext['dev']['setStorage']>[0]
    );
  }

  async waitForChainReady(api: SubstrateApi): Promise<void> {
    this.logger.debug('Waiting for chain to be ready...');
    for (let attempt = 1; attempt <= CHAIN_READY_MAX_ATTEMPTS; attempt++) {
      try {
        this.logger.debug(`Chain ready at block #${await blockNumber(api)}`);
        return;
      } catch (error) {
        if (attempt === CHAIN_READY_MAX_ATTEMPTS) {
          throw new Error(`Chain not ready after ${CHAIN_READY_MAX_ATTEMPTS} attempts: ${error}`);
        }
        this.logger.debug(
          `Chain not ready yet (attempt ${attempt}/${CHAIN_READY_MAX_ATTEMPTS}), retrying...`
        );
        await delay(CHAIN_READY_DELAY_MS);
      }
    }
  }

  async pause(): Promise<void> {
    this.logger.debug('Pausing Chopsticks instance...');
    await this.context.pause();
  }

  async cleanup(): Promise<void> {
    this.logger.debug('Cleaning up Chopsticks context...');
    await this.context.teardown();
    this.logger.success('Chopsticks cleanup complete');
  }
}
