import type { ChopsticksManager } from '../network/chopsticks-manager';
import type { PreCall, ReferendumSource } from '../types';
import type { SubstrateApi } from '../types/substrate-api';
import type { ParsedEvent } from '../utils/events';
import type { Logger } from '../utils/logger';
import { fetchReferendum } from './referenda-fetcher';
import type { ReferendaKind } from './referenda-kind';
import { createReferendum } from './referendum-creator';
import { ReferendumSimulator } from './referendum-simulator';

export interface SimulationTarget {
  api: SubstrateApi;
  manager: ChopsticksManager;
}

export interface ReferendumRun {
  target: SimulationTarget;
  source: ReferendumSource;
  kind: ReferendaKind;
  preCall?: PreCall;
  label?: string;
}

async function referendumIdOf(
  { target, source, kind }: ReferendumRun,
  label: string,
  logger: Logger
): Promise<number> {
  if (source.kind === 'existing') return source.id;
  logger.section(`Creating ${label} Referendum`);
  const referendumId = await createReferendum(target, source, kind, logger);
  logger.success(`${label} referendum #${referendumId} created successfully`);
  return referendumId;
}

export async function simulateReferendum(
  run: ReferendumRun,
  logger: Logger
): Promise<{ referendumId: number; events: ParsedEvent[] }> {
  const { target, kind, preCall, label = kind.label } = run;
  const referendumId = await referendumIdOf(run, label, logger);
  const referendum = await fetchReferendum(target.api, referendumId, kind, logger);
  const simulator = new ReferendumSimulator(logger, target.manager, target.api, kind);
  const { outcome, events } = await simulator.simulate(referendum, preCall);
  logger.success(
    outcome === 'executed'
      ? `\n✓ ${label} referendum #${referendumId} executed successfully!`
      : `\n✓ ${label} referendum #${referendumId} was already enacted; nothing to execute`
  );
  return { referendumId, events };
}
