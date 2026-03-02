import { setupNetworks } from '@acala-network/chopsticks-testing';
import type { PolkadotClient } from 'polkadot-api';
import type { ChopsticksConfig, SimulationResult, TestOptions } from '../types';
import type { SubstrateApi } from '../types/substrate-api';
import { displayChainEvents } from '../utils/event-serializer';
import type { Logger } from '../utils/logger';
import { createApiForChain, createPolkadotClient, getChainInfo } from './chain-registry';
import { ChainTopologyBuilder, type TopologyConfig } from './chain-topology-builder';
import { type ChopsticksContext, ChopsticksManager } from './chopsticks-manager';
import { ReferendaFetcher } from './referenda-fetcher';
import { ReferendumCreator } from './referendum-creator';
import { ReferendumSimulator } from './referendum-simulator';

interface CreateReferendumParams {
  api: SubstrateApi;
  chopsticks: ChopsticksManager;
  callHex: string | undefined;
  preimageHex: string | undefined;
  isFellowship: boolean;
}

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

  private throwIfFailed(result: SimulationResult, label: string): void {
    if (!result.executionSucceeded) {
      if (result.errors) {
        for (const errorMessage of result.errors) {
          this.logger.error(`  ${errorMessage}`);
        }
      }
      throw new Error(`${label} execution failed`);
    }
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

      const createdId = await this.createReferendumIfNeeded({
        api,
        chopsticks,
        callHex: config.createCallHex,
        preimageHex: config.createPreimageHex,
        isFellowship: config.isFellowship,
      });
      const actualReferendumId = createdId ?? config.referendumId;

      if (actualReferendumId === undefined) {
        throw new Error(`${label} referendum ID is required but was not provided or created`);
      }

      const fetcher = new ReferendaFetcher(this.logger);
      const referendum = await fetcher.fetchReferendum(
        api,
        actualReferendumId,
        config.isFellowship
      );

      if (!referendum) {
        throw new Error(`Failed to fetch ${label.toLowerCase()} referendum ${actualReferendumId}`);
      }

      const simulator = new ReferendumSimulator(this.logger, chopsticks, api, config.isFellowship);
      const result = await simulator.simulate(referendum, {
        preCall: config.options?.preCall,
        preOrigin: config.options?.preOrigin,
      });

      this.throwIfFailed(result, `${label} referendum #${actualReferendumId}`);
      this.logger.success(`\n✓ ${label} referendum #${actualReferendumId} executed successfully!`);
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
      chopsticksConfig['import-storage'] = ReferendumCreator.getFellowshipStorageInjection();
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

      const createdFellowship = await this.createReferendumIfNeeded({
        api,
        chopsticks,
        callHex: options?.callToCreateFellowshipReferendum,
        preimageHex: options?.callToNotePreimageForFellowshipReferendum,
        isFellowship: true,
      });
      const actualFellowshipId = createdFellowship ?? fellowshipReferendumId;

      const createdGovernance = await this.createReferendumIfNeeded({
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

      await this.simulateSequentialReferenda(api, chopsticks, actualFellowshipId, actualMainId);
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
    fellowshipReferendumId: number,
    mainReferendumId: number
  ): Promise<void> {
    const fetcher = new ReferendaFetcher(this.logger);

    this.logger.section(`[1/2] Fellowship Referendum #${fellowshipReferendumId}`);
    const fellowshipRef = await fetcher.fetchReferendum(api, fellowshipReferendumId, true);
    if (!fellowshipRef) {
      throw new Error(`Failed to fetch fellowship referendum ${fellowshipReferendumId}`);
    }
    const fellowshipSimulator = new ReferendumSimulator(this.logger, chopsticks, api, true);
    const fellowshipResult = await fellowshipSimulator.simulate(fellowshipRef);
    this.throwIfFailed(fellowshipResult, `Fellowship referendum #${fellowshipReferendumId}`);

    this.logger.section(`[2/2] Main Governance Referendum #${mainReferendumId}`);
    const mainRef = await fetcher.fetchReferendum(api, mainReferendumId);
    if (!mainRef) {
      throw new Error(`Failed to fetch main referendum ${mainReferendumId}`);
    }
    const mainSimulator = new ReferendumSimulator(this.logger, chopsticks, api, false);
    const mainResult = await mainSimulator.simulate(mainRef);
    this.throwIfFailed(mainResult, `Main referendum #${mainReferendumId}`);

    this.logger.success('\n✓ Both referenda executed successfully!');
  }

  private async simulateMultiChainReferenda(chains: {
    fellowship: { api: SubstrateApi; chopsticks: ChopsticksManager; referendumId: number };
    governance: { api: SubstrateApi; chopsticks: ChopsticksManager; referendumId: number };
  }): Promise<void> {
    const { fellowship, governance } = chains;
    const fetcher = new ReferendaFetcher(this.logger);

    this.logger.section(
      `[1/2] Fellowship Referendum #${fellowship.referendumId} (${this.topology.fellowshipChain!.label})`
    );
    const fellowshipRef = await fetcher.fetchReferendum(
      fellowship.api,
      fellowship.referendumId,
      true
    );
    if (!fellowshipRef) {
      throw new Error(`Failed to fetch fellowship referendum ${fellowship.referendumId}`);
    }
    const fellowshipSimulator = new ReferendumSimulator(
      this.logger,
      fellowship.chopsticks,
      fellowship.api,
      true
    );
    const fellowshipResult = await fellowshipSimulator.simulate(fellowshipRef);
    this.throwIfFailed(fellowshipResult, `Fellowship referendum #${fellowship.referendumId}`);

    this.logger.startSpinner('Waiting for XCM message propagation...');
    await fellowship.chopsticks.newBlock();
    await governance.chopsticks.newBlock();
    this.logger.succeedSpinner('XCM messages propagated');

    this.logger.section(
      `[2/2] Main Governance Referendum #${governance.referendumId} (${this.topology.governanceChain!.label})`
    );
    const mainRef = await fetcher.fetchReferendum(governance.api, governance.referendumId);
    if (!mainRef) {
      throw new Error(`Failed to fetch main referendum ${governance.referendumId}`);
    }
    const governanceSimulator = new ReferendumSimulator(
      this.logger,
      governance.chopsticks,
      governance.api
    );
    const mainResult = await governanceSimulator.simulate(mainRef);
    this.throwIfFailed(mainResult, `Main referendum #${governance.referendumId}`);

    this.logger.success('\n✓ Both referenda executed successfully!');
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

      const createdFellowship = await this.createReferendumIfNeeded({
        api: fellowshipApi,
        chopsticks: fellowshipManager,
        callHex: options?.callToCreateFellowshipReferendum,
        preimageHex: options?.callToNotePreimageForFellowshipReferendum,
        isFellowship: true,
      });
      const actualFellowshipId = createdFellowship ?? fellowshipReferendumId;

      const createdGovernance = await this.createReferendumIfNeeded({
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

      await this.simulateMultiChainReferenda({
        fellowship: {
          api: fellowshipApi,
          chopsticks: fellowshipManager,
          referendumId: actualFellowshipId,
        },
        governance: {
          api: governanceApi,
          chopsticks: governanceManager,
          referendumId: actualMainId,
        },
      });

      await this.displayPostExecutionEvents({
        governance: { chopsticks: governanceManager, api: governanceApi },
        fellowship: { chopsticks: fellowshipManager, api: fellowshipApi },
        additionalManagers,
      });
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

  private async createReferendumIfNeeded(
    params: CreateReferendumParams
  ): Promise<number | undefined> {
    if (!params.callHex) return undefined;

    const label = params.isFellowship ? 'Fellowship' : 'Governance';
    this.logger.section(`Creating ${label} Referendum`);
    const creator = new ReferendumCreator(this.logger, params.chopsticks);
    const result = await creator.createReferendum(
      params.api,
      params.callHex,
      params.preimageHex,
      params.isFellowship
    );
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

    await Promise.all([governance.chopsticks.newBlock(), fellowship.chopsticks.newBlock()]);

    const [
      [governanceBlockNumber, governanceEventsPost],
      [fellowshipBlockNumber, fellowshipEvents],
    ] = await Promise.all([
      Promise.all([
        governance.api.query.System.Number.getValue(),
        governance.api.query.System.Events.getValue(),
      ]),
      Promise.all([
        fellowship.api.query.System.Number.getValue(),
        fellowship.api.query.System.Events.getValue(),
      ]),
    ]);

    displayChainEvents(
      this.topology.governanceChain!.label,
      governanceBlockNumber,
      governanceEventsPost,
      this.logger
    );
    this.logger.info('');

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
        await manager.newBlock();

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
        const chainError = error as Error;
        this.logger.error(`Error collecting events from ${chainLabel}: ${chainError.message}`);
        this.logger.debug(`Stack trace: ${chainError.stack}`);
      }
    }
  }
}
