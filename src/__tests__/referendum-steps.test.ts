import { describe, expect, it } from 'vitest';
import type { ReferendumStep } from '../types';
import { describeStep, referendumCreations } from '../utils/referendum-steps';

const GOVERNANCE_EXISTING: ReferendumStep = {
  referenda: { kind: 'governance', governance: { kind: 'existing', id: 1944 } },
};
const FELLOWSHIP_EXISTING: ReferendumStep = {
  referenda: { kind: 'fellowship', fellowship: { kind: 'existing', id: 613 } },
};
const GOVERNANCE_CREATION: ReferendumStep = {
  referenda: { kind: 'governance', governance: { kind: 'create', submitCall: '0xaa' } },
  postTest: { module: 'post-tests/dump.mjs' },
};
const FELLOWSHIP_CREATION_THEN_GOVERNANCE: ReferendumStep = {
  referenda: {
    kind: 'fellowshipThenGovernance',
    fellowship: { kind: 'create', submitCall: '0xbb' },
    governance: { kind: 'existing', id: 1942 },
  },
};

describe('referendumCreations', () => {
  it('creation flags of every step in the run', () => {
    expect(
      referendumCreations([GOVERNANCE_EXISTING, FELLOWSHIP_CREATION_THEN_GOVERNANCE]),
      'the fork of each chain must fund Alice before the first step, for a creation in any later step'
    ).toEqual({ governance: false, fellowship: true });
    expect(referendumCreations([FELLOWSHIP_EXISTING, GOVERNANCE_CREATION])).toEqual({
      governance: true,
      fellowship: false,
    });
  });
});

describe('describeStep', () => {
  it('fellowship before governance, then the post-test file name', () => {
    expect(
      describeStep({
        referenda: {
          kind: 'fellowshipThenGovernance',
          fellowship: { kind: 'existing', id: 612 },
          governance: { kind: 'existing', id: 1942 },
        },
      })
    ).toBe('fellowship #612 + governance #1942');
    expect(describeStep(GOVERNANCE_CREATION)).toBe(
      'create governance referendum + post-test dump.mjs'
    );
  });
});
