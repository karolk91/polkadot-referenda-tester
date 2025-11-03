import { createClient } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws-provider/node';
import { withPolkadotSdkCompat } from 'polkadot-api/polkadot-sdk-compat';
import { TestOptions, ChopsticksConfig } from '../types';
import { Logger } from '../utils/logger';
import { ReferendaFetcher } from '../services/referenda-fetcher';
import { ChopsticksManager } from '../services/chopsticks-manager';
import { ReferendumSimulator } from '../services/referendum-simulator';
import { NetworkCoordinator } from '../services/network-coordinator';
import { getChainInfo, createApiForChain } from '../services/chain-registry';
import { parseEndpoint, parseMultipleEndpoints } from '../utils/chain-endpoint-parser';

export async function testReferendum(options: TestOptions): Promise<void> {
  const logger = new Logger(options.verbose);
  const cleanupEnabled = options.cleanup !== false;

  try {
    // Validate that at least one referendum is provided
    if (!options.referendum && !options.fellowship) {
      throw new Error('At least one of --referendum or --fellowship must be specified');
    }

    // Check if fellowship referendum is provided
    if (options.fellowship) {
      // Use NetworkCoordinator for multi-chain setup
      return await testWithFellowship(options, logger, cleanupEnabled);
    }

    // Otherwise continue with single-chain test below

    // Validate governance chain URL is provided for single referendum test
    if (!options.governanceChainUrl) {
      throw new Error('--governance-chain-url is required when testing a governance referendum');
    }

    // Validate referendum ID
    if (!options.referendum) {
      throw new Error('--referendum is required when testing a governance referendum');
    }

    // Parse governance URL and optional block number
    const governanceParsed = parseEndpoint(options.governanceChainUrl);
    const governanceUrl = governanceParsed.url;

    // Block number from url,block format or use latest
    const specifiedBlock = governanceParsed.block;

    const referendumId = parseInt(options.referendum);
    if (isNaN(referendumId)) {
      throw new Error(`Invalid referendum ID: ${options.referendum}`);
    }

    // Determine fork block and get chain info (if needed for latest block)
    let forkBlock: number;
    let governanceChain;

    if (specifiedBlock !== undefined) {
      forkBlock = specifiedBlock;
      logger.info(`Using specified block: ${forkBlock}`);
      // We'll get chain info after connecting to Chopsticks
      governanceChain = null;
    } else {
      logger.startSpinner('Connecting to live network to get latest block...');
      const tempClient = createClient(withPolkadotSdkCompat(getWsProvider(governanceUrl)));
      const tempApi = createApiForChain(tempClient);
      governanceChain = await getChainInfo(tempApi, governanceUrl);
      const fetcher = new ReferendaFetcher(logger);
      forkBlock = await fetcher.getLatestBlock(tempApi);
      tempClient.destroy();
      logger.succeedSpinner(`Latest block: ${forkBlock} on ${governanceChain.label}`);
    }

    logger.section('Polkadot Referenda Tester');
    const tableData: Record<string, string> = {
      'Governance Endpoint': governanceUrl,
      'Governance Chain': governanceChain?.label || 'detecting...',
      'Referendum ID': options.referendum,
      Port: options.port,
      Block: forkBlock.toString(),
    };

    if (options.preCall) {
      tableData['Pre-Call'] = `${options.preCall.substring(0, 20)}...`;
      tableData['Pre-Origin'] = options.preOrigin || 'Root';
    }

    logger.table(tableData);

    logger.section('Setting Up Test Environment');
    const chopsticks = new ChopsticksManager(logger);
    const chopsticsConfig: ChopsticksConfig = {
      endpoint: governanceUrl,
      port: parseInt(options.port),
      block: forkBlock,
      'build-block-mode': 'manual',
      'mock-signature-host': true,
      'allow-unresolved-imports': true,
    };

    await chopsticks.setup(chopsticsConfig);

    logger.startSpinner('Connecting to Chopsticks instance...');
    const localClient = createClient(
      withPolkadotSdkCompat(getWsProvider(`ws://localhost:${options.port}`))
    );
    const localApi = createApiForChain(localClient);
    logger.succeedSpinner('Connected to Chopsticks instance');

    logger.startSpinner('Waiting for chain to be ready...');
    await chopsticks.waitForChainReady(localApi);
    logger.succeedSpinner('Chain is ready');

    // Get chain info from Chopsticks instance if we didn't get it earlier
    if (!governanceChain) {
      logger.startSpinner('Detecting chain from runtime...');
      governanceChain = await getChainInfo(localApi, governanceUrl);
      logger.succeedSpinner(
        `Detected chain: ${governanceChain.label} (${governanceChain.specName})`
      );
    }

    logger.section('Fetching Referendum Data');
    const fetcher = new ReferendaFetcher(logger);
    const referendum = await fetcher.fetchReferendum(localApi, referendumId);

    if (!referendum) {
      logger.error('Failed to fetch referendum or referendum not found');
      localClient.destroy();
      await chopsticks.cleanup();
      process.exit(1);
    }

    logger.success('Referendum data fetched successfully');
    logger.table({
      ID: referendum.id,
      Track: referendum.track,
      Status: referendum.status,
      'Proposal Hash': referendum.proposal.hash,
      'Submitted At': referendum.submittedAt,
      Ayes: referendum.tally?.ayes.toString() || 'N/A',
      Nays: referendum.tally?.nays.toString() || 'N/A',
      Support: referendum.tally?.support.toString() || 'N/A',
    });

    const simulator = new ReferendumSimulator(logger, chopsticks, localApi);
    const result = await simulator.simulate(referendum, {
      preCall: options.preCall,
      preOrigin: options.preOrigin,
    });

    logger.section('Simulation Results');

    let executionSuccess = false;

    if (result.success && result.executionSucceeded) {
      logger.success(`Referendum #${result.referendumId} executed successfully!`);
      logger.table({
        'Executed at Block': result.blockExecuted || 'N/A',
        'Events Count': result.events.length,
      });

      if (options.verbose && result.events.length > 0) {
        logger.info('Events:');
        result.events.forEach((event, i) => {
          console.log(`  ${i + 1}. ${event.section}.${event.method}`);
          if (event.data) {
            console.log(`     Data: ${JSON.stringify(event.data, null, 2)}`);
          }
        });
      }
      executionSuccess = true;
    } else if (result.success && !result.executionSucceeded) {
      logger.error(`Referendum #${result.referendumId} execution failed`);
      if (result.errors) {
        logger.error('Errors:');
        result.errors.forEach((error) => {
          console.log(`  - ${error}`);
        });
      }
    } else {
      logger.error(`Simulation failed for referendum #${result.referendumId}`);
      if (result.errors) {
        logger.error('Errors:');
        result.errors.forEach((error) => {
          console.log(`  - ${error}`);
        });
      }
    }

    // Step 8: Cleanup
    if (cleanupEnabled) {
      logger.section('Cleaning Up');
      await chopsticks.cleanup();
      localClient.destroy();
      logger.success('Cleanup complete');
      process.exit(executionSuccess ? 0 : 1);
    } else {
      logger.info(`Chopsticks instance still running on port ${options.port}`);
      logger.info('Press Ctrl+C to stop');
      if (!executionSuccess) {
        logger.info('Note: Test failed but Chopsticks instance is still running for inspection');
      }
    }
  } catch (error) {
    logger.error('Test execution failed', error as Error);
    process.exit(1);
  }
}

