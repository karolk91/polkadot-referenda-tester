import type { SubstrateApi } from '../types/substrate-api';
import { stringify } from './json';
import type { Logger } from './logger';

export interface ParsedEvent {
  section: string;
  method: string;
  data: unknown;
}

export function isEvent(event: ParsedEvent, section: string, method: string): boolean {
  return event.section === section && event.method === method;
}

export async function blockEvents(api: SubstrateApi): Promise<ParsedEvent[]> {
  return (await api.query.System.Events.getValue()).map(({ event }) => ({
    section: event.type,
    method: event.value.type,
    data: event.value.value,
  }));
}

export function printEvents(heading: string, events: ParsedEvent[], logger: Logger): void {
  logger.info(heading);
  if (events.length === 0) {
    logger.info('  No events found');
  }
  for (const event of events) {
    logger.info(`  • ${event.section}.${event.method}`);
    if (logger.isVerbose() && event.data !== undefined) {
      logger.debug(`    Data: ${stringify(event.data, 2)}`);
    }
  }
}
