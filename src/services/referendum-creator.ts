import { getPolkadotSigner } from 'polkadot-api/signer';
import { Binary } from '@polkadot-api/substrate-bindings';
import { Keyring } from '@polkadot/keyring';
import { Logger } from '../utils/logger';
import { ChopsticksManager } from './chopsticks-manager';

// Alice's address on Substrate-based chains
export const ALICE_ADDRESS = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

/**
 * Fellowship collective storage to inject for Alice to be recognized as a ranked fellow
 */
export const FELLOWSHIP_STORAGE_INJECTION = {
  System: {
    Account: [
      [
        [ALICE_ADDRESS],
        {
          providers: 1,
          data: {
            free: '10000000000000000000',
          },
        },
      ],
    ],
  },
  FellowshipCollective: {
    $removePrefix: ['IdToIndex', 'IndexToId', 'MemberCount', 'Members'],
    IdToIndex: [
      [[0, ALICE_ADDRESS], 0],
      [[1, ALICE_ADDRESS], 0],
      [[2, ALICE_ADDRESS], 0],
      [[3, ALICE_ADDRESS], 0],
      [[4, ALICE_ADDRESS], 0],
      [[5, ALICE_ADDRESS], 0],
      [[6, ALICE_ADDRESS], 0],
      [[7, ALICE_ADDRESS], 0],
    ],
    IndexToId: [
      [[0, 0], ALICE_ADDRESS],
      [[1, 0], ALICE_ADDRESS],
      [[2, 0], ALICE_ADDRESS],
      [[3, 0], ALICE_ADDRESS],
      [[4, 0], ALICE_ADDRESS],
      [[5, 0], ALICE_ADDRESS],
      [[6, 0], ALICE_ADDRESS],
      [[7, 0], ALICE_ADDRESS],
    ],
    MemberCount: [
      [[0], 1],
      [[1], 1],
      [[2], 1],
      [[3], 1],
      [[4], 1],
      [[5], 1],
      [[6], 1],
      [[7], 1],
    ],
    Members: [[[ALICE_ADDRESS], { rank: 7 }]],
    Voting: [],
  },
};

/**
 * Minimal storage injection to fund Alice on any chain (for paying submission deposits, etc.)
 */
export const ALICE_ACCOUNT_INJECTION = {
  System: {
    Account: [
      [
        [ALICE_ADDRESS],
        {
          providers: 1,
          data: {
            free: '10000000000000000000',
          },
        },
      ],
    ],
  },
};

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

  /**
   * Creates a referendum on the given chain using Alice account
   * @param api - The typed API for the chain
   * @param submitCallHex - Hex string of the referendum submit call
   * @param preimageCallHex - Optional hex string of the preimage note call
   * @param isFellowship - Whether this is a fellowship referendum
   * @returns The created referendum ID and preimage status
   */
  private static validateHex(input: string, paramName: string): string {
    const hex = input.startsWith('0x') ? input : `0x${input}`;
    if (!/^0x[0-9a-fA-F]*$/.test(hex)) {
      throw new Error(`Invalid hex string for ${paramName}: ${input}`);
    }
    return hex;
  }

  async createReferendum(
    api: any,
    submitCallHex: string,
    preimageCallHex?: string,
    isFellowship: boolean = false
  ): Promise<ReferendumCreationResult> {
    // Validate hex inputs
    const validatedSubmitHex = ReferendumCreator.validateHex(submitCallHex, 'submitCall');

    // Create Alice account from keyring
    const keyring = new Keyring({ type: 'sr25519' });
    const alice = keyring.addFromUri('//Alice');
    const signer = getPolkadotSigner(alice.publicKey, 'Sr25519', alice.sign);

    this.logger.info(
      `Creating ${isFellowship ? 'fellowship' : 'governance'} referendum using Alice account...`
    );

    // Note preimage if provided
    let preimageNoted = false;
    if (preimageCallHex) {
      const validatedPreimageHex = ReferendumCreator.validateHex(preimageCallHex, 'preimageCall');
      this.logger.startSpinner('Noting preimage...');
      let preimageCall;
      try {
        preimageCall = await api.txFromCallData(Binary.fromHex(validatedPreimageHex));
      } catch (e) {
        this.logger.failSpinner('Failed to decode preimage call data');
        throw new Error(
          `Invalid preimage call data for this chain's runtime. The hex may have been generated for a different runtime version or chain. Original error: ${(e as Error).message}`
        );
      }

      // Sign the transaction and pass it directly to newBlock to avoid race conditions.
      // Using signAndSubmit in fire-and-forget mode can cause the extrinsic to not be in the
      // tx pool when newBlock() is called, because the async validation/broadcast pipeline
      // may not have completed yet.
      const signedPreimageTx = await preimageCall.sign(signer);
      this.logger.debug('Preimage transaction signed');

      // Create block with the signed transaction included directly
      await this.chopsticks.newBlock({ transactions: [signedPreimageTx] });
      await this.chopsticks.newBlock();

      this.logger.succeedSpinner('Preimage noted successfully');
      preimageNoted = true;
    }

    // Submit referendum
    this.logger.startSpinner('Submitting referendum...');
    let submitCall;
    try {
      submitCall = await api.txFromCallData(Binary.fromHex(validatedSubmitHex));
    } catch (e) {
      this.logger.failSpinner('Failed to decode referendum submit call data');
      throw new Error(
        `Invalid referendum submit call data for this chain's runtime. The hex may have been generated for a different runtime version or chain. Original error: ${(e as Error).message}`
      );
    }

    // Read referendum count BEFORE submitting so we can determine the new ID
    const palletQuery = isFellowship ? api.query.FellowshipReferenda : api.query.Referenda;
    const countBefore = Number(await palletQuery.ReferendumCount.getValue());
    this.logger.debug(`Referendum count before submit: ${countBefore}`);

    // Sign the transaction and pass it directly to newBlock to avoid race conditions.
    const signedSubmitTx = await submitCall.sign(signer);
    this.logger.debug('Referendum transaction signed');

    // Create block with the signed transaction included directly
    await this.chopsticks.newBlock({ transactions: [signedSubmitTx] });
    await this.chopsticks.newBlock();

    this.logger.succeedSpinner('Referendum submitted successfully');

    // Retrieve referendum ID from ReferendumCount (most reliable method)
    this.logger.startSpinner('Retrieving referendum ID...');

    const countAfter = Number(await palletQuery.ReferendumCount.getValue());
    this.logger.debug(`Referendum count after submit: ${countAfter}`);

    let referendumId: number | undefined;
    if (countAfter > countBefore) {
      // The new referendum ID is countAfter - 1 (0-indexed)
      referendumId = countAfter - 1;
      this.logger.debug(`Referendum ID determined from count: #${referendumId}`);
    }

    if (referendumId === undefined) {
      this.logger.failSpinner('Referendum count did not increase — submission may have failed');
      throw new Error(
        'No new referendum detected after submission. The call data may be invalid or the origin may lack permissions.'
      );
    }

    this.logger.succeedSpinner(`Referendum #${referendumId} created successfully`);

    return {
      referendumId,
      preimageNoted,
    };
  }

  /**
   * Gets the fellowship storage injection object for Alice
   */
  static getFellowshipStorageInjection(): any {
    return FELLOWSHIP_STORAGE_INJECTION;
  }

  /**
   * Gets a minimal storage injection to fund Alice on any chain
   */
  static getAliceAccountInjection(): any {
    return ALICE_ACCOUNT_INJECTION;
  }
}
