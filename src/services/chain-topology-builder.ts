import { BuildBlockMode } from '@acala-network/chopsticks-core';
import * as path from 'path';
import type { PolkadotClient } from 'polkadot-api';
import type { TestOptions } from '../types';
import type { ParsedEndpoint } from '../utils/chain-endpoint-parser';
import type { Logger } from '../utils/logger';
import {
  type ChainInfo,
  type ChainNetwork,
  createApiForChain,
  createPolkadotClient,
  getChainInfo,
} from './chain-registry';
import { ReferendumCreator } from './referendum-creator';

export interface TopologyConfig {
  governance?: string;
  governanceBlock?: number;
  fellowship?: string;
  fellowshipBlock?: number;
  additionalChains?: ParsedEndpoint[];
}

export class ChainTopologyBuilder {
  private logger: Logger;
  private governanceEndpoint?: string;
  private governanceBlock?: number;
  private fellowshipEndpoint?: string;
  private fellowshipBlock?: number;
  private additionalChainEndpoints: ParsedEndpoint[];

  private _governanceChain?: ChainInfo;
  private _fellowshipChain?: ChainInfo;
  private _additionalChains: ChainInfo[] = [];

  constructor(logger: Logger, config: TopologyConfig) {
    this.logger = logger;
    this.governanceEndpoint = config.governance;
    this.governanceBlock = config.governanceBlock;
    this.fellowshipEndpoint = config.fellowship;
    this.fellowshipBlock = config.fellowshipBlock;
    this.additionalChainEndpoints = config.additionalChains || [];
  }

  get governanceChain(): ChainInfo | undefined {
    return this._governanceChain;
  }

  set governanceChain(info: ChainInfo | undefined) {
    this._governanceChain = info;
  }

  get fellowshipChain(): ChainInfo | undefined {
    return this._fellowshipChain;
  }

  set fellowshipChain(info: ChainInfo | undefined) {
    this._fellowshipChain = info;
  }

  get additionalChains(): ChainInfo[] {
    return this._additionalChains;
  }

  getGovernanceEndpoint(): string | undefined {
    return this.governanceEndpoint;
  }

  getFellowshipEndpoint(): string | undefined {
    return this.fellowshipEndpoint;
  }

  getGovernanceBlock(): number | undefined {
    return this.governanceBlock;
  }

  getFellowshipBlock(): number | undefined {
    return this.fellowshipBlock;
  }

  hasAdditionalChains(): boolean {
    return this.additionalChainEndpoints.length > 0;
  }

  async detectChainTypes(): Promise<void> {
    this.logger.startSpinner('Detecting chain types...');

    const clients: PolkadotClient[] = [];
    try {
      const detectionTasks: Promise<void>[] = [];

      if (this.governanceEndpoint) {
        detectionTasks.push(
          this.detectChainInfo(this.governanceEndpoint, clients).then((info) => {
            this._governanceChain = info;
          })
        );
      }

      if (this.fellowshipEndpoint) {
        detectionTasks.push(
          this.detectChainInfo(this.fellowshipEndpoint, clients).then((info) => {
            this._fellowshipChain = info;
          })
        );
      }

      for (const additionalEndpoint of this.additionalChainEndpoints) {
        detectionTasks.push(
          this.detectChainInfo(additionalEndpoint.url, clients).then((info) => {
            this._additionalChains.push(info);
          })
        );
      }

      await Promise.all(detectionTasks);

      this.logger.succeedSpinner('Chain types detected');
      if (this._governanceChain) {
        this.logger.info(
          `Governance: ${this._governanceChain.label} (${this._governanceChain.kind})`
        );
      }
      if (this._fellowshipChain) {
        this.logger.info(
          `Fellowship: ${this._fellowshipChain.label} (${this._fellowshipChain.kind})`
        );
      }
    } finally {
      for (const client of clients) {
        client.destroy();
      }
    }
  }

  private async detectChainInfo(endpoint: string, clients: PolkadotClient[]): Promise<ChainInfo> {
    const client = createPolkadotClient(endpoint);
    clients.push(client);
    const api = createApiForChain(client);
    return getChainInfo(api, endpoint);
  }

  async detectRelayNetworkKey(endpoint: string): Promise<string | undefined> {
    let tempClient: PolkadotClient | undefined;
    try {
      tempClient = createPolkadotClient(endpoint);
      const tempApi = createApiForChain(tempClient);
      const chainInfo = await getChainInfo(tempApi, endpoint);
      if (chainInfo.kind === 'relay') {
        this.logger.debug(`Chain is a relay chain, using network key: ${chainInfo.network}`);
        return chainInfo.network;
      }
    } catch (error) {
      this.logger.debug(`Pre-detection failed, using default network key: ${error}`);
    } finally {
      tempClient?.destroy();
    }
    return undefined;
  }

