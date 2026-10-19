import { FELLOWSHIP, GOVERNANCE, type ReferendaKind } from '../referendum/referenda-kind';
import { simulateReferendum } from '../referendum/simulation-runner';
import type { PreCall, ReferendumSource, ReferendumStep } from '../types';
import type { Logger } from '../utils/logger';
import { referendumCreations } from '../utils/referendum-steps';
import {
  detectChains,
  type SingleConsensusEndpoints,
  singleConsensusTopology,
} from './chain-topology-builder';
import { buildBlocksAndPrintEvents } from './event-collector';
import { chainForks, type Fork, type ForkWithLabel, forksWithLabels, shutdownForks } from './fork';
import type { ForkedNetwork, StepOutcome } from './step-runner';

function requiredFork(fork: Fork | undefined, role: string): Fork {
  if (!fork) {
    throw new Error(
      `The step has a ${role} referendum, but the ${role} chain is not in the network`
    );
  }
  return fork;
}

export class SingleConsensusNetwork implements ForkedNetwork {
  private constructor(
    private readonly logger: Logger,
    private readonly forkList: ForkWithLabel[],
    private readonly governance: Fork | undefined,
    private readonly fellowship: Fork | undefined
  ) {}

  static async create(
    logger: Logger,
    endpoints: SingleConsensusEndpoints,
    steps: ReferendumStep[]
  ): Promise<SingleConsensusNetwork> {
    const chains = await detectChains(endpoints, logger);
    const creations = referendumCreations(steps);
    const topology = singleConsensusTopology(
      chains,
      {
        governance: creations.governance ? 'alice-account' : undefined,
        fellowship: creations.fellowship ? 'fellowship' : undefined,
      },
      logger
    );

    logger.startSpinner('Forking chains...');
    const forks = await chainForks(topology.specs, logger);
    logger.succeedSpinner('Chains are ready');
    const forkList = forksWithLabels(forks);
    for (const { label, fork } of forkList) {
      logger.info(`${label} at ${fork.manager.context.url}`);
    }
    const roleFork = (key: string | undefined) => (key === undefined ? undefined : forks.get(key));
    return new SingleConsensusNetwork(
      logger,
      forkList,
      roleFork(topology.governanceKey),
      roleFork(topology.fellowshipKey)
    );
  }

  forks(): Fork[] {
    return this.forkList.map(({ fork }) => fork);
  }

  async runStep(step: ReferendumStep): Promise<StepOutcome> {
    const referenda = step.referenda;
    switch (referenda.kind) {
      case 'governance': {
        const chain = requiredFork(this.governance, 'governance');
        const referendumId = await this.runReferendum(
          chain,
          referenda.governance,
          GOVERNANCE,
          referenda.preCall
        );
        return { main: chain, referendumId };
      }
      case 'fellowship': {
        const chain = requiredFork(this.fellowship, 'fellowship');
        const fellowshipReferendumId = await this.runReferendum(
          chain,
          referenda.fellowship,
          FELLOWSHIP,
          referenda.preCall
        );
        return { main: chain, fellowshipReferendumId };
      }
      case 'fellowshipThenGovernance': {
        const governance = requiredFork(this.governance, 'governance');
        const fellowship = requiredFork(this.fellowship, 'fellowship');
        this.logger.section(`[1/2] Fellowship referendum on ${fellowship.info.label}`);
        const fellowshipRun = await simulateReferendum(
          {
            target: fellowship,
            source: referenda.fellowship,
            kind: FELLOWSHIP,
          },
          this.logger
        );
        if (fellowship !== governance) {
          this.logger.startSpinner('Waiting for XCM message propagation...');
          await fellowship.manager.newBlock();
          await governance.manager.newBlock();
          this.logger.succeedSpinner('XCM messages propagated');
        }
        this.logger.section(`[2/2] Governance referendum on ${governance.info.label}`);
        const referendumId = await this.runReferendum(governance, referenda.governance, GOVERNANCE);
        return {
          main: governance,
          referendumId,
          fellowshipReferendumId: fellowshipRun.referendumId,
        };
      }
    }
  }

  async teardown(cleanup: boolean): Promise<void> {
    await shutdownForks(this.forkList, cleanup, this.logger);
  }

  private async runReferendum(
    chain: Fork,
    source: ReferendumSource,
    kind: ReferendaKind,
    preCall?: PreCall
  ): Promise<number> {
    const { referendumId } = await simulateReferendum(
      {
        target: chain,
        source,
        kind,
        preCall,
      },
      this.logger
    );
    await buildBlocksAndPrintEvents(
      this.forks().filter((fork) => fork !== chain),
      this.logger
    );
    return referendumId;
  }
}
