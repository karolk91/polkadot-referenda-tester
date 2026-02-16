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
}

export interface ReferendumInfo {
  id: number;
  track: string;
  origin: any;
  proposal: {
    hash: string; // Hex string representation
    call: any;
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
    who: string;
    amount: bigint;
  };
  decisionDeposit?: {
    who: string;
    amount: bigint;
  };
  deciding?: {
    since: number;
    confirming?: number;
  };
}

export interface SimulationResult {
  success: boolean;
  referendumId: number;
  executionSucceeded: boolean;
  events: Array<{
    section: string;
    method: string;
    data: any;
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
  'import-storage'?: Record<string, any>;
  'mock-signature-host'?: boolean;
  'allow-unresolved-imports'?: boolean;
  'runtime-log-level'?: number;
}
