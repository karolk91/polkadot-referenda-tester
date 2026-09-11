import { setupNetworks } from '@acala-network/chopsticks-testing';
import type { ReferendumStep, TestOptions } from '../types';
import type { SubstrateApi } from '../types/substrate-api';
import { serializeEventData } from '../utils/event-serializer';
import type { Logger } from '../utils/logger';
import {
  describeStep,
  stepHalf,
  stepHasFellowship,
  stepHasGovernance,
} from '../utils/referendum-steps';
import {
  type BridgeChain,
  BridgeConnector,
  type BridgeKusamaSide,
  type BridgePolkadotSide,
  collectOutboundXcmIds,
  type DownstreamSettleResult,
} from './bridge-connector';
import {
  BridgeTopologyBuilder,
  type BridgeTopologyConfig,
  KUSAMA_SIDE_KEYS,
  POLKADOT_SIDE_KEYS,
} from './bridge-topology-builder';
import { BridgeVerifier } from './bridge-verifier';
import {
  type ChainInfo,
  createApiForChain,
  createPolkadotClient,
  getChainInfo,
} from './chain-registry';
import {
  ChainTopologyBuilder,
  type RegisteredChain,
  type TopologyConfig,
  type TopologyInjections,
} from './chain-topology-builder';
import { type ChopsticksContext, ChopsticksManager } from './chopsticks-manager';
import { EventCollector } from './event-collector';
import {
  type PostTestChain,
  type PostTestContext,
  type PostTestStepInfo,
  runPostTest,
} from './post-test-runner';
import { SimulationRunner } from './simulation-runner';

/**
 * A forked chain: a chopsticks node with a long-lived polkadot-api client and a known identity.
 * Same shape as {@link BridgeChain}, so bridged forks work with the same helpers.
 */
type Fork = BridgeChain;

/**
 * The forked network a run executes on. Built once from the union of what every step requires,
 * then every {@link ReferendumStep} runs against it in order, so each step starts from the state
 * the previous steps and their post-tests produced. `fellowship` is the same object as
 * `governance` when both referenda are on one chain.
 */
interface ForkedNetwork {
  governance?: Fork;
  fellowship?: Fork;
  additional: Fork[];
}

/** What a step executed, for the post-test context. */
interface StepOutcome {
  /** The fork the step's referendum executed on — the post-test's `main`. */
  main: Fork;
  referendumId?: number;
  fellowshipReferendumId?: number;
}

/** The spawned bridged network that {@link NetworkCoordinator.runBridgedStep} uses. */
interface BridgedRun {
  connector: BridgeConnector;
  polkadot: BridgePolkadotSide;
  kusama: BridgeKusamaSide;
  /** Every Kusama-side fork, for downstream fan-out settlement. */
  kusamaChains: BridgeChain[];
}

export class NetworkCoordinator {
  private logger: Logger;
  private topology: ChainTopologyBuilder;
  private eventCollector: EventCollector;
  private runner: SimulationRunner;

  constructor(logger: Logger, endpoints: TopologyConfig) {
    this.logger = logger;
    this.topology = new ChainTopologyBuilder(logger, endpoints);
    this.eventCollector = new EventCollector(logger);
    this.runner = new SimulationRunner(logger);

    const additionalChains = endpoints.additionalChains || [];
    this.logger.debug(`Additional chains configured: ${additionalChains.length}`);
    if (additionalChains.length > 0) {
      this.logger.info(`Additional chains to monitor: ${additionalChains.length}`);
      additionalChains.forEach((chain) => {
        this.logger.info(`  - ${chain.url}${chain.block ? ` @ block ${chain.block}` : ''}`);
      });
    }

    if (endpoints.governanceBlock) {
      this.logger.info(`Governance chain will fork at block ${endpoints.governanceBlock}`);
    }
    if (endpoints.fellowshipBlock) {
      this.logger.info(`Fellowship chain will fork at block ${endpoints.fellowshipBlock}`);
    }
  }

  getGovernanceLabel(): string {
    return this.topology.governanceChain?.label || 'unknown';
  }

  getFellowshipLabel(): string | undefined {
    return this.topology.fellowshipChain?.label;
  }

  getNetwork(): string {
    return this.topology.governanceChain?.network || 'unknown';
  }

