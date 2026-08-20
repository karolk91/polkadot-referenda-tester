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
