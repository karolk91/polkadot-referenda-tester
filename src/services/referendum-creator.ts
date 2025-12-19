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
  ParasDisputes: {
    $removePrefix: ['disputes'], // those can make block building super slow
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
  async createReferendum(
    api: any,
    submitCallHex: string,
    preimageCallHex?: string,
    isFellowship: boolean = false
  ): Promise<ReferendumCreationResult> {
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
      this.logger.startSpinner('Noting preimage...');
      const preimageCall = await api.txFromCallData(Binary.fromHex(preimageCallHex));

      // Submit to transaction pool (don't await - manual block mode)
      preimageCall.signAndSubmit(signer);

      this.logger.debug('Preimage transaction submitted to pool');

      // Create blocks to include the transaction
      await this.chopsticks.newBlock();
      await this.chopsticks.newBlock();

      this.logger.succeedSpinner('Preimage noted successfully');
      preimageNoted = true;
    }

    // Submit referendum
    this.logger.startSpinner('Submitting referendum...');
    const submitCall = await api.txFromCallData(Binary.fromHex(submitCallHex));

    // Submit to transaction pool (don't await - manual block mode)
    submitCall.signAndSubmit(signer);

    this.logger.debug('Referendum transaction submitted to pool');

    // Create blocks to include the transaction
    await this.chopsticks.newBlock();
    await this.chopsticks.newBlock();

    this.logger.succeedSpinner('Referendum submitted successfully');

    // Pull events to get referendum ID
    this.logger.startSpinner('Retrieving referendum ID from events...');
    let events;
    if (isFellowship) {
      events = await api.event.FellowshipReferenda.Submitted.pull();
    } else {
      events = await api.event.Referenda.Submitted.pull();
    }

    if (!events || events.length === 0) {
      this.logger.failSpinner('No referendum submission event found');
      throw new Error('No referendum submission event found');
    }

    if (events.length > 1) {
      this.logger.warn(`Found ${events.length} referendum events, using the first one`);
    }

    const referendumId = events[0].payload.index;
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
}