  /**
   * Run an ordered list of referendum steps on one forked network.
   *
   * The network is forked once from the union of what the steps require: the governance chain if
   * any step has a governance referendum, the fellowship chain if any step has a fellowship
   * referendum, plus `--additional-chains`. The run funds the signer for every creation call
   * before the first step. Each step executes its referenda (fellowship first, then governance,
   * when it has both), settles XCM on the other forks, and runs its post-test before the next
   * step starts.
   */
  async runSteps(steps: ReferendumStep[], cleanup: boolean = true): Promise<void> {
    if (steps.length === 0) {
      throw new Error('At least one referendum step is required');
    }

    const needGovernance = steps.some(stepHasGovernance);
    const needFellowship = steps.some(stepHasFellowship);

    if (needFellowship && !this.topology.getFellowshipEndpoint()) {
      throw new Error('Fellowship chain URL must be provided when testing fellowship referendum');
    }
    if (needGovernance && !this.topology.getGovernanceEndpoint()) {
      throw new Error('Governance chain URL must be provided when testing governance referendum');
    }

    await this.topology.detectChainTypes();

    const injections: TopologyInjections = {
      governance: steps.some((step) => !!step.callToCreateGovernanceReferendum)
        ? 'alice-account'
        : undefined,
      fellowship: steps.some((step) => !!step.callToCreateFellowshipReferendum)
        ? 'fellowship'
        : undefined,
    };

    if (steps.length > 1) {
      this.logger.section(`Referendum Chain (${steps.length} steps)`);
      steps.forEach((step, index) => {
        this.logger.info(`  ${index + 1}. ${describeStep(step)}`);
      });
    }

    const network = await this.setupForkedNetwork(needGovernance, needFellowship, injections);
    try {
      await this.runStepChain(steps, this.forks(network), (step, index) =>
        this.runStep(network, step, index)
      );
    } finally {
      await this.teardownForkedNetwork(network, cleanup);
    }
  }

  /**
   * Run the steps in order against one forked network: print the step header, execute the step's
   * referenda, then run its post-test before the next step starts. `execute` runs the referenda
   * and returns the fork they executed on; `forks` contains every fork a post-test can use. The
   * single-consensus and bridged paths share this method and differ only in `execute`.
   */
  private async runStepChain(
    steps: ReferendumStep[],
    forks: Fork[],
    execute: (step: ReferendumStep, index: number) => Promise<StepOutcome>
  ): Promise<void> {
    for (const [index, step] of steps.entries()) {
      if (steps.length > 1) {
        this.logger.section(`Step ${index + 1}/${steps.length}: ${describeStep(step)}`);
      }
      const outcome = await execute(step, index);
      await this.maybeRunPostTest(step, outcome, { index: index + 1, count: steps.length }, forks);
    }
  }

  /**
   * Fork every chain the run requires with one `setupNetworks` call, so chopsticks connects
   * sibling and relay message passing between them, then connect a client to each fork.
   */
  private async setupForkedNetwork(
    needGovernance: boolean,
    needFellowship: boolean,
    injections: TopologyInjections
  ): Promise<ForkedNetwork> {
    const {
      networkConfig,
      governance: governanceSlot,
      fellowship: fellowshipSlot,
      additional,
    } = this.topology.buildNetworkTopology({ needGovernance, needFellowship, injections });

    this.logger.startSpinner('Setting up interconnected chains...');
    const networks = await setupNetworks(networkConfig as Parameters<typeof setupNetworks>[0]);
    this.logger.succeedSpinner('Networks ready');

    const contextOf = (key: string): ChopsticksContext =>
      networks[key] as unknown as ChopsticksContext;
    const sharedFork = !!fellowshipSlot && fellowshipSlot.key === governanceSlot?.key;

    if (governanceSlot) {
      this.logger.info(`  Governance: ${contextOf(governanceSlot.key).ws.endpoint}`);
    }
    if (fellowshipSlot && !sharedFork) {
      this.logger.info(`  Fellowship: ${contextOf(fellowshipSlot.key).ws.endpoint}`);
    }

    this.logger.startSpinner('Waiting for chains to be ready...');
    const [governance, distinctFellowship, additionalForks] = await Promise.all([
      governanceSlot ? this.connectPrimaryChain(governanceSlot, contextOf) : undefined,
      fellowshipSlot && !sharedFork
        ? this.connectPrimaryChain(fellowshipSlot, contextOf)
        : undefined,
      // Additional chains reuse the identity detected before forking. They also get a client
      // here, so per-step event collection reuses it instead of reconnecting on every step.
      Promise.all(additional.map((slot) => this.connectFork(contextOf(slot.key), () => slot.info))),
    ]);
    const fellowship = fellowshipSlot ? (distinctFellowship ?? governance) : undefined;
    this.logger.succeedSpinner('Chains are ready');

    if (governance) {
      this.topology.governanceChain = governance.info;
      this.logger.info(`Governance: ${governance.info.label} (${governance.info.specName})`);
    }
    if (fellowship) {
      this.topology.fellowshipChain = fellowship.info;
      if (fellowship !== governance) {
        this.logger.info(`Fellowship: ${fellowship.info.label} (${fellowship.info.specName})`);
      }
    }
    if (additionalForks.length > 0) {
      this.logger.info(
        `Additional chains connected: ${additionalForks.map((fork) => fork.label).join(', ')}`
      );
    }

    return { governance, fellowship, additional: additionalForks };
  }

