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
import { describeStep, referendumPresence } from '../utils/referendum-steps';
import { buildSteps, type TestOptions } from './test-options';

export type RunPlan =
  | { kind: 'single'; steps: ReferendumStep[]; endpoints: SingleConsensusEndpoints }
  | { kind: 'bridged'; steps: ReferendumStep[]; endpoints: BridgeEndpoints; maxPumpRounds: number };

async function crossNetworkScenario(
  fellowship: ParsedEndpoint,
  governance: ParsedEndpoint
): Promise<'single' | 'bridged' | 'unsupported'> {
  const [fellowshipNetwork, governanceNetwork] = (
    await Promise.all([
      fetchChainInfoFromEndpoint(fellowship.url),
      fetchChainInfoFromEndpoint(governance.url),
    ])
  ).map((info) => info.network);
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
  const presence = referendumPresence(steps);
  if (presence.governance && !options.governanceChainUrl) {
    throw new Error('--governance-chain-url is required when testing a governance referendum');
  }
  if (presence.fellowship && !options.fellowshipChainUrl) {
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
  const single: RunPlan = {
    kind: 'single',
    steps,
    endpoints: {
      governance: presence.governance ? governance : undefined,
      fellowship: presence.fellowship ? fellowship : undefined,
      additional,
    },
  };
  if (!governance || !fellowship) return single;

  const scenario = await crossNetworkScenario(fellowship, governance);
  if (scenario === 'unsupported') {
    throw new Error(
      'Unsupported direction: only "Polkadot fellowship → Kusama governance" is currently supported. ' +
        'Got fellowship-chain-url + governance-chain-url on different networks in a reversed/unsupported combination. ' +
        'Either use the supported direction or run both referenda on the same network.'
    );
  }
  if (scenario === 'single') return single;
  if (!presence.fellowship) {
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
    logger.section(
      referendumPresence(plan.steps).fellowship
        ? 'Polkadot Referenda Tester (Fellowship Mode)'
        : 'Polkadot Referenda Tester'
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
