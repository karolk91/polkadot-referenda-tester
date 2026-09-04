import { setupNetworks } from '@acala-network/chopsticks-testing';
import type { PolkadotClient } from 'polkadot-api';
import type { ChopsticksConfig, TestOptions } from '../types';
import { serializeEventData } from '../utils/event-serializer';
import type { Logger } from '../utils/logger';
import { FELLOWSHIP_STORAGE_INJECTION } from '../utils/storage-constants';
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
  createApiForChain,
  createPolkadotClient,
  fetchChainInfoFromEndpoint,
  getChainInfo,
} from './chain-registry';
import { ChainTopologyBuilder, type TopologyConfig } from './chain-topology-builder';
import { type ChopsticksContext, ChopsticksManager } from './chopsticks-manager';
import { EventCollector } from './event-collector';
import { type PostTestChain, type PostTestContext, runPostTest } from './post-test-runner';
import { SimulationRunner } from './simulation-runner';

interface SingleChainTestConfig {
  endpoint: string;
  block: number | undefined;
  referendumId: number | undefined;
  isFellowship: boolean;
  storageInjection: 'fellowship' | 'alice-account' | undefined;
  createCallHex: string | undefined;
  createPreimageHex: string | undefined;
  options?: TestOptions;
  cleanup: boolean;
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

  async testWithFellowship(
    mainReferendumId: number | undefined,
    fellowshipReferendumId: number | undefined,
    cleanup: boolean = true,
    options?: TestOptions
  ): Promise<void> {
    const hasFellowship =
      fellowshipReferendumId !== undefined || !!options?.callToCreateFellowshipReferendum;
    const hasMain = mainReferendumId !== undefined || !!options?.callToCreateGovernanceReferendum;

    if (!hasMain && hasFellowship) {
      if (!this.topology.getFellowshipEndpoint()) {
        throw new Error('Fellowship chain URL must be provided when testing fellowship referendum');
      }

      if (this.topology.hasAdditionalChains()) {
        await this.topology.detectChainTypes();
        return this.runSingleChainWithAdditionalChains(
          fellowshipReferendumId,
          true,
          cleanup,
          options
        );
      }

      return this.runSingleChainTest({
        endpoint: this.topology.getFellowshipEndpoint()!,
        block: this.topology.getFellowshipBlock(),
        referendumId: fellowshipReferendumId,
        isFellowship: true,
        storageInjection: options?.callToCreateFellowshipReferendum ? 'fellowship' : undefined,
        createCallHex: options?.callToCreateFellowshipReferendum,
        createPreimageHex: options?.callToNotePreimageForFellowshipReferendum,
        options,
        cleanup,
      });
    }

    if (hasMain && !hasFellowship) {
      if (!this.topology.getGovernanceEndpoint()) {
        throw new Error('Governance endpoint must be set for single referendum testing');
      }

      if (this.topology.hasAdditionalChains()) {
        await this.topology.detectChainTypes();
        return this.runSingleChainWithAdditionalChains(mainReferendumId, false, cleanup, options);
      }

      return this.runSingleChainTest({
        endpoint: this.topology.getGovernanceEndpoint()!,
        block: this.topology.getGovernanceBlock(),
        referendumId: mainReferendumId,
        isFellowship: false,
        storageInjection: options?.callToCreateGovernanceReferendum ? 'alice-account' : undefined,
        createCallHex: options?.callToCreateGovernanceReferendum,
        createPreimageHex: options?.callToNotePreimageForGovernanceReferendum,
        options,
        cleanup,
      });
    }

    if (!hasFellowship || !hasMain) {
      throw new Error('Both referendum IDs must be provided or created for dual testing');
    }

    if (!this.topology.getFellowshipEndpoint()) {
      throw new Error('Fellowship chain URL must be provided when fellowship referendum ID is set');
    }

    if (!this.topology.getGovernanceEndpoint()) {
      throw new Error('Governance chain URL must be provided when testing both referenda');
    }

    await this.topology.detectChainTypes();

    this.logger.section('Setting Up Multi-Chain Environment');
    this.logger.info(`Governance Chain: ${this.topology.governanceChain!.label}`);
    this.logger.info(`Fellowship Chain: ${this.topology.fellowshipChain!.label}`);
    this.logger.info(`Fellowship Referendum: #${fellowshipReferendumId}`);
    this.logger.info(`Main Referendum: #${mainReferendumId}\n`);

    const sameEndpoint =
      this.topology.getGovernanceEndpoint() === this.topology.getFellowshipEndpoint() ||
      this.topology.governanceChain!.label === this.topology.fellowshipChain!.label;

    if (sameEndpoint) {
      return this.testSameChainWithFellowship(mainReferendumId, fellowshipReferendumId, options);
    }

    return this.testMultiChain(mainReferendumId, fellowshipReferendumId, cleanup, options);
  }