  /**
   * Wrap a chopsticks context with a manager and a ready polkadot-api client, then identify it.
   * `identify` reads from the live fork, so the identity includes any `wasm-override`.
   */
  private async connectFork(
    context: ChopsticksContext,
    identify: (api: SubstrateApi, endpoint: string) => ChainInfo | Promise<ChainInfo>
  ): Promise<Fork> {
    const manager = ChopsticksManager.fromExistingContext(this.logger, context);
    const endpoint = context.ws.endpoint;
    const client = createPolkadotClient(endpoint);
    const api = createApiForChain(client);
    await manager.waitForChainReady(api);
    const info = await identify(api, endpoint);
    return { label: info.label, manager, client, api, info };
  }

  /**
   * Connect a primary fork. Re-reads the identity from the live fork, so a `wasm-override`
   * applies, but keeps the upstream endpoint from the command line on the {@link ChainInfo}.
   */
  private connectPrimaryChain(
    slot: RegisteredChain,
    contextOf: (key: string) => ChopsticksContext
  ): Promise<Fork> {
    return this.connectFork(contextOf(slot.key), (api) => getChainInfo(api, slot.info.endpoint));
  }

  /** Execute one step against the forked network. */
  private async runStep(
    network: ForkedNetwork,
    step: ReferendumStep,
    index: number
  ): Promise<StepOutcome> {
    const hasGovernance = stepHasGovernance(step);
    const hasFellowship = stepHasFellowship(step);
    const { governance, fellowship } = network;

    if (hasGovernance && hasFellowship) {
      if (!governance || !fellowship) {
        throw new Error('Step needs governance and fellowship chains but they were not forked');
      }
      return this.runDualStep(network, step, governance, fellowship);
    }
    if (hasGovernance) {
      if (!governance) {
        throw new Error('Step needs the governance chain but it was not forked');
      }
      return this.runSingleStep(network, step, governance, false);
    }
    if (hasFellowship) {
      if (!fellowship) {
        throw new Error('Step needs the fellowship chain but it was not forked');
      }
      return this.runSingleStep(network, step, fellowship, true);
    }
    throw new Error(`Step ${index + 1} names no referendum`);
  }

