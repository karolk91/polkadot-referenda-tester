import { Logger } from '../utils/logger';
import { ChopsticksManager } from './chopsticks-manager';
import { ReferendumSimulator } from './referendum-simulator';
import { ReferendaFetcher } from './referenda-fetcher';
import { createClient } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws-provider/node';
import { withPolkadotSdkCompat } from 'polkadot-api/polkadot-sdk-compat';
import { setupNetworks } from '@acala-network/chopsticks-testing';
import { BuildBlockMode } from '@acala-network/chopsticks-core';
import * as path from 'path';
import { ChainInfo, ChainNetwork, getChainInfo, createApiForChain } from './chain-registry';

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
    _basePort: number,
    cleanup: boolean = true
  ): Promise<void> {
    // Fellowship-only mode (no main referendum)
    if (!mainRefId && fellowshipRefId) {
      if (!this.fellowshipEndpoint) {
        throw new Error('Fellowship chain URL must be provided when testing fellowship referendum');
      }
      return this.testFellowshipOnly(fellowshipRefId, _basePort, cleanup);
    }

    // Main referendum only (no fellowship)
    if (mainRefId && !fellowshipRefId) {
      return this.testSingleReferendum(mainRefId, _basePort);
    }

    // Both main and fellowship referenda
    if (!fellowshipRefId || !mainRefId) {
      throw new Error('Both referendum IDs must be provided for dual testing');
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
      return this.testSameChainWithFellowship(mainRefId, fellowshipRefId);
    }

    if (this.governanceChain!.kind !== 'relay' && this.fellowshipChain!.kind !== 'relay') {
      throw new Error('At least one of governance or fellowship chains must be a relay chain');
    }

    return this.testMultiChain(mainRefId, fellowshipRefId, cleanup);
  }

  private async testSingleReferendum(refId: number, _port: number): Promise<void> {
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

      const fetcher = new ReferendaFetcher(this.logger);
      const referendum = await fetcher.fetchReferendum(api, refId);

      if (!referendum) {
        throw new Error(`Failed to fetch referendum ${refId}`);
      }

      const simulator = new ReferendumSimulator(this.logger, chopsticks, api, false); // Main governance
      const result = await simulator.simulate(referendum);

      if (!result.executionSucceeded) {
        throw new Error(`Referendum #${refId} execution failed`);
      }
    } finally {
      if (client) {
        client.destroy();
      }
      await chopsticks.cleanup();
    }
  }

  private async testFellowshipOnly(refId: number, _port: number, cleanup: boolean = true): Promise<void> {
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

      const fetcher = new ReferendaFetcher(this.logger);
      const referendum = await fetcher.fetchReferendum(api, refId, true); // true = isFellowship

      if (!referendum) {
        throw new Error(`Failed to fetch fellowship referendum ${refId}`);
      }

      const simulator = new ReferendumSimulator(this.logger, chopsticks, api, true); // isFellowship = true
      const result = await simulator.simulate(referendum);

      if (!result.executionSucceeded) {
        if (result.errors) {
          result.errors.forEach((err) => this.logger.error(`  ${err}`));
        }
        throw new Error(`Fellowship referendum #${refId} execution failed`);
      }

      this.logger.success(`\n✓ Fellowship referendum #${refId} executed successfully!`);
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
    mainRefId: number,
    fellowshipRefId: number
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
    } finally {
      if (client) {
        client.destroy();
      }
      await chopsticks.cleanup();
    }
  }

  private async testMultiChain(
    mainRefId: number,
    fellowshipRefId: number,
    cleanup: boolean = true
  ): Promise<void> {
    // First, quickly detect chain types to set up topology
    await this.detectChainTypes();

    const { governanceManager, fellowshipManager, additionalManagers } =
      await this.setupInterconnectedChains();

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
        throw new Error('Both governance and fellowship endpoints must be set for multi-chain testing');
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

      const fetcher = new ReferendaFetcher(this.logger);

      this.logger.section(
        `[1/2] Fellowship Referendum #${fellowshipRefId} (${this.fellowshipChain!.label})`
      );
      const fellowshipRef = await fetcher.fetchReferendum(fellowshipApi, fellowshipRefId, true);
      if (!fellowshipRef) {
        throw new Error(`Failed to fetch fellowship referendum ${fellowshipRefId}`);
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
        `[2/2] Main Governance Referendum #${mainRefId} (${this.governanceChain.label})`
      );
      const mainRef = await fetcher.fetchReferendum(governanceApi, mainRefId);
      if (!mainRef) {
        throw new Error(`Failed to fetch main referendum ${mainRefId}`);
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
        const govClient = createClient(withPolkadotSdkCompat(getWsProvider(this.governanceEndpoint)));
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
        this.logger.info(`Governance: ${this.governanceChain.label} (${this.governanceChain.kind})`);
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

  private async setupInterconnectedChains(): Promise<{
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

    const relayChain = governanceIsRelay ? this.governanceChain : this.fellowshipChain;
    const parachain = governanceIsRelay ? this.fellowshipChain : this.governanceChain;

    // Determine which block numbers to use
    const relayBlock = governanceIsRelay ? this.governanceBlock : this.fellowshipBlock;
    const parachainBlock = governanceIsRelay ? this.fellowshipBlock : this.governanceBlock;

    const relayKey = this.getRelayKey(relayChain.network);
    const parachainKey = governanceIsRelay ? 'fellowship' : 'governance';

    // Build network config including additional chains
    const networkConfig: Record<string, any> = {
      [relayKey]: this.buildConfig(relayChain.endpoint, relayBlock),
      [parachainKey]: this.buildConfig(parachain.endpoint, parachainBlock),
    };

    // Track which endpoints are already in the network and map chains to their network keys
    const usedEndpoints = new Set([relayChain.endpoint, parachain.endpoint]);
    const chainToNetworkKey = new Map<string, string>();

    // Add additional chains to the network (skip duplicates)
    this.additionalChains.forEach((chain, index) => {
      if (usedEndpoints.has(chain.endpoint)) {
        this.logger.debug(`Skipping duplicate endpoint for ${chain.label}: ${chain.endpoint}`);
        return;
      }

      const key = `additional_${index}`;
      const block = this.additionalChainBlocks[index];
      networkConfig[key] = this.buildConfig(chain.endpoint, block);
      usedEndpoints.add(chain.endpoint);
      chainToNetworkKey.set(chain.label, key);
      this.logger.debug(
        `Adding ${chain.label} to network config with key: ${key}${block ? ` at block ${block}` : ''}`
      );
    });

    const networks = await setupNetworks(networkConfig);

    const governanceContext = governanceIsRelay ? networks[relayKey] : networks[parachainKey];
    const fellowshipContext = fellowshipIsRelay ? networks[relayKey] : networks[parachainKey];

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

  private buildConfig(endpoint: string, block?: number) {
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

        const api = createApiForChain(client);

        // Get current block number
        const blockNumber = await api.query.System.Number.getValue();

        // Get events from the latest block
        const eventsQuery = api.query.System.Events.getValue();
        const events = await eventsQuery;

        this.logger.info(`📡 ${chainLabel} (Block #${blockNumber})`);

        if (events && Array.isArray(events)) {
          events.forEach((event: any, index: number) => {
            const resolved =
              typeof event.event === 'function'
                ? event.event()
                : (event.event?.value ??
                  (typeof event.event === 'object' && event.event !== null ? event.event : null) ??
                  event);

            const sectionSource = resolved?.section ?? event.section;
            const methodSource = resolved?.method ?? event.method;
            const dataSource = resolved?.data ?? resolved?.args ?? event.data ?? event.args;

            const section =
              typeof sectionSource === 'string'
                ? sectionSource
                : typeof sectionSource?.toString === 'function'
                  ? sectionSource.toString()
                  : undefined;

            const method =
              typeof methodSource === 'string'
                ? methodSource
                : typeof methodSource?.toString === 'function'
                  ? methodSource.toString()
                  : undefined;

            const sectionStr = section ?? 'Unknown';
            const methodStr = method ?? 'Unknown';

            this.logger.info(`  • [${index}] ${sectionStr}.${methodStr}`);

            if (sectionStr === 'Unknown' || methodStr === 'Unknown') {
              this.logger.debug(
                `Raw event [${index}]: ${JSON.stringify(event, (_, value) =>
                  typeof value === 'bigint' ? value.toString() : value
                )}`
              );
            }

            if (this.logger.isVerbose() && dataSource !== undefined) {
              const serialized =
                typeof dataSource?.toHuman === 'function'
                  ? dataSource.toHuman()
                  : typeof dataSource?.toJSON === 'function'
                    ? dataSource.toJSON()
                    : dataSource;

              this.logger.debug(
                `Event payload [${index}]: ${JSON.stringify(serialized, (_, value) =>
                  typeof value === 'bigint' ? value.toString() : value
                )}`
              );
            }
          });
        } else {
          this.logger.info(`  No events found`);
        }

        client.destroy();
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