  /**
   * Describe a live forked chain for a post-test. Reads `spec_name` via the same one-shot legacy
   * RPC as pre-fork detection (chopsticks forks serve it too); only called when `--post-test` is set.
   */
  private async describePostTestChain(
    label: string,
    manager: ChopsticksManager
  ): Promise<PostTestChain> {
    const context = manager.getContext();
    const wsEndpoint = context.ws.endpoint;
    // The live chopsticks-core Blockchain, for in-process block building (see PostTestChain.chain).
    const chain = (context as unknown as { chain?: unknown }).chain;
    try {
      const info = await fetchChainInfoFromEndpoint(wsEndpoint);
      return {
        label: info.label,
        specName: info.specName,
        network: info.network,
        kind: info.kind,
        wsEndpoint,
        chain,
      };
    } catch {
      return { label, specName: 'unknown', network: 'unknown', kind: 'unknown', wsEndpoint, chain };
    }
  }

  /**
   * Run the optional `--post-test` module against the live post-referendum network. `mainLabel`
   * names the chain the referendum executed on. Rethrows on failure so the caller exits non-zero.
   */
  private async maybeRunPostTest(
    options: TestOptions | undefined,
    mainLabel: string,
    managers: Map<string, ChopsticksManager>
  ): Promise<void> {
    if (!options?.postTest) return;
    const chains: PostTestChain[] = [];
    for (const [label, manager] of managers) {
      chains.push(await this.describePostTestChain(label, manager));
    }
    const main = chains.find((c) => c.label === mainLabel) ?? chains[0];
    if (!main) throw new Error('No chains available for the post-test');
    const context: PostTestContext = {
      main,
      chains,
      args: undefined,
      verbose: !!options.verbose,
    };
    await runPostTest(this.logger, options.postTest, context, options.postTestArgs);
  }

  private async runSingleChainTest(config: SingleChainTestConfig): Promise<void> {
    const label = config.isFellowship ? 'Fellowship' : 'Governance';
    this.logger.startSpinner(`Starting Chopsticks for ${label.toLowerCase()} chain...`);

    const chopsticks = new ChopsticksManager(this.logger);
    let client: PolkadotClient | null = null;

    try {
      const chopsticksConfig = config.isFellowship
        ? await this.buildFellowshipChopsticksConfig(config)
        : this.topology.buildConfig(config.endpoint, config.block, config.storageInjection);

      const networkKey = config.isFellowship
        ? await this.topology.detectRelayNetworkKey(config.endpoint)
        : undefined;

      const context = await chopsticks.setup(
        chopsticksConfig as unknown as ChopsticksConfig,
        networkKey
      );

      const wsEndpoint = context.ws.endpoint;
      client = createPolkadotClient(wsEndpoint);
      const api = createApiForChain(client);

      this.logger.succeedSpinner(`Chopsticks ready at ${wsEndpoint}`);

      this.logger.startSpinner('Waiting for chain to be ready...');
      await chopsticks.waitForChainReady(api);
      this.logger.succeedSpinner('Chain is ready');

      const chainInfo = await getChainInfo(api, config.endpoint);
      if (config.isFellowship) {
        this.topology.fellowshipChain = chainInfo;
      } else {
        this.topology.governanceChain = chainInfo;
      }
      this.logger.info(`Detected chain: ${chainInfo.label} (${chainInfo.specName})`);

      await this.runner.fetchAndSimulate({
        api,
        chopsticks,
        referendumId: config.referendumId,
        isFellowship: config.isFellowship,
        createCallHex: config.createCallHex,
        createPreimageHex: config.createPreimageHex,
        preCall: config.options?.preCall,
        preOrigin: config.options?.preOrigin,
      });

      await this.maybeRunPostTest(
        config.options,
        chainInfo.label,
        new Map([[chainInfo.label, chopsticks]])
      );
    } finally {
      if (client) {
        client.destroy();
      }
      if (config.cleanup) {
        await chopsticks.cleanup();
      } else {
        this.logger.info(`\nChopsticks instance still running for inspection`);
        this.logger.info('Press Ctrl+C to exit');
        await chopsticks.pause();
      }
    }
  }

