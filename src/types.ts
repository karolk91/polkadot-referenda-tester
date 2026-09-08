import type { SS58String } from 'polkadot-api';

export interface TestOptions {
  governanceChainUrl?: string;
  referendum?: string;
  fellowship?: string; // Optional fellowship referendum ID
  fellowshipChainUrl?: string;
  port: string;
  preCall?: string; // Hex string of call to execute before main referendum
  preOrigin?: string; // Origin for pre-execution call
  cleanup: boolean;
  verbose: boolean;
  additionalChains?: string; // Comma-separated list of additional chain URLs
  // Referendum creation options
  callToCreateGovernanceReferendum?: string; // Hex string of call to create governance referendum
  callToNotePreimageForGovernanceReferendum?: string; // Hex string of call to note preimage for governance referendum
  callToCreateFellowshipReferendum?: string; // Hex string of call to create fellowship referendum
  callToNotePreimageForFellowshipReferendum?: string; // Hex string of call to note preimage for fellowship referendum
  // Bridge options. The bridged scenario is auto-detected from URL networks:
  //   --fellowship-chain-url on Polkadot + --governance-chain-url on Kusama → bridged.
  // When bridged, the AHK URL defaults from --governance-chain-url; explicit override below.
  //
  // Relays (and any other observable chains) go in --additional-chains; the tool
  // auto-classifies each entry's network + relay-ness from the URL.
  assetHubPolkadotUrl?: string; // AHP — required when bridged
  bridgeHubPolkadotUrl?: string; // BHP — required when bridged
  assetHubKusamaUrl?: string; // AHK override; defaults from --governance-chain-url when bridged
  bridgeHubKusamaUrl?: string; // BHK — required when bridged
  bridgePumpRounds?: string; // Max rounds the bridge connector pumps before giving up
  // Post-referendum testing
  postTest?: string; // Path to a module run against the live network after the referendum executes
  postTestArgs?: string; // Value passed to the post-test as `args` (JSON when parseable)
  // Referendum chaining: the steps given after each `--then` separator (already parsed from the
  // same per-referendum flags), run in order on the same forked network after the step described
  // by the top-level flags. See utils/referendum-steps.ts.
  thenSteps?: ReferendumStep[];
}

/**
 * One referendum step of a run: what a single invocation of the tool used to do. A run is an
 * ordered list of steps executed on ONE forked network, so each step sees the state left behind
 * by the previous ones (including anything a step's post-test did, e.g. applying a runtime upgrade).
 *
 * A step is a governance referendum, a fellowship referendum, or both (fellowship first, then
 * governance — the whitelisting pattern). Each half is either an existing ID or a creation call.
 */
export interface ReferendumStep {
  referendum?: number; // Existing governance referendum ID
  fellowship?: number; // Existing fellowship referendum ID
  callToCreateGovernanceReferendum?: string;
  callToNotePreimageForGovernanceReferendum?: string;
  callToCreateFellowshipReferendum?: string;
  callToNotePreimageForFellowshipReferendum?: string;
  preCall?: string; // Executed before the step's referendum (single-referendum steps only)
  preOrigin?: string;
  postTest?: string; // Module run against the live network after this step executes
  postTestArgs?: string;
}

export interface ReferendumInfo {
  id: number;
  track: string;
  origin: unknown;
  proposal: {
    hash: string; // Hex string representation
    call: unknown;
    type: 'Lookup' | 'Inline';
    len?: number; // Only present for Lookup proposals
  };
  status: 'ongoing' | 'approved' | 'rejected' | 'cancelled' | 'timedout' | 'killed';
  tally?: {
    ayes: bigint;
    nays: bigint;
    support: bigint;
  };
  submittedAt: number;
  submissionDeposit?: {
    who: SS58String;
    amount: bigint;
  };
  decisionDeposit?: {
    who: SS58String;
    amount: bigint;
  };
  deciding?: {
    since: number;
    confirming?: number;
  };
}

export interface SimulationResult {
  referendumId: number;
  executionSucceeded: boolean;
  events: Array<{
    section: string;
    method: string;
    data: unknown;
  }>;
  errors?: string[];
  blockExecuted?: number;
}

export interface ChopsticksConfig {
  endpoint: string;
  port?: number;
  block?: number;
  db?: string;
  'build-block-mode'?: 'batch' | 'manual' | 'instant';
  'import-storage'?: Record<string, unknown>;
  'mock-signature-host'?: boolean;
  'allow-unresolved-imports'?: boolean;
  'runtime-log-level'?: number;
}
