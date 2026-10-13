import type { BridgeHandle, NetworkContext } from '@acala-network/chopsticks-testing';
import { getChainInfo } from '../network/chain-identity';
import {
  connectFork,
  type Fork,
  type ForkWithLabel,
  shutdownForks,
  spawnForks,
} from '../network/fork';
import type { ForkedNetwork, StepOutcome } from '../network/step-runner';
import { FELLOWSHIP, GOVERNANCE } from '../referendum/referenda-kind';
import { simulateReferendum } from '../referendum/simulation-runner';
import type { ReferendumStep } from '../types';
import { isEvent } from '../utils/events';
import type { Logger } from '../utils/logger';
import {
  fellowshipSource,
  governanceSource,
  preCallOf,
  referendumCreations,
} from '../utils/referendum-steps';
import {
  type BridgeKusamaSide,
  type BridgePolkadotSide,
  BridgePump,
  connectBridgeRelayer,
} from './bridge-pump';
import {
  type BridgeEndpoints,
  type BridgeSideSpecs,
  kusamaSideSpecs,
  polkadotSideSpecs,
} from './bridge-topology-builder';
import { verifyBridgeDelivery } from './bridge-verifier';
import { ForkEventLog } from './fork-event-log';
import { type DownstreamDelivery, outboundXcmIds, processDownstreamMessages } from './xcm-delivery';

const UNTRACKED_DOWNSTREAM_ROUNDS = 3;
const DOWNSTREAM_ROUND_DELAY_MS = 500;

interface BridgeSide {
  forks: Map<string, Fork>;
  additionalKeys: string[];
}

async function connectSide(
  contexts: Map<string, NetworkContext>,
  specs: BridgeSideSpecs,
  logger: Logger
): Promise<BridgeSide> {
  const entries = await Promise.all(
    specs.specs.map(async ({ key, config }): Promise<[string, Fork]> => {
      const fork = await connectFork(
        contexts.get(key)!,
        (api) => getChainInfo(api, config.endpoint),
        logger
      );
      logger.info(`  ${key} ready: ${fork.info.label} at ${fork.manager.context.url}`);
      return [key, fork];
    })
  );
  return { forks: new Map(entries), additionalKeys: specs.additionalKeys };
}

export class BridgedNetwork implements ForkedNetwork {
  private constructor(
    private readonly logger: Logger,
    private readonly polkadot: BridgePolkadotSide,
    private readonly kusama: BridgeKusamaSide,
    private readonly forksWithLabels: ForkWithLabel[],
    private readonly relayer: BridgeHandle,
    private readonly pump: BridgePump,
    private readonly maxRounds: number
  ) {}

  static async create(
    logger: Logger,
    endpoints: BridgeEndpoints,
    steps: ReferendumStep[],
    maxRounds: number
  ): Promise<BridgedNetwork> {
    const creations = referendumCreations(steps);
    const injections = {
      fellowshipStorageOnCollectives: creations.fellowship,
      aliceOnAssetHubKusama: creations.governance,
    };
    const polkadotSpecs = polkadotSideSpecs(endpoints, injections, logger);
    const kusamaSpecs = kusamaSideSpecs(endpoints, injections, logger);

    logger.section('Setting Up Bridged Multi-Chain Environment');
    logger.startSpinner('Spawning Polkadot-side and Kusama-side chopsticks forks...');
    const [polkadotContexts, kusamaContexts] = await Promise.all([
      spawnForks(polkadotSpecs.specs),
      spawnForks(kusamaSpecs.specs),
    ]);
    logger.succeedSpinner('Polkadot-side and Kusama-side networks ready');

    const [polkadotForks, kusamaForks] = await Promise.all([
      connectSide(polkadotContexts, polkadotSpecs, logger),
      connectSide(kusamaContexts, kusamaSpecs, logger),
    ]);
    const polkadot: BridgePolkadotSide = {
      collectives: polkadotForks.forks.get('collectives')!,
      assetHub: polkadotForks.forks.get('assetHubPolkadot')!,
      bridgeHub: polkadotForks.forks.get('bridgeHubPolkadot')!,
      additional: polkadotForks.additionalKeys.map((key) => polkadotForks.forks.get(key)!),
    };
    const kusama: BridgeKusamaSide = {
      assetHub: kusamaForks.forks.get('assetHubKusama')!,
      bridgeHub: kusamaForks.forks.get('bridgeHubKusama')!,
      additional: kusamaForks.additionalKeys.map((key) => kusamaForks.forks.get(key)!),
    };
    const forksWithLabels = [
      ...[...polkadotForks.forks].map(([key, fork]) => ({
        label: `Polkadot/${key} (${fork.info.label})`,
        fork,
      })),
      ...[...kusamaForks.forks].map(([key, fork]) => ({
        label: `Kusama/${key} (${fork.info.label})`,
        fork,
      })),
    ];

    const relayer = await connectBridgeRelayer(polkadot, kusama, logger);
    const pump = await BridgePump.create(logger, polkadot, kusama, maxRounds);
    return new BridgedNetwork(logger, polkadot, kusama, forksWithLabels, relayer, pump, maxRounds);
  }