  private async runSingleChainWithAdditionalChains(
    referendumId: number | undefined,
    isFellowship: boolean,
    cleanup: boolean,
    options?: TestOptions
  ): Promise<void> {
    const mainChain = isFellowship
      ? this.topology.fellowshipChain!
      : this.topology.governanceChain!;
    const mainEndpoint = isFellowship
      ? this.topology.getFellowshipEndpoint()!
      : this.topology.getGovernanceEndpoint()!;
    const mainBlock = isFellowship
      ? this.topology.getFellowshipBlock()
      : this.topology.getGovernanceBlock();
    const mainIsRelay = mainChain.kind === 'relay';
    const label = isFellowship ? 'Fellowship' : 'Governance';

    const mainKey = mainIsRelay
      ? this.topology.getRelayKey(mainChain.network)
      : isFellowship
        ? 'fellowship'
        : 'governance';

    let storageInjection: 'fellowship' | 'alice-account' | undefined;
    if (isFellowship && options?.callToCreateFellowshipReferendum) {
      storageInjection = 'fellowship';
    } else if (!isFellowship && options?.callToCreateGovernanceReferendum) {
      storageInjection = 'alice-account';
    }

    const networkConfig: Record<string, unknown> = {};
    networkConfig[mainKey] = this.topology.buildConfig(mainEndpoint, mainBlock, storageInjection);

    const { chainToNetworkKey } = this.topology.registerAdditionalChains(
      networkConfig,
      new Set([mainEndpoint]),
      !isFellowship && mainIsRelay,
      isFellowship && mainIsRelay
    );

    this.logger.startSpinner('Setting up interconnected chains...');
    const networks = await setupNetworks(networkConfig as Parameters<typeof setupNetworks>[0]);

    const mainManager = ChopsticksManager.fromExistingContext(
      this.logger,
      networks[mainKey] as unknown as ChopsticksContext
    );

    const additionalManagers = new Map<string, ChopsticksManager>();
    for (const [chainLabel, networkKey] of chainToNetworkKey) {
      additionalManagers.set(
        chainLabel,
        ChopsticksManager.fromExistingContext(
          this.logger,
          networks[networkKey] as unknown as ChopsticksContext
        )
      );
    }

    this.logger.succeedSpinner('Networks ready');
    this.logger.info(`  ${label}: ${mainManager.getContext().ws.endpoint}`);
    if (additionalManagers.size > 0) {
      this.logger.info(
        `Additional chains connected: ${Array.from(additionalManagers.keys()).join(', ')}`
      );
    }

    const mainClient = createPolkadotClient(mainManager.getContext().ws.endpoint);

    try {
      const api = createApiForChain(mainClient);

      this.logger.startSpinner('Waiting for chain to be ready...');
      await mainManager.waitForChainReady(api);
      this.logger.succeedSpinner('Chain is ready');

      const chainInfo = await getChainInfo(api, mainEndpoint);
      if (isFellowship) {
        this.topology.fellowshipChain = chainInfo;
      } else {
        this.topology.governanceChain = chainInfo;
      }
      this.logger.info(`Detected chain: ${chainInfo.label} (${chainInfo.specName})`);

      await this.runner.fetchAndSimulate({
        api,
        chopsticks: mainManager,
        referendumId,
        isFellowship,
        createCallHex: isFellowship
          ? options?.callToCreateFellowshipReferendum
          : options?.callToCreateGovernanceReferendum,
        createPreimageHex: isFellowship
          ? options?.callToNotePreimageForFellowshipReferendum
          : options?.callToNotePreimageForGovernanceReferendum,
        preCall: options?.preCall,
        preOrigin: options?.preOrigin,
      });

      await this.eventCollector.collectAdditionalChainEvents(additionalManagers);

      const postTestManagers = new Map<string, ChopsticksManager>([
        [chainInfo.label, mainManager],
        ...additionalManagers,
      ]);
      await this.maybeRunPostTest(options, chainInfo.label, postTestManagers);
    } finally {
      mainClient.destroy();

      if (cleanup) {
        await Promise.all([
          mainManager.cleanup(),
          ...Array.from(additionalManagers.values()).map((manager) => manager.cleanup()),
        ]);
      } else {
        await this.pauseAllManagers([
          { label: `${label} (${mainChain.label})`, manager: mainManager },
          ...Array.from(additionalManagers).map(([chainLabel, manager]) => ({
            label: chainLabel,
            manager,
          })),
        ]);
      }
    }
  }

