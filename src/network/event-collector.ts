import { blockEvents, printEvents } from '../utils/events';
import type { Logger } from '../utils/logger';
import { blockNumber } from './chain-client';
import type { Fork } from './fork';

export async function buildBlocksAndPrintEvents(forks: Fork[], logger: Logger): Promise<void> {
  if (forks.length === 0) {
    return;
  }
  logger.section('Additional Chain Events');
  logger.info(`Advancing blocks on ${forks.length} additional chains to process XCM messages...\n`);
  for (const fork of forks) {
    try {
      await fork.manager.newBlock();
      const [number, events] = await Promise.all([blockNumber(fork.api), blockEvents(fork.api)]);
      printEvents(`\u{1F4E1} ${fork.info.label} (Block #${number})`, events, logger);
      logger.info('');
    } catch (error) {
      logger.error(`Error collecting events from ${fork.info.label}`, error);
    }
  }
}