  /** Fellowship referendum then governance referendum (the whitelisting pattern). */
  private async runDualStep(
    network: ForkedNetwork,
    step: ReferendumStep,
    governance: Fork,
    fellowship: Fork
  ): Promise<StepOutcome> {
    if (step.preCall) {
      this.logger.warn(
        '--pre-call applies only to single-referendum steps; ignoring it for this fellowship + governance step'
      );
    }

    const createdFellowship = await this.runner.createReferendumIfNeeded({
      api: fellowship.api,
      chopsticks: fellowship.manager,
      ...stepHalf(step, true),
      isFellowship: true,
    });
    const fellowshipId = createdFellowship ?? step.fellowship;

    const createdGovernance = await this.runner.createReferendumIfNeeded({
      api: governance.api,
      chopsticks: governance.manager,
      ...stepHalf(step, false),
      isFellowship: false,
    });
    const governanceId = createdGovernance ?? step.referendum;

    if (fellowshipId === undefined) {
      throw new Error('Fellowship referendum ID is required but was not provided or created');
    }
    if (governanceId === undefined) {
      throw new Error('Main referendum ID is required but was not provided or created');
    }

    if (governance === fellowship) {
      await this.runner.simulateSequentialReferenda(
        governance.api,
        governance.manager,
        fellowshipId,
        governanceId
      );
      await this.eventCollector.collectAdditionalChainEvents(this.forks(network, governance));
    } else {
      await this.runner.simulateMultiChainReferenda({
        fellowship: {
          api: fellowship.api,
          chopsticks: fellowship.manager,
          referendumId: fellowshipId,
          label: fellowship.info.label,
        },
        governance: {
          api: governance.api,
          chopsticks: governance.manager,
          referendumId: governanceId,
          label: governance.info.label,
        },
      });
      await this.eventCollector.displayPostExecutionEvents({
        governance: { chopsticks: governance.manager, api: governance.api },
        fellowship: { chopsticks: fellowship.manager, api: fellowship.api },
        additional: network.additional,
        governanceLabel: governance.info.label,
        fellowshipLabel: fellowship.info.label,
      });
    }

    return {
      main: governance,
      referendumId: governanceId,
      fellowshipReferendumId: fellowshipId,
    };
  }

  /** A governance-only or fellowship-only referendum on `chain`; XCM settles on every other fork. */
  private async runSingleStep(
    network: ForkedNetwork,
    step: ReferendumStep,
    chain: Fork,
    isFellowship: boolean
  ): Promise<StepOutcome> {
    const { referendumId, callHex, preimageHex } = stepHalf(step, isFellowship);
    const result = await this.runner.fetchAndSimulate({
      api: chain.api,
      chopsticks: chain.manager,
      referendumId,
      isFellowship,
      createCallHex: callHex,
      createPreimageHex: preimageHex,
      preCall: step.preCall,
      preOrigin: step.preOrigin,
    });

    await this.eventCollector.collectAdditionalChainEvents(this.forks(network, chain));

    return {
      main: chain,
      referendumId: isFellowship ? undefined : result.referendumId,
      fellowshipReferendumId: isFellowship ? result.referendumId : undefined,
    };
  }

  /**
   * Every fork in the network in a stable order: primaries first, then additional chains, without
   * `except` (the chain a step just executed on, when the other forks should settle its XCM). A
   * chain used as both primaries is one fork and appears once.
   */
  private forks(network: ForkedNetwork, except?: Fork): Fork[] {
    const primaries = [network.governance, network.fellowship].filter(
      (fork): fork is Fork => !!fork && fork !== except
    );
    return [...new Set(primaries), ...network.additional];
  }

  private async teardownForkedNetwork(network: ForkedNetwork, cleanup: boolean): Promise<void> {
    const labelled: Array<{ label: string; fork: Fork }> = [];
    if (network.governance) {
      labelled.push({
        label: `Governance (${network.governance.info.label})`,
        fork: network.governance,
      });
    }
    if (network.fellowship && network.fellowship !== network.governance) {
      labelled.push({
        label: `Fellowship (${network.fellowship.info.label})`,
        fork: network.fellowship,
      });
    }
    labelled.push(...network.additional.map((fork) => ({ label: fork.label, fork })));
    await this.shutdownForks(labelled, cleanup);
  }

  /** Destroy the clients, then tear the forks down or leave them paused for inspection. */
  private async shutdownForks(
    forks: Array<{ label: string; fork: Fork }>,
    cleanup: boolean
  ): Promise<void> {
    for (const { fork } of forks) {
      try {
        fork.client.destroy();
      } catch {
        // best-effort
      }
    }
    const managers = forks.map(({ label, fork }) => ({ label, manager: fork.manager }));
    if (cleanup) {
      await Promise.all(managers.map(({ manager }) => manager.cleanup()));
    } else {
      await this.pauseAllManagers(managers);
    }
  }

