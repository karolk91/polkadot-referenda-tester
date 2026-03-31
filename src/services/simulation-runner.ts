import type { SimulationResult, TestOptions } from '../types';
import type { SubstrateApi } from '../types/substrate-api';
import type { Logger } from '../utils/logger';
import type { ChopsticksManager } from './chopsticks-manager';
import { ReferendaFetcher } from './referenda-fetcher';
import { ReferendumCreator } from './referendum-creator';
import { ReferendumSimulator } from './referendum-simulator';

/**
 * Runs referendum simulations given already-initialized chain APIs.
 *
 * ┌───────────────────────────────────────────────────────┐
 * │                 SimulationRunner                       │
 * │                                                        │
 * │  fetchAndSimulate()   — single referendum lifecycle    │
 * │    ├─ createReferendumIfNeeded()                       │
 * │    ├─ ReferendaFetcher.fetchReferendum()               │
 * │    ├─ ReferendumSimulator.simulate()                   │
 * │    └─ throwIfFailed()                                  │
 * │                                                        │
 * │  simulateSequentialReferenda()                         │
 * │    ├─ [1/2] fellowship via fetchAndSimulate()          │
 * │    └─ [2/2] governance via fetchAndSimulate()          │
 * │                                                        │
 * │  simulateMultiChainReferenda()                         │
 * │    ├─ [1/2] fellowship on fellowship chain             │
 * │    ├─ XCM propagation blocks                           │
 * │    └─ [2/2] governance on governance chain             │
 * └───────────────────────────────────────────────────────┘
 */

export interface CreateReferendumParams {
  api: SubstrateApi;
  chopsticks: ChopsticksManager;
  callHex: string | undefined;
  preimageHex: string | undefined;
  isFellowship: boolean;
}

export class SimulationRunner {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * End-to-end single referendum: optionally create, fetch, simulate, and verify.
   */
  async fetchAndSimulate(params: {
    api: SubstrateApi;
    chopsticks: ChopsticksManager;
    referendumId: number | undefined;
    isFellowship: boolean;
    createCallHex?: string;
    createPreimageHex?: string;
    preCall?: string;
    preOrigin?: string;
    label?: string;
  }): Promise<SimulationResult> {
    const label = params.label ?? (params.isFellowship ? 'Fellowship' : 'Governance');

    const createdId = await this.createReferendumIfNeeded({
      api: params.api,
      chopsticks: params.chopsticks,
      callHex: params.createCallHex,
      preimageHex: params.createPreimageHex,
      isFellowship: params.isFellowship,
    });
    const actualReferendumId = createdId ?? params.referendumId;

    if (actualReferendumId === undefined) {
      throw new Error(`${label} referendum ID is required but was not provided or created`);
    }

    const fetcher = new ReferendaFetcher(this.logger);
    const referendum = await fetcher.fetchReferendum(
      params.api,
      actualReferendumId,
      params.isFellowship
    );

    if (!referendum) {
      throw new Error(`Failed to fetch ${label.toLowerCase()} referendum ${actualReferendumId}`);
    }

    const simulator = new ReferendumSimulator(
      this.logger,
      params.chopsticks,
      params.api,
      params.isFellowship
    );

    // Extract raw preimage bytes from the notePreimage call for Lookup proposals
    const rawPreimageHex = params.createPreimageHex
      ? SimulationRunner.extractPreimageBytesFromNoteCall(params.createPreimageHex)
      : undefined;

    const result = await simulator.simulate(referendum, {
      preCall: params.preCall,
      preOrigin: params.preOrigin,
      rawPreimageHex,
    });

    this.throwIfFailed(result, `${label} referendum #${actualReferendumId}`);
    this.logger.success(`\n✓ ${label} referendum #${actualReferendumId} executed successfully!`);

    return result;
  }

  /**
   * Run fellowship then governance on the same chain instance (sequential).
   */
  async simulateSequentialReferenda(
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

  /**
   * Run fellowship then governance on separate chain instances with XCM propagation.
   */
  async simulateMultiChainReferenda(chains: {
    fellowship: {
      api: SubstrateApi;
      chopsticks: ChopsticksManager;
      referendumId: number;
      label: string;
    };
    governance: {
      api: SubstrateApi;
      chopsticks: ChopsticksManager;
      referendumId: number;
      label: string;
    };
  }): Promise<void> {
    const { fellowship, governance } = chains;
    const fetcher = new ReferendaFetcher(this.logger);

    this.logger.section(
      `[1/2] Fellowship Referendum #${fellowship.referendumId} (${fellowship.label})`
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
      `[2/2] Main Governance Referendum #${governance.referendumId} (${governance.label})`
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

  async createReferendumIfNeeded(params: CreateReferendumParams): Promise<number | undefined> {
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

  throwIfFailed(result: SimulationResult, label: string): void {
    if (!result.executionSucceeded) {
      if (result.errors) {
        for (const errorMessage of result.errors) {
          this.logger.error(`  ${errorMessage}`);
        }
      }
      throw new Error(`${label} execution failed`);
    }
  }

  /**
   * Extract raw preimage bytes from a Preimage.notePreimage(bytes) call.
   * The call format is: [pallet_idx][call_idx][compact_len][bytes...]
   * Returns the raw bytes as a hex string, or undefined if extraction fails.
   */
  private static extractPreimageBytesFromNoteCall(noteCallHex: string): string | undefined {
    try {
      const hex = noteCallHex.startsWith('0x') ? noteCallHex.slice(2) : noteCallHex;
      // Skip pallet index (1 byte = 2 hex) + call index (1 byte = 2 hex) = 4 hex chars
      let offset = 4;

      // Decode SCALE compact length
      const firstByte = parseInt(hex.slice(offset, offset + 2), 16);
      const mode = firstByte & 0x03;
      let dataOffset: number;

      if (mode === 0) {
        // Single byte compact (values 0-63)
        dataOffset = offset + 2;
      } else if (mode === 1) {
        // Two byte compact (values 64-16383)
        dataOffset = offset + 4;
      } else if (mode === 2) {
        // Four byte compact (values 16384+)
        dataOffset = offset + 8;
      } else {
        // Big integer mode - not expected for preimage lengths
        return undefined;
      }

      const rawBytes = hex.slice(dataOffset);
      return rawBytes.length > 0 ? `0x${rawBytes}` : undefined;
    } catch {
      return undefined;
    }
  }
}
