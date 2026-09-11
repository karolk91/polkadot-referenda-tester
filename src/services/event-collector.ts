import type { SubstrateApi } from '../types/substrate-api';
import { displayChainEvents } from '../utils/event-serializer';
import type { Logger } from '../utils/logger';
import type { ChopsticksManager } from './chopsticks-manager';

/** A live fork this collector builds blocks on and reads events from (a `Fork` from the coordinator). */
export interface CollectableChain {
  label: string;
  manager: ChopsticksManager;
  api: SubstrateApi;
}

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
 * │    └─ for each other fork:                        │
 * │        ├─ newBlock() to process XCM               │
 * │        └─ displayChainEvents()                    │
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
    additional: CollectableChain[];
    governanceLabel: string;
    fellowshipLabel: string;
  }): Promise<void> {
    const { governance, fellowship, additional, governanceLabel, fellowshipLabel } = context;
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

    await this.collectAdditionalChainEvents(additional);
  }

  /**
   * Build a block on every other fork so it processes the XCM the referendum sent, then print the
   * resulting events. This reuses each fork's long-lived client, so a chained run does not
   * reconnect to every chain and re-download its metadata on every step.
   */
  async collectAdditionalChainEvents(chains: CollectableChain[]): Promise<void> {
    this.logger.debug(`collectAdditionalChainEvents called with ${chains.length} chains`);

    if (chains.length === 0) {
      this.logger.debug('No additional chains to process');
      return;
    }

    this.logger.section('Additional Chain Events');
    this.logger.info(
      `Advancing blocks on ${chains.length} additional chains to process XCM messages...\n`
    );

    for (const { label, manager, api } of chains) {
      this.logger.debug(`Processing events for chain: ${label}`);
      try {
        await manager.newBlock();

        const [blockNumber, events] = await Promise.all([
          api.query.System.Number.getValue(),
          api.query.System.Events.getValue(),
        ]);

        displayChainEvents(label, blockNumber, events, this.logger);
        this.logger.info('');
      } catch (error) {
        const chainError = error as Error;
        this.logger.error(`Error collecting events from ${label}: ${chainError.message}`);
        this.logger.debug(`Stack trace: ${chainError.stack}`);
      }
    }
  }
}
