import { Logger } from '../utils/logger';
import { ChopsticksManager } from './chopsticks-manager';
import { ReferendumSimulator } from './referendum-simulator';
import { ReferendaFetcher } from './referenda-fetcher';
import { ReferendumCreator } from './referendum-creator';
import { createClient } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws-provider/node';
import { withPolkadotSdkCompat } from 'polkadot-api/polkadot-sdk-compat';
import { setupNetworks } from '@acala-network/chopsticks-testing';
import { BuildBlockMode } from '@acala-network/chopsticks-core';
import * as path from 'path';
import { ChainInfo, ChainNetwork, getChainInfo, createApiForChain } from './chain-registry';
import { TestOptions } from '../types';
import { displayChainEvents } from '../utils/event-serializer';

interface CoordinatorConfig {
  governance?: string;
  governanceBlock?: number;
  fellowship?: string;
  fellowshipBlock?: number;
  additionalChains?: string[]; // Array of additional chain URLs
  additionalChainBlocks?: (number | undefined)[]; // Block numbers for each additional chain (parallel array)
}

export class NetworkCoordinator {
  private logger: Logger;
  private governanceEndpoint?: string;
  private governanceBlock?: number;
  private fellowshipEndpoint?: string;
  private fellowshipBlock?: number;
  private additionalEndpoints: string[];
  private additionalChainBlocks: (number | undefined)[];

  // Cached chain info (populated when we connect)
  private governanceChain?: ChainInfo;
  private fellowshipChain?: ChainInfo;
  private additionalChains: ChainInfo[] = [];

  constructor(logger: Logger, endpoints: CoordinatorConfig) {
    this.logger = logger;
    this.governanceEndpoint = endpoints.governance;
    this.governanceBlock = endpoints.governanceBlock;
    this.fellowshipEndpoint = endpoints.fellowship;
    this.fellowshipBlock = endpoints.fellowshipBlock;
    this.additionalEndpoints = endpoints.additionalChains || [];
    this.additionalChainBlocks = endpoints.additionalChainBlocks || [];

    // Log configuration
    this.logger.debug(`Additional chains configured: ${this.additionalEndpoints.length}`);
    if (this.additionalEndpoints.length > 0) {
      this.logger.info(`Additional chains to monitor: ${this.additionalEndpoints.length}`);
      this.additionalEndpoints.forEach((url, index) => {
        const block = this.additionalChainBlocks[index];
        this.logger.info(`  - ${url}${block ? ` @ block ${block}` : ''}`);
      });
    }

    // Log governance and fellowship blocks if specified
    if (this.governanceBlock) {
      this.logger.info(`Governance chain will fork at block ${this.governanceBlock}`);
    }
    if (this.fellowshipBlock) {
      this.logger.info(`Fellowship chain will fork at block ${this.fellowshipBlock}`);
    }
  }

  getGovernanceLabel(): string {
    return this.governanceChain?.label || 'unknown';
  }

  getFellowshipLabel(): string | undefined {
    return this.fellowshipChain?.label;
  }

  getNetwork(): ChainNetwork {
    return this.governanceChain?.network || 'unknown';
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
      if (!this.fellowshipEndpoint) {
        throw new Error('Fellowship chain URL must be provided when testing fellowship referendum');
      }
      return this.testFellowshipOnly(fellowshipRefId, cleanup, options);
    }

    // Main referendum only (no fellowship)
    if (hasMain && !hasFellowship) {
      return this.testSingleReferendum(mainRefId, options);
    }

    // Both main and fellowship referenda (either existing or being created)
    if (!hasFellowship || !hasMain) {
      throw new Error('Both referendum IDs must be provided or created for dual testing');
    }

    if (!this.fellowshipEndpoint) {
      throw new Error('Fellowship chain URL must be provided when fellowship referendum ID is set');
    }

    if (!this.governanceEndpoint) {
      throw new Error('Governance chain URL must be provided when testing both referenda');
    }

    // Detect chain types first
    await this.detectChainTypes();