  /** Describe a live fork for a post-test, using the identity read when the fork was connected. */
  private describePostTestChain(fork: Fork): PostTestChain {
    const context = fork.manager.getContext();
    return {
      label: fork.info.label,
      specName: fork.info.specName,
      network: fork.info.network,
      kind: fork.info.kind,
      wsEndpoint: context.ws.endpoint,
      // The live chopsticks-core Blockchain, for in-process block building (see PostTestChain.chain).
      chain: (context as unknown as { chain?: unknown }).chain,
    };
  }

  /**
   * Run a step's post-test module against the live network. `outcome.main` is the fork the step's
   * referendum executed on. Rethrows on failure so the caller exits non-zero.
   */
  private async maybeRunPostTest(
    step: Pick<ReferendumStep, 'postTest' | 'postTestArgs'>,
    outcome: StepOutcome,
    position: Pick<PostTestStepInfo, 'index' | 'count'>,
    forks: Fork[]
  ): Promise<void> {
    if (!step.postTest) return;
    const mainIndex = forks.indexOf(outcome.main);
    if (mainIndex < 0) {
      throw new Error(`Post-test main chain ${outcome.main.label} is not one of the run's forks`);
    }
    const chains = forks.map((fork) => this.describePostTestChain(fork));
    const context: Omit<PostTestContext, 'args'> = {
      main: chains[mainIndex],
      chains,
      verbose: this.logger.isVerbose(),
      step: {
        ...position,
        referendumId: outcome.referendumId,
        fellowshipReferendumId: outcome.fellowshipReferendumId,
      },
    };
    await runPostTest(this.logger, step.postTest, context, step.postTestArgs);
  }

