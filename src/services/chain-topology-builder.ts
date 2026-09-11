import type { ParsedEndpoint } from '../utils/chain-endpoint-parser';
import { buildChopsticksChainConfig, type StorageInjection } from '../utils/chopsticks-config';
import type { Logger } from '../utils/logger';
import { type ChainInfo, type ChainNetwork, fetchChainInfoFromEndpoint } from './chain-registry';

export type PrimaryRole = 'governance' | 'fellowship';

/** Which predefined storage each primary fork receives (see {@link StorageInjection}). */
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

/** One `--additional-chains` entry: the endpoint the user requested, and its detected identity. */
interface AdditionalChain {
  endpoint: ParsedEndpoint;
  info: ChainInfo;
}

/** A primary role's detected chain, with the fork block and YAML extras for that role. */
interface PrimaryChain {
  info: ChainInfo;
  block?: number;
  baseConfig?: Record<string, unknown>;
}

/** A chain included in the forked network: its chopsticks config key and its identity. */
export interface RegisteredChain {
  key: string;
  info: ChainInfo;
}

/** The `setupNetworks` config for a run, and the key each chain uses in it. */
export interface NetworkTopology {
  networkConfig: Record<string, unknown>;
  /** The governance fork, when the run tests a governance referendum. */
  governance?: RegisteredChain;
  /** The fellowship fork; the same entry as `governance` when both use one chain. */
  fellowship?: RegisteredChain;
  /** The `--additional-chains` that received their own fork, in config order. */
  additional: RegisteredChain[];
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
  private _additionalChains: AdditionalChain[] = [];

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

  getGovernanceEndpoint(): string | undefined {
    return this.governanceEndpoint;
  }

  getFellowshipEndpoint(): string | undefined {
    return this.fellowshipEndpoint;
  }

