import { Logger } from '../utils/logger';
import {
  createApiForChain,
  createPolkadotClient,
  getReferendaPallet,
  getReferendaPalletName,
} from '../services/chain-registry';
import { parseEndpoint } from '../utils/chain-endpoint-parser';
import { ChopsticksManager } from '../services/chopsticks-manager';
import { ReferendaFetcher } from '../services/referenda-fetcher';
import { ChopsticksConfig } from '../types';

interface ListOptions {
  governanceChainUrl?: string;
  fellowshipChainUrl?: string;
  status?: string;
  verbose?: boolean;
}

export async function listReferendums(options: ListOptions): Promise<void> {
  const logger = new Logger(options.verbose);

  let chopsticks: ChopsticksManager | null = null;
  let client: any = null;

  try {
    // Determine which chain to use
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

    // Determine fork block
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

    // Start Chopsticks
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

    // Fetch all referendums
    const results: Array<{
      id: number;
      status: string;
      track?: string;
      ayes?: string;
      nays?: string;
      support?: string;
      bareAyes?: string;
    }> = [];

    for (let id = 0; id < referendumCount; id++) {
      const refInfo = await pallet.ReferendumInfoFor.getValue(id);

      if (!refInfo) {
        continue; // Skip if referendum doesn't exist
      }

      // Parse status
      const refType = refInfo.type || Object.keys(refInfo)[0];
      let status: string = refType.toLowerCase();

      // Get track and tally for ongoing referendums
      let track: string | undefined;
      let ayes: string | undefined;
      let nays: string | undefined;
      let support: string | undefined;
      let bareAyes: string | undefined;

      if (status === 'ongoing') {
        const refValue = refInfo.value || refInfo[refType];
        const trackId = refValue?.track;
        if (trackId !== undefined) {
          track = trackId.toString();
        }

        // Extract tally information
        if (refValue?.tally) {
          ayes = refValue.tally.ayes?.toString();
          nays = refValue.tally.nays?.toString();
          support = refValue.tally.support?.toString();
          bareAyes = refValue.tally.bare_ayes?.toString();
        }
      }

      results.push({ id, status, track, ayes, nays, support, bareAyes });
    }

    // Filter results by status if specified
    let filteredResults = results;
    if (options.status) {
      const filterStatus = options.status.toLowerCase();
      filteredResults = results.filter((ref) => ref.status === filterStatus);
    }

    // Output results in parseable format: id,status,track,ayes,nays,support,bareAyes
    for (const ref of filteredResults) {
      const parts = [ref.id, ref.status];

      if (ref.track !== undefined) {
        parts.push(`track=${ref.track}`);
      }
      if (ref.ayes !== undefined) {
        parts.push(`ayes=${ref.ayes}`);
      }
      if (ref.nays !== undefined) {
        parts.push(`nays=${ref.nays}`);
      }
      if (ref.support !== undefined) {
        parts.push(`support=${ref.support}`);
      }
      if (ref.bareAyes !== undefined) {
        parts.push(`bareAyes=${ref.bareAyes}`);
      }

      console.log(parts.join(','));
    }

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
