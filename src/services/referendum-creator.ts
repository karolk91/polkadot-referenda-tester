import { Keyring } from '@polkadot/keyring';
import { Binary } from '@polkadot-api/substrate-bindings';
import { getPolkadotSigner } from 'polkadot-api/signer';
import { formatDispatchError } from '../utils/dispatch-result';
import { parseBlockEvent } from '../utils/event-serializer';
import { stringify } from '../utils/json';
import type { Logger } from '../utils/logger';
import { getReferendaPallet } from './chain-registry';
import type { ChopsticksManager } from './chopsticks-manager';

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
      [[8, ALICE_ADDRESS], 0],
      [[9, ALICE_ADDRESS], 0],
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
      [[8, 0], ALICE_ADDRESS],
      [[9, 0], ALICE_ADDRESS],
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
      [[8], 1],
      [[9], 1],
    ],
    Members: [[[ALICE_ADDRESS], { rank: 9 }]],
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

  private async notePreimage(api: any, signer: any, preimageCallHex: string): Promise<boolean> {
    const validatedHex = ReferendumCreator.validateHex(preimageCallHex, 'preimageCall');
    this.logger.startSpinner('Noting preimage...');

    let preimageCall: any;
    try {
      preimageCall = await api.txFromCallData(Binary.fromHex(validatedHex));
    } catch (e) {
      this.logger.failSpinner('Failed to decode preimage call data');
      throw new Error(
        `Invalid preimage call data for this chain's runtime. The hex may have been generated for a different runtime version or chain. Original error: ${(e as Error).message}`
      );
    }

    // Sign and pass directly to newBlock to avoid race conditions with async tx pool
    const signedPreimageTx = await preimageCall.sign(signer);
    this.logger.debug('Preimage transaction signed');

    await this.chopsticks.newBlock({ transactions: [signedPreimageTx] });
    await this.chopsticks.newBlock();

    this.logger.succeedSpinner('Preimage noted successfully');
    return true;
  }

  private async submitAndRetrieveId(
    api: any,
    signer: any,
    validatedSubmitHex: string,
    isFellowship: boolean
  ): Promise<number> {
    this.logger.startSpinner('Submitting referendum...');

    let submitCall: any;
    try {
      submitCall = await api.txFromCallData(Binary.fromHex(validatedSubmitHex));
    } catch (e) {
      this.logger.failSpinner('Failed to decode referendum submit call data');
      throw new Error(
        `Invalid referendum submit call data for this chain's runtime. The hex may have been generated for a different runtime version or chain. Original error: ${(e as Error).message}`
      );
    }

    const palletQuery = getReferendaPallet(api, isFellowship);
    const countBefore = Number(await palletQuery.ReferendumCount.getValue());
    this.logger.debug(`Referendum count before submit: ${countBefore}`);

    // Sign and pass directly to newBlock to avoid race conditions with async tx pool
    const signedSubmitTx = await submitCall.sign(signer);
    this.logger.debug('Referendum transaction signed');

    await this.chopsticks.newBlock({ transactions: [signedSubmitTx] });

    try {
      const events = await api.query.System.Events.getValue();
      if (events && Array.isArray(events)) {
        this.logger.debug(`Submit block events (${events.length} total):`);
        for (const rawEvent of events) {
          const parsed = parseBlockEvent(rawEvent);
          this.logger.debug(`  ${parsed.section}.${parsed.method}`);
          if (parsed.section === 'System' && parsed.method === 'ExtrinsicFailed') {
            const errMsg = formatDispatchError(parsed.data);
            this.logger.error(`Extrinsic dispatch failed: ${errMsg}`);
            this.logger.error(`Full error data: ${stringify(parsed.data, 2)}`);
          }
        }
      }
    } catch (eventErr) {
      this.logger.debug(`Failed to read submit block events: ${eventErr}`);
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
