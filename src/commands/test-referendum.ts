import { TestOptions, ChopsticksConfig, SimulationResult } from '../types';
import { Logger } from '../utils/logger';
import { stringify } from '../utils/json';
import { ReferendaFetcher } from '../services/referenda-fetcher';
import { ChopsticksManager } from '../services/chopsticks-manager';
import { ReferendumSimulator } from '../services/referendum-simulator';
import { NetworkCoordinator } from '../services/network-coordinator';
import { getChainInfo, createApiForChain, createPolkadotClient } from '../services/chain-registry';
import { parseEndpoint, parseMultipleEndpoints } from '../utils/chain-endpoint-parser';
import { ReferendumCreator } from '../services/referendum-creator';

function validateOptions(options: TestOptions): void {
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

  const hasGovernanceRef = !!(options.referendum || options.callToCreateGovernanceReferendum);
  const hasFellowshipRef = !!(options.fellowship || options.callToCreateFellowshipReferendum);

  if (!hasGovernanceRef && !hasFellowshipRef) {
    throw new Error(
      'At least one referendum must be specified (--referendum, --fellowship) or created (--call-to-create-governance-referendum, --call-to-create-fellowship-referendum)'
    );
  }
}

function displaySimulationResults(
  result: SimulationResult,
  logger: Logger,
  verbose: boolean
): boolean {
  logger.section('Simulation Results');

  if (result.success && result.executionSucceeded) {
    logger.success(`Referendum #${result.referendumId} executed successfully!`);
    logger.table({
      'Executed at Block': result.blockExecuted || 'N/A',
      'Events Count': result.events.length,
    });

    if (verbose && result.events.length > 0) {
      logger.info('Events:');
      for (const [i, event] of result.events.entries()) {
        logger.info(`  ${i + 1}. ${event.section}.${event.method}`);
        if (event.data) {
          logger.debug(`     Data: ${stringify(event.data, 2)}`);
        }
      }
    }
    return true;
  }

  if (result.success && !result.executionSucceeded) {
    logger.error(`Referendum #${result.referendumId} execution failed`);
  } else {
    logger.error(`Simulation failed for referendum #${result.referendumId}`);
  }

  if (result.errors) {
    logger.error('Errors:');
    for (const error of result.errors) {
      logger.info(`  - ${error}`);
    }
  }

  return false;
}

async function setupGovernanceChain(
  options: TestOptions,
  logger: Logger
): Promise<{
  governanceUrl: string;
  forkBlock: number;
  governanceChainLabel: string | null;
  referendumId: number | undefined;
}> {
  if (!options.governanceChainUrl) {
    throw new Error('--governance-chain-url is required when testing a governance referendum');
  }

  if (!options.referendum && !options.callToCreateGovernanceReferendum) {
    throw new Error(
      '--referendum or --call-to-create-governance-referendum is required when testing a governance referendum'
    );
  }

  const governanceParsed = parseEndpoint(options.governanceChainUrl);
  const governanceUrl = governanceParsed.url;
  const specifiedBlock = governanceParsed.block;

  let referendumId: number | undefined;
  if (options.referendum) {
    referendumId = parseInt(options.referendum);
    if (isNaN(referendumId)) {
      throw new Error(`Invalid referendum ID: ${options.referendum}`);
    }
  }

  let forkBlock: number;
  let governanceChainLabel: string | null = null;

  if (specifiedBlock !== undefined) {
    forkBlock = specifiedBlock;
    logger.info(`Using specified block: ${forkBlock}`);
  } else {
    logger.startSpinner('Connecting to live network to get latest block...');
    const tempClient = createPolkadotClient(governanceUrl);
    const tempApi = createApiForChain(tempClient);
    const chainInfo = await getChainInfo(tempApi, governanceUrl);
    governanceChainLabel = chainInfo.label;
    const fetcher = new ReferendaFetcher(logger);
    forkBlock = await fetcher.getLatestBlock(tempApi);
    tempClient.destroy();
    logger.succeedSpinner(`Latest block: ${forkBlock} on ${governanceChainLabel}`);
  }

  return { governanceUrl, forkBlock, governanceChainLabel, referendumId };
}