  private async buildFellowshipChopsticksConfig(
    config: SingleChainTestConfig
  ): Promise<Record<string, unknown>> {
    const chopsticksConfig: Record<string, unknown> = {
      endpoint: config.endpoint,
      'build-block-mode': 'manual',
    };

    if (config.block !== undefined) {
      chopsticksConfig.block = config.block;
    }

    if (config.storageInjection === 'fellowship') {
      chopsticksConfig['import-storage'] = FELLOWSHIP_STORAGE_INJECTION;
      this.logger.debug('Injecting fellowship storage for Alice account');
    }

    return chopsticksConfig;
  }

  private async testSameChainWithFellowship(
    mainReferendumId: number | undefined,
    fellowshipReferendumId: number | undefined,
    options?: TestOptions
  ): Promise<void> {
    this.logger.startSpinner('Starting shared chain...');

    const chopsticks = new ChopsticksManager(this.logger);
    let client: PolkadotClient | null = null;

    try {
      const chainEndpoint =
        this.topology.getGovernanceEndpoint() || this.topology.getFellowshipEndpoint();
      if (!chainEndpoint) {
        throw new Error('At least one chain endpoint must be provided');
      }

      const config: Record<string, unknown> = {
        endpoint: chainEndpoint,
        'build-block-mode': 'manual',
      };

      const block = this.topology.getGovernanceBlock() ?? this.topology.getFellowshipBlock();
      if (block !== undefined) {
        config.block = block;
      }

      if (options?.callToCreateFellowshipReferendum) {
        config['import-storage'] = FELLOWSHIP_STORAGE_INJECTION;
        this.logger.debug('Injecting fellowship storage for Alice account');
      }

      const context = await chopsticks.setup(config as unknown as ChopsticksConfig);

      const endpoint = context.ws.endpoint;
      client = createPolkadotClient(endpoint);
      const api = createApiForChain(client);

      this.logger.succeedSpinner(`Chain ready at ${endpoint}`);

      this.logger.startSpinner('Waiting for chain to be ready...');
      await chopsticks.waitForChainReady(api);
      this.logger.succeedSpinner('Chain is ready');

      this.topology.governanceChain = await getChainInfo(api, chainEndpoint);
      this.topology.fellowshipChain = this.topology.governanceChain;
      this.logger.info(
        `Detected chain: ${this.topology.governanceChain.label} (${this.topology.governanceChain.specName})`
      );

      const createdFellowship = await this.runner.createReferendumIfNeeded({
        api,
        chopsticks,
        callHex: options?.callToCreateFellowshipReferendum,
        preimageHex: options?.callToNotePreimageForFellowshipReferendum,
        isFellowship: true,
      });
      const actualFellowshipId = createdFellowship ?? fellowshipReferendumId;

      const createdGovernance = await this.runner.createReferendumIfNeeded({
        api,
        chopsticks,
        callHex: options?.callToCreateGovernanceReferendum,
        preimageHex: options?.callToNotePreimageForGovernanceReferendum,
        isFellowship: false,
      });
      const actualMainId = createdGovernance ?? mainReferendumId;

      if (actualFellowshipId === undefined) {
        throw new Error('Fellowship referendum ID is required but was not provided or created');
      }

      if (actualMainId === undefined) {
        throw new Error('Main referendum ID is required but was not provided or created');
      }

      await this.runner.simulateSequentialReferenda(
        api,
        chopsticks,
        actualFellowshipId,
        actualMainId
      );

      // Post-test against the shared chain (governance == fellowship here; no additional chains).
      const sharedLabel =
        this.topology.governanceChain?.label ??
        this.topology.fellowshipChain?.label ??
        'Governance';
      await this.maybeRunPostTest(options, sharedLabel, new Map([[sharedLabel, chopsticks]]));
    } finally {
      if (client) {
        client.destroy();
      }
      await chopsticks.cleanup();
    }
  }

