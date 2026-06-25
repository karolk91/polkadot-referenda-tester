import { describe, expect, it } from 'vitest';
import {
  ALICE_ADDRESS,
  FELLOWSHIP_STORAGE_INJECTION,
} from '../utils/storage-constants';

/**
 * Regression tests for the fellowship storage injection.
 *
 * Background: a fellowship referendum proposal commonly calls into
 * `FellowshipCore` (e.g. `coreFellowship.approve(who, rank)`) which reads the
 * target member's rank from `FellowshipCollective`. An earlier version of the
 * injection used Chopsticks' `$removePrefix` to WIPE `FellowshipCollective`
 * (Members/IdToIndex/IndexToId/MemberCount) and re-add only Alice. That desynced
 * `FellowshipCollective` from `FellowshipCore`, so enacting a proposal that
 * referenced any real fellow failed with `FellowshipCore.Unranked`.
 *
 * The injection must therefore be ADDITIVE: register Alice without destroying
 * the forked chain's existing fellowship members.
 */
describe('FELLOWSHIP_STORAGE_INJECTION', () => {
  const fellowship = FELLOWSHIP_STORAGE_INJECTION.FellowshipCollective as Record<
    string,
    unknown
  >;

  it('does not wipe existing FellowshipCollective storage ($removePrefix)', () => {
    // The wipe is what desynced FellowshipCollective from FellowshipCore and
    // caused FellowshipCore.Unranked on enactment. It must never come back.
    expect(fellowship).not.toHaveProperty('$removePrefix');

    // Belt-and-braces: no key anywhere in the injection requests a prefix removal.
    expect(JSON.stringify(FELLOWSHIP_STORAGE_INJECTION)).not.toContain(
      '$removePrefix'
    );
  });

  it('additively registers Alice as a high-rank fellow', () => {
    const members = fellowship.Members as Array<[[string], { rank: number }]>;
    expect(Array.isArray(members)).toBe(true);

    const aliceEntry = members.find(([[addr]]) => addr === ALICE_ADDRESS);
    expect(aliceEntry).toBeDefined();
    // Rank 9 covers every Polkadot/Kusama fellowship track's submit origin.
    expect(aliceEntry?.[1].rank).toBe(9);
  });

  it('only touches Alice in Members (no other members overwritten)', () => {
    const members = fellowship.Members as Array<[[string], { rank: number }]>;
    // Exactly one Members entry — Alice. Anything else would clobber a real
    // fellow at that key on the forked chain.
    expect(members).toHaveLength(1);
    expect(members[0][0][0]).toBe(ALICE_ADDRESS);
  });

  it('funds Alice so she can pay the submission deposit', () => {
    const accounts = (
      FELLOWSHIP_STORAGE_INJECTION.System as {
        Account: Array<[[string], { data: { free: string } }]>;
      }
    ).Account;
    const aliceAccount = accounts.find(([[addr]]) => addr === ALICE_ADDRESS);
    expect(aliceAccount).toBeDefined();
    expect(BigInt(aliceAccount?.[1].data.free ?? '0')).toBeGreaterThan(0n);
  });
});
