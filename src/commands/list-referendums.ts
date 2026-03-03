import type { PolkadotClient } from 'polkadot-api';
import {
  createApiForChain,
  createPolkadotClient,
  getReferendaPallet,
  getReferendaPalletName,
} from '../services/chain-registry';
import { ChopsticksManager } from '../services/chopsticks-manager';
import { ReferendaFetcher } from '../services/referenda-fetcher';
import type { ChopsticksConfig } from '../types';
import type { RawReferendumInfo, ReferendaPallet } from '../types/substrate-api';
import { parseEndpoint } from '../utils/chain-endpoint-parser';
import { Logger } from '../utils/logger';

interface ListOptions {
  governanceChainUrl?: string;
  fellowshipChainUrl?: string;
  status?: string;
  verbose?: boolean;
}

interface ReferendumEntry {
  id: number;
  status: string;
  track?: string;
  ayes?: string;
  nays?: string;
  support?: string;
  bareAyes?: string;
}

async function fetchAllReferendumEntries(
  pallet: ReferendaPallet,
  referendumCount: number
): Promise<ReferendumEntry[]> {
  const entries: ReferendumEntry[] = [];

  for (let id = 0; id < referendumCount; id++) {
    const refInfo = (await pallet.ReferendumInfoFor.getValue(id)) as RawReferendumInfo | undefined;

    if (!refInfo) {
      continue;
    }

    const status: string = refInfo.type.toLowerCase();
    let track: string | undefined;
    let ayes: string | undefined;
    let nays: string | undefined;
    let support: string | undefined;
    let bareAyes: string | undefined;

    if (refInfo.type === 'Ongoing') {
      const ongoing = refInfo.value;
      track = String(ongoing.track);

      if (ongoing.tally) {
        ayes = ongoing.tally.ayes.toString();
        nays = ongoing.tally.nays.toString();
        support = 'support' in ongoing.tally ? String(ongoing.tally.support) : undefined;
        bareAyes = 'bare_ayes' in ongoing.tally ? String(ongoing.tally.bare_ayes) : undefined;
      }
    }

    entries.push({ id, status, track, ayes, nays, support, bareAyes });
  }

  return entries;
}

function formatReferendumOutput(entries: ReferendumEntry[], statusFilter?: string): void {
  let filtered = entries;
  if (statusFilter) {
    const filterStatus = statusFilter.toLowerCase();
    filtered = entries.filter((entry) => entry.status === filterStatus);
  }

  for (const entry of filtered) {
    const parts: Array<string | number> = [entry.id, entry.status];

    if (entry.track !== undefined) {
      parts.push(`track=${entry.track}`);
    }
    if (entry.ayes !== undefined) {
      parts.push(`ayes=${entry.ayes}`);
    }
    if (entry.nays !== undefined) {
      parts.push(`nays=${entry.nays}`);
    }
    if (entry.support !== undefined) {
      parts.push(`support=${entry.support}`);
    }
    if (entry.bareAyes !== undefined) {
      parts.push(`bareAyes=${entry.bareAyes}`);
    }

    console.log(parts.join(','));
  }
}

export async function listReferendums(options: ListOptions): Promise<void> {
  const logger = new Logger(options.verbose);

  let chopsticks: ChopsticksManager | null = null;
  let client: PolkadotClient | null = null;

  try {
    let chainUrl: string;
    let blockNumber: number | undefined;
    let useFellowship = false;

    if (options.fellowshipChainUrl) {
      const parsed = parseEndpoint(options.fellowshipChainUrl);
      chainUrl = parsed.url;
      blockNumber = parsed.block;
      useFellowship = true;
    } else if (options.governanceChainUrl) {
      const parsed = parseEndpoint(options.governanceChainUrl);
      chainUrl = parsed.url;
      blockNumber = parsed.block;
      useFellowship = false;
    } else {
      throw new Error('Either --governance-chain-url or --fellowship-chain-url is required');
    }

    let forkBlock: number;
    if (blockNumber !== undefined) {
      forkBlock = blockNumber;
      logger.info(`Using specified block: ${forkBlock}`);
    } else {
      logger.startSpinner('Connecting to live network to get latest block...');
      const tempClient = createPolkadotClient(chainUrl);
      const tempApi = createApiForChain(tempClient);
      const fetcher = new ReferendaFetcher(logger);
      forkBlock = await fetcher.getLatestBlock(tempApi);
      tempClient.destroy();
      logger.succeedSpinner(`Latest block: ${forkBlock}`);
    }

    chopsticks = new ChopsticksManager(logger);
    const chopsticksConfig: ChopsticksConfig = {
      endpoint: chainUrl,
      port: 8000,
      block: forkBlock,
      'build-block-mode': 'manual',
      'mock-signature-host': true,
      'allow-unresolved-imports': true,
    };

    const context = await chopsticks.setup(chopsticksConfig);

    logger.startSpinner('Connecting to Chopsticks...');
    const chopsticksEndpoint = context.ws.endpoint;
    client = createPolkadotClient(chopsticksEndpoint);
    const api = createApiForChain(client);
    logger.succeedSpinner('Connected');

    const palletName = getReferendaPalletName(useFellowship);
    const pallet = getReferendaPallet(api, useFellowship);
    logger.startSpinner(`Fetching ${palletName} referendums...`);

    const referendumCount: number = await pallet.ReferendumCount.getValue();
    logger.succeedSpinner(`Found ${referendumCount} referendum(s)`);

    const entries = await fetchAllReferendumEntries(pallet, referendumCount);
    formatReferendumOutput(entries, options.status);

    process.exitCode = 0;
  } catch (error) {
    logger.error('Failed to list referendums', error as Error);
    process.exitCode = 1;
  } finally {
    try {
      if (client) client.destroy();
    } catch (cleanupError) {
      logger.debug(`Error destroying client: ${cleanupError}`);
    }
    try {
      if (chopsticks) await chopsticks.cleanup();
    } catch (cleanupError) {
      logger.debug(`Error cleaning up chopsticks: ${cleanupError}`);
    }
  }
}
