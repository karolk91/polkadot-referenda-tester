/** Alice's well-known SS58 address on Substrate dev chains */
export const ALICE_ADDRESS = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

/**
 * Fellowship collective storage injection: registers Alice as a rank-9 fellow
 * with member indices at ranks 0-9, plus funds her account.
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
