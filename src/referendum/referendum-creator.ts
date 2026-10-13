import { fromHex, toHex } from '@polkadot-api/utils';
import type { HexString } from 'polkadot-api';
import { getTxCreator, type TxCreator } from 'polkadot-api/tx-creator';
import type { ReferendumSource } from '../types';
import { aliceKeyPair } from '../utils/alice';
import { blockEvents } from '../utils/events';
import type { Logger } from '../utils/logger';
import { extrinsicFailureMessages } from './execution-result-checker';
import type { ReferendaKind } from './referenda-kind';
import type { SimulationTarget } from './simulation-runner';

async function includeInBlock(
  { api, manager }: SimulationTarget,
  creator: TxCreator,
  callHex: HexString,
  description: string
): Promise<string[]> {
  const decoded = await api.txFromCallData(fromHex(callHex)).catch((error: Error) => {
    throw new Error(
      `Invalid ${description} call data for this chain's runtime. The hex may have been generated for a different runtime version or chain. Original error: ${error.message}`
    );
  });
  await manager.newBlock({ transactions: [toHex(await decoded.create(creator))] });
  const failures = extrinsicFailureMessages(await blockEvents(api));
  await manager.newBlock();
  return failures;
}

export async function createReferendum(
  target: SimulationTarget,
  source: Extract<ReferendumSource, { kind: 'create' }>,
  kind: ReferendaKind,
  logger: Logger
): Promise<number> {
  const alice = aliceKeyPair();
  const creator = getTxCreator(alice.publicKey, 'Sr25519', alice.sign);
  logger.info(`Creating ${kind.label.toLowerCase()} referendum using Alice account...`);

  if (source.preimageCall) {
    logger.startSpinner('Noting preimage...');
    const failures = await includeInBlock(target, creator, source.preimageCall, 'preimage');
    if (failures.length > 0) {
      logger.failSpinner(`Preimage extrinsic failed: ${failures.join('; ')}`);
    } else {
      logger.succeedSpinner('Preimage noted successfully');
    }
  }

  logger.startSpinner('Submitting referendum...');
  const referenda = kind.pallet(target.api);
  const countBefore = Number(await referenda.ReferendumCount.getValue());
  const failures = await includeInBlock(target, creator, source.submitCall, 'referendum submit');
  if (failures.length > 0) {
    throw new Error(`Referendum submit extrinsic failed: ${failures.join('; ')}`);
  }
  const countAfter = Number(await referenda.ReferendumCount.getValue());
  if (countAfter <= countBefore) {
    throw new Error(
      'No new referendum detected after submission. The call data may be invalid or the origin may lack permissions.'
    );
  }
  const referendumId = countAfter - 1;
  logger.succeedSpinner(`Referendum #${referendumId} submitted`);
  return referendumId;
}
