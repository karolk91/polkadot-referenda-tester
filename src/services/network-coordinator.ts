import { setupNetworks } from '@acala-network/chopsticks-testing';
import type { PolkadotClient } from 'polkadot-api';
import type { ChopsticksConfig, TestOptions } from '../types';
import type { SubstrateApi } from '../types/substrate-api';
import { displayChainEvents } from '../utils/event-serializer';
import type { Logger } from '../utils/logger';
import { createApiForChain, createPolkadotClient, getChainInfo } from './chain-registry';
import { ChainTopologyBuilder, type TopologyConfig } from './chain-topology-builder';
import { type ChopsticksContext, ChopsticksManager } from './chopsticks-manager';
import { ReferendaFetcher } from './referenda-fetcher';
import { ReferendumCreator } from './referendum-creator';
import { ReferendumSimulator } from './referendum-simulator';

export class NetworkCoordinator {
  private logger: Logger;
  private topology: ChainTopologyBuilder;

  constructor(logger: Logger, endpoints: TopologyConfig) {
    this.logger = logger;
    this.topology = new ChainTopologyBuilder(logger, endpoints);

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
    mainRefId: number | undefined,
    fellowshipRefId: number | undefined,
    cleanup: boolean = true,
    options?: TestOptions
  ): Promise<void> {
    // Determine if we're actually dealing with fellowship and/or main referendums
    const hasFellowship =
      fellowshipRefId !== undefined || !!options?.callToCreateFellowshipReferendum;
    const hasMain = mainRefId !== undefined || !!options?.callToCreateGovernanceReferendum;

    // Fellowship-only mode (no main referendum)
    if (!hasMain && hasFellowship) {
      if (!this.topology.getFellowshipEndpoint()) {
        throw new Error('Fellowship chain URL must be provided when testing fellowship referendum');
      }
      return this.testFellowshipOnly(fellowshipRefId, cleanup, options);
    }

    // Main referendum only (no fellowship)
    if (hasMain && !hasFellowship) {
      return this.testSingleReferendum(mainRefId, cleanup, options);
    }

    // Both main and fellowship referenda (either existing or being created)
    if (!hasFellowship || !hasMain) {
      throw new Error('Both referendum IDs must be provided or created for dual testing');
    }

    if (!this.topology.getFellowshipEndpoint()) {
      throw new Error('Fellowship chain URL must be provided when fellowship referendum ID is set');
    }

    if (!this.topology.getGovernanceEndpoint()) {
      throw new Error('Governance chain URL must be provided when testing both referenda');
    }

    // Detect chain types first
    await this.topology.detectChainTypes();

    this.logger.section('Setting Up Multi-Chain Environment');
    this.logger.info(`Governance Chain: ${this.topology.governanceChain!.label}`);
    this.logger.info(`Fellowship Chain: ${this.topology.fellowshipChain!.label}`);
    this.logger.info(`Fellowship Referendum: #${fellowshipRefId}`);
    this.logger.info(`Main Referendum: #${mainRefId}\n`);

    const sameEndpoint =
      this.topology.getGovernanceEndpoint() === this.topology.getFellowshipEndpoint() ||
      this.topology.governanceChain!.label === this.topology.fellowshipChain!.label;

    if (sameEndpoint) {
      return this.testSameChainWithFellowship(mainRefId, fellowshipRefId, options);
    }

    return this.testMultiChain(mainRefId, fellowshipRefId, cleanup, options);
  }