    this.logger.section('Setting Up Multi-Chain Environment');
    this.logger.info(`Governance Chain: ${this.governanceChain!.label}`);
    this.logger.info(`Fellowship Chain: ${this.fellowshipChain!.label}`);
    this.logger.info(`Fellowship Referendum: #${fellowshipRefId}`);
    this.logger.info(`Main Referendum: #${mainRefId}\n`);

    const sameEndpoint =
      this.governanceEndpoint === this.fellowshipEndpoint ||
      this.governanceChain!.label === this.fellowshipChain!.label;

    if (sameEndpoint) {
      return this.testSameChainWithFellowship(mainRefId, fellowshipRefId, options);
    }

    return this.testMultiChain(mainRefId, fellowshipRefId, cleanup, options);
  }

  private async testSingleReferendum(
    refId: number | undefined,
    options?: TestOptions
  ): Promise<void> {
    if (!this.governanceEndpoint) {
      throw new Error('Governance endpoint must be set for single referendum testing');
    }

    this.logger.startSpinner('Starting Chopsticks...');

    const chopsticks = new ChopsticksManager(this.logger);
    let client: any;

    try {
      const config: any = {
        endpoint: this.governanceEndpoint,
        'build-block-mode': 'manual',
      };

      if (this.governanceBlock !== undefined) {
        config.block = this.governanceBlock;
      }

      const context = await chopsticks.setup(config);

      const endpoint = context.ws.endpoint;
      const wsProvider = getWsProvider(endpoint);
      client = createClient(withPolkadotSdkCompat(wsProvider));
      const api = createApiForChain(client);

      this.logger.succeedSpinner(`Chopsticks ready at ${endpoint}`);

      // Wait for chain to be ready
      this.logger.startSpinner('Waiting for chain to be ready...');
      await chopsticks.waitForChainReady(api);
      this.logger.succeedSpinner('Chain is ready');

      // Detect chain info from runtime
      this.governanceChain = await getChainInfo(api, this.governanceEndpoint);
      this.logger.info(
        `Detected chain: ${this.governanceChain.label} (${this.governanceChain.specName})`
      );

      // Create referendum if needed
      let actualRefId = refId;
      if (options?.callToCreateGovernanceReferendum) {
        this.logger.section('Creating Governance Referendum');
        const creator = new ReferendumCreator(this.logger, chopsticks);
        const creationResult = await creator.createReferendum(
          api,
          options.callToCreateGovernanceReferendum,
          options.callToNotePreimageForGovernanceReferendum,
          false // not fellowship
        );
        actualRefId = creationResult.referendumId;
        this.logger.success(`Governance referendum #${actualRefId} created successfully`);
      }

      if (!actualRefId) {
        throw new Error('Referendum ID is required but was not provided or created');
      }

      const fetcher = new ReferendaFetcher(this.logger);
      const referendum = await fetcher.fetchReferendum(api, actualRefId);

      if (!referendum) {
        throw new Error(`Failed to fetch referendum ${actualRefId}`);
      }

      const simulator = new ReferendumSimulator(this.logger, chopsticks, api, false); // Main governance
      const result = await simulator.simulate(referendum);

      if (!result.executionSucceeded) {
        throw new Error(`Referendum #${actualRefId} execution failed`);
      }
    } finally {
      if (client) {
        client.destroy();
      }
      await chopsticks.cleanup();
    }
  }

  private async testFellowshipOnly(
    refId: number | undefined,
    cleanup: boolean = true,
    options?: TestOptions
  ): Promise<void> {
    if (!this.fellowshipEndpoint) {
      throw new Error('Fellowship endpoint must be set for fellowship-only testing');
    }

    this.logger.startSpinner('Starting Chopsticks for fellowship chain...');

    const chopsticks = new ChopsticksManager(this.logger);
    let client: any;

    try {
      const config: any = {
        endpoint: this.fellowshipEndpoint,
        'build-block-mode': 'manual',
      };

      if (this.fellowshipBlock !== undefined) {
        config.block = this.fellowshipBlock;
      }

      // If creating fellowship referendum, inject storage for Alice to be a ranked fellow
      if (options?.callToCreateFellowshipReferendum) {
        config['import-storage'] = ReferendumCreator.getFellowshipStorageInjection();
        this.logger.debug('Injecting fellowship storage for Alice account');
      }

      const context = await chopsticks.setup(config);

      const endpoint = context.ws.endpoint;
      const wsProvider = getWsProvider(endpoint);
      client = createClient(withPolkadotSdkCompat(wsProvider));
      const api = createApiForChain(client);

      this.logger.succeedSpinner(`Chopsticks ready at ${endpoint}`);

      // Wait for chain to be ready
      this.logger.startSpinner('Waiting for chain to be ready...');
      await chopsticks.waitForChainReady(api);
      this.logger.succeedSpinner('Chain is ready');

      // Detect chain info from runtime
      this.fellowshipChain = await getChainInfo(api, this.fellowshipEndpoint);
      this.logger.info(
        `Detected chain: ${this.fellowshipChain.label} (${this.fellowshipChain.specName})`
      );

      // Create referendum if needed
      let fellowshipRefId = refId;
      if (options?.callToCreateFellowshipReferendum) {
        this.logger.section('Creating Fellowship Referendum');
        const creator = new ReferendumCreator(this.logger, chopsticks);
        const creationResult = await creator.createReferendum(
          api,
          options.callToCreateFellowshipReferendum,
          options.callToNotePreimageForFellowshipReferendum,
          true // isFellowship
        );
        fellowshipRefId = creationResult.referendumId;
        this.logger.success(`Fellowship referendum #${fellowshipRefId} created successfully`);
      }

      if (!fellowshipRefId) {
        throw new Error('Fellowship referendum ID is required but was not provided or created');
      }

      const fetcher = new ReferendaFetcher(this.logger);
      const referendum = await fetcher.fetchReferendum(api, fellowshipRefId, true); // true = isFellowship

      if (!referendum) {
        throw new Error(`Failed to fetch fellowship referendum ${fellowshipRefId}`);
      }

      const simulator = new ReferendumSimulator(this.logger, chopsticks, api, true); // isFellowship = true
      const result = await simulator.simulate(referendum);

      if (!result.executionSucceeded) {
        if (result.errors) {
          result.errors.forEach((err) => this.logger.error(`  ${err}`));
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
    let client: any;

    try {
      // Use governance endpoint if available, otherwise fellowship
      const chainEndpoint = this.governanceEndpoint || this.fellowshipEndpoint;
      if (!chainEndpoint) {
        throw new Error('At least one chain endpoint must be provided');
      }

      const config: any = {
        endpoint: chainEndpoint,
        'build-block-mode': 'manual',
      };

      // Use governance block, or fellowship block if governance not specified
      const block = this.governanceBlock ?? this.fellowshipBlock;
      if (block !== undefined) {
        config.block = block;
      }

      // If creating fellowship referendum on same chain, inject storage
      if (options?.callToCreateFellowshipReferendum) {
        config['import-storage'] = ReferendumCreator.getFellowshipStorageInjection();
        this.logger.debug('Injecting fellowship storage for Alice account');
      }

      const context = await chopsticks.setup(config);

      const endpoint = context.ws.endpoint;
      const wsProvider = getWsProvider(endpoint);
      client = createClient(withPolkadotSdkCompat(wsProvider));
      const api = createApiForChain(client);

      this.logger.succeedSpinner(`Chain ready at ${endpoint}`);

      // Wait for chain to be ready
      this.logger.startSpinner('Waiting for chain to be ready...');
      await chopsticks.waitForChainReady(api);
      this.logger.succeedSpinner('Chain is ready');

      // Detect chain info from runtime
      this.governanceChain = await getChainInfo(api, chainEndpoint);
      this.fellowshipChain = this.governanceChain; // Same chain
      this.logger.info(
        `Detected chain: ${this.governanceChain.label} (${this.governanceChain.specName})`
      );

      // Create fellowship referendum if needed
      let actualFellowshipRefId = fellowshipRefId;
      if (options?.callToCreateFellowshipReferendum) {
        this.logger.section('Creating Fellowship Referendum');
        const fellowshipCreator = new ReferendumCreator(this.logger, chopsticks);
        const fellowshipCreationResult = await fellowshipCreator.createReferendum(
          api,
          options.callToCreateFellowshipReferendum,
          options.callToNotePreimageForFellowshipReferendum,
          true // isFellowship
        );
        actualFellowshipRefId = fellowshipCreationResult.referendumId;
        this.logger.success(`Fellowship referendum #${actualFellowshipRefId} created successfully`);
      }

      // Create governance referendum if needed
      let actualMainRefId = mainRefId;
      if (options?.callToCreateGovernanceReferendum) {
        this.logger.section('Creating Governance Referendum');
        const governanceCreator = new ReferendumCreator(this.logger, chopsticks);
        const governanceCreationResult = await governanceCreator.createReferendum(
          api,
          options.callToCreateGovernanceReferendum,
          options.callToNotePreimageForGovernanceReferendum,
          false // not fellowship
        );
        actualMainRefId = governanceCreationResult.referendumId;
        this.logger.success(`Governance referendum #${actualMainRefId} created successfully`);
      }

      if (!actualFellowshipRefId) {
        throw new Error('Fellowship referendum ID is required but was not provided or created');
      }

      if (!actualMainRefId) {
        throw new Error('Main referendum ID is required but was not provided or created');
      }

      const fetcher = new ReferendaFetcher(this.logger);

      this.logger.section(`[1/2] Fellowship Referendum #${actualFellowshipRefId}`);
      const fellowshipRef = await fetcher.fetchReferendum(api, actualFellowshipRefId, true);
      if (!fellowshipRef) {
        throw new Error(`Failed to fetch fellowship referendum ${actualFellowshipRefId}`);
      }
      const fellowshipSimulator = new ReferendumSimulator(this.logger, chopsticks, api, true);
      const fellowshipResult = await fellowshipSimulator.simulate(fellowshipRef);
      if (!fellowshipResult.executionSucceeded) {
        throw new Error(`Fellowship referendum #${actualFellowshipRefId} execution failed`);
      }

      this.logger.section(`[2/2] Main Governance Referendum #${actualMainRefId}`);
      const mainRef = await fetcher.fetchReferendum(api, actualMainRefId);
      if (!mainRef) {
        throw new Error(`Failed to fetch main referendum ${actualMainRefId}`);
      }
      const mainSimulator = new ReferendumSimulator(this.logger, chopsticks, api, false);
      const mainResult = await mainSimulator.simulate(mainRef);
      if (!mainResult.executionSucceeded) {
        throw new Error(`Main referendum #${actualMainRefId} execution failed`);
      }

      this.logger.success('\n✓ Both referenda executed successfully!');
    } finally {
      if (client) {
        client.destroy();
      }
      await chopsticks.cleanup();
    }
  }

  private async testMultiChain(
    mainRefId: number | undefined,
    fellowshipRefId: number | undefined,
    cleanup: boolean = true,
    options?: TestOptions
  ): Promise<void> {
    // First, quickly detect chain types to set up topology
    await this.detectChainTypes();

    const { governanceManager, fellowshipManager, additionalManagers } =
      await this.setupInterconnectedChains(options);

    const governanceEndpoint = governanceManager.getContext().ws.endpoint;
    const fellowshipEndpoint = fellowshipManager.getContext().ws.endpoint;

    this.logger.succeedSpinner('Networks ready');
    this.logger.info(`  Governance: ${governanceEndpoint}`);
    this.logger.info(`  Fellowship: ${fellowshipEndpoint}`);

    const governanceChopsticks = governanceManager;
    const fellowshipChopsticks = fellowshipManager;

    const governanceClient = createClient(withPolkadotSdkCompat(getWsProvider(governanceEndpoint)));
    const fellowshipClient = createClient(withPolkadotSdkCompat(getWsProvider(fellowshipEndpoint)));

    try {
      const governanceApi = createApiForChain(governanceClient);
      const fellowshipApi = createApiForChain(fellowshipClient);

      // Wait for both chains to be ready
      this.logger.startSpinner('Waiting for chains to be ready...');
      await governanceChopsticks.waitForChainReady(governanceApi);
      await fellowshipChopsticks.waitForChainReady(fellowshipApi);
      this.logger.succeedSpinner('Chains are ready');

      // Validate endpoints are set (should be guaranteed by caller but TypeScript needs to know)
      if (!this.governanceEndpoint || !this.fellowshipEndpoint) {
        throw new Error(
          'Both governance and fellowship endpoints must be set for multi-chain testing'
        );
      }

      // Detect chain info from runtimes
      this.governanceChain = await getChainInfo(governanceApi, this.governanceEndpoint);
      this.fellowshipChain = await getChainInfo(fellowshipApi, this.fellowshipEndpoint);
      this.logger.info(
        `Governance: ${this.governanceChain.label} (${this.governanceChain.specName})`
      );
      this.logger.info(
        `Fellowship: ${this.fellowshipChain.label} (${this.fellowshipChain.specName})`
      );

      // Create fellowship referendum if needed
      let actualFellowshipRefId = fellowshipRefId;
      if (options?.callToCreateFellowshipReferendum) {
        this.logger.section('Creating Fellowship Referendum');
        const fellowshipCreator = new ReferendumCreator(this.logger, fellowshipChopsticks);
        const fellowshipCreationResult = await fellowshipCreator.createReferendum(
          fellowshipApi,
          options.callToCreateFellowshipReferendum,
          options.callToNotePreimageForFellowshipReferendum,
          true // isFellowship
        );
        actualFellowshipRefId = fellowshipCreationResult.referendumId;
        this.logger.success(`Fellowship referendum #${actualFellowshipRefId} created successfully`);
      }

      // Create governance referendum if needed
      let actualMainRefId = mainRefId;
      if (options?.callToCreateGovernanceReferendum) {
        this.logger.section('Creating Governance Referendum');
        const governanceCreator = new ReferendumCreator(this.logger, governanceChopsticks);
        const governanceCreationResult = await governanceCreator.createReferendum(
          governanceApi,
          options.callToCreateGovernanceReferendum,
          options.callToNotePreimageForGovernanceReferendum,
          false // not fellowship
        );
        actualMainRefId = governanceCreationResult.referendumId;
        this.logger.success(`Governance referendum #${actualMainRefId} created successfully`);
      }

      if (!actualFellowshipRefId) {
        throw new Error('Fellowship referendum ID is required but was not provided or created');
      }

      if (!actualMainRefId) {
        throw new Error('Main referendum ID is required but was not provided or created');
      }

      const fetcher = new ReferendaFetcher(this.logger);

      this.logger.section(
        `[1/2] Fellowship Referendum #${actualFellowshipRefId} (${this.fellowshipChain!.label})`
      );
      const fellowshipRef = await fetcher.fetchReferendum(
        fellowshipApi,
        actualFellowshipRefId,
        true
      );
      if (!fellowshipRef) {
        throw new Error(`Failed to fetch fellowship referendum ${actualFellowshipRefId}`);
      }
      const fellowshipSimulator = new ReferendumSimulator(
        this.logger,
        fellowshipChopsticks,
        fellowshipApi,
        true // isFellowship = true
      );
      const fellowshipResult = await fellowshipSimulator.simulate(fellowshipRef);

      if (!fellowshipResult.executionSucceeded) {
        if (fellowshipResult.errors) {
          fellowshipResult.errors.forEach((err) => this.logger.error(`  ${err}`));
        }
        throw new Error('Fellowship referendum execution failed');
      }

      this.logger.startSpinner('Waiting for XCM message propagation...');
      await fellowshipChopsticks.newBlock();
      await governanceChopsticks.newBlock();

      this.logger.succeedSpinner('XCM messages propagated');

      this.logger.section(
        `[2/2] Main Governance Referendum #${actualMainRefId} (${this.governanceChain.label})`
      );
      const mainRef = await fetcher.fetchReferendum(governanceApi, actualMainRefId);
      if (!mainRef) {
        throw new Error(`Failed to fetch main referendum ${actualMainRefId}`);
      }
      const governanceSimulator = new ReferendumSimulator(
        this.logger,
        governanceChopsticks,
        governanceApi
      );
      const mainResult = await governanceSimulator.simulate(mainRef);

      if (!mainResult.executionSucceeded) {
        if (mainResult.errors) {
          mainResult.errors.forEach((err) => this.logger.error(`  ${err}`));
        }
        throw new Error('Main referendum execution failed');
      }

      this.logger.success('\n✓ Both referenda executed successfully!');

      // Process XCM messages from governance to fellowship chain
      this.logger.section('Post-Execution XCM Events');
      this.logger.info('Advancing blocks to process XCM messages...\n');

      await governanceChopsticks.newBlock();
      await fellowshipChopsticks.newBlock();

      // Display governance chain events (in case fellowship sent XCM back)
      const governanceBlockNumber = await governanceApi.query.System.Number.getValue();
      const governanceEventsPost = await governanceApi.query.System.Events.getValue();

      displayChainEvents(
        this.governanceChain.label,
        governanceBlockNumber,
        governanceEventsPost,
        this.logger
      );
      this.logger.info('');

      // Display fellowship chain events (to see XCM from governance)
      const fellowshipBlockNumber = await fellowshipApi.query.System.Number.getValue();
      const fellowshipEvents = await fellowshipApi.query.System.Events.getValue();

      displayChainEvents(
        this.fellowshipChain.label,
        fellowshipBlockNumber,
        fellowshipEvents,
        this.logger
      );
      this.logger.info('');

      // Collect events from additional chains
      await this.collectAdditionalChainEvents(additionalManagers);
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
        // Pause networks so user can examine them
        this.logger.info('\n' + '='.repeat(70));
        this.logger.info('Chopsticks networks are paused for manual examination');
        const governancePort = governanceChopsticks.getContext().chain.port;
        const fellowshipPort = fellowshipChopsticks.getContext().chain.port;
        this.logger.info(`  Governance: ${this.governanceChain!.label} on port ${governancePort}`);
        this.logger.info(`  Fellowship: ${this.fellowshipChain!.label} on port ${fellowshipPort}`);

        if (additionalManagers.size > 0) {
          this.logger.info('  Additional chains:');
          for (const [label, manager] of additionalManagers) {
            const context = manager.getContext();
            const port = context?.chain?.port ?? 'unknown';
            this.logger.info(`    • ${label} on port ${port}`);
          }
        }

        this.logger.info('Press Ctrl+C to exit');
        this.logger.info('='.repeat(70));

        const pauseWithSafety = async (
          label: string,
          manager: ChopsticksManager,
          awaitResult: boolean
        ) => {
          try {
            const pausePromise = manager.pause();
            if (awaitResult) {
              await pausePromise;
            }
          } catch (error) {
            const err = error as Error;
            this.logger.warn(`Failed to pause ${label}: ${err.message}`);
          }
        };

        const managersInOrder: Array<{ label: string; manager: ChopsticksManager }> = [
          { label: 'governance', manager: governanceChopsticks },
          ...Array.from(additionalManagers).map(([label, manager]) => ({ label, manager })),
          { label: 'fellowship', manager: fellowshipChopsticks },
        ];

        for (let index = 0; index < managersInOrder.length; index++) {
          const { label, manager } = managersInOrder[index];
          const isLast = index === managersInOrder.length - 1;
          const pauseTask = pauseWithSafety(label, manager, isLast);
          if (isLast) {
            await pauseTask;
          }
        }
      }
    }
  }

  /**
   * Quickly detect chain types by connecting temporarily to get runtime info.
   * This is needed before setting up the interconnected Chopsticks network.
   */
  private async detectChainTypes(): Promise<void> {
    this.logger.startSpinner('Detecting chain types...');

    const clients: any[] = [];
    try {
      // Detect governance chain if provided
      if (this.governanceEndpoint) {
        const govClient = createClient(
          withPolkadotSdkCompat(getWsProvider(this.governanceEndpoint))
        );
        clients.push(govClient);
        const govApi = createApiForChain(govClient);
        this.governanceChain = await getChainInfo(govApi, this.governanceEndpoint);
      }

      // Detect fellowship chain if provided
      if (this.fellowshipEndpoint) {
        const fellClient = createClient(
          withPolkadotSdkCompat(getWsProvider(this.fellowshipEndpoint))
        );
        clients.push(fellClient);
        const fellApi = createApiForChain(fellClient);
        this.fellowshipChain = await getChainInfo(fellApi, this.fellowshipEndpoint);
      }

      // Detect additional chains
      for (const endpoint of this.additionalEndpoints) {
        const client = createClient(withPolkadotSdkCompat(getWsProvider(endpoint)));
        clients.push(client);
        const api = createApiForChain(client);
        const chainInfo = await getChainInfo(api, endpoint);
        this.additionalChains.push(chainInfo);
      }

      this.logger.succeedSpinner('Chain types detected');
      if (this.governanceChain) {
        this.logger.info(
          `Governance: ${this.governanceChain.label} (${this.governanceChain.kind})`
        );
      }
      if (this.fellowshipChain) {
        this.logger.info(
          `Fellowship: ${this.fellowshipChain.label} (${this.fellowshipChain.kind})`
        );
      }
    } finally {
      // Close all temp connections
      clients.forEach((client) => client.destroy());
    }
  }

  private async setupInterconnectedChains(options?: TestOptions): Promise<{
    governanceManager: ChopsticksManager;
    fellowshipManager: ChopsticksManager;
    additionalManagers: Map<string, ChopsticksManager>;
  }> {
    // Chain info should be populated by detectChainTypes() before calling this
    if (!this.governanceChain || !this.fellowshipChain) {
      throw new Error('Chain types must be detected before setting up interconnected chains');
    }

    const governanceIsRelay = this.governanceChain.kind === 'relay';
    const fellowshipIsRelay = this.fellowshipChain.kind === 'relay';

    // Build network config including additional chains
    const networkConfig: Record<string, any> = {};
    let governanceKey: string;
    let fellowshipKey: string;

    // Determine what storage injections are needed
    const fellowshipInjection = options?.callToCreateFellowshipReferendum
      ? 'fellowship' as const
      : undefined;
    const governanceInjection = options?.callToCreateGovernanceReferendum
      ? 'alice-account' as const
      : undefined;

    // Handle different chain configurations
    if (!governanceIsRelay && !fellowshipIsRelay) {
      // Both are parachains - set them up independently without a relay chain
      governanceKey = 'governance';
      fellowshipKey = 'fellowship';
      networkConfig[governanceKey] = this.buildConfig(
        this.governanceChain.endpoint,
        this.governanceBlock,
        governanceInjection
      );
      networkConfig[fellowshipKey] = this.buildConfig(
        this.fellowshipChain.endpoint,
        this.fellowshipBlock,
        fellowshipInjection
      );
    } else {
      // At least one is a relay chain - use traditional relay/parachain setup
      const relayChain = governanceIsRelay ? this.governanceChain : this.fellowshipChain;
      const parachain = governanceIsRelay ? this.fellowshipChain : this.governanceChain;

      // Determine which block numbers to use
      const relayBlock = governanceIsRelay ? this.governanceBlock : this.fellowshipBlock;
      const parachainBlock = governanceIsRelay ? this.fellowshipBlock : this.governanceBlock;

      const relayKey = this.getRelayKey(relayChain.network);
      const parachainKey = governanceIsRelay ? 'fellowship' : 'governance';

      governanceKey = governanceIsRelay ? relayKey : parachainKey;
      fellowshipKey = fellowshipIsRelay ? relayKey : parachainKey;

      // Determine storage injection for each chain in the relay/parachain pair
      const relayInjection = governanceIsRelay ? governanceInjection : fellowshipInjection;
      const parachainInjection = governanceIsRelay ? fellowshipInjection : governanceInjection;

      networkConfig[relayKey] = this.buildConfig(relayChain.endpoint, relayBlock, relayInjection);
      networkConfig[parachainKey] = this.buildConfig(
        parachain.endpoint,
        parachainBlock,
        parachainInjection
      );
    }

    // Track which endpoints are already in the network and map chains to their network keys
    const usedEndpoints = new Set([this.governanceChain.endpoint, this.fellowshipChain.endpoint]);
    const chainToNetworkKey = new Map<string, string>();

    // Add additional chains to the network (skip duplicates)
    // Track used relay keys to avoid conflicts when multiple relay chains are added
    const usedRelayKeys = new Set<string>();
    // Collect relay keys already used by governance/fellowship
    if (governanceIsRelay) {
      usedRelayKeys.add(this.getRelayKey(this.governanceChain.network));
    }
    if (fellowshipIsRelay) {
      usedRelayKeys.add(this.getRelayKey(this.fellowshipChain.network));
    }

    this.additionalChains.forEach((chain, index) => {
      if (usedEndpoints.has(chain.endpoint)) {
        this.logger.debug(`Skipping duplicate endpoint for ${chain.label}: ${chain.endpoint}`);
        return;
      }

      let key: string;
      if (chain.kind === 'relay') {
        // Relay chains must use their network-specific key for chopsticks to recognize them
        const relayKey = this.getRelayKey(chain.network);
        if (usedRelayKeys.has(relayKey)) {
          this.logger.warn(
            `Skipping relay chain ${chain.label}: relay key '${relayKey}' is already in use`
          );
          return;
        }
        key = relayKey;
        usedRelayKeys.add(relayKey);
      } else {
        key = `additional_${index}`;
      }

      const block = this.additionalChainBlocks[index];
      networkConfig[key] = this.buildConfig(chain.endpoint, block);
      usedEndpoints.add(chain.endpoint);
      chainToNetworkKey.set(chain.label, key);
      this.logger.debug(
        `Adding ${chain.label} (${chain.kind}) to network config with key: ${key}${block ? ` at block ${block}` : ''}`
      );
    });

    const networks = await setupNetworks(networkConfig);

    const governanceContext = networks[governanceKey];
    const fellowshipContext = networks[fellowshipKey];

    // Collect additional chain managers (excluding governance and fellowship)
    const additionalManagers = new Map<string, ChopsticksManager>();
    for (const [chainLabel, networkKey] of chainToNetworkKey) {
      // Skip if this chain is already used as governance or fellowship
      if (
        chainLabel === this.governanceChain!.label ||
        chainLabel === this.fellowshipChain?.label
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
        ChopsticksManager.fromExistingContext(this.logger, networks[networkKey])
      );
    }

    this.logger.debug(`Setup complete. Additional managers created: ${additionalManagers.size}`);
    if (additionalManagers.size > 0) {
      this.logger.info(
        `Additional chains connected: ${Array.from(additionalManagers.keys()).join(', ')}`
      );
    }

    return {
      governanceManager: ChopsticksManager.fromExistingContext(this.logger, governanceContext),
      fellowshipManager: ChopsticksManager.fromExistingContext(this.logger, fellowshipContext),
      additionalManagers,
    };
  }

  private buildConfig(
    endpoint: string,
    block?: number,
    storageInjection?: 'fellowship' | 'alice-account'
  ) {
    const config: any = {
      endpoint,
      db: path.join(process.cwd(), '.chopsticks-db'),
      'build-block-mode': BuildBlockMode.Manual,
      'mock-signature-host': true,
      'allow-unresolved-imports': true,
      'runtime-log-level': 0,
    };

    // Add block parameter if specified
    if (block !== undefined) {
      config.block = block;
    }

    // Inject storage if needed
    if (storageInjection === 'fellowship') {
      config['import-storage'] = ReferendumCreator.getFellowshipStorageInjection();
      this.logger.debug('Injecting fellowship storage for Alice account');
    } else if (storageInjection === 'alice-account') {
      config['import-storage'] = ReferendumCreator.getAliceAccountInjection();
      this.logger.debug('Injecting Alice account with funds');
    }

    return config;
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
        const wsProvider = getWsProvider(endpoint);
        const client = createClient(withPolkadotSdkCompat(wsProvider));

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

  private getRelayKey(network: ChainNetwork): string {
    if (network === 'polkadot') {
      return 'polkadot';
    }
    if (network === 'kusama') {
      return 'kusama';
    }
    return 'relay';
  }
}
