import { FELLOWSHIP, GOVERNANCE, type ReferendaKind } from '../referendum/referenda-kind';
import { simulateReferendum } from '../referendum/simulation-runner';
import type { PreCall, ReferendumSource, ReferendumStep } from '../types';
import type { Logger } from '../utils/logger';
import { referendumCreations } from '../utils/referendum-steps';
import { getChainInfo } from './chain-identity';
import {
  type DetectedChain,
  detectChains,
  type SingleConsensusEndpoints,
  singleConsensusTopology,
} from './chain-topology-builder';
import { buildBlocksAndPrintEvents } from './event-collector';
import { connectFork, type Fork, shutdownForks, spawnForks } from './fork';
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
    private readonly governance: Fork | undefined,
    private readonly fellowship: Fork | undefined,
    private readonly additional: Fork[]
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

    logger.startSpinner('Setting up interconnected chains...');
    const contexts = await spawnForks(topology.specs);
    logger.succeedSpinner('Networks ready');

    logger.startSpinner('Waiting for chains to be ready...');
    const connectPrimary = (key: string | undefined, chain: DetectedChain | undefined) =>
      key && chain
        ? connectFork(contexts.get(key)!, (api) => getChainInfo(api, chain.endpoint.url), logger)
        : undefined;
    const isShared = topology.fellowshipKey === topology.governanceKey;
    const [governance, distinctFellowship, additional] = await Promise.all([
      connectPrimary(topology.governanceKey, chains.governance),
      isShared ? undefined : connectPrimary(topology.fellowshipKey, chains.fellowship),
      Promise.all(
        topology.additional.map(({ key, chain }) =>
          connectFork(contexts.get(key)!, () => chain.info, logger)
        )
      ),
    ]);
    const fellowship = topology.fellowshipKey
      ? isShared
        ? governance
        : distinctFellowship
      : undefined;
    logger.succeedSpinner('Chains are ready');

    for (const [role, fork] of [
      ['Governance', governance],
      ['Fellowship', fellowship === governance ? undefined : fellowship],
    ] as const) {
      if (fork) {
        logger.info(
          `${role}: ${fork.info.label} (${fork.info.specName}) at ${fork.manager.context.url}`
        );
      }
    }
    if (additional.length > 0) {
      logger.info(
        `Additional chains connected: ${additional.map((fork) => fork.info.label).join(', ')}`
      );
    }
    return new SingleConsensusNetwork(logger, governance, fellowship, additional);
  }

  forks(): Fork[] {
    const primaries = [this.governance, this.fellowship].filter(
      (fork): fork is Fork => fork !== undefined
    );
    return [...new Set(primaries), ...this.additional];
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
    const forksWithLabels = [
      ...(this.governance
        ? [{ label: `Governance (${this.governance.info.label})`, fork: this.governance }]
        : []),
      ...(this.fellowship && this.fellowship !== this.governance
        ? [{ label: `Fellowship (${this.fellowship.info.label})`, fork: this.fellowship }]
        : []),
      ...this.additional.map((fork) => ({ label: fork.info.label, fork })),
    ];
    await shutdownForks(forksWithLabels, cleanup, this.logger);
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