  private async testSingleReferendum(
    refId: number | undefined,
    cleanup: boolean,
    options?: TestOptions
  ): Promise<void> {
    if (!this.topology.getGovernanceEndpoint()) {
      throw new Error('Governance endpoint must be set for single referendum testing');
    }

    this.logger.startSpinner('Starting Chopsticks...');

    const chopsticks = new ChopsticksManager(this.logger);
    let client: PolkadotClient | null = null;

    try {
      const storageInjection = options?.callToCreateGovernanceReferendum
        ? ('alice-account' as const)
        : undefined;
      const config = this.topology.buildConfig(
        this.topology.getGovernanceEndpoint()!,
        this.topology.getGovernanceBlock(),
        storageInjection
      );

      const context = await chopsticks.setup(config as unknown as ChopsticksConfig);

      const endpoint = context.ws.endpoint;
      client = createPolkadotClient(endpoint);
      const api = createApiForChain(client);

      this.logger.succeedSpinner(`Chopsticks ready at ${endpoint}`);

      this.logger.startSpinner('Waiting for chain to be ready...');
      await chopsticks.waitForChainReady(api);
      this.logger.succeedSpinner('Chain is ready');

      this.topology.governanceChain = await getChainInfo(
        api,
        this.topology.getGovernanceEndpoint()!
      );
      this.logger.info(
        `Detected chain: ${this.topology.governanceChain.label} (${this.topology.governanceChain.specName})`
      );

      const createdId = await this.createReferendumIfNeeded(
        api,
        chopsticks,
        options?.callToCreateGovernanceReferendum,
        options?.callToNotePreimageForGovernanceReferendum,
        false
      );
      const actualRefId = createdId ?? refId;

      if (actualRefId === undefined) {
        throw new Error('Referendum ID is required but was not provided or created');
      }

      const fetcher = new ReferendaFetcher(this.logger);
      const referendum = await fetcher.fetchReferendum(api, actualRefId);

      if (!referendum) {
        throw new Error(`Failed to fetch referendum ${actualRefId}`);
      }

      const simulator = new ReferendumSimulator(this.logger, chopsticks, api, false);
      const result = await simulator.simulate(referendum, {
        preCall: options?.preCall,
        preOrigin: options?.preOrigin,
      });

      if (!result.executionSucceeded) {
        if (result.errors) {
          result.errors.forEach((err) => {
            this.logger.error(`  ${err}`);
          });
        }
        throw new Error(`Referendum #${actualRefId} execution failed`);
      }

      this.logger.success(`\n✓ Referendum #${actualRefId} executed successfully!`);
    } finally {
      if (client) {
        client.destroy();
      }
      if (cleanup) {
        await chopsticks.cleanup();
      } else {
        this.logger.info(`\nChopsticks instance still running for inspection`);
        this.logger.info('Press Ctrl+C to exit');
        await chopsticks.pause();
      }
    }
  }

