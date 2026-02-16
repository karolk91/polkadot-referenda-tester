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
import { ReferendumCreator } from '../services/referendum-creator';

export async function testReferendum(options: TestOptions): Promise<void> {
  const logger = new Logger(options.verbose);
  const cleanupEnabled = options.cleanup !== false;

  try {
    // Validate mutually exclusive parameters
    if (options.referendum && options.callToCreateGovernanceReferendum) {
      throw new Error(
        'Cannot specify both --referendum (existing ID) and --call-to-create-governance-referendum (create new). Use one or the other.'
      );
    }

    if (options.fellowship && options.callToCreateFellowshipReferendum) {
      throw new Error(
        'Cannot specify both --fellowship (existing ID) and --call-to-create-fellowship-referendum (create new). Use one or the other.'
      );
    }

    // Validate that at least one referendum is provided or will be created
    const hasGovernanceRef = !!(options.referendum || options.callToCreateGovernanceReferendum);
    const hasFellowshipRef = !!(options.fellowship || options.callToCreateFellowshipReferendum);

    if (!hasGovernanceRef && !hasFellowshipRef) {
      throw new Error(
        'At least one referendum must be specified (--referendum, --fellowship) or created (--call-to-create-governance-referendum, --call-to-create-fellowship-referendum)'
      );
    }

    // Check if fellowship referendum is provided or will be created
    if (hasFellowshipRef) {
      // Use NetworkCoordinator for multi-chain setup
      return await testWithFellowship(options, logger, cleanupEnabled);
    }

    // Otherwise continue with single-chain test below (governance only)

    // Validate governance chain URL is provided for single referendum test
    if (!options.governanceChainUrl) {
      throw new Error('--governance-chain-url is required when testing a governance referendum');
    }

    // Validate referendum ID or creation call is provided
    if (!options.referendum && !options.callToCreateGovernanceReferendum) {
      throw new Error(
        '--referendum or --call-to-create-governance-referendum is required when testing a governance referendum'
      );
    }

    // Parse governance URL and optional block number
    const governanceParsed = parseEndpoint(options.governanceChainUrl);
    const governanceUrl = governanceParsed.url;

    // Block number from url,block format or use latest
    const specifiedBlock = governanceParsed.block;

    // Parse referendum ID if provided, otherwise it will be created later
    let referendumId: number | undefined;
    if (options.referendum) {
      referendumId = parseInt(options.referendum);
      if (isNaN(referendumId)) {
        throw new Error(`Invalid referendum ID: ${options.referendum}`);
      }
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
      'Referendum ID': options.referendum || '(creating...)',
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
    const chopsticksConfig: ChopsticksConfig = {
      endpoint: governanceUrl,
      port: parseInt(options.port),
      block: forkBlock,
      'build-block-mode': 'manual',
      'mock-signature-host': true,
      'allow-unresolved-imports': true,
    };

    await chopsticks.setup(chopsticksConfig);

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

    // Create referendum if needed
    if (options.callToCreateGovernanceReferendum) {
      logger.section('Creating Governance Referendum');
      const creator = new ReferendumCreator(logger, chopsticks);
      const creationResult = await creator.createReferendum(
        localApi,
        options.callToCreateGovernanceReferendum,
        options.callToNotePreimageForGovernanceReferendum,
        false // not fellowship
      );
      referendumId = creationResult.referendumId;
      logger.success(`Referendum #${referendumId} created successfully`);
    }

    if (!referendumId) {
      throw new Error('Referendum ID is required but was not provided or created');
    }

    logger.section('Fetching Referendum Data');
    const fetcher = new ReferendaFetcher(logger);
    const referendum = await fetcher.fetchReferendum(localApi, referendumId);

    if (!referendum) {
      localClient.destroy();
      await chopsticks.cleanup();
      throw new Error('Failed to fetch referendum or referendum not found');
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
    // Force exit - cleanup already happened in finally blocks,
    // but dangling WebSocket handles can keep the process alive
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

  // Parse fellowship referendum ID if provided (otherwise it will be created)
  const fellowshipRefId = options.fellowship ? parseInt(options.fellowship) : undefined;

  if (fellowshipRefId !== undefined && isNaN(fellowshipRefId)) {
    throw new Error('Invalid fellowship referendum ID');
  }

  // Check if we're testing fellowship only (no main referendum)
  const mainRefId = options.referendum ? parseInt(options.referendum) : undefined;

  if (mainRefId !== undefined && isNaN(mainRefId)) {
    throw new Error('Invalid main referendum ID');
  }

  // Determine if we're testing fellowship only (no main referendum)
  const hasMain = mainRefId !== undefined || !!options.callToCreateGovernanceReferendum;

  // If only testing fellowship (no main ref), validate fellowship chain URL is provided
  if (!hasMain && !options.fellowshipChainUrl) {
    throw new Error('--fellowship-chain-url is required when testing a fellowship referendum');
  }

  // If testing with both refs, validate governance chain URL is provided
  if (hasMain && !options.governanceChainUrl) {
    throw new Error(
      '--governance-chain-url is required when testing both governance and fellowship referenda'
    );
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
    logger.info(
      `Fellowship Referendum: ${fellowshipRefId !== undefined ? `#${fellowshipRefId}` : '(creating...)'}`
    );
    logger.info(`Main Referendum: #${mainRefId}\n`);
  } else {
    logger.info(
      `Fellowship Referendum: ${fellowshipRefId !== undefined ? `#${fellowshipRefId}` : '(creating...)'}\n`
    );
  }

  await coordinator.testWithFellowship(mainRefId, fellowshipRefId, cleanupEnabled, options);

  if (cleanupEnabled) {
    logger.success('\n\u2713 Fellowship workflow completed');
    process.exit(0);
  }
}
