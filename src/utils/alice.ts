import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';

export function aliceKeyPair(): KeyringPair {
  return new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
}