  private async testFellowshipOnly(
    refId: number | undefined,
    cleanup: boolean = true,
    options?: TestOptions
  ): Promise<void> {
    if (!this.topology.getFellowshipEndpoint()) {
      throw new Error('Fellowship endpoint must be set for fellowship-only testing');
    }

    this.logger.startSpinner('Starting Chopsticks for fellowship chain...');

    const chopsticks = new ChopsticksManager(this.logger);
    let client: PolkadotClient | null = null;

    try {
      const config: Record<string, unknown> = {
        endpoint: this.topology.getFellowshipEndpoint(),
        'build-block-mode': 'manual',
      };

      if (this.topology.getFellowshipBlock() !== undefined) {
        config.block = this.topology.getFellowshipBlock();
      }

      // If creating fellowship referendum, inject storage for Alice to be a ranked fellow
      if (options?.callToCreateFellowshipReferendum) {
        config['import-storage'] = ReferendumCreator.getFellowshipStorageInjection();
        this.logger.debug('Injecting fellowship storage for Alice account');
      }

      const networkKey = await this.topology.detectRelayNetworkKey(
        this.topology.getFellowshipEndpoint()!
      );
      const context = await chopsticks.setup(config as unknown as ChopsticksConfig, networkKey);

      const endpoint = context.ws.endpoint;
      client = createPolkadotClient(endpoint);
      const api = createApiForChain(client);

      this.logger.succeedSpinner(`Chopsticks ready at ${endpoint}`);

      this.logger.startSpinner('Waiting for chain to be ready...');
      await chopsticks.waitForChainReady(api);
      this.logger.succeedSpinner('Chain is ready');

      this.topology.fellowshipChain = await getChainInfo(
        api,
        this.topology.getFellowshipEndpoint()!
      );
      this.logger.info(
        `Detected chain: ${this.topology.fellowshipChain.label} (${this.topology.fellowshipChain.specName})`
      );

      // Create referendum if needed
      const createdFellowshipId = await this.createReferendumIfNeeded(
        api,
        chopsticks,
        options?.callToCreateFellowshipReferendum,
        options?.callToNotePreimageForFellowshipReferendum,
        true
      );
      const fellowshipRefId = createdFellowshipId ?? refId;

      if (fellowshipRefId === undefined) {
        throw new Error('Fellowship referendum ID is required but was not provided or created');
      }

      const fetcher = new ReferendaFetcher(this.logger);
      const referendum = await fetcher.fetchReferendum(api, fellowshipRefId, true);

      if (!referendum) {
        throw new Error(`Failed to fetch fellowship referendum ${fellowshipRefId}`);
      }

      const simulator = new ReferendumSimulator(this.logger, chopsticks, api, true); // isFellowship = true
      const result = await simulator.simulate(referendum);

      if (!result.executionSucceeded) {
        if (result.errors) {
          result.errors.forEach((err) => {
            this.logger.error(`  ${err}`);
          });
        }
        throw new Error(`Fellowship referendum #${fellowshipRefId} execution failed`);
      }

      this.logger.success(`\n✓ Fellowship referendum #${fellowshipRefId} executed successfully!`);
    } finally {
      if (client) {
        client.destroy();
      }
      if (cleanup) {
        await chopsticks.cleanup();
      } else {
        this.logger.info(`\nChopsticks instance still running for inspection`);
        this.logger.info('Press Ctrl+C to exit');
        await chopsticks.pause();
      }
    }
  }