  forks(): Fork[] {
    return this.forksWithLabels.map(({ fork }) => fork);
  }

  async runStep(step: ReferendumStep): Promise<StepOutcome> {
    const fellowship = fellowshipSource(step);
    const governance = governanceSource(step);
    const preCall = preCallOf(step);
    const outcome: StepOutcome = {
      main: governance ? this.kusama.assetHub : this.polkadot.collectives,
    };

    if (fellowship) {
      this.logger.section('Fellowship Referendum Simulation (Collectives)');
      const { referendumId } = await simulateReferendum(
        {
          target: this.polkadot.collectives,
          source: fellowship,
          kind: FELLOWSHIP,
          preCall,
        },
        this.logger
      );
      outcome.fellowshipReferendumId = referendumId;

      this.logger.section('Bridge Pump (observe BHP outbound, deliver to BHK)');
      const log = new ForkEventLog();
      const report = await this.pump.pumpUntilQuiet(log);
      this.logger.info(
        `Bridge pump observed ${report.messageCount} outbound message(s) across ${report.laneCount} lane(s) over ${report.rounds} round(s)`
      );
      if (report.messageCount > 0) {
        const failures = await verifyBridgeDelivery(this.polkadot, this.kusama, log, this.logger);
        if (failures.length > 0) {
          throw new Error(`Bridge end-to-end verification FAILED: ${failures.join('; ')}`);
        }
      } else {
        this.logger.info(
          'No bridge messages observed (the fellowship referendum may not have produced one).'
        );
      }
    }

    if (governance) {
      this.logger.section('Bridged-Target Public Referendum (AHK whitelistedcaller)');
      const { referendumId, events } = await simulateReferendum(
        {
          target: this.kusama.assetHub,
          source: governance,
          kind: GOVERNANCE,
          preCall,
          label: 'AHK Public',
        },
        this.logger
      );
      outcome.referendumId = referendumId;
      await this.processFanOut(outboundXcmIds(events));
    }
    return outcome;
  }

  async teardown(cleanup: boolean): Promise<void> {
    try {
      await this.relayer.disconnect();
    } catch (error) {
      this.logger.debug(`Bridge relayer disconnect failed: ${(error as Error).message}`);
    }
    await shutdownForks(this.forksWithLabels, cleanup, this.logger);
  }

  private async processFanOut(messageIds: Set<string>): Promise<void> {
    const downstream = [this.kusama.bridgeHub, ...this.kusama.additional];
    this.logger.section('Downstream Fan-Out Processing (Kusama system chains)');
    const log = new ForkEventLog();
    if (messageIds.size === 0) {
      this.logger.info(
        `The referendum sent no XCM to track; building ${UNTRACKED_DOWNSTREAM_ROUNDS} blocks on each other Kusama chain`
      );
      for (let round = 0; round < UNTRACKED_DOWNSTREAM_ROUNDS; round++) {
        for (const fork of downstream) {
          await log.advance(fork);
        }
      }
      return;
    }
    const deliveries = await processDownstreamMessages(downstream, messageIds, log, {
      maxRounds: this.maxRounds,
      roundDelayMs: DOWNSTREAM_ROUND_DELAY_MS,
    });
    this.reportFanOut(deliveries, log);
  }

  private reportFanOut(deliveries: Map<Fork, DownstreamDelivery>, log: ForkEventLog): void {
    let upgradeCount = 0;
    for (const [fork, delivery] of deliveries) {
      const label = fork.info.label;
      if (delivery.kind === 'timeout') {
        this.logger.warn(
          `  ${label}: fan-out message NOT observed processed within ${delivery.rounds} round(s) — possible delivery lag`
        );
        continue;
      }
      const codeHashes = log
        .events(fork)
        .filter((event) => isEvent(event, 'System', 'UpgradeAuthorized'))
        .map((event) => (event.data as { code_hash?: string } | null)?.code_hash ?? 'unknown');
      upgradeCount += codeHashes.length;
      if (codeHashes.length === 0) {
        this.logger.info(
          `  ${label}: fan-out message processed (no UpgradeAuthorized — call was not an upgrade for this chain)`
        );
      }
      for (const codeHash of codeHashes) {
        this.logger.success(`  ${label}: System.UpgradeAuthorized — code_hash=${codeHash}`);
      }
    }
    if (upgradeCount === 0) {
      this.logger.info(
        '  No downstream UpgradeAuthorized observed — the dispatched call did not authorize an upgrade on these chains.'
      );
    }
  }
}