/**
 * Test referendum with fellowship companion (multi-chain)
 */
async function testWithFellowship(
  options: TestOptions,
  logger: Logger,
  cleanupEnabled: boolean
): Promise<void> {
  logger.section('Polkadot Referenda Tester (Fellowship Mode)');

  const fellowshipRefId = parseInt(options.fellowship!);

  if (isNaN(fellowshipRefId)) {
    throw new Error('Invalid fellowship referendum ID');
  }

  // Check if we're testing fellowship only (no main referendum)
  const mainRefId = options.referendum ? parseInt(options.referendum) : undefined;

  if (mainRefId !== undefined && isNaN(mainRefId)) {
    throw new Error('Invalid main referendum ID');
  }

  // If only testing fellowship (no main ref), validate fellowship chain URL is provided
  if (!mainRefId && !options.fellowshipChainUrl) {
    throw new Error('--fellowship-chain-url is required when testing a fellowship referendum');
  }

  // If testing with both refs, validate governance chain URL is provided
  if (mainRefId && !options.governanceChainUrl) {
    throw new Error('--governance-chain-url is required when testing both governance and fellowship referenda');
  }

  // Parse governance endpoint and optional block (if provided)
  const governanceParsed = options.governanceChainUrl
    ? parseEndpoint(options.governanceChainUrl)
    : undefined;

  // Parse fellowship endpoint and optional block
  const fellowshipParsed = options.fellowshipChainUrl
    ? parseEndpoint(options.fellowshipChainUrl)
    : undefined;

  // Parse additional chains if provided
  const additionalChainsParsed = options.additionalChains
    ? parseMultipleEndpoints(options.additionalChains)
    : [];

  logger.debug(`Parsed additional chains: ${additionalChainsParsed.length}`);
  if (additionalChainsParsed.length > 0) {
    logger.debug(
      `URLs: ${additionalChainsParsed.map((c) => `${c.url}${c.block ? `,${c.block}` : ''}`).join('; ')}`
    );
  }

  // Check fellowship URL was provided
  if (!fellowshipParsed?.url) {
    throw new Error('Fellowship chain URL is required when using --fellowship');
  }

  const coordinator = new NetworkCoordinator(logger, {
    governance: governanceParsed?.url,
    governanceBlock: governanceParsed?.block,
    fellowship: fellowshipParsed.url,
    fellowshipBlock: fellowshipParsed.block,
    additionalChains: additionalChainsParsed.map((c) => c.url),
    additionalChainBlocks: additionalChainsParsed.map((c) => c.block),
  });

  if (mainRefId) {
    logger.info(`Fellowship Referendum: #${fellowshipRefId}`);
    logger.info(`Main Referendum: #${mainRefId}\n`);
  } else {
    logger.info(`Fellowship Referendum: #${fellowshipRefId}\n`);
  }

  await coordinator.testWithFellowship(
    mainRefId,
    fellowshipRefId,
    parseInt(options.port),
    cleanupEnabled
  );

  if (cleanupEnabled) {
    logger.success('\n✓ Fellowship workflow completed');
    process.exit(0);
  }
}