async function runGovernanceSimulation(
  options: TestOptions,
  logger: Logger,
  governanceUrl: string,
  forkBlock: number,
  governanceChainLabel: string | null,
  referendumId: number | undefined,
  cleanupEnabled: boolean
): Promise<void> {
  const chopsticks = new ChopsticksManager(logger);
  const chopsticksConfig: ChopsticksConfig = {
    endpoint: governanceUrl,
    port: parseInt(options.port),
    block: forkBlock,
    'build-block-mode': 'manual',
    'mock-signature-host': true,
    'allow-unresolved-imports': true,
  };

  if (options.callToCreateGovernanceReferendum) {
    chopsticksConfig['import-storage'] = ReferendumCreator.getAliceAccountInjection();
    logger.debug('Injecting Alice account with funds for referendum creation');
  }

  await chopsticks.setup(chopsticksConfig);

  logger.startSpinner('Connecting to Chopsticks instance...');
  const localClient = createPolkadotClient(`ws://localhost:${options.port}`);
  const localApi = createApiForChain(localClient);
  logger.succeedSpinner('Connected to Chopsticks instance');

  logger.startSpinner('Waiting for chain to be ready...');
  await chopsticks.waitForChainReady(localApi);
  logger.succeedSpinner('Chain is ready');

  if (!governanceChainLabel) {
    logger.startSpinner('Detecting chain from runtime...');
    const chainInfo = await getChainInfo(localApi, governanceUrl);
    governanceChainLabel = chainInfo.label;
    logger.succeedSpinner(`Detected chain: ${chainInfo.label} (${chainInfo.specName})`);
  }

  if (options.callToCreateGovernanceReferendum) {
    logger.section('Creating Governance Referendum');
    const creator = new ReferendumCreator(logger, chopsticks);
    const creationResult = await creator.createReferendum(
      localApi,
      options.callToCreateGovernanceReferendum,
      options.callToNotePreimageForGovernanceReferendum,
      false
    );
    referendumId = creationResult.referendumId;
    logger.success(`Referendum #${referendumId} created successfully`);
  }

  if (referendumId === undefined) {
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

  const executionSuccess = displaySimulationResults(result, logger, options.verbose);

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
}

export async function testReferendum(options: TestOptions): Promise<void> {
  const logger = new Logger(options.verbose);
  const cleanupEnabled = options.cleanup !== false;

  try {
    validateOptions(options);

    const hasFellowshipRef = !!(options.fellowship || options.callToCreateFellowshipReferendum);

    if (hasFellowshipRef) {
      return await testWithFellowship(options, logger, cleanupEnabled);
    }

    const { governanceUrl, forkBlock, governanceChainLabel, referendumId } =
      await setupGovernanceChain(options, logger);

    logger.section('Polkadot Referenda Tester');
    const tableData: Record<string, string> = {
      'Governance Endpoint': governanceUrl,
      'Governance Chain': governanceChainLabel || 'detecting...',
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
    await runGovernanceSimulation(
      options, logger, governanceUrl, forkBlock, governanceChainLabel, referendumId, cleanupEnabled
    );
  } catch (error) {
    logger.error('Test execution failed', error as Error);
    process.exit(1);
  }
}

async function testWithFellowship(
  options: TestOptions,
  logger: Logger,
  cleanupEnabled: boolean
): Promise<void> {
  logger.section('Polkadot Referenda Tester (Fellowship Mode)');

  const fellowshipRefId = options.fellowship ? parseInt(options.fellowship) : undefined;

  if (fellowshipRefId !== undefined && isNaN(fellowshipRefId)) {
    throw new Error('Invalid fellowship referendum ID');
  }

  const mainRefId = options.referendum ? parseInt(options.referendum) : undefined;

  if (mainRefId !== undefined && isNaN(mainRefId)) {
    throw new Error('Invalid main referendum ID');
  }

  const hasMain = mainRefId !== undefined || !!options.callToCreateGovernanceReferendum;

  if (!hasMain && !options.fellowshipChainUrl) {
    throw new Error('--fellowship-chain-url is required when testing a fellowship referendum');
  }

  if (hasMain && !options.governanceChainUrl) {
    throw new Error(
      '--governance-chain-url is required when testing both governance and fellowship referenda'
    );
  }

  const governanceParsed = options.governanceChainUrl
    ? parseEndpoint(options.governanceChainUrl)
    : undefined;

  const fellowshipParsed = options.fellowshipChainUrl
    ? parseEndpoint(options.fellowshipChainUrl)
    : undefined;

  const additionalChainsParsed = options.additionalChains
    ? parseMultipleEndpoints(options.additionalChains)
    : [];

  logger.debug(`Parsed additional chains: ${additionalChainsParsed.length}`);
  if (additionalChainsParsed.length > 0) {
    logger.debug(
      `URLs: ${additionalChainsParsed.map((c) => `${c.url}${c.block ? `,${c.block}` : ''}`).join('; ')}`
    );
  }

  if (!fellowshipParsed?.url) {
    throw new Error('Fellowship chain URL is required when using --fellowship');
  }

  const coordinator = new NetworkCoordinator(logger, {
    governance: governanceParsed?.url,
    governanceBlock: governanceParsed?.block,
    fellowship: fellowshipParsed.url,
    fellowshipBlock: fellowshipParsed.block,
    additionalChains: additionalChainsParsed,
  });

  if (mainRefId !== undefined) {
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
