import { setupNetworks } from '@acala-network/chopsticks-testing';
import type { PolkadotClient } from 'polkadot-api';
import type { ReferendumStep, TestOptions } from '../types';
import type { SubstrateApi } from '../types/substrate-api';
import { serializeEventData } from '../utils/event-serializer';
import type { Logger } from '../utils/logger';
import { describeStep, stepHasFellowship, stepHasGovernance } from '../utils/referendum-steps';
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
  fetchChainInfoFromEndpoint,
  getChainInfo,
} from './chain-registry';
import {
  ChainTopologyBuilder,
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

/** A live fork plus its long-lived polkadot-api client. */
interface ConnectedFork {
  manager: ChopsticksManager;
  client: PolkadotClient;
  api: SubstrateApi;
}

/** A primary (governance or fellowship) fork with its detected chain identity. */
interface ForkedChain extends ConnectedFork {
  info: ChainInfo;
}

/** Any fork the run knows about, as handed to event settlement and post-tests. */
interface Fork {
  label: string;
  manager: ChopsticksManager;
  /** Detected identity; when absent the post-test description falls back to an RPC read. */
  info?: ChainInfo;
}

/**
 * The forked network a run executes on. Built once from the union of what every step needs, then
 * every {@link ReferendumStep} runs against it in order, so later steps see the state earlier ones
 * (and their post-tests) left behind. `fellowship` is the very same object as `governance` when
 * both referenda live on one chain.
 */
interface ForkedNetwork {
  governance?: ForkedChain;
  fellowship?: ForkedChain;
  additional: Fork[];
}

/** What a step executed, for the post-test context. */
interface StepOutcome {
  mainLabel: string;
  referendumId?: number;
  fellowshipReferendumId?: number;
}

function managersOf(forks: Fork[]): Map<string, ChopsticksManager> {
  return new Map(forks.map((fork) => [fork.label, fork.manager]));
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
   * The network is forked once from the union of what the steps need: the governance chain if any
   * step has a governance referendum, the fellowship chain if any has a fellowship referendum, plus
   * `--additional-chains`. Signers are funded up front for every creation call in the run. Each
   * step then executes (fellowship first, then governance, when it has both), settles XCM on the
   * other forks, and runs its own post-test before the next step starts.
   */
  async runSteps(
    steps: ReferendumStep[],
    cleanup: boolean = true,
    options?: TestOptions
  ): Promise<void> {
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
      for (const [index, step] of steps.entries()) {
        await this.runStep(network, step, index, steps.length, !!options?.verbose);
      }
    } finally {
      await this.teardownForkedNetwork(network, cleanup);
    }
  }

  /**
   * Fork every chain the run needs with one `setupNetworks` call so sibling/relay message passing
   * is wired between them, then adopt the primaries with long-lived clients.
   */
  private async setupForkedNetwork(
    needGovernance: boolean,
    needFellowship: boolean,
    injections: TopologyInjections
  ): Promise<ForkedNetwork> {
    const governanceInfo = this.topology.governanceChain;
    const fellowshipInfo = this.topology.fellowshipChain;
    if (needGovernance && !governanceInfo) {
      throw new Error('Governance chain type could not be detected');
    }
    if (needFellowship && !fellowshipInfo) {
      throw new Error('Fellowship chain type could not be detected');
    }

    const sharedChain =
      needGovernance &&
      needFellowship &&
      (this.topology.getGovernanceEndpoint() === this.topology.getFellowshipEndpoint() ||
        governanceInfo!.label === fellowshipInfo!.label);

    let networkConfig: Record<string, unknown> = {};
    let governanceKey: string | undefined;
    let fellowshipKey: string | undefined;

    if (needGovernance && needFellowship && !sharedChain) {
      this.logger.section('Setting Up Multi-Chain Environment');
      this.logger.info(`Governance Chain: ${governanceInfo!.label}`);
      this.logger.info(`Fellowship Chain: ${fellowshipInfo!.label}\n`);
      ({ networkConfig, governanceKey, fellowshipKey } =
        this.topology.buildNetworkTopology(injections));
    } else {
      // One primary fork: the governance chain, or the fellowship chain, or the chain shared by both.
      const role = needGovernance ? 'governance' : 'fellowship';
      const { info, block, baseConfig } = this.topology.primary(role);
      const primary = info!;
      const key = primary.kind === 'relay' ? this.topology.getRelayKey(primary.network) : role;
      // A fork takes one canned injection; the fellowship one is a superset of the Alice one, so it
      // also covers a shared chain that creates both kinds of referendum.
      const injection = injections.fellowship ?? injections.governance;
      networkConfig[key] = this.topology.buildConfig(
        primary.endpoint,
        block,
        injection,
        baseConfig
      );
      governanceKey = needGovernance ? key : undefined;
      fellowshipKey = needFellowship ? key : undefined;
    }

    const usedEndpoints = new Set<string>();
    if (needGovernance) usedEndpoints.add(governanceInfo!.endpoint);
    if (needFellowship) usedEndpoints.add(fellowshipInfo!.endpoint);
    const { chainToNetworkKey } = this.topology.registerAdditionalChains(
      networkConfig,
      usedEndpoints,
      needGovernance && governanceInfo!.kind === 'relay',
      needFellowship && fellowshipInfo!.kind === 'relay'
    );

    this.logger.startSpinner('Setting up interconnected chains...');
    const networks = await setupNetworks(networkConfig as Parameters<typeof setupNetworks>[0]);
    this.logger.succeedSpinner('Networks ready');

    const contextOf = (key: string): ChopsticksContext =>
      networks[key] as unknown as ChopsticksContext;

    if (governanceKey) {
      this.logger.info(`  Governance: ${contextOf(governanceKey).ws.endpoint}`);
    }
    if (fellowshipKey && fellowshipKey !== governanceKey) {
      this.logger.info(`  Fellowship: ${contextOf(fellowshipKey).ws.endpoint}`);
    }

    this.logger.startSpinner('Waiting for chains to be ready...');
    const [governance, distinctFellowship] = await Promise.all([
      governanceKey
        ? this.adoptPrimaryChain(contextOf(governanceKey), governanceInfo!.endpoint)
        : undefined,
      fellowshipKey && fellowshipKey !== governanceKey
        ? this.adoptPrimaryChain(contextOf(fellowshipKey), fellowshipInfo!.endpoint)
        : undefined,
    ]);
    const fellowship = fellowshipKey ? (distinctFellowship ?? governance) : undefined;
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

    const additional: Fork[] = [];
    for (const [label, networkKey] of chainToNetworkKey) {
      if (label === governance?.info.label || label === fellowship?.info.label) {
        this.logger.debug(`Skipping ${label} as it's already used as governance/fellowship chain`);
        continue;
      }
      this.logger.debug(
        `Adding additional chain manager: ${label} from network key: ${networkKey}`
      );
      additional.push({
        label,
        manager: ChopsticksManager.fromExistingContext(this.logger, contextOf(networkKey)),
        info: this.topology.additionalChains.find((chain) => chain.label === label),
      });
    }
    if (additional.length > 0) {
      this.logger.info(
        `Additional chains connected: ${additional.map((fork) => fork.label).join(', ')}`
      );
    }

    return { governance, fellowship, additional };
  }

  /** Wrap a chopsticks context with a manager and a ready polkadot-api client. */
  private async connectFork(context: ChopsticksContext): Promise<ConnectedFork> {
    const manager = ChopsticksManager.fromExistingContext(this.logger, context);
    const client = createPolkadotClient(context.ws.endpoint);
    const api = createApiForChain(client);
    await manager.waitForChainReady(api);
    return { manager, client, api };
  }

  private async adoptPrimaryChain(
    context: ChopsticksContext,
    endpoint: string
  ): Promise<ForkedChain> {
    const fork = await this.connectFork(context);
    return { ...fork, info: await getChainInfo(fork.api, endpoint) };
  }

  /** Execute one step against the forked network and run its post-test. */
  private async runStep(
    network: ForkedNetwork,
    step: ReferendumStep,
    index: number,
    count: number,
    verbose: boolean
  ): Promise<void> {
    if (count > 1) {
      this.logger.section(`Step ${index + 1}/${count}: ${describeStep(step)}`);
    }

    const hasGovernance = stepHasGovernance(step);
    const hasFellowship = stepHasFellowship(step);
    const { governance, fellowship } = network;

    let outcome: StepOutcome;
    if (hasGovernance && hasFellowship) {
      if (!governance || !fellowship) {
        throw new Error('Step needs governance and fellowship chains but they were not forked');
      }
      outcome = await this.runDualStep(network, step, governance, fellowship);
    } else if (hasGovernance) {
      if (!governance) {
        throw new Error('Step needs the governance chain but it was not forked');
      }
      outcome = await this.runSingleStep(network, step, governance, false);
    } else if (hasFellowship) {
      if (!fellowship) {
        throw new Error('Step needs the fellowship chain but it was not forked');
      }
      outcome = await this.runSingleStep(network, step, fellowship, true);
    } else {
      throw new Error(`Step ${index + 1} names no referendum`);
    }

    await this.maybeRunPostTest(
      step,
      outcome,
      { index: index + 1, count },
      this.forks(network),
      verbose
    );
  }

  /** Fellowship referendum then governance referendum (the whitelisting pattern). */
  private async runDualStep(
    network: ForkedNetwork,
    step: ReferendumStep,
    governance: ForkedChain,
    fellowship: ForkedChain
  ): Promise<StepOutcome> {
    if (step.preCall) {
      this.logger.warn(
        'pre-call is only applied to single-referendum steps; ignoring it for this fellowship + governance step'
      );
    }

    const createdFellowship = await this.runner.createReferendumIfNeeded({
      api: fellowship.api,
      chopsticks: fellowship.manager,
      callHex: step.callToCreateFellowshipReferendum,
      preimageHex: step.callToNotePreimageForFellowshipReferendum,
      isFellowship: true,
    });
    const fellowshipId = createdFellowship ?? step.fellowship;

    const createdGovernance = await this.runner.createReferendumIfNeeded({
      api: governance.api,
      chopsticks: governance.manager,
      callHex: step.callToCreateGovernanceReferendum,
      preimageHex: step.callToNotePreimageForGovernanceReferendum,
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
      await this.eventCollector.collectAdditionalChainEvents(managersOf(network.additional));
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
        additionalManagers: managersOf(network.additional),
        governanceLabel: governance.info.label,
        fellowshipLabel: fellowship.info.label,
      });
    }

    return {
      mainLabel: governance.info.label,
      referendumId: governanceId,
      fellowshipReferendumId: fellowshipId,
    };
  }

  /** A governance-only or fellowship-only referendum on `chain`; XCM settles on every other fork. */
  private async runSingleStep(
    network: ForkedNetwork,
    step: ReferendumStep,
    chain: ForkedChain,
    isFellowship: boolean
  ): Promise<StepOutcome> {
    const result = await this.runner.fetchAndSimulate({
      api: chain.api,
      chopsticks: chain.manager,
      referendumId: isFellowship ? step.fellowship : step.referendum,
      isFellowship,
      createCallHex: isFellowship
        ? step.callToCreateFellowshipReferendum
        : step.callToCreateGovernanceReferendum,
      createPreimageHex: isFellowship
        ? step.callToNotePreimageForFellowshipReferendum
        : step.callToNotePreimageForGovernanceReferendum,
      preCall: step.preCall,
      preOrigin: step.preOrigin,
    });

    await this.eventCollector.collectAdditionalChainEvents(managersOf(this.forks(network, chain)));

    return {
      mainLabel: chain.info.label,
      referendumId: isFellowship ? undefined : result.referendumId,
      fellowshipReferendumId: isFellowship ? result.referendumId : undefined,
    };
  }

  /**
   * Every fork in the network in a stable order — primaries first, then additional chains — minus
   * `except` (the chain a step just executed on, when the others should settle its XCM).
   */
  private forks(network: ForkedNetwork, except?: ForkedChain): Fork[] {
    const forks: Fork[] = [];
    for (const primary of [network.governance, network.fellowship]) {
      if (
        primary &&
        primary !== except &&
        !forks.some((fork) => fork.manager === primary.manager)
      ) {
        forks.push({ label: primary.info.label, manager: primary.manager, info: primary.info });
      }
    }
    forks.push(...network.additional);
    return forks;
  }

  private async teardownForkedNetwork(network: ForkedNetwork, cleanup: boolean): Promise<void> {
    const primaries: Array<{ label: string; chain: ForkedChain }> = [];
    if (network.governance) {
      primaries.push({
        label: `Governance (${network.governance.info.label})`,
        chain: network.governance,
      });
    }
    if (network.fellowship && network.fellowship !== network.governance) {
      primaries.push({
        label: `Fellowship (${network.fellowship.info.label})`,
        chain: network.fellowship,
      });
    }
    await this.shutdownForks(
      primaries.map(({ chain }) => chain.client),
      [
        ...primaries.map(({ label, chain }) => ({ label, manager: chain.manager })),
        ...network.additional.map(({ label, manager }) => ({ label, manager })),
      ],
      cleanup
    );
  }

  /** Destroy the clients, then tear the forks down or leave them paused for inspection. */
  private async shutdownForks(
    clients: PolkadotClient[],
    managers: Array<{ label: string; manager: ChopsticksManager }>,
    cleanup: boolean
  ): Promise<void> {
    for (const client of clients) {
      try {
        client.destroy();
      } catch {
        // best-effort
      }
    }
    if (cleanup) {
      await Promise.all(managers.map(({ manager }) => manager.cleanup()));
    } else {
      await this.pauseAllManagers(managers);
    }
  }

  /**
   * Describe a live fork for a post-test. Uses the identity detected at fork time when we have it;
   * otherwise reads `spec_name` via the same one-shot legacy RPC as pre-fork detection.
   */
  private async describePostTestChain(fork: Fork): Promise<PostTestChain> {
    const context = fork.manager.getContext();
    const wsEndpoint = context.ws.endpoint;
    // The live chopsticks-core Blockchain, for in-process block building (see PostTestChain.chain).
    const chain = (context as unknown as { chain?: unknown }).chain;
    let info = fork.info;
    if (!info) {
      try {
        info = await fetchChainInfoFromEndpoint(wsEndpoint);
      } catch {
        return {
          label: fork.label,
          specName: 'unknown',
          network: 'unknown',
          kind: 'unknown',
          wsEndpoint,
          chain,
        };
      }
    }
    return {
      label: info.label,
      specName: info.specName,
      network: info.network,
      kind: info.kind,
      wsEndpoint,
      chain,
    };
  }

  /**
   * Run a step's post-test module against the live network. `outcome.mainLabel` names the chain
   * the step's referendum executed on. Rethrows on failure so the caller exits non-zero.
   */
  private async maybeRunPostTest(
    step: Pick<ReferendumStep, 'postTest' | 'postTestArgs'>,
    outcome: StepOutcome,
    position: Pick<PostTestStepInfo, 'index' | 'count'>,
    forks: Fork[],
    verbose: boolean
  ): Promise<void> {
    if (!step.postTest) return;
    const chains = await Promise.all(forks.map((fork) => this.describePostTestChain(fork)));
    const main = chains.find((c) => c.label === outcome.mainLabel) ?? chains[0];
    if (!main) throw new Error('No chains available for the post-test');
    const context: PostTestContext = {
      main,
      chains,
      args: undefined,
      verbose,
      step: {
        ...position,
        referendumId: outcome.referendumId,
        fellowshipReferendumId: outcome.fellowshipReferendumId,
      },
    };
    await runPostTest(this.logger, step.postTest, context, step.postTestArgs);
  }

  /**
   * Run referendum steps whose fellowship half sends an XCM that ultimately executes on a chain
   * in a different consensus (across the Polkadot → Kusama bridge).
   *
   * Both sides are spawned once (Polkadot: Collectives + AHP + BHP, Kusama: AHK + BHK, plus any
   * `--additional-chains` routed per side). Then, per step: the fellowship referendum on
   * Collectives, the bridge pump that delivers its message to BHK and verifies it landed on AHK,
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
      // Alice on AHK is only needed when *creating* a referendum (she signs notePreimage
      // + submit). An existing referendum is force-approved via storage, so no signer.
      injectAliceOnAssetHubKusama:
        bridgeEndpoints.injectAliceOnAssetHubKusama ??
        steps.some((step) => !!step.callToCreateGovernanceReferendum),
      // Alice signs receive_messages_proof on BHK — always fund her there.
      injectAliceOnBridgeHubKusama: bridgeEndpoints.injectAliceOnBridgeHubKusama ?? true,
    });

    const polkadotSide = builder.buildPolkadotSide();
    const kusamaSide = builder.buildKusamaSide();

    this.logger.section('Setting Up Bridged Multi-Chain Environment');
    this.logger.info(`Polkadot-side keys: ${Object.values(POLKADOT_SIDE_KEYS).join(', ')}`);
    this.logger.info(`Kusama-side keys: ${Object.values(KUSAMA_SIDE_KEYS).join(', ')}`);

    this.logger.startSpinner('Spawning Polkadot-side chopsticks fork...');
    const polkadotNetworks = await setupNetworks(
      polkadotSide.networkConfig as Parameters<typeof setupNetworks>[0]
    );
    this.logger.succeedSpinner('Polkadot-side network ready');

    this.logger.startSpinner('Spawning Kusama-side chopsticks fork...');
    const kusamaNetworks = await setupNetworks(
      kusamaSide.networkConfig as Parameters<typeof setupNetworks>[0]
    );
    this.logger.succeedSpinner('Kusama-side network ready');

    const polkadotChains: Record<string, BridgeChain> = {};
    const kusamaChains: Record<string, BridgeChain> = {};
    // Hoisted so the finally-block can tear down the bridge subscription + the
    // polkadot.js ApiPromise instances it owns, even if the bridge work throws.
    let bridgeConnector: BridgeConnector | null = null;

    try {
      for (const [key, ctx] of Object.entries(polkadotNetworks)) {
        polkadotChains[key] = await this.adoptBridgeChain(key, ctx as unknown as ChopsticksContext);
      }
      for (const [key, ctx] of Object.entries(kusamaNetworks)) {
        kusamaChains[key] = await this.adoptBridgeChain(key, ctx as unknown as ChopsticksContext);
      }

      // Everything adopted under a non-core key (relay `polkadot`/`kusama` or `extra_<n>`)
      // came from --additional-chains; hand them to the connector so the pump advances them.
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
      // Construction only stores the sides; the bridge subscription is set up lazily by the first
      // pump. One connector for the whole run: its collected events accumulate across steps.
      bridgeConnector = new BridgeConnector(
        this.logger,
        polkadotSideForConnector,
        kusamaSideForConnector,
        pumpRounds !== undefined ? { maxRounds: pumpRounds } : undefined
      );
      const connector = bridgeConnector;

      const bridgeForks: Fork[] = [
        ...Object.values(polkadotChains),
        ...Object.values(kusamaChains),
      ].map((chain) => ({ label: chain.label, manager: chain.manager, info: chain.info }));

      for (const [index, step] of steps.entries()) {
        if (steps.length > 1) {
          this.logger.section(`Step ${index + 1}/${steps.length}: ${describeStep(step)}`);
        }
        const outcome: StepOutcome = {
          mainLabel: stepHasGovernance(step)
            ? kusamaSideForConnector.ahk.label
            : polkadotSideForConnector.collectives.label,
        };

        if (stepHasFellowship(step)) {
          this.logger.section('Fellowship Referendum Simulation (Collectives)');
          const fellowshipResult = await this.runner.fetchAndSimulate({
            api: polkadotSideForConnector.collectives.api,
            chopsticks: polkadotSideForConnector.collectives.manager,
            referendumId: step.fellowship,
            isFellowship: true,
            createCallHex: step.callToCreateFellowshipReferendum,
            createPreimageHex: step.callToNotePreimageForFellowshipReferendum,
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
            // Verify the end-to-end happy path: BHP MessageAccepted, BHK MessagesReceived,
            // AHK MessageQueue.Processed{success:true} all fired.
            this.logger.section('Bridge Delivery Verification');
            const verifier = new BridgeVerifier(this.logger, {
              outboundPalletName: 'BridgeKusamaMessages',
              destMessagesPalletName: 'BridgePolkadotMessages',
            });
            const verification = await verifier.verify(
              polkadotSideForConnector,
              kusamaSideForConnector,
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
        // dispatch then actually executes call_X on AHK.
        if (stepHasGovernance(step)) {
          this.logger.section('Bridged-Target Public Referendum (AHK whitelistedcaller)');
          const ahkResult = await this.runner.fetchAndSimulate({
            api: kusamaSideForConnector.ahk.api,
            chopsticks: kusamaSideForConnector.ahk.manager,
            // Existing AHK governance referendum (`-r`), or undefined when creating one.
            referendumId: step.referendum,
            isFellowship: false,
            createCallHex: step.callToCreateGovernanceReferendum,
            createPreimageHex: step.callToNotePreimageForGovernanceReferendum,
            preCall: step.preCall,
            preOrigin: step.preOrigin,
            label: 'AHK Public',
          });
          outcome.referendumId = ahkResult.referendumId;

          // The dispatched call may fan XCM out to the other Kusama chains (e.g. a
          // network-wide `authorize_upgrade`). AHK has already queued those messages on
          // each target's inbound queue; build blocks on every other Kusama-side chain
          // until each one actually *processes* the fan-out message addressed to it, then
          // report what each one did.
          const downstream = Object.values(kusamaChains).filter(
            (chain) => chain !== kusamaSideForConnector.ahk
          );
          if (downstream.length > 0) {
            this.logger.section('Downstream Fan-Out Settlement (Kusama system chains)');
            // Identifiers of the XCM the AHK referendum dispatched outward. settleDownstream
            // waits until each target processes one of these (a `MessageQueue.Processed`
            // whose `id` is in this set) — a call-agnostic completion signal, instead of
            // advancing a fixed number of blocks and racing the cross-chain delivery.
            const expectedMessageIds = collectOutboundXcmIds(ahkResult.events);
            const settleResults = await connector.settleDownstream(downstream, expectedMessageIds);
            // Report only the fan-out targets; AHK is the source and its own
            // UpgradeAuthorized is already surfaced during the public-referendum simulation.
            this.reportDownstreamFanOut(connector, downstream, settleResults);
          }
        }

        await this.maybeRunPostTest(
          step,
          outcome,
          { index: index + 1, count: steps.length },
          bridgeForks,
          !!options.verbose
        );
      }
    } finally {
      // Tear down the bridge subscription + its polkadot.js ApiPromise instances
      // BEFORE we shut down chopsticks; otherwise the ApiPromise sockets observe a
      // server disconnect and log noisy errors during cleanup.
      if (bridgeConnector) {
        try {
          await bridgeConnector.teardown();
        } catch (error) {
          this.logger.debug(`bridge teardown failed (best-effort): ${(error as Error).message}`);
        }
      }

      const allChains = [
        ...Object.entries(polkadotChains).map(([key, chain]) => ({
          label: `Polkadot/${key} (${chain.label})`,
          chain,
        })),
        ...Object.entries(kusamaChains).map(([key, chain]) => ({
          label: `Kusama/${key} (${chain.label})`,
          chain,
        })),
      ];
      await this.shutdownForks(
        allChains.map(({ chain }) => chain.client),
        allChains.map(({ label, chain }) => ({ label, manager: chain.manager })),
        cleanup
      );
    }
  }

  /**
   * Summarise, per chain, what the AHK fan-out actually did downstream: whether the chain
   * *processed* the fan-out message addressed to it (the call-agnostic settlement signal,
   * from `settleResults`) and — if the carried call was a runtime upgrade — which code hash
   * it authorized (`System.UpgradeAuthorized`). Reads events from the connector's
   * accumulated log, which `settleDownstream` has just topped up.
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
        // The fan-out message never showed up as processed within the round cap — an
        // honest timeout, not a silent pass. (Storage may still settle a block later;
        // bump --bridge-pump-rounds if this recurs.)
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
        // Message processed, but the carried call didn't authorize an upgrade here. That's
        // expected for non-upgrade referenda (spends, config changes, …).
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

  /** Adopt a bridged fork; a failed identity read keeps the network key as its label. */
  private async adoptBridgeChain(key: string, ctx: ChopsticksContext): Promise<BridgeChain> {
    const fork = await this.connectFork(ctx);
    const wsEndpoint = fork.manager.getContext().ws.endpoint;
    let info: ChainInfo | undefined;
    try {
      info = await getChainInfo(fork.api, wsEndpoint);
    } catch (error) {
      this.logger.debug(`Could not detect chain info for ${key}: ${(error as Error).message}`);
    }
    const label = info?.label ?? key;
    this.logger.info(`  ${key} ready: ${label} at ${wsEndpoint}`);
    return { ...fork, label, info };
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