  /**
   * Run referendum steps whose fellowship half sends an XCM that executes on a chain in a
   * different consensus (across the Polkadot → Kusama bridge).
   *
   * This method spawns both sides once (Polkadot: Collectives + AHP + BHP, Kusama: AHK + BHK,
   * plus any `--additional-chains` routed per side). Then, per step: the fellowship referendum on
   * Collectives, the bridge pump that delivers its message to BHK and verifies it arrived on AHK,
   * the AHK public referendum that dispatches the whitelisted call (when the step has a governance
   * half), downstream fan-out settlement on the other Kusama chains, and the step's post-test.
   */
  async testFellowshipBridged(
    steps: ReferendumStep[],
    cleanup: boolean,
    options: TestOptions,
    bridgeEndpoints: BridgeTopologyConfig
  ): Promise<void> {
    if (steps.length === 0) {
      throw new Error('At least one referendum step is required');
    }
    const builder = new BridgeTopologyBuilder(this.logger, {
      ...bridgeEndpoints,
      injectFellowshipStorage:
        bridgeEndpoints.injectFellowshipStorage ??
        steps.some((step) => !!step.callToCreateFellowshipReferendum),
      // Alice on AHK is only required when creating a referendum (the Alice account signs
      // notePreimage + submit). An existing referendum is force-approved via storage, so it
      // requires no signer.
      injectAliceOnAssetHubKusama:
        bridgeEndpoints.injectAliceOnAssetHubKusama ??
        steps.some((step) => !!step.callToCreateGovernanceReferendum),
      // The Alice account signs receive_messages_proof on BHK, so always fund it there.
      injectAliceOnBridgeHubKusama: bridgeEndpoints.injectAliceOnBridgeHubKusama ?? true,
    });

    const polkadotSide = builder.buildPolkadotSide();
    const kusamaSide = builder.buildKusamaSide();

    this.logger.section('Setting Up Bridged Multi-Chain Environment');
    this.logger.info(`Polkadot-side keys: ${Object.values(POLKADOT_SIDE_KEYS).join(', ')}`);
    this.logger.info(`Kusama-side keys: ${Object.values(KUSAMA_SIDE_KEYS).join(', ')}`);

    // The two sides are independent: chopsticks connects message passing only within one
    // `setupNetworks` call, and BridgeConnector establishes the cross-consensus link later.
    this.logger.startSpinner('Spawning Polkadot-side and Kusama-side chopsticks forks...');
    const [polkadotNetworks, kusamaNetworks] = await Promise.all([
      setupNetworks(polkadotSide.networkConfig as Parameters<typeof setupNetworks>[0]),
      setupNetworks(kusamaSide.networkConfig as Parameters<typeof setupNetworks>[0]),
    ]);
    this.logger.succeedSpinner('Polkadot-side and Kusama-side networks ready');

    const polkadotChains: Record<string, BridgeChain> = {};
    const kusamaChains: Record<string, BridgeChain> = {};
    // Hoisted so the finally-block can tear down the bridge subscription + the
    // polkadot.js ApiPromise instances it owns, even if the bridge work throws.
    let bridgeConnector: BridgeConnector | null = null;

    try {
      // Each call connects to one already-spawned fork and only reads from it, so they all run
      // concurrently instead of downloading metadata one chain at a time. Each call records its
      // chain immediately, so the finally-block tears down the chains that connected even when
      // another one fails.
      const connectSide = (
        networks: Record<string, unknown>,
        into: Record<string, BridgeChain>
      ): Promise<unknown> =>
        Promise.all(
          Object.entries(networks).map(async ([key, ctx]) => {
            into[key] = await this.connectBridgeChain(key, ctx as unknown as ChopsticksContext);
          })
        );
      await Promise.all([
        connectSide(polkadotNetworks, polkadotChains),
        connectSide(kusamaNetworks, kusamaChains),
      ]);

      // Every chain under a non-core key (relay `polkadot`/`kusama` or `extra_<n>`) came from
      // --additional-chains. Pass them to the connector so the pump advances them.
      const polkadotCoreKeys = new Set<string>(Object.values(POLKADOT_SIDE_KEYS));
      const kusamaCoreKeys = new Set<string>(Object.values(KUSAMA_SIDE_KEYS));
      const polkadotExtras = Object.entries(polkadotChains)
        .filter(([key]) => !polkadotCoreKeys.has(key))
        .map(([, chain]) => chain);
      const kusamaExtras = Object.entries(kusamaChains)
        .filter(([key]) => !kusamaCoreKeys.has(key))
        .map(([, chain]) => chain);

      const polkadotSideForConnector: BridgePolkadotSide = {
        collectives: polkadotChains[POLKADOT_SIDE_KEYS.collectives],
        ahp: polkadotChains[POLKADOT_SIDE_KEYS.assetHub],
        bhp: polkadotChains[POLKADOT_SIDE_KEYS.bridgeHub],
        extras: polkadotExtras,
      };
      const kusamaSideForConnector: BridgeKusamaSide = {
        ahk: kusamaChains[KUSAMA_SIDE_KEYS.assetHub],
        bhk: kusamaChains[KUSAMA_SIDE_KEYS.bridgeHub],
        extras: kusamaExtras,
      };

      const pumpRounds = options.bridgePumpRounds
        ? parseInt(options.bridgePumpRounds, 10)
        : undefined;
      // The constructor only stores the sides; the first pump sets up the bridge subscription.
      // One connector for the whole run, so its collected events accumulate across steps.
      bridgeConnector = new BridgeConnector(
        this.logger,
        polkadotSideForConnector,
        kusamaSideForConnector,
        pumpRounds !== undefined ? { maxRounds: pumpRounds } : undefined
      );
      const run: BridgedRun = {
        connector: bridgeConnector,
        polkadot: polkadotSideForConnector,
        kusama: kusamaSideForConnector,
        kusamaChains: Object.values(kusamaChains),
      };
      const bridgeForks: Fork[] = [...Object.values(polkadotChains), ...run.kusamaChains];

      await this.runStepChain(steps, bridgeForks, (step) => this.runBridgedStep(step, run));
    } finally {
      // Tear down the bridge subscription and its polkadot.js ApiPromise instances BEFORE
      // shutting down chopsticks; otherwise the ApiPromise sockets receive a server disconnect
      // and log errors during cleanup.
      if (bridgeConnector) {
        try {
          await bridgeConnector.teardown();
        } catch (error) {
          this.logger.debug(`bridge teardown failed (best-effort): ${(error as Error).message}`);
        }
      }

      await this.shutdownForks(
        [
          ...Object.entries(polkadotChains).map(([key, fork]) => ({
            label: `Polkadot/${key} (${fork.label})`,
            fork,
          })),
          ...Object.entries(kusamaChains).map(([key, fork]) => ({
            label: `Kusama/${key} (${fork.label})`,
            fork,
          })),
        ],
        cleanup
      );
    }
  }

