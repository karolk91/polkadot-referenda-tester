import {
  type BridgeEndpoints,
  classifyAdditionalBridgeChains,
} from '../bridge/bridge-topology-builder';
import { BridgedNetwork } from '../bridge/bridged-network';
import { fetchChainInfoFromEndpoint } from '../network/chain-identity';
import type { SingleConsensusEndpoints } from '../network/chain-topology-builder';
import { SingleConsensusNetwork } from '../network/single-consensus-network';
import { runStepsOnNetwork } from '../network/step-runner';
import type { ReferendumStep } from '../types';
import {
  type ParsedEndpoint,
  parseEndpoint,
  parseMultipleEndpoints,
} from '../utils/chain-endpoint-parser';
import { Logger } from '../utils/logger';
import { type ChainNetwork, networkFromText } from '../utils/networks';
import { describeStep, fellowshipSource, governanceSource } from '../utils/referendum-steps';
import { buildSteps, type TestOptions } from './test-options';

export type RunPlan =
  | { kind: 'single'; steps: ReferendumStep[]; endpoints: SingleConsensusEndpoints }
  | { kind: 'bridged'; steps: ReferendumStep[]; endpoints: BridgeEndpoints; maxPumpRounds: number };

async function endpointNetwork(endpoint: ParsedEndpoint): Promise<ChainNetwork> {
  const network = networkFromText(endpoint.url);
  if (network !== 'unknown') return network;
  try {
    return (await fetchChainInfoFromEndpoint(endpoint.url)).network;
  } catch {
    return 'unknown';
  }
}

async function crossNetworkScenario(
  fellowship: ParsedEndpoint,
  governance: ParsedEndpoint
): Promise<'single' | 'bridged' | 'unsupported'> {
  const [fellowshipNetwork, governanceNetwork] = await Promise.all([
    endpointNetwork(fellowship),
    endpointNetwork(governance),
  ]);
  if (fellowshipNetwork === 'polkadot' && governanceNetwork === 'kusama') return 'bridged';
  if (
    fellowshipNetwork !== 'unknown' &&
    governanceNetwork !== 'unknown' &&
    fellowshipNetwork !== governanceNetwork
  ) {
    return 'unsupported';
  }
  return 'single';
}

export async function planRun(options: TestOptions, logger: Logger): Promise<RunPlan> {
  const steps = buildSteps(options);
  const hasGovernance = steps.some((step) => governanceSource(step) !== undefined);
  const hasFellowship = steps.some((step) => fellowshipSource(step) !== undefined);
  if (hasGovernance && !options.governanceChainUrl) {
    throw new Error('--governance-chain-url is required when testing a governance referendum');
  }
  if (hasFellowship && !options.fellowshipChainUrl) {
    throw new Error('--fellowship-chain-url is required when testing a fellowship referendum');
  }

  const governance = options.governanceChainUrl
    ? parseEndpoint(options.governanceChainUrl)
    : undefined;
  const fellowship = options.fellowshipChainUrl
    ? parseEndpoint(options.fellowshipChainUrl)
    : undefined;
  const additional = options.additionalChains
    ? parseMultipleEndpoints(options.additionalChains)
    : [];
  const scenario =
    governance && fellowship ? await crossNetworkScenario(fellowship, governance) : 'single';

  if (scenario === 'unsupported') {
    throw new Error(
      'Unsupported direction: only "Polkadot fellowship → Kusama governance" is currently supported. ' +
        'Got fellowship-chain-url + governance-chain-url on different networks in a reversed/unsupported combination. ' +
        'Either use the supported direction or run both referenda on the same network.'
    );
  }
  if (scenario === 'single' || !governance || !fellowship) {
    return {
      kind: 'single',
      steps,
      endpoints: {
        governance: hasGovernance ? governance : undefined,
        fellowship: hasFellowship ? fellowship : undefined,
        additional,
      },
    };
  }
  if (!hasFellowship) {
    throw new Error(
      'Bridged scenario (Polkadot fellowship → Kusama governance) requires a fellowship referendum (--fellowship or --call-to-create-fellowship-referendum)'
    );
  }
  const core = {
    collectives: fellowship,
    assetHubPolkadot: parseEndpoint(options.assetHubPolkadotUrl),
    bridgeHubPolkadot: parseEndpoint(options.bridgeHubPolkadotUrl),
    assetHubKusama: governance,
    bridgeHubKusama: parseEndpoint(options.bridgeHubKusamaUrl),
  };
  const { polkadot, kusama } = await classifyAdditionalBridgeChains(
    additional,
    Object.values(core),
    logger
  );
  return {
    kind: 'bridged',
    steps,
    endpoints: { ...core, additionalPolkadot: polkadot, additionalKusama: kusama },
    maxPumpRounds: options.bridgePumpRounds,
  };
}

export async function testReferendum(options: TestOptions): Promise<void> {
  const logger = new Logger(options.verbose);
  try {
    const plan = await planRun(options, logger);
    const hasFellowship = plan.steps.some((step) => fellowshipSource(step) !== undefined);
    logger.section(
      hasFellowship ? 'Polkadot Referenda Tester (Fellowship Mode)' : 'Polkadot Referenda Tester'
    );
    if (plan.steps.length > 1) {
      logger.section(`Referendum Chain (${plan.steps.length} steps)`);
      plan.steps.forEach((step, index) => {
        logger.info(`  ${index + 1}. ${describeStep(step)}`);
      });
    }

    const network =
      plan.kind === 'bridged'
        ? await BridgedNetwork.create(logger, plan.endpoints, plan.steps, plan.maxPumpRounds)
        : await SingleConsensusNetwork.create(logger, plan.endpoints, plan.steps);
    await runStepsOnNetwork(network, plan.steps, options.cleanup, logger);

    if (options.cleanup) {
      logger.success('\n✓ Workflow completed');
      process.exit(0);
    }
  } catch (error) {
    logger.failSpinner();
    logger.error('Test execution failed', error);
    process.exit(1);
  }
}
