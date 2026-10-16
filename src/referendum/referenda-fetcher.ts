import type { FetchedReferendum } from '../types';
import type { SubstrateApi } from '../types/substrate-api';
import type { Logger } from '../utils/logger';
import { enactmentTaskName } from '../utils/scheduler-task-name';
import type { ReferendaKind } from './referenda-kind';
import { scheduledTaskAddress } from './scheduler-manager';

export async function fetchReferendum(
  api: SubstrateApi,
  referendumId: number,
  kind: ReferendaKind,
  logger: Logger
): Promise<FetchedReferendum> {
  const { palletName } = kind;
  const info = await kind.pallet(api).ReferendumInfoFor.getValue(referendumId);
  if (!info) {
    throw new Error(`Referendum #${referendumId} not found in ${palletName} pallet`);
  }
  logger.debug(`Referendum #${referendumId} in ${palletName}: ${info.type}`);
  if (info.type === 'Ongoing') {
    return { status: 'ongoing', id: referendumId };
  }
  if (info.type !== 'Approved') {
    throw new Error(
      `Referendum #${referendumId} is ${info.type.toLowerCase()}; only ongoing or approved referenda can be simulated`
    );
  }
  const enactment = await scheduledTaskAddress(api, enactmentTaskName(referendumId), logger);
  if (!enactment) {
    logger.info(
      `Referendum #${referendumId} is approved and its scheduled enactment has already executed`
    );
    return { status: 'enacted', id: referendumId };
  }
  logger.info(
    `Referendum #${referendumId} is approved with scheduled enactment at block ${enactment.block}`
  );
  return { status: 'approved', id: referendumId, enactment };
}