  /**
   * One step of a bridged run: the fellowship referendum on Collectives, the bridge pump that
   * delivers its message to BHK and verifies it landed on AHK, then the AHK public referendum that
   * dispatches the whitelisted call and the downstream fan-out settlement it triggers.
   */
  private async runBridgedStep(step: ReferendumStep, run: BridgedRun): Promise<StepOutcome> {
    const { connector, polkadot, kusama } = run;
    const outcome: StepOutcome = {
      main: stepHasGovernance(step) ? kusama.ahk : polkadot.collectives,
    };

    if (stepHasFellowship(step)) {
      this.logger.section('Fellowship Referendum Simulation (Collectives)');
      const { referendumId, callHex, preimageHex } = stepHalf(step, true);
      const fellowshipResult = await this.runner.fetchAndSimulate({
        api: polkadot.collectives.api,
        chopsticks: polkadot.collectives.manager,
        referendumId,
        isFellowship: true,
        createCallHex: callHex,
        createPreimageHex: preimageHex,
        preCall: step.preCall,
        preOrigin: step.preOrigin,
        label: 'Fellowship',
      });
      outcome.fellowshipReferendumId = fellowshipResult.referendumId;

      this.logger.section('Bridge Pump (observe BHP outbound, deliver to BHK)');
      const report = await connector.pumpUntilQuiet();
      this.logger.info(
        `Bridge pump observed ${report.totalSeen} outbound message(s) across ${report.byLane.size} lane(s) over ${report.rounds} round(s)`
      );

      if (report.totalSeen > 0) {
        // The chopsticks connector delivered the messages to BHK during the pump above.
        // Verify the end-to-end path: BHP MessageAccepted, BHK MessagesReceived and
        // AHK MessageQueue.Processed{success:true} all occurred.
        this.logger.section('Bridge Delivery Verification');
        const verifier = new BridgeVerifier(this.logger, {
          outboundPalletName: 'BridgeKusamaMessages',
          destMessagesPalletName: 'BridgePolkadotMessages',
        });
        const verification = await verifier.verify(
          polkadot,
          kusama,
          connector.getCollectedEvents()
        );
        if (!verification.overallPass) {
          throw new Error(
            `Bridge end-to-end verification FAILED: ${verification.failureReasons.join('; ')}`
          );
        }
      } else {
        this.logger.info(
          'No bridge messages observed (fellowship referendum may not have produced one, or BHK not in topology).'
        );
      }
    }

    // Second half of the full end-to-end scenario: now that the fellowship referendum has
    // bridged Whitelist.whitelist_call(hash) into AHK, run an AHK public referendum on the
    // WhitelistedCaller track whose proposal is
    // Whitelist.dispatch_whitelisted_call_with_preimage(call_X). Approval + scheduler
    // dispatch then executes call_X on AHK.
    if (stepHasGovernance(step)) {
      this.logger.section('Bridged-Target Public Referendum (AHK whitelistedcaller)');
      // Existing AHK governance referendum (`-r`), or undefined when creating one.
      const { referendumId, callHex, preimageHex } = stepHalf(step, false);
      const ahkResult = await this.runner.fetchAndSimulate({
        api: kusama.ahk.api,
        chopsticks: kusama.ahk.manager,
        referendumId,
        isFellowship: false,
        createCallHex: callHex,
        createPreimageHex: preimageHex,
        preCall: step.preCall,
        preOrigin: step.preOrigin,
        label: 'AHK Public',
      });
      outcome.referendumId = ahkResult.referendumId;

      // The dispatched call may fan XCM out to the other Kusama chains (e.g. a
      // network-wide `authorize_upgrade`). AHK has already queued those messages on
      // each target's inbound queue; build blocks on every other Kusama-side chain
      // until each one processes the fan-out message addressed to it, then report the
      // result for each chain.
      const downstream = run.kusamaChains.filter((chain) => chain !== kusama.ahk);
      if (downstream.length > 0) {
        this.logger.section('Downstream Fan-Out Settlement (Kusama system chains)');
        // Identifiers of the XCM the AHK referendum dispatched outward. settleDownstream
        // waits until each target processes one of these (a `MessageQueue.Processed`
        // whose `id` is in this set). This is a call-agnostic completion signal, instead of
        // advancing a fixed number of blocks, which can read state before delivery completes.
        const expectedMessageIds = collectOutboundXcmIds(ahkResult.events);
        const settleResults = await connector.settleDownstream(downstream, expectedMessageIds);
        // Report only the fan-out targets; AHK is the source, and the public-referendum
        // simulation already reports its UpgradeAuthorized.
        this.reportDownstreamFanOut(connector, downstream, settleResults);
      }
    }

    return outcome;
  }

