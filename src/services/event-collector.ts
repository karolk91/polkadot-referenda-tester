import type { SubstrateApi } from '../types/substrate-api';
import { displayChainEvents } from '../utils/event-serializer';
import type { Logger } from '../utils/logger';
import { createApiForChain, createPolkadotClient } from './chain-registry';
import type { ChopsticksManager } from './chopsticks-manager';

/**
 * Collects and displays post-execution events from chain instances.
 *
 * ┌──────────────────────────────────────────────────┐
 * │              EventCollector                       │
 * │                                                   │
 * │  displayPostExecutionEvents()                     │
 * │    ├─ advance blocks on gov + fellowship          │
 * │    ├─ read System.Events from each                │
 * │    ├─ displayChainEvents() for each               │
 * │    └─ collectAdditionalChainEvents()              │
 * │                                                   │
 * │  collectAdditionalChainEvents()                   │
 * │    ├─ for each additional manager:                │
 * │    │   ├─ newBlock() to process XCM               │
 * │    │   ├─ create temp client + api                │
 * │    │   └─ displayChainEvents()                    │
 * │    └─ destroy temp clients                        │
 * └──────────────────────────────────────────────────┘
 */
export class EventCollector {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async displayPostExecutionEvents(context: {
    governance: { chopsticks: ChopsticksManager; api: SubstrateApi };
    fellowship: { chopsticks: ChopsticksManager; api: SubstrateApi };
    additionalManagers: Map<string, ChopsticksManager>;
    governanceLabel: string;
    fellowshipLabel: string;
  }): Promise<void> {
    const { governance, fellowship, additionalManagers, governanceLabel, fellowshipLabel } =
      context;
    this.logger.section('Post-Execution XCM Events');
    this.logger.info('Advancing blocks to process XCM messages...\n');

    await Promise.all([governance.chopsticks.newBlock(), fellowship.chopsticks.newBlock()]);

    const [
      [governanceBlockNumber, governanceEventsPost],
      [fellowshipBlockNumber, fellowshipEvents],
    ] = await Promise.all([
      Promise.all([
        governance.api.query.System.Number.getValue(),
        governance.api.query.System.Events.getValue(),
      ]),
      Promise.all([
        fellowship.api.query.System.Number.getValue(),
        fellowship.api.query.System.Events.getValue(),
      ]),
    ]);

    displayChainEvents(governanceLabel, governanceBlockNumber, governanceEventsPost, this.logger);
    this.logger.info('');

    displayChainEvents(fellowshipLabel, fellowshipBlockNumber, fellowshipEvents, this.logger);
    this.logger.info('');

    await this.collectAdditionalChainEvents(additionalManagers);
  }

  async collectAdditionalChainEvents(
    additionalManagers: Map<string, ChopsticksManager>
  ): Promise<void> {
    this.logger.debug(
      `collectAdditionalChainEvents called with ${additionalManagers.size} managers`
    );

    if (additionalManagers.size === 0) {
      this.logger.debug('No additional chains to process');
      return;
    }

    this.logger.section('Additional Chain Events');
    this.logger.info(
      `Advancing blocks on ${additionalManagers.size} additional chains to process XCM messages...\n`
    );

    for (const [chainLabel, manager] of additionalManagers) {
      this.logger.debug(`Processing events for chain: ${chainLabel}`);
      try {
        await manager.newBlock();

        const endpoint = manager.getContext().ws.endpoint;
        const client = createPolkadotClient(endpoint);

        try {
          const api = createApiForChain(client);

          const blockNumber = await api.query.System.Number.getValue();
          const events = await api.query.System.Events.getValue();

          displayChainEvents(chainLabel, blockNumber, events, this.logger);
        } finally {
          client.destroy();
        }

        this.logger.info('');
      } catch (error) {
        const chainError = error as Error;
        this.logger.error(`Error collecting events from ${chainLabel}: ${chainError.message}`);
        this.logger.debug(`Stack trace: ${chainError.stack}`);
      }
    }
  }
}