  private async testMultiChain(
    mainReferendumId: number | undefined,
    fellowshipReferendumId: number | undefined,
    cleanup: boolean = true,
    options?: TestOptions
  ): Promise<void> {
    const { governanceManager, fellowshipManager, additionalManagers } =
      await this.setupInterconnectedChains(options);

    const governanceClient = createPolkadotClient(governanceManager.getContext().ws.endpoint);
    const fellowshipClient = createPolkadotClient(fellowshipManager.getContext().ws.endpoint);

    this.logger.succeedSpinner('Networks ready');
    this.logger.info(`  Governance: ${governanceManager.getContext().ws.endpoint}`);
    this.logger.info(`  Fellowship: ${fellowshipManager.getContext().ws.endpoint}`);

    try {
      const governanceApi = createApiForChain(governanceClient);
      const fellowshipApi = createApiForChain(fellowshipClient);

      this.logger.startSpinner('Waiting for chains to be ready...');
      await Promise.all([
        governanceManager.waitForChainReady(governanceApi),
        fellowshipManager.waitForChainReady(fellowshipApi),
      ]);
      this.logger.succeedSpinner('Chains are ready');

      const [govChainInfo, fellChainInfo] = await Promise.all([
        getChainInfo(governanceApi, this.topology.getGovernanceEndpoint()!),
        getChainInfo(fellowshipApi, this.topology.getFellowshipEndpoint()!),
      ]);
      this.topology.governanceChain = govChainInfo;
      this.topology.fellowshipChain = fellChainInfo;
      this.logger.info(`Governance: ${govChainInfo.label} (${govChainInfo.specName})`);
      this.logger.info(`Fellowship: ${fellChainInfo.label} (${fellChainInfo.specName})`);

      const createdFellowship = await this.runner.createReferendumIfNeeded({
        api: fellowshipApi,
        chopsticks: fellowshipManager,
        callHex: options?.callToCreateFellowshipReferendum,
        preimageHex: options?.callToNotePreimageForFellowshipReferendum,
        isFellowship: true,
      });
      const actualFellowshipId = createdFellowship ?? fellowshipReferendumId;

      const createdGovernance = await this.runner.createReferendumIfNeeded({
        api: governanceApi,
        chopsticks: governanceManager,
        callHex: options?.callToCreateGovernanceReferendum,
        preimageHex: options?.callToNotePreimageForGovernanceReferendum,
        isFellowship: false,
      });
      const actualMainId = createdGovernance ?? mainReferendumId;

      if (actualFellowshipId === undefined) {
        throw new Error('Fellowship referendum ID is required but was not provided or created');
      }

      if (actualMainId === undefined) {
        throw new Error('Main referendum ID is required but was not provided or created');
      }

      await this.runner.simulateMultiChainReferenda({
        fellowship: {
          api: fellowshipApi,
          chopsticks: fellowshipManager,
          referendumId: actualFellowshipId,
          label: this.topology.fellowshipChain!.label,
        },
        governance: {
          api: governanceApi,
          chopsticks: governanceManager,
          referendumId: actualMainId,
          label: this.topology.governanceChain!.label,
        },
      });

      await this.eventCollector.displayPostExecutionEvents({
        governance: { chopsticks: governanceManager, api: governanceApi },
        fellowship: { chopsticks: fellowshipManager, api: fellowshipApi },
        additionalManagers,
        governanceLabel: this.topology.governanceChain!.label,
        fellowshipLabel: this.topology.fellowshipChain!.label,
      });

      // Run the post-referendum test against every fork (governance + fellowship + additional).
      // The referendum executed on the governance chain, so that is `main` for the post-test.
      const postTestManagers = new Map<string, ChopsticksManager>([
        [this.topology.governanceChain!.label, governanceManager],
        [this.topology.fellowshipChain!.label, fellowshipManager],
        ...additionalManagers,
      ]);
      await this.maybeRunPostTest(
        options,
        this.topology.governanceChain!.label,
        postTestManagers
      );
    } finally {
      governanceClient.destroy();
      fellowshipClient.destroy();

      if (cleanup) {
        await Promise.all([
          governanceManager.cleanup(),
          fellowshipManager.cleanup(),
          ...Array.from(additionalManagers.values()).map((manager) => manager.cleanup()),
        ]);
      } else {
        await this.pauseAllManagers([
          {
            label: `Governance (${this.topology.governanceChain!.label})`,
            manager: governanceManager,
          },
          ...Array.from(additionalManagers).map(([label, manager]) => ({ label, manager })),
          {
            label: `Fellowship (${this.topology.fellowshipChain!.label})`,
            manager: fellowshipManager,
          },
        ]);
      }
    }
  }