  /**
   * Report, per chain, the result of the AHK fan-out: whether the chain processed the fan-out
   * message addressed to it (the call-agnostic settlement signal, from `settleResults`) and, when
   * the message contained a runtime upgrade, which code hash it authorized
   * (`System.UpgradeAuthorized`). Reads events from the connector's accumulated log, which
   * `settleDownstream` has just updated.
   */
  private reportDownstreamFanOut(
    connector: BridgeConnector,
    chains: BridgeChain[],
    settleResults: Map<string, DownstreamSettleResult>
  ): void {
    const collected = connector.getCollectedEvents();
    let anyUpgrade = false;
    for (const chain of chains) {
      const events = collected.get(chain.label) ?? [];
      const settle = settleResults.get(chain.label);
      const upgrades = events.filter(
        (e) => e.section === 'System' && e.method === 'UpgradeAuthorized'
      );
      if (settle && !settle.matched) {
        // The fan-out message was not processed within the round limit. Report a timeout
        // instead of passing. Storage may still settle a block later; increase
        // --bridge-pump-rounds if this recurs.
        this.logger.warn(
          `  ${chain.label}: fan-out message NOT observed processed within ${settle.rounds} round(s) — possible delivery lag`
        );
        continue;
      }
      if (upgrades.length > 0) {
        anyUpgrade = true;
        for (const ev of upgrades) {
          // getBlockEvents leaves `data` as raw decoded values (code_hash is a Binary
          // object); serializeEventData hex-encodes it the same way the verbose display does.
          const data = serializeEventData(ev.data) as { code_hash?: string };
          this.logger.success(
            `  ${chain.label}: System.UpgradeAuthorized — code_hash=${data?.code_hash ?? 'unknown'}`
          );
        }
      } else {
        // The message was processed, but the call it contained did not authorize an upgrade
        // here. This is expected for non-upgrade referenda (spends, config changes, …).
        this.logger.info(
          `  ${chain.label}: fan-out message processed (no UpgradeAuthorized — call was not an upgrade for this chain)`
        );
      }
    }
    if (!anyUpgrade) {
      this.logger.info(
        '  No downstream UpgradeAuthorized observed — the dispatched call did not authorize an upgrade on these chains.'
      );
    }
  }

  /** Connect a bridged fork. When the identity read fails, use the network key as the label. */
  private async connectBridgeChain(key: string, ctx: ChopsticksContext): Promise<BridgeChain> {
    const fork = await this.connectFork(ctx, async (api, endpoint) => {
      try {
        return await getChainInfo(api, endpoint);
      } catch (error) {
        this.logger.debug(`Could not detect chain info for ${key}: ${(error as Error).message}`);
        return {
          id: key,
          label: key,
          endpoint,
          network: 'unknown',
          kind: 'parachain',
          specName: 'unknown',
        };
      }
    });
    this.logger.info(`  ${key} ready: ${fork.label} at ${fork.info.endpoint}`);
    return fork;
  }

  private async pauseAllManagers(
    managers: Array<{ label: string; manager: ChopsticksManager }>
  ): Promise<void> {
    this.logger.info(`\n${'='.repeat(70)}`);
    this.logger.info('Chopsticks networks are paused for manual examination');

    for (const { label, manager } of managers) {
      try {
        const port = manager.getContext()?.chain?.port ?? 'unknown';
        this.logger.info(`  ${label} on port ${port}`);
      } catch {
        this.logger.info(`  ${label}`);
      }
    }

    this.logger.info('Press Ctrl+C to exit');
    this.logger.info('='.repeat(70));

    const pausePromises = managers.map(async ({ label, manager }) => {
      try {
        await manager.pause();
      } catch (error) {
        this.logger.warn(`Failed to pause ${label}: ${(error as Error).message}`);
      }
    });
    await Promise.all(pausePromises);
  }
}
