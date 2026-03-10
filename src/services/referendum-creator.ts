import { Keyring } from '@polkadot/keyring';
import { Binary } from '@polkadot-api/substrate-bindings';
import type { PolkadotSigner } from 'polkadot-api';
import { getPolkadotSigner } from 'polkadot-api/signer';
import type { SubstrateApi } from '../types/substrate-api';
import { formatDispatchError } from '../utils/dispatch-result';
import { getBlockEvents } from '../utils/event-serializer';
import { toHexString } from '../utils/hex';
import { stringify } from '../utils/json';
import type { Logger } from '../utils/logger';
import {
  ALICE_ACCOUNT_INJECTION,
  ALICE_ADDRESS,
  FELLOWSHIP_STORAGE_INJECTION,
} from '../utils/storage-constants';
import { getReferendaPallet } from './chain-registry';
import type { ChopsticksManager } from './chopsticks-manager';

export { ALICE_ADDRESS, FELLOWSHIP_STORAGE_INJECTION, ALICE_ACCOUNT_INJECTION };

export interface ReferendumCreationResult {
  referendumId: number;
  preimageNoted: boolean;
}

export class ReferendumCreator {
  private logger: Logger;
  private chopsticks: ChopsticksManager;

  constructor(logger: Logger, chopsticks: ChopsticksManager) {
    this.logger = logger;
    this.chopsticks = chopsticks;
  }

  private static validateHex(input: string, paramName: string): string {
    const hex = toHexString(input) as string;
    if (!/^0x[0-9a-fA-F]*$/.test(hex)) {
      throw new Error(`Invalid hex string for ${paramName}: ${input}`);
    }
    return hex;
  }

  async createReferendum(
    api: SubstrateApi,
    submitCallHex: string,
    preimageCallHex?: string,
    isFellowship: boolean = false
  ): Promise<ReferendumCreationResult> {
    const validatedSubmitHex = ReferendumCreator.validateHex(submitCallHex, 'submitCall');

    const keyring = new Keyring({ type: 'sr25519' });
    const alice = keyring.addFromUri('//Alice');
    const signer = getPolkadotSigner(alice.publicKey, 'Sr25519', alice.sign);

    this.logger.info(
      `Creating ${isFellowship ? 'fellowship' : 'governance'} referendum using Alice account...`
    );

    const preimageNoted = preimageCallHex
      ? await this.notePreimage(api, signer, preimageCallHex)
      : false;

    const referendumId = await this.submitAndRetrieveId(
      api,
      signer,
      validatedSubmitHex,
      isFellowship
    );

    return { referendumId, preimageNoted };
  }

  private async decodeAndSignCall(
    api: SubstrateApi,
    signer: PolkadotSigner,
    validatedHex: string,
    failureLabel: string
  ): Promise<string> {
    const decoded = await api.txFromCallData(Binary.fromHex(validatedHex)).catch((e: Error) => {
      this.logger.failSpinner(`Failed to decode ${failureLabel} call data`);
      throw new Error(
        `Invalid ${failureLabel} call data for this chain's runtime. The hex may have been generated for a different runtime version or chain. Original error: ${e.message}`
      );
    });

    const signedTx = await decoded.sign(signer);
    this.logger.debug(`${failureLabel} transaction signed`);
    return signedTx;
  }

  private async notePreimage(
    api: SubstrateApi,
    signer: PolkadotSigner,
    preimageCallHex: string
  ): Promise<boolean> {
    const validatedHex = ReferendumCreator.validateHex(preimageCallHex, 'preimageCall');
    this.logger.startSpinner('Noting preimage...');

    const signedPreimageTx = await this.decodeAndSignCall(api, signer, validatedHex, 'preimage');

    await this.chopsticks.newBlock({ transactions: [signedPreimageTx] });
    await this.chopsticks.newBlock();

    this.logger.succeedSpinner('Preimage noted successfully');
    return true;
  }

  private async submitAndRetrieveId(
    api: SubstrateApi,
    signer: PolkadotSigner,
    validatedSubmitHex: string,
    isFellowship: boolean
  ): Promise<number> {
    this.logger.startSpinner('Submitting referendum...');

    const palletQuery = getReferendaPallet(api, isFellowship);
    const countBefore = Number(await palletQuery.ReferendumCount.getValue());
    this.logger.debug(`Referendum count before submit: ${countBefore}`);

    const signedSubmitTx = await this.decodeAndSignCall(
      api,
      signer,
      validatedSubmitHex,
      'referendum submit'
    );

    await this.chopsticks.newBlock({ transactions: [signedSubmitTx] });

    const events = await getBlockEvents(api.query.System.Events, this.logger);
    if (events.length > 0) {
      this.logger.debug(`Submit block events (${events.length} total):`);
      for (const parsed of events) {
        this.logger.debug(`  ${parsed.section}.${parsed.method}`);
        if (parsed.section === 'System' && parsed.method === 'ExtrinsicFailed') {
          const errMsg = formatDispatchError(parsed.data);
          this.logger.error(`Extrinsic dispatch failed: ${errMsg}`);
          this.logger.error(`Full error data: ${stringify(parsed.data, 2)}`);
        }
      }
    }

    await this.chopsticks.newBlock();
    this.logger.succeedSpinner('Referendum submitted successfully');

    this.logger.startSpinner('Retrieving referendum ID...');
    const countAfter = Number(await palletQuery.ReferendumCount.getValue());
    this.logger.debug(`Referendum count after submit: ${countAfter}`);

    if (countAfter <= countBefore) {
      this.logger.failSpinner('Referendum count did not increase — submission may have failed');
      throw new Error(
        'No new referendum detected after submission. The call data may be invalid or the origin may lack permissions.'
      );
    }

    const referendumId = countAfter - 1;
    this.logger.debug(`Referendum ID determined from count: #${referendumId}`);
    this.logger.succeedSpinner(`Referendum #${referendumId} created successfully`);

    return referendumId;
  }

  static getFellowshipStorageInjection(): Record<string, unknown> {
    return FELLOWSHIP_STORAGE_INJECTION;
  }

  static getAliceAccountInjection(): Record<string, unknown> {
    return ALICE_ACCOUNT_INJECTION;
  }
}
