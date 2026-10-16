import type { BridgeHandle } from '@acala-network/chopsticks-testing';
import {
  chainForks,
  type Fork,
  type ForkWithLabel,
  forksWithLabels,
  shutdownForks,
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
  kusamaSideSpecs,
  polkadotSideSpecs,
} from './bridge-topology-builder';
import { verifyBridgeDelivery } from './bridge-verifier';
import { ForkEventLog } from './fork-event-log';
import { type DownstreamDelivery, outboundXcmIds, processDownstreamMessages } from './xcm-delivery';

const UNTRACKED_DOWNSTREAM_ROUNDS = 3;
const DOWNSTREAM_ROUND_DELAY_MS = 500;

export class BridgedNetwork implements ForkedNetwork {
  private constructor(
    private readonly logger: Logger,
    private readonly polkadot: BridgePolkadotSide,
    private readonly kusama: BridgeKusamaSide,
    private readonly forkList: ForkWithLabel[],
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
    const polkadotSpecs = polkadotSideSpecs(endpoints, creations, logger);
    const kusamaSpecs = kusamaSideSpecs(endpoints, creations, logger);

    logger.section('Setting Up Bridged Multi-Chain Environment');
    logger.startSpinner('Forking the Polkadot-side and Kusama-side chains...');
    const [polkadotForks, kusamaForks] = await Promise.all([
      chainForks(polkadotSpecs.specs, logger),
      chainForks(kusamaSpecs.specs, logger),
    ]);
    logger.succeedSpinner('Polkadot-side and Kusama-side chains are ready');
    const forkList = [
      ...forksWithLabels(polkadotForks, 'Polkadot/'),
      ...forksWithLabels(kusamaForks, 'Kusama/'),
    ];
    for (const { label, fork } of forkList) {
      logger.info(`  ${label} at ${fork.manager.context.url}`);
    }
    const polkadot: BridgePolkadotSide = {
      collectives: polkadotForks.get('collectives')!,
      assetHub: polkadotForks.get('assetHubPolkadot')!,
      bridgeHub: polkadotForks.get('bridgeHubPolkadot')!,
      additional: polkadotSpecs.additionalKeys.map((key) => polkadotForks.get(key)!),
    };
    const kusama: BridgeKusamaSide = {
      assetHub: kusamaForks.get('assetHubKusama')!,
      bridgeHub: kusamaForks.get('bridgeHubKusama')!,
      additional: kusamaSpecs.additionalKeys.map((key) => kusamaForks.get(key)!),
    };

    const relayer = await connectBridgeRelayer(polkadot, kusama, logger);
    const pump = await BridgePump.create(logger, polkadot, kusama, maxRounds);
    return new BridgedNetwork(logger, polkadot, kusama, forkList, relayer, pump, maxRounds);
  }

  forks(): Fork[] {
    return this.forkList.map(({ fork }) => fork);
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
    await shutdownForks(this.forkList, cleanup, this.logger);
  }

  private async processFanOut(messageIds: Set<string>): Promise<void> {
    const downstream = [this.kusama.bridgeHub, ...this.kusama.additional];
    this.logger.section('Downstream Fan-Out Processing (Kusama system chains)');
    if (messageIds.size === 0) {
      this.logger.info(
        `The referendum sent no XCM to track; building ${UNTRACKED_DOWNSTREAM_ROUNDS} blocks on each other Kusama chain`
      );
      for (let round = 0; round < UNTRACKED_DOWNSTREAM_ROUNDS; round++) {
        for (const fork of downstream) {
          await fork.manager.newBlock();
        }
      }
      return;
    }
    const log = new ForkEventLog();
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
