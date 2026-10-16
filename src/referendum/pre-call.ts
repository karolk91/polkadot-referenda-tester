import { blockNumber } from '../network/chain-client';
import type { ChopsticksManager } from '../network/chopsticks-manager';
import type { PreCall } from '../types';
import type { SubstrateApi } from '../types/substrate-api';
import { blockEvents, printEvents } from '../utils/events';
import { stringify } from '../utils/json';
import type { Logger } from '../utils/logger';
import { executionFailures } from './execution-result-checker';
import type { SchedulerManager } from './scheduler-manager';

const GOVERNANCE_ORIGINS = new Set([
  'WhitelistedCaller',
  'WishForChange',
  'StakingAdmin',
  'Treasurer',
  'LeaseAdmin',
  'FellowshipAdmin',
  'GeneralAdmin',
  'AuctionAdmin',
  'ReferendumCanceller',
  'ReferendumKiller',
  'SmallTipper',
  'BigTipper',
  'SmallSpender',
  'MediumSpender',
  'BigSpender',
]);

export interface PreCallChain {
  api: SubstrateApi;
  chopsticks: ChopsticksManager;
  scheduler: SchedulerManager;
}

export function parseOriginString(originString: string, logger: Logger): Record<string, string> {
  if (originString === 'Root') {
    return { System: 'Root' };
  }
  if (originString.includes('.')) {
    const [palletOrType, variant] = originString.split('.');
    return { [palletOrType]: variant };
  }
  if (GOVERNANCE_ORIGINS.has(originString)) {
    return { Origins: originString };
  }
  logger.warn(`Unknown origin format "${originString}", treating as System origin`);
  return { System: originString };
}

export async function executePreCall(
  preCall: PreCall,
  { api, chopsticks, scheduler }: PreCallChain,
  logger: Logger
): Promise<void> {
  logger.section('Executing Pre-Call');
  logger.debug(`Pre-call hex: ${preCall.call.substring(0, 66)}...`);
  const origin = parseOriginString(preCall.origin ?? 'Root', logger);
  logger.info(`Pre-call origin: ${stringify(origin)}`);

  const preCallBlock = await scheduler.nextAgendaBlock();
  logger.startSpinner(`Injecting pre-call into Scheduler at block ${preCallBlock}...`);
  const task = await scheduler.appendInlineCall(preCall.call, origin, preCallBlock);
  logger.succeedSpinner(`Pre-call injected into Scheduler at block ${preCallBlock}`);

  logger.startSpinner('Creating block to execute pre-call...');
  await chopsticks.newBlock();
  logger.succeedSpinner(`Pre-call executed at block ${await blockNumber(api)}`);

  const events = await blockEvents(api);
  printEvents('Pre-call events:', events, logger);
  const failures = executionFailures(events, task, logger);
  if (failures.length === 0) {
    logger.success('Pre-call executed successfully');
  } else {
    logger.warn(`Pre-call dispatch failed: ${failures.join('; ')}`);
  }
}