  /**
   * Test a fellowship referendum whose proposal sends an XCM that ultimately executes on
   * a chain in a different consensus (across a bridge).
   *
   * Phase 1 scope (current): spawn both sides (Polkadot: relay + Collectives + AHP + BHP,
   * Kusama: relay + AHK + BHK), drive the fellowship referendum on Collectives, and run a
   * read-only BridgeConnector that decodes and reports any outbound bridge messages
   * emitted on BHP. NO Kusama-side delivery happens yet — that arrives in Phase 4.
   */
  async testFellowshipBridged(
    fellowshipReferendumId: number | undefined,
    mainReferendumId: number | undefined,
    cleanup: boolean,
    options: TestOptions,
    bridgeEndpoints: BridgeTopologyConfig
  ): Promise<void> {
    // The second-half AHK governance referendum runs either from a create-call (new
    // referendum) or from an existing referendum ID (`-r`). Either way it dispatches
    // the bridged whitelisted call; without it, only the bridge crossing is exercised.
    const runAhkPublicReferendum =
      !!options.callToCreateGovernanceReferendum || mainReferendumId !== undefined;
    const builder = new BridgeTopologyBuilder(this.logger, {
      ...bridgeEndpoints,
      injectFellowshipStorage:
        bridgeEndpoints.injectFellowshipStorage ?? !!options.callToCreateFellowshipReferendum,
      // Alice on AHK is only needed when *creating* a referendum (she signs notePreimage
      // + submit). An existing referendum is force-approved via storage, so no signer.
      injectAliceOnAssetHubKusama:
        bridgeEndpoints.injectAliceOnAssetHubKusama ?? !!options.callToCreateGovernanceReferendum,
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
    const clientsToDestroy: PolkadotClient[] = [];
    // Hoisted so the finally-block can tear down the bridge subscription + the
    // polkadot.js ApiPromise instances it owns, even if the bridge work throws.
    let bridgeConnector: BridgeConnector | null = null;

    try {
      for (const [key, ctx] of Object.entries(polkadotNetworks)) {
        const chain = await this.adoptBridgeChain(key, ctx as unknown as ChopsticksContext);
        polkadotChains[key] = chain;
        clientsToDestroy.push(chain.client);
      }
      for (const [key, ctx] of Object.entries(kusamaNetworks)) {
        const chain = await this.adoptBridgeChain(key, ctx as unknown as ChopsticksContext);
        kusamaChains[key] = chain;
        clientsToDestroy.push(chain.client);
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

      this.logger.section('Fellowship Referendum Simulation (Collectives)');
      await this.runner.fetchAndSimulate({
        api: polkadotSideForConnector.collectives.api,
        chopsticks: polkadotSideForConnector.collectives.manager,
        referendumId: fellowshipReferendumId,
        isFellowship: true,
        createCallHex: options.callToCreateFellowshipReferendum,
        createPreimageHex: options.callToNotePreimageForFellowshipReferendum,
        preCall: options.preCall,
        preOrigin: options.preOrigin,
        label: 'Fellowship',
      });

      const pumpRounds = options.bridgePumpRounds
        ? parseInt(options.bridgePumpRounds, 10)
        : undefined;
      bridgeConnector = new BridgeConnector(
        this.logger,
        polkadotSideForConnector,
        kusamaSideForConnector,
        pumpRounds !== undefined ? { maxRounds: pumpRounds } : undefined
      );
      const connector = bridgeConnector;

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

      // Second half of the full end-to-end scenario: now that the fellowship
      // referendum has bridged Whitelist.whitelist_call(hash) into AHK, run an AHK
      // public referendum on the WhitelistedCaller track whose proposal is
      // Whitelist.dispatch_whitelisted_call_with_preimage(call_X). Approval +
      // scheduler dispatch then actually executes call_X on AHK.
      if (runAhkPublicReferendum) {
        this.logger.section('Bridged-Target Public Referendum (AHK whitelistedcaller)');
        const ahkResult = await this.runner.fetchAndSimulate({
          api: kusamaSideForConnector.ahk.api,
          chopsticks: kusamaSideForConnector.ahk.manager,
          // Existing AHK governance referendum (`-r`), or undefined when creating one.
          referendumId: mainReferendumId,
          isFellowship: false,
          createCallHex: options.callToCreateGovernanceReferendum,
          createPreimageHex: options.callToNotePreimageForGovernanceReferendum,
          label: 'AHK Public',
        });

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

      for (const client of clientsToDestroy) {
        try {
          client.destroy();
        } catch {
          // ignore — best-effort
        }
      }

      const allManagers = [
        ...Object.entries(polkadotChains).map(([label, c]) => ({
          label: `Polkadot/${label} (${c.label})`,
          manager: c.manager,
        })),
        ...Object.entries(kusamaChains).map(([label, c]) => ({
          label: `Kusama/${label} (${c.label})`,
          manager: c.manager,
        })),
      ];

      if (cleanup) {
        await Promise.all(allManagers.map(({ manager }) => manager.cleanup()));
      } else {
        await this.pauseAllManagers(allManagers);
      }
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

  private async adoptBridgeChain(label: string, ctx: ChopsticksContext): Promise<BridgeChain> {
    const manager = ChopsticksManager.fromExistingContext(this.logger, ctx);
    const client = createPolkadotClient(manager.getContext().ws.endpoint);
    const api = createApiForChain(client);
    await manager.waitForChainReady(api);
    let chainLabel = label;
    try {
      const info = await getChainInfo(api, manager.getContext().ws.endpoint);
      chainLabel = info.label;
    } catch (error) {
      this.logger.debug(`Could not detect chain info for ${label}: ${(error as Error).message}`);
    }
    this.logger.info(`  ${label} ready: ${chainLabel} at ${manager.getContext().ws.endpoint}`);
    return { manager, api, client, label: chainLabel };
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

  private async setupInterconnectedChains(options?: TestOptions): Promise<{
    governanceManager: ChopsticksManager;
    fellowshipManager: ChopsticksManager;
    additionalManagers: Map<string, ChopsticksManager>;
  }> {
    if (!this.topology.governanceChain || !this.topology.fellowshipChain) {
      throw new Error('Chain types must be detected before setting up interconnected chains');
    }

    const { networkConfig, governanceKey, fellowshipKey } =
      this.topology.buildNetworkTopology(options);

    const { chainToNetworkKey } = this.topology.registerAdditionalChains(
      networkConfig,
      new Set([this.topology.governanceChain.endpoint, this.topology.fellowshipChain.endpoint]),
      this.topology.governanceChain.kind === 'relay',
      this.topology.fellowshipChain.kind === 'relay'
    );

    const networks = await setupNetworks(networkConfig as Parameters<typeof setupNetworks>[0]);

    const additionalManagers = new Map<string, ChopsticksManager>();
    for (const [chainLabel, networkKey] of chainToNetworkKey) {
      if (
        chainLabel === this.topology.governanceChain!.label ||
        chainLabel === this.topology.fellowshipChain?.label
      ) {
        this.logger.debug(
          `Skipping ${chainLabel} as it's already used as governance/fellowship chain`
        );
        continue;
      }

      this.logger.debug(
        `Adding additional chain manager: ${chainLabel} from network key: ${networkKey}`
      );
      additionalManagers.set(
        chainLabel,
        ChopsticksManager.fromExistingContext(
          this.logger,
          networks[networkKey] as unknown as ChopsticksContext
        )
      );
    }

    this.logger.debug(`Setup complete. Additional managers created: ${additionalManagers.size}`);
    if (additionalManagers.size > 0) {
      this.logger.info(
        `Additional chains connected: ${Array.from(additionalManagers.keys()).join(', ')}`
      );
    }

    return {
      governanceManager: ChopsticksManager.fromExistingContext(
        this.logger,
        networks[governanceKey] as unknown as ChopsticksContext
      ),
      fellowshipManager: ChopsticksManager.fromExistingContext(
        this.logger,
        networks[fellowshipKey] as unknown as ChopsticksContext
      ),
      additionalManagers,
    };
  }
}
