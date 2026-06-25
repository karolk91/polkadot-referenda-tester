/** Alice's well-known SS58 address on Substrate dev chains */
export const ALICE_ADDRESS = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

/**
 * Fellowship collective storage injection: registers Alice as a rank-9 fellow
 * (additively, without disturbing existing members) and funds her account.
 *
 * Only the `Members` entry is needed: submitting a fellowship referendum checks
 * the SubmitOrigin's rank via `FellowshipCollective.Members[who].rank`, and this
 * tool force-writes the passing tally rather than casting real votes — so the
 * IdToIndex/IndexToId/MemberCount voting maps are never read and are left intact.
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
    Members: [[[ALICE_ADDRESS], { rank: 9 }]],
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
