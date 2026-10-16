import { blockEvents, type ParsedEvent, printEvents } from '../utils/events';
import type { Logger } from '../utils/logger';
import { blockNumber } from './chain-client';
import type { Fork } from './fork';

export async function printForkEvents(
  fork: Fork,
  events: ParsedEvent[],
  logger: Logger
): Promise<void> {
  printEvents(
    `\u{1F4E1} ${fork.info.label} (Block #${await blockNumber(fork.api)})`,
    events,
    logger
  );
  logger.info('');
}

export async function buildBlocksAndPrintEvents(forks: Fork[], logger: Logger): Promise<void> {
  if (forks.length === 0) {
    return;
  }
  logger.section('Additional Chain Events');
  logger.info(`Advancing blocks on ${forks.length} additional chains to process XCM messages...\n`);
  for (const fork of forks) {
    try {
      await fork.manager.newBlock();
      await printForkEvents(fork, await blockEvents(fork.api), logger);
    } catch (error) {
      logger.error(`Error collecting events from ${fork.info.label}`, error);
    }
  }
}
