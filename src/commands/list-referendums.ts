import { fetchChainInfoFromEndpoint } from '../network/chain-identity';
import { forkSpec } from '../network/chain-topology-builder';
import { chainForks, type Fork, shutdownForks } from '../network/fork';
import { FELLOWSHIP, GOVERNANCE } from '../referendum/referenda-kind';
import type { RawReferendumInfo } from '../types/substrate-api';
import { parseEndpoint } from '../utils/chain-endpoint-parser';
import { Logger } from '../utils/logger';

interface ListOptions {
  governanceChainUrl?: string;
  fellowshipChainUrl?: string;
  status?: string;
  verbose?: boolean;
}

function referendumLine(id: number, info: RawReferendumInfo): string {
  const parts: Array<string | number> = [id, info.type.toLowerCase()];
  if (info.type === 'Ongoing') {
    const { track, tally } = info.value;
    parts.push(`track=${track}`, `ayes=${tally.ayes}`, `nays=${tally.nays}`);
    if ('support' in tally) parts.push(`support=${tally.support}`);
    if ('bare_ayes' in tally) parts.push(`bareAyes=${tally.bare_ayes}`);
  }
  return parts.join(',');
}

export async function listReferendums(options: ListOptions): Promise<void> {
  const logger = new Logger(options.verbose);
  const kind = options.fellowshipChainUrl === undefined ? GOVERNANCE : FELLOWSHIP;
  const url = options.fellowshipChainUrl ?? options.governanceChainUrl;
  let fork: Fork | undefined;
  try {
    if (!url) {
      throw new Error('Either --governance-chain-url or --fellowship-chain-url is required');
    }
    const endpoint = parseEndpoint(url);
    const info = await fetchChainInfoFromEndpoint(endpoint.url);

    logger.startSpinner('Starting Chopsticks local environment...');
    const forks = await chainForks(
      [forkSpec('chain', endpoint, info.kind, { runtimeLogLevel: 0 })],
      logger
    );
    fork = forks.get('chain')!;
    logger.succeedSpinner(
      `Forked ${info.label} at block ${fork.manager.context.chain.head.number}`
    );

    logger.startSpinner(`Fetching ${kind.palletName} referendums...`);
    const entries = await kind.pallet(fork.api).ReferendumInfoFor.getEntries();
    logger.succeedSpinner(`Found ${entries.length} referendum(s)`);

    const statusFilter = options.status?.toLowerCase();
    const referenda = entries
      .map(({ keyArgs, value }) => ({ id: Number(keyArgs[0]), referendum: value }))
      .sort((first, second) => first.id - second.id);
    for (const { id, referendum } of referenda) {
      if (!statusFilter || referendum.type.toLowerCase() === statusFilter) {
        console.log(referendumLine(id, referendum));
      }
    }
    process.exitCode = 0;
  } catch (error) {
    logger.failSpinner();
    logger.error('Failed to list referendums', error);
    process.exitCode = 1;
  } finally {
    if (fork) {
      await shutdownForks([{ label: fork.info.label, fork }], true, logger).catch((error) =>
        logger.debug(`Error cleaning up chopsticks: ${error}`)
      );
    }
  }
}
