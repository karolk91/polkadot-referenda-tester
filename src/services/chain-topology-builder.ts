import type { ParsedEndpoint } from '../utils/chain-endpoint-parser';
import { buildChopsticksChainConfig, type StorageInjection } from '../utils/chopsticks-config';
import type { Logger } from '../utils/logger';
import { type ChainInfo, type ChainNetwork, fetchChainInfoFromEndpoint } from './chain-registry';

export type PrimaryRole = 'governance' | 'fellowship';

/** Which canned storage each primary fork gets (see {@link StorageInjection}). */
export interface TopologyInjections {
  governance?: StorageInjection;
  fellowship?: StorageInjection;
}

export interface TopologyConfig {
  governance?: string;
  governanceBlock?: number;
  /** Extra chopsticks config from a YAML file for the governance chain (wasm-override, …). */
  governanceBaseConfig?: Record<string, unknown>;
  fellowship?: string;
  fellowshipBlock?: number;
  fellowshipBaseConfig?: Record<string, unknown>;
  additionalChains?: ParsedEndpoint[];
}

export class ChainTopologyBuilder {
  private logger: Logger;
  private governanceEndpoint?: string;
  private governanceBlock?: number;
  private governanceBaseConfig?: Record<string, unknown>;
  private fellowshipEndpoint?: string;
  private fellowshipBlock?: number;
  private fellowshipBaseConfig?: Record<string, unknown>;
  private additionalChainEndpoints: ParsedEndpoint[];

  private _governanceChain?: ChainInfo;
  private _fellowshipChain?: ChainInfo;
  private _additionalChains: ChainInfo[] = [];

  constructor(logger: Logger, config: TopologyConfig) {
    this.logger = logger;
    this.governanceEndpoint = config.governance;
    this.governanceBlock = config.governanceBlock;
    this.governanceBaseConfig = config.governanceBaseConfig;
    this.fellowshipEndpoint = config.fellowship;
    this.fellowshipBlock = config.fellowshipBlock;
    this.fellowshipBaseConfig = config.fellowshipBaseConfig;
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

    const detectionTasks: Promise<void>[] = [];

    if (this.governanceEndpoint) {
      detectionTasks.push(
        this.detectChainInfo(this.governanceEndpoint).then((info) => {
          this._governanceChain = info;
        })
      );
    }

    if (this.fellowshipEndpoint) {
      detectionTasks.push(
        this.detectChainInfo(this.fellowshipEndpoint).then((info) => {
          this._fellowshipChain = info;
        })
      );
    }

    // Detect concurrently but keep `_additionalChains` index-aligned with
    // `additionalChainEndpoints`: buildNetworkTopology pairs the two arrays by index to attach
    // each endpoint's `block`/`baseConfig` (e.g. an import-storage override) to the right chain.
    detectionTasks.push(
      Promise.all(
        this.additionalChainEndpoints.map((endpoint) => this.detectChainInfo(endpoint.url))
      ).then((infos) => {
        this._additionalChains.push(...infos);
      })
    );

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
  }

  private async detectChainInfo(endpoint: string): Promise<ChainInfo> {
    // Legacy `state_getRuntimeVersion` path (no polkadot-api `createClient`), so detection
    // works against legacy-only endpoints such as a subway caching proxy (see chain-registry).
    return fetchChainInfoFromEndpoint(endpoint);
  }

  async detectRelayNetworkKey(endpoint: string): Promise<string | undefined> {
    try {
      const chainInfo = await fetchChainInfoFromEndpoint(endpoint);
      if (chainInfo.kind === 'relay') {
        this.logger.debug(`Chain is a relay chain, using network key: ${chainInfo.network}`);
        return chainInfo.network;
      }
    } catch (error) {
      this.logger.debug(`Pre-detection failed, using default network key: ${error}`);
    }
    return undefined;
  }

  /** The detected chain plus fork block and YAML extras for one primary role. */
  primary(role: PrimaryRole): {
    info: ChainInfo | undefined;
    block: number | undefined;
    baseConfig: Record<string, unknown> | undefined;
  } {
    return role === 'governance'
      ? {
          info: this._governanceChain,
          block: this.governanceBlock,
          baseConfig: this.governanceBaseConfig,
        }
      : {
          info: this._fellowshipChain,
          block: this.fellowshipBlock,
          baseConfig: this.fellowshipBaseConfig,
        };
  }

  /**
   * Network config for a governance chain + a distinct fellowship chain. `injections` says which
   * canned storage to merge into each fork — the caller decides from the whole run (with chaining,
   * any step that creates a referendum needs its signer funded from the start).
   */
  buildNetworkTopology(injections?: TopologyInjections): {
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

    const fellowshipInjection = injections?.fellowship;
    const governanceInjection = injections?.governance;

    if (!governanceIsRelay && !fellowshipIsRelay) {
      governanceKey = 'governance';
      fellowshipKey = 'fellowship';
      networkConfig[governanceKey] = this.buildConfig(
        this._governanceChain.endpoint,
        this.governanceBlock,
        governanceInjection,
        this.governanceBaseConfig
      );
      networkConfig[fellowshipKey] = this.buildConfig(
        this._fellowshipChain.endpoint,
        this.fellowshipBlock,
        fellowshipInjection,
        this.fellowshipBaseConfig
      );
    } else {
      const relayChain = governanceIsRelay ? this._governanceChain : this._fellowshipChain;
      const parachain = governanceIsRelay ? this._fellowshipChain : this._governanceChain;

      const relayBlock = governanceIsRelay ? this.governanceBlock : this.fellowshipBlock;
      const parachainBlock = governanceIsRelay ? this.fellowshipBlock : this.governanceBlock;
      const relayBaseConfig = governanceIsRelay
        ? this.governanceBaseConfig
        : this.fellowshipBaseConfig;
      const parachainBaseConfig = governanceIsRelay
        ? this.fellowshipBaseConfig
        : this.governanceBaseConfig;

      const relayKey = this.getRelayKey(relayChain.network);
      const parachainKey = governanceIsRelay ? 'fellowship' : 'governance';

      governanceKey = governanceIsRelay ? relayKey : parachainKey;
      fellowshipKey = fellowshipIsRelay ? relayKey : parachainKey;

      const relayInjection = governanceIsRelay ? governanceInjection : fellowshipInjection;
      const parachainInjection = governanceIsRelay ? fellowshipInjection : governanceInjection;

      networkConfig[relayKey] = this.buildConfig(
        relayChain.endpoint,
        relayBlock,
        relayInjection,
        relayBaseConfig
      );
      networkConfig[parachainKey] = this.buildConfig(
        parachain.endpoint,
        parachainBlock,
        parachainInjection,
        parachainBaseConfig
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
      const baseConfig = this.additionalChainEndpoints[chainIndex]?.baseConfig;
      networkConfig[key] = this.buildConfig(chain.endpoint, block, undefined, baseConfig);
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
    storageInjection?: StorageInjection,
    userBaseConfig?: Record<string, unknown>
  ): Record<string, unknown> {
    if (storageInjection === 'fellowship') {
      this.logger.debug('Injecting fellowship storage for Alice account');
    } else if (storageInjection === 'alice-account') {
      this.logger.debug('Injecting Alice account with funds');
    }
    return buildChopsticksChainConfig(endpoint, block, storageInjection, userBaseConfig, 0);
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
