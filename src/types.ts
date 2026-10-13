import type { HexString } from 'polkadot-api';
import type { ParsedEvent } from './utils/events';

export type ReferendumSource =
  | { kind: 'existing'; id: number }
  | { kind: 'create'; submitCall: HexString; preimageCall?: HexString };

export interface PreCall {
  call: HexString;
  origin?: string;
}

export type StepReferenda =
  | { kind: 'governance'; governance: ReferendumSource; preCall?: PreCall }
  | { kind: 'fellowship'; fellowship: ReferendumSource; preCall?: PreCall }
  | {
      kind: 'fellowshipThenGovernance';
      fellowship: ReferendumSource;
      governance: ReferendumSource;
    };

export interface PostTest {
  module: string;
  args?: string;
}

/**
 * One referendum step of a run. A run is an ordered list of steps executed on ONE forked network,
 * so each step runs on the state the previous steps produced, including changes made by a step's
 * post-test (for example applying a runtime upgrade).
 */
export interface ReferendumStep {
  referenda: StepReferenda;
  postTest?: PostTest;
}

export interface TaskAddress {
  block: number;
  index: number;
}

export type FetchedReferendum =
  | { status: 'ongoing'; id: number }
  | { status: 'approved'; id: number; enactment: TaskAddress }
  | { status: 'enacted'; id: number };

export interface SimulationResult {
  outcome: 'executed' | 'already-enacted';
  events: ParsedEvent[];
}