  buildNetworkTopology(options?: TestOptions): {
    networkConfig: Record<string, unknown>;
    governanceKey: string;
    fellowshipKey: string;
  } {
    if (!this._governanceChain || !this._fellowshipChain) {
      throw new Error('Chain types must be detected before building network topology');
    }

    const governanceIsRelay = this._governanceChain.kind === 'relay';
    const fellowshipIsRelay = this._fellowshipChain.kind === 'relay';

    const networkConfig: Record<string, unknown> = {};
    let governanceKey: string;
    let fellowshipKey: string;

    const fellowshipInjection = options?.callToCreateFellowshipReferendum
      ? ('fellowship' as const)
      : undefined;
    const governanceInjection = options?.callToCreateGovernanceReferendum
      ? ('alice-account' as const)
      : undefined;

    if (!governanceIsRelay && !fellowshipIsRelay) {
      governanceKey = 'governance';
      fellowshipKey = 'fellowship';
      networkConfig[governanceKey] = this.buildConfig(
        this._governanceChain.endpoint,
        this.governanceBlock,
        governanceInjection
      );
      networkConfig[fellowshipKey] = this.buildConfig(
        this._fellowshipChain.endpoint,
        this.fellowshipBlock,
        fellowshipInjection
      );
    } else {
      const relayChain = governanceIsRelay ? this._governanceChain : this._fellowshipChain;
      const parachain = governanceIsRelay ? this._fellowshipChain : this._governanceChain;

      const relayBlock = governanceIsRelay ? this.governanceBlock : this.fellowshipBlock;
      const parachainBlock = governanceIsRelay ? this.fellowshipBlock : this.governanceBlock;

      const relayKey = this.getRelayKey(relayChain.network);
      const parachainKey = governanceIsRelay ? 'fellowship' : 'governance';

      governanceKey = governanceIsRelay ? relayKey : parachainKey;
      fellowshipKey = fellowshipIsRelay ? relayKey : parachainKey;

      const relayInjection = governanceIsRelay ? governanceInjection : fellowshipInjection;
      const parachainInjection = governanceIsRelay ? fellowshipInjection : governanceInjection;

      networkConfig[relayKey] = this.buildConfig(relayChain.endpoint, relayBlock, relayInjection);
      networkConfig[parachainKey] = this.buildConfig(
        parachain.endpoint,
        parachainBlock,
        parachainInjection
      );
    }

    return { networkConfig, governanceKey, fellowshipKey };
  }

  registerAdditionalChains(
    networkConfig: Record<string, unknown>,
    usedEndpoints: Set<string>,
    governanceIsRelay: boolean,
    fellowshipIsRelay: boolean
  ): { usedEndpoints: Set<string>; chainToNetworkKey: Map<string, string> } {
    const chainToNetworkKey = new Map<string, string>();
    const usedRelayKeys = new Set<string>();

    if (governanceIsRelay) {
      usedRelayKeys.add(this.getRelayKey(this._governanceChain!.network));
    }
    if (fellowshipIsRelay) {
      usedRelayKeys.add(this.getRelayKey(this._fellowshipChain!.network));
    }

    this._additionalChains.forEach((chain, chainIndex) => {
      if (usedEndpoints.has(chain.endpoint)) {
        this.logger.debug(`Skipping duplicate endpoint for ${chain.label}: ${chain.endpoint}`);
        return;
      }

      let key: string;
      if (chain.kind === 'relay') {
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
        key = `additional_${chainIndex}`;
      }

      const block = this.additionalChainEndpoints[chainIndex]?.block;
      networkConfig[key] = this.buildConfig(chain.endpoint, block);
      usedEndpoints.add(chain.endpoint);
      chainToNetworkKey.set(chain.label, key);
      this.logger.debug(
        `Adding ${chain.label} (${chain.kind}) to network config with key: ${key}${block ? ` at block ${block}` : ''}`
      );
    });

    return { usedEndpoints, chainToNetworkKey };
  }

  buildConfig(
    endpoint: string,
    block?: number,
    storageInjection?: 'fellowship' | 'alice-account'
  ): Record<string, unknown> {
    const config: Record<string, unknown> = {
      endpoint,
      db: path.join(process.cwd(), '.chopsticks-db'),
      'build-block-mode': BuildBlockMode.Manual,
      'mock-signature-host': true,
      'allow-unresolved-imports': true,
      'runtime-log-level': 0,
    };

    if (block !== undefined) {
      config.block = block;
    }

    if (storageInjection === 'fellowship') {
      config['import-storage'] = ReferendumCreator.getFellowshipStorageInjection();
      this.logger.debug('Injecting fellowship storage for Alice account');
    } else if (storageInjection === 'alice-account') {
      config['import-storage'] = ReferendumCreator.getAliceAccountInjection();
      this.logger.debug('Injecting Alice account with funds');
    }

    return config;
  }

  getRelayKey(network: ChainNetwork): string {
    if (network === 'polkadot') {
      return 'polkadot';
    }
    if (network === 'kusama') {
      return 'kusama';
    }
    return 'relay';
  }
}
