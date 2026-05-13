import { Blake2256 } from '@polkadot-api/substrate-bindings';
import { mergeUint8 } from '@polkadot-api/utils';
import { str, u32 } from 'scale-ts';

const ASSEMBLY_ID = new TextEncoder().encode('assembly');

/**
 * Compute the Scheduler task name pallet-referenda uses for a referendum's enactment:
 *   T::Scheduler::schedule_named((b"assembly", "enactment", index).using_encoded(blake2_256), ...)
 */
export function getEnactmentTaskName(referendumIndex: number): Uint8Array {
  return Blake2256(mergeUint8([ASSEMBLY_ID, str.enc('enactment'), u32.enc(referendumIndex)]));
}