  private async testSameChainWithFellowship(
    mainRefId: number | undefined,
    fellowshipRefId: number | undefined,
    options?: TestOptions
  ): Promise<void> {
    this.logger.startSpinner('Starting shared chain...');

    const chopsticks = new ChopsticksManager(this.logger);
    let client: PolkadotClient | null = null;

    try {
      // Use governance endpoint if available, otherwise fellowship
      const chainEndpoint =
        this.topology.getGovernanceEndpoint() || this.topology.getFellowshipEndpoint();
      if (!chainEndpoint) {
        throw new Error('At least one chain endpoint must be provided');
      }

      const config: Record<string, unknown> = {
        endpoint: chainEndpoint,
        'build-block-mode': 'manual',
      };

      // Use governance block, or fellowship block if governance not specified
      const block = this.topology.getGovernanceBlock() ?? this.topology.getFellowshipBlock();
      if (block !== undefined) {
        config.block = block;
      }

      // If creating fellowship referendum on same chain, inject storage
      if (options?.callToCreateFellowshipReferendum) {
        config['import-storage'] = ReferendumCreator.getFellowshipStorageInjection();
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

      const createdFellowship = await this.createReferendumIfNeeded(
        api,
        chopsticks,
        options?.callToCreateFellowshipReferendum,
        options?.callToNotePreimageForFellowshipReferendum,
        true
      );
      const actualFellowshipRefId = createdFellowship ?? fellowshipRefId;

      const createdGovernance = await this.createReferendumIfNeeded(
        api,
        chopsticks,
        options?.callToCreateGovernanceReferendum,
        options?.callToNotePreimageForGovernanceReferendum,
        false
      );
      const actualMainRefId = createdGovernance ?? mainRefId;

      if (actualFellowshipRefId === undefined) {
        throw new Error('Fellowship referendum ID is required but was not provided or created');
      }

      if (actualMainRefId === undefined) {
        throw new Error('Main referendum ID is required but was not provided or created');
      }

      await this.simulateSequentialReferenda(
        api,
        chopsticks,
        actualFellowshipRefId,
        actualMainRefId
      );
    } finally {
      if (client) {
        client.destroy();
      }
      await chopsticks.cleanup();
    }
  }

  private async simulateSequentialReferenda(
    api: SubstrateApi,
    chopsticks: ChopsticksManager,
    fellowshipRefId: number,
    mainRefId: number
  ): Promise<void> {
    const fetcher = new ReferendaFetcher(this.logger);

    this.logger.section(`[1/2] Fellowship Referendum #${fellowshipRefId}`);
    const fellowshipRef = await fetcher.fetchReferendum(api, fellowshipRefId, true);
    if (!fellowshipRef) {
      throw new Error(`Failed to fetch fellowship referendum ${fellowshipRefId}`);
    }
    const fellowshipSimulator = new ReferendumSimulator(this.logger, chopsticks, api, true);
    const fellowshipResult = await fellowshipSimulator.simulate(fellowshipRef);
    if (!fellowshipResult.executionSucceeded) {
      throw new Error(`Fellowship referendum #${fellowshipRefId} execution failed`);
    }

    this.logger.section(`[2/2] Main Governance Referendum #${mainRefId}`);
    const mainRef = await fetcher.fetchReferendum(api, mainRefId);
    if (!mainRef) {
      throw new Error(`Failed to fetch main referendum ${mainRefId}`);
    }
    const mainSimulator = new ReferendumSimulator(this.logger, chopsticks, api, false);
    const mainResult = await mainSimulator.simulate(mainRef);
    if (!mainResult.executionSucceeded) {
      throw new Error(`Main referendum #${mainRefId} execution failed`);
    }

    this.logger.success('\n✓ Both referenda executed successfully!');
  }

  private async simulateMultiChainReferenda(chains: {
    fellowship: { api: SubstrateApi; chopsticks: ChopsticksManager; refId: number };
    governance: { api: SubstrateApi; chopsticks: ChopsticksManager; refId: number };
  }): Promise<void> {
    const { fellowship, governance } = chains;
    const fetcher = new ReferendaFetcher(this.logger);

    this.logger.section(
      `[1/2] Fellowship Referendum #${fellowship.refId} (${this.topology.fellowshipChain!.label})`
    );
    const fellowshipRef = await fetcher.fetchReferendum(fellowship.api, fellowship.refId, true);
    if (!fellowshipRef) {
      throw new Error(`Failed to fetch fellowship referendum ${fellowship.refId}`);
    }
    const fellowshipSimulator = new ReferendumSimulator(
      this.logger,
      fellowship.chopsticks,
      fellowship.api,
      true
    );
    const fellowshipResult = await fellowshipSimulator.simulate(fellowshipRef);

    if (!fellowshipResult.executionSucceeded) {
      if (fellowshipResult.errors) {
        fellowshipResult.errors.forEach((err) => {
          this.logger.error(`  ${err}`);
        });
      }
      throw new Error('Fellowship referendum execution failed');
    }

    this.logger.startSpinner('Waiting for XCM message propagation...');
    await fellowship.chopsticks.newBlock();
    await governance.chopsticks.newBlock();
    this.logger.succeedSpinner('XCM messages propagated');

    this.logger.section(
      `[2/2] Main Governance Referendum #${governance.refId} (${this.topology.governanceChain!.label})`
    );
    const mainRef = await fetcher.fetchReferendum(governance.api, governance.refId);
    if (!mainRef) {
      throw new Error(`Failed to fetch main referendum ${governance.refId}`);
    }
    const governanceSimulator = new ReferendumSimulator(
      this.logger,
      governance.chopsticks,
      governance.api
    );
    const mainResult = await governanceSimulator.simulate(mainRef);

    if (!mainResult.executionSucceeded) {
      if (mainResult.errors) {
        mainResult.errors.forEach((err) => {
          this.logger.error(`  ${err}`);
        });
      }
      throw new Error('Main referendum execution failed');
    }

    this.logger.success('\n✓ Both referenda executed successfully!');
  }

  private async testMultiChain(
    mainRefId: number | undefined,
    fellowshipRefId: number | undefined,
    cleanup: boolean = true,
    options?: TestOptions
  ): Promise<void> {
    const { governanceManager, fellowshipManager, additionalManagers } =
      await this.setupInterconnectedChains(options);

    const governanceEndpoint = governanceManager.getContext().ws.endpoint;
    const fellowshipEndpoint = fellowshipManager.getContext().ws.endpoint;

    this.logger.succeedSpinner('Networks ready');
    this.logger.info(`  Governance: ${governanceEndpoint}`);
    this.logger.info(`  Fellowship: ${fellowshipEndpoint}`);

    const governanceChopsticks = governanceManager;
    const fellowshipChopsticks = fellowshipManager;

    const governanceClient = createPolkadotClient(governanceEndpoint);
    const fellowshipClient = createPolkadotClient(fellowshipEndpoint);

    try {
      const governanceApi = createApiForChain(governanceClient);
      const fellowshipApi = createApiForChain(fellowshipClient);

      this.logger.startSpinner('Waiting for chains to be ready...');
      await governanceChopsticks.waitForChainReady(governanceApi);
      await fellowshipChopsticks.waitForChainReady(fellowshipApi);
      this.logger.succeedSpinner('Chains are ready');

      if (!this.topology.getGovernanceEndpoint() || !this.topology.getFellowshipEndpoint()) {
        throw new Error(
          'Both governance and fellowship endpoints must be set for multi-chain testing'
        );
      }

      this.topology.governanceChain = await getChainInfo(
        governanceApi,
        this.topology.getGovernanceEndpoint()!
      );
      this.topology.fellowshipChain = await getChainInfo(
        fellowshipApi,
        this.topology.getFellowshipEndpoint()!
      );
      this.logger.info(
        `Governance: ${this.topology.governanceChain.label} (${this.topology.governanceChain.specName})`
      );
      this.logger.info(
        `Fellowship: ${this.topology.fellowshipChain.label} (${this.topology.fellowshipChain.specName})`
      );

      const createdFellowship = await this.createReferendumIfNeeded(
        fellowshipApi,
        fellowshipChopsticks,
        options?.callToCreateFellowshipReferendum,
        options?.callToNotePreimageForFellowshipReferendum,
        true
      );
      const actualFellowshipRefId = createdFellowship ?? fellowshipRefId;

      const createdGovernance = await this.createReferendumIfNeeded(
        governanceApi,
        governanceChopsticks,
        options?.callToCreateGovernanceReferendum,
        options?.callToNotePreimageForGovernanceReferendum,
        false
      );
      const actualMainRefId = createdGovernance ?? mainRefId;

      if (actualFellowshipRefId === undefined) {
        throw new Error('Fellowship referendum ID is required but was not provided or created');
      }

      if (actualMainRefId === undefined) {
        throw new Error('Main referendum ID is required but was not provided or created');
      }

      await this.simulateMultiChainReferenda({
        fellowship: {
          api: fellowshipApi,
          chopsticks: fellowshipChopsticks,
          refId: actualFellowshipRefId,
        },
        governance: {
          api: governanceApi,
          chopsticks: governanceChopsticks,
          refId: actualMainRefId,
        },
      });

      await this.displayPostExecutionEvents({
        governance: { chopsticks: governanceChopsticks, api: governanceApi },
        fellowship: { chopsticks: fellowshipChopsticks, api: fellowshipApi },
        additionalManagers,
      });
    } finally {
      governanceClient.destroy();
      fellowshipClient.destroy();

      if (cleanup) {
        await governanceChopsticks.cleanup();
        await fellowshipChopsticks.cleanup();

        // Cleanup additional chains
        for (const manager of additionalManagers.values()) {
          await manager.cleanup();
        }
      } else {
        await this.pauseAllManagers([
          {
            label: `Governance (${this.topology.governanceChain!.label})`,
            manager: governanceChopsticks,
          },
          ...Array.from(additionalManagers).map(([label, manager]) => ({ label, manager })),
          {
            label: `Fellowship (${this.topology.fellowshipChain!.label})`,
            manager: fellowshipChopsticks,
          },
        ]);
      }
    }
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

    for (let i = 0; i < managers.length; i++) {
      const { label, manager } = managers[i];
      const isLast = i === managers.length - 1;
      try {
        const pausePromise = manager.pause();
        if (isLast) {
          await pausePromise;
        }
      } catch (error) {
        this.logger.warn(`Failed to pause ${label}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Quickly detect chain types by connecting temporarily to get runtime info.
   * This is needed before setting up the interconnected Chopsticks network.
   */
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

  private async createReferendumIfNeeded(
    api: SubstrateApi,
    chopsticks: ChopsticksManager,
    callHex: string | undefined,
    preimageHex: string | undefined,
    isFellowship: boolean
  ): Promise<number | undefined> {
    if (!callHex) return undefined;

    const label = isFellowship ? 'Fellowship' : 'Governance';
    this.logger.section(`Creating ${label} Referendum`);
    const creator = new ReferendumCreator(this.logger, chopsticks);
    const result = await creator.createReferendum(api, callHex, preimageHex, isFellowship);
    this.logger.success(`${label} referendum #${result.referendumId} created successfully`);
    return result.referendumId;
  }

  private async displayPostExecutionEvents(context: {
    governance: { chopsticks: ChopsticksManager; api: SubstrateApi };
    fellowship: { chopsticks: ChopsticksManager; api: SubstrateApi };
    additionalManagers: Map<string, ChopsticksManager>;
  }): Promise<void> {
    const { governance, fellowship, additionalManagers } = context;
    this.logger.section('Post-Execution XCM Events');
    this.logger.info('Advancing blocks to process XCM messages...\n');

    await governance.chopsticks.newBlock();
    await fellowship.chopsticks.newBlock();

    const governanceBlockNumber = await governance.api.query.System.Number.getValue();
    const governanceEventsPost = await governance.api.query.System.Events.getValue();
    displayChainEvents(
      this.topology.governanceChain!.label,
      governanceBlockNumber,
      governanceEventsPost,
      this.logger
    );
    this.logger.info('');

    const fellowshipBlockNumber = await fellowship.api.query.System.Number.getValue();
    const fellowshipEvents = await fellowship.api.query.System.Events.getValue();
    displayChainEvents(
      this.topology.fellowshipChain!.label,
      fellowshipBlockNumber,
      fellowshipEvents,
      this.logger
    );
    this.logger.info('');

    await this.collectAdditionalChainEvents(additionalManagers);
  }

  private async collectAdditionalChainEvents(
    additionalManagers: Map<string, ChopsticksManager>
  ): Promise<void> {
    this.logger.debug(
      `collectAdditionalChainEvents called with ${additionalManagers.size} managers`
    );

    if (additionalManagers.size === 0) {
      this.logger.debug('No additional chains to process');
      return;
    }

    this.logger.section('Additional Chain Events');
    this.logger.info(
      `Advancing blocks on ${additionalManagers.size} additional chains to process XCM messages...\n`
    );

    for (const [chainLabel, manager] of additionalManagers) {
      this.logger.debug(`Processing events for chain: ${chainLabel}`);
      try {
        // Create a new block to process any pending XCM messages
        await manager.newBlock();

        // Connect to the chain to read events
        const endpoint = manager.getContext().ws.endpoint;
        const client = createPolkadotClient(endpoint);

        try {
          const api = createApiForChain(client);

          const blockNumber = await api.query.System.Number.getValue();
          const events = await api.query.System.Events.getValue();

          displayChainEvents(chainLabel, blockNumber, events, this.logger);
        } finally {
          client.destroy();
        }

        this.logger.info('');
      } catch (error) {
        const err = error as Error;
        this.logger.error(`Error collecting events from ${chainLabel}: ${err.message}`);
        this.logger.debug(`Stack trace: ${err.stack}`);
      }
    }
  }
}
