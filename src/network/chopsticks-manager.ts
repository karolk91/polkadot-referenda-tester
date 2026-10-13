import type { NetworkContext } from '@acala-network/chopsticks-testing';
import type { SubstrateApi } from '../types/substrate-api';
import type { Logger } from '../utils/logger';

const CHAIN_READY_MAX_ATTEMPTS = 10;
const CHAIN_READY_DELAY_MS = 500;
const NEW_HEAD_TIMEOUT_MS = 10_000;
const NEW_HEAD_POLL_MS = 100;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
    const headBefore = this.context.chain.head.number;
    await this.context.dev.newBlock(params);
    const deadline = Date.now() + NEW_HEAD_TIMEOUT_MS;
    while (this.context.chain.head.number <= headBefore && Date.now() < deadline) {
      await delay(NEW_HEAD_POLL_MS);
    }
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
        const blockNumber = await api.query.System.Number.getValue();
        this.logger.debug(`Chain ready at block #${blockNumber}`);
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