  /**
   * Identify every configured chain from its runtime `spec_name`, concurrently. Uses the legacy
   * `state_getRuntimeVersion` path (no polkadot-api `createClient`), so detection works against
   * legacy-only endpoints such as a subway caching proxy (see chain-registry).
   */
  async detectChainTypes(): Promise<void> {
    this.logger.startSpinner('Detecting chain types...');

    const [governanceInfo, fellowshipInfo, additionalInfos] = await Promise.all([
      this.governanceEndpoint
        ? fetchChainInfoFromEndpoint(this.governanceEndpoint)
        : Promise.resolve(undefined),
      this.fellowshipEndpoint
        ? fetchChainInfoFromEndpoint(this.fellowshipEndpoint)
        : Promise.resolve(undefined),
      Promise.all(
        this.additionalChainEndpoints.map((endpoint) => fetchChainInfoFromEndpoint(endpoint.url))
      ),
    ]);

    if (governanceInfo) this._governanceChain = governanceInfo;
    if (fellowshipInfo) this._fellowshipChain = fellowshipInfo;
    // Each endpoint stores its own detected identity, so an entry's `block` / `baseConfig`
    // always applies to the chain the user requested.
    this._additionalChains = this.additionalChainEndpoints.map((endpoint, index) => ({
      endpoint,
      info: additionalInfos[index],
    }));

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

  /** The detected chain for a primary role, with its fork block and YAML extras. */
  private primary(role: PrimaryRole): PrimaryChain {
    const info = role === 'governance' ? this._governanceChain : this._fellowshipChain;
    if (!info) {
      throw new Error(
        `${role === 'governance' ? 'Governance' : 'Fellowship'} chain type could not be detected`
      );
    }
    return role === 'governance'
      ? { info, block: this.governanceBlock, baseConfig: this.governanceBaseConfig }
      : { info, block: this.fellowshipBlock, baseConfig: this.fellowshipBaseConfig };
  }

  /**
   * Build the whole `setupNetworks` config for a run: the primary fork(s) the run requires, plus
   * every `--additional-chains` entry that is not already one of them.
   *
   * A run requires one primary fork when it tests only governance, only fellowship, or both on
   * the same chain, and two when the referenda are on different chains. `injections` specifies
   * which predefined storage to merge into each primary. The caller decides this from the whole
   * run, because with chaining any step that creates a referendum requires a funded signer from
   * the start.
   */
  buildNetworkTopology(request: {
    needGovernance: boolean;
    needFellowship: boolean;
    injections?: TopologyInjections;
  }): NetworkTopology {
    const { needGovernance, needFellowship, injections } = request;
    if (!needGovernance && !needFellowship) {
      throw new Error('A run must test a governance or a fellowship referendum');
    }

    const governance = needGovernance ? this.primary('governance') : undefined;
    const fellowship = needFellowship ? this.primary('fellowship') : undefined;
    const sharedChain =
      !!governance &&
      !!fellowship &&
      (this.governanceEndpoint === this.fellowshipEndpoint ||
        governance.info.label === fellowship.info.label);

    const networkConfig: Record<string, unknown> = {};
    let governanceSlot: RegisteredChain | undefined;
    let fellowshipSlot: RegisteredChain | undefined;

    if (governance && fellowship && !sharedChain) {
      this.logger.section('Setting Up Multi-Chain Environment');
      this.logger.info(`Governance Chain: ${governance.info.label}`);
      this.logger.info(`Fellowship Chain: ${fellowship.info.label}\n`);
      // A relay uses its network key, so chopsticks connects the vertical relay↔parachain link.
      // The other side uses its role name. When both are relays, only the first can use the
      // relay key.
      const governanceIsRelay = governance.info.kind === 'relay';
      const governanceKey = governanceIsRelay
        ? this.getRelayKey(governance.info.network)
        : 'governance';
      const fellowshipKey =
        fellowship.info.kind === 'relay' && !governanceIsRelay
          ? this.getRelayKey(fellowship.info.network)
          : 'fellowship';
      networkConfig[governanceKey] = this.buildConfig(governance, injections?.governance);
      networkConfig[fellowshipKey] = this.buildConfig(fellowship, injections?.fellowship);
      governanceSlot = { key: governanceKey, info: governance.info };
      fellowshipSlot = { key: fellowshipKey, info: fellowship.info };
    } else {
      // One primary fork: the governance chain, or the fellowship chain, or the chain shared by both.
      const primary = governance ?? fellowship!;
      const role: PrimaryRole = governance ? 'governance' : 'fellowship';
      const key = primary.info.kind === 'relay' ? this.getRelayKey(primary.info.network) : role;
      // A fork receives one predefined injection. The fellowship injection is a superset of the
      // Alice injection, so it also covers a shared chain that creates both kinds of referendum.
      networkConfig[key] = this.buildConfig(
        primary,
        injections?.fellowship ?? injections?.governance
      );
      const slot: RegisteredChain = { key, info: primary.info };
      governanceSlot = governance ? slot : undefined;
      fellowshipSlot = fellowship ? slot : undefined;
    }

    const additional = this.registerAdditionalChains(
      networkConfig,
      [governance, fellowship].filter((p): p is PrimaryChain => !!p)
    );

    return {
      networkConfig,
      governance: governanceSlot,
      fellowship: fellowshipSlot,
      additional,
    };
  }

  /**
   * Add every `--additional-chains` entry to `networkConfig`, skipping the entries already forked
   * as a primary (by endpoint or by identity) and any relay whose key a primary already uses.
   */
  private registerAdditionalChains(
    networkConfig: Record<string, unknown>,
    primaries: PrimaryChain[]
  ): RegisteredChain[] {
    const usedEndpoints = new Set(primaries.map(({ info }) => info.endpoint));
    const usedLabels = new Set(primaries.map(({ info }) => info.label));
    const usedRelayKeys = new Set(
      primaries
        .filter(({ info }) => info.kind === 'relay')
        .map(({ info }) => this.getRelayKey(info.network))
    );

    const registered: RegisteredChain[] = [];
    this._additionalChains.forEach(({ endpoint, info }, chainIndex) => {
      if (usedEndpoints.has(info.endpoint) || usedLabels.has(info.label)) {
        this.logger.debug(
          `Skipping ${info.label}: already forked as the governance/fellowship chain`
        );
        return;
      }

      let key: string;
      if (info.kind === 'relay') {
        const relayKey = this.getRelayKey(info.network);
        if (usedRelayKeys.has(relayKey)) {
          this.logger.warn(
            `Skipping relay chain ${info.label}: relay key '${relayKey}' is already in use`
          );
          return;
        }
        key = relayKey;
        usedRelayKeys.add(relayKey);
      } else {
        key = `additional_${chainIndex}`;
      }

      networkConfig[key] = this.buildConfig(
        { info, block: endpoint.block, baseConfig: endpoint.baseConfig },
        undefined
      );
      usedEndpoints.add(info.endpoint);
      usedLabels.add(info.label);
      registered.push({ key, info });
      this.logger.debug(
        `Adding ${info.label} (${info.kind}) to network config with key: ${key}${endpoint.block ? ` at block ${endpoint.block}` : ''}`
      );
    });

    return registered;
  }

  private buildConfig(
    chain: PrimaryChain,
    storageInjection: StorageInjection | undefined
  ): Record<string, unknown> {
    if (storageInjection === 'fellowship') {
      this.logger.debug('Injecting fellowship storage for Alice account');
    } else if (storageInjection === 'alice-account') {
      this.logger.debug('Injecting Alice account with funds');
    }
    return buildChopsticksChainConfig(
      chain.info.endpoint,
      chain.block,
      storageInjection,
      chain.baseConfig,
      0
    );
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
