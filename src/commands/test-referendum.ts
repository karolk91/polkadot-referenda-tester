import { TestOptions } from '../types';
import { Logger } from '../utils/logger';
import { NetworkCoordinator } from '../services/network-coordinator';
import { parseEndpoint, parseMultipleEndpoints } from '../utils/chain-endpoint-parser';

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

export async function testReferendum(options: TestOptions): Promise<void> {
  const logger = new Logger(options.verbose);
  const cleanupEnabled = options.cleanup !== false;

  try {
    validateOptions(options);

    const hasGovernanceRef = !!(options.referendum || options.callToCreateGovernanceReferendum);
    const hasFellowshipRef = !!(options.fellowship || options.callToCreateFellowshipReferendum);

    if (hasGovernanceRef && !options.governanceChainUrl) {
      throw new Error('--governance-chain-url is required when testing a governance referendum');
    }

    if (hasFellowshipRef && !options.fellowshipChainUrl) {
      throw new Error('--fellowship-chain-url is required when testing a fellowship referendum');
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

    const mainRefId = options.referendum ? parseInt(options.referendum) : undefined;
    if (mainRefId !== undefined && isNaN(mainRefId)) {
      throw new Error(`Invalid referendum ID: ${options.referendum}`);
    }

    const fellowshipRefId = options.fellowship ? parseInt(options.fellowship) : undefined;
    if (fellowshipRefId !== undefined && isNaN(fellowshipRefId)) {
      throw new Error('Invalid fellowship referendum ID');
    }

    if (hasFellowshipRef) {
      logger.section('Polkadot Referenda Tester (Fellowship Mode)');
    } else {
      logger.section('Polkadot Referenda Tester');
    }

    const coordinator = new NetworkCoordinator(logger, {
      governance: governanceParsed?.url,
      governanceBlock: governanceParsed?.block,
      fellowship: fellowshipParsed?.url,
      fellowshipBlock: fellowshipParsed?.block,
      additionalChains: additionalChainsParsed,
    });

    await coordinator.testWithFellowship(mainRefId, fellowshipRefId, cleanupEnabled, options);

    if (cleanupEnabled) {
      logger.success('\n\u2713 Workflow completed');
      process.exit(0);
    }
  } catch (error) {
    logger.error('Test execution failed', error as Error);
    process.exit(1);
  }
}
