import { describe, expect, it } from 'vitest';
import {
  buildSteps,
  parseThenSegment,
  parseThenSegments,
  splitArgvOnThen,
  type TestOptions,
} from '../commands/test-options';
import type { ReferendumSource, ReferendumStep } from '../types';
import { fellowshipStep, governanceStep, testOptions } from './helpers';

const base = testOptions();

function existing(id: number): ReferendumSource {
  return { kind: 'existing', id };
}

function dualStep(fellowshipId: number, governanceId: number): ReferendumStep {
  return {
    referenda: {
      kind: 'fellowshipThenGovernance',
      fellowship: existing(fellowshipId),
      governance: existing(governanceId),
    },
  };
}

describe('splitArgvOnThen', () => {
  it('main segment only without --then', () => {
    expect(splitArgvOnThen(['test', '-r', '1', '-v'])).toEqual({
      main: ['test', '-r', '1', '-v'],
      segments: [],
    });
  });

  it('one segment per --then, without the separators', () => {
    const argv = ['test', '-r', '1942', '-f', '612'];
    for (const id of ['1944', '1945', '1946']) argv.push('--then', '-r', id);

    expect(splitArgvOnThen(argv)).toEqual({
      main: ['test', '-r', '1942', '-f', '612'],
      segments: [
        ['-r', '1944'],
        ['-r', '1945'],
        ['-r', '1946'],
      ],
    });
  });

  it('empty segment for a trailing or doubled --then', () => {
    expect(
      splitArgvOnThen(['test', '-r', '1', '--then']).segments,
      'the parser reports an empty segment instead of ignoring a misplaced --then'
    ).toEqual([[]]);
    expect(splitArgvOnThen(['test', '-r', '1', '--then', '--then', '-r', '2']).segments).toEqual([
      [],
      ['-r', '2'],
    ]);
  });
});

describe('parseThenSegment', () => {
  it('short and long referendum flags', () => {
    expect(parseThenSegment(['-r', '1944'], '--then #1')).toEqual(governanceStep(1944));
    expect(parseThenSegment(['--referendum', '1944'], '--then #1')).toEqual(governanceStep(1944));
    expect(parseThenSegment(['-f', '613'], '--then #1')).toEqual(fellowshipStep(613));
  });

  it('fellowship referendum, governance creation, preimage and post-test in one segment', () => {
    expect(
      parseThenSegment(
        [
          '-f',
          '613',
          '--call-to-create-governance-referendum',
          '0xaa',
          '--call-to-note-preimage-for-governance-referendum',
          '0xbb',
          '--post-test',
          'post-tests/x.mjs',
          '--post-test-args',
          '{"blocks":2}',
        ],
        '--then #1'
      )
    ).toEqual({
      referenda: {
        kind: 'fellowshipThenGovernance',
        fellowship: existing(613),
        governance: { kind: 'create', submitCall: '0xaa', preimageCall: '0xbb' },
      },
      postTest: { module: 'post-tests/x.mjs', args: '{"blocks":2}' },
    });
  });

  it('pre-call with its origin on a single-referendum step', () => {
    expect(
      parseThenSegment(['-r', '1', '--pre-call', '0xcc', '--pre-origin', 'Root'], '--then #1')
    ).toEqual({
      referenda: {
        kind: 'governance',
        governance: existing(1),
        preCall: { call: '0xcc', origin: 'Root' },
      },
    });
  });

  it('error for an empty segment', () => {
    expect(() => parseThenSegment([], '--then #2')).toThrow(
      '--then #2: no referendum flags after --then'
    );
  });

  it('error with the correct position for a run-level flag', () => {
    expect(() =>
      parseThenSegment(['--governance-chain-url', 'wss://x', '-r', '1'], '--then #1')
    ).toThrow(
      /--then #1: unknown option '--governance-chain-url'.*run-level flags go before the first --then/
    );
  });

  it('error for a stray positional argument', () => {
    expect(() => parseThenSegment(['1944'], '--then #1')).toThrow(/--then #1: too many arguments/);
  });

  it('same validation as the top-level flags, with the segment label', () => {
    expect(() =>
      parseThenSegment(['-r', '1', '--call-to-create-governance-referendum', '0x'], '--then #1')
    ).toThrow(
      '--then #1: Cannot specify both --referendum (existing ID) and --call-to-create-governance-referendum (create new). Use one or the other.'
    );
    expect(() => parseThenSegment(['--post-test', 'x.mjs'], '--then #3')).toThrow(
      /--then #3: At least one referendum must be specified/
    );
    expect(() => parseThenSegment(['-r', 'abc'], '--then #1')).toThrow(
      '--then #1: Invalid referendum ID: abc'
    );
  });
});

describe('parseThenSegments', () => {
  it('steps in segment order', () => {
    expect(
      parseThenSegments([
        ['-r', '1'],
        ['-f', '2'],
        ['--call-to-create-governance-referendum', '0xaa'],
        ['-r', '4', '--post-test', 'dump-chain-events'],
      ])
    ).toEqual([
      governanceStep(1),
      fellowshipStep(2),
      { referenda: { kind: 'governance', governance: { kind: 'create', submitCall: '0xaa' } } },
      { ...governanceStep(4), postTest: { module: 'dump-chain-events', args: undefined } },
    ]);
  });

  it('error label with the position of the invalid segment', () => {
    expect(() => parseThenSegments([['-r', '1'], []])).toThrow('--then #2: no referendum flags');
    expect(() =>
      parseThenSegments([
        ['-r', '1'],
        ['-r', '2'],
        ['-r', '3'],
        ['-r', 'nope'],
      ])
    ).toThrow('--then #4: Invalid referendum ID: nope');
  });
});

describe('buildSteps', () => {
  it('first step from the top-level flags', () => {
    expect(
      buildSteps({
        ...base,
        referendum: '1942',
        fellowship: '612',
        postTest: 'a.mjs',
        postTestArgs: '{"x":1}',
      })
    ).toEqual([{ ...dualStep(612, 1942), postTest: { module: 'a.mjs', args: '{"x":1}' } }]);
  });

  it('--then steps after the top-level step', () => {
    expect(
      buildSteps({
        ...base,
        referendum: '1942',
        fellowship: '612',
        thenSteps: [governanceStep(1944), fellowshipStep(613)],
      })
    ).toEqual([dualStep(612, 1942), governanceStep(1944), fellowshipStep(613)]);
  });

  it('run of --then steps only', () => {
    expect(buildSteps({ ...base, thenSteps: [governanceStep(1), governanceStep(2)] })).toEqual([
      governanceStep(1),
      governanceStep(2),
    ]);
  });

  it('error for top-level step flags without a top-level referendum', () => {
    expect(() =>
      buildSteps({ ...base, postTest: 'a.mjs', thenSteps: [governanceStep(1)] })
    ).toThrow(
      'Step flags without a referendum in the same segment: --post-test. Move them after the --then for their referendum.'
    );
  });

  it('errors for invalid top-level referendum flags', () => {
    expect(() => buildSteps(base)).toThrow(
      'At least one referendum must be specified (--referendum, --fellowship) or created (--call-to-create-governance-referendum, --call-to-create-fellowship-referendum)'
    );
    expect(() =>
      buildSteps({ ...base, referendum: '1', callToCreateGovernanceReferendum: '0x' })
    ).toThrow(
      'Cannot specify both --referendum (existing ID) and --call-to-create-governance-referendum (create new). Use one or the other.'
    );
    expect(() =>
      buildSteps({ ...base, fellowship: '1', callToCreateFellowshipReferendum: '0x' })
    ).toThrow(
      'Cannot specify both --fellowship (existing ID) and --call-to-create-fellowship-referendum (create new). Use one or the other.'
    );
    expect(() => buildSteps({ ...base, referendum: 'nope' })).toThrow(
      'Invalid referendum ID: nope'
    );
    expect(() => buildSteps({ ...base, fellowship: 'nope' })).toThrow(
      'Invalid fellowship referendum ID'
    );
  });

  it('errors for flags without the flag they modify', () => {
    const cases: Array<[Partial<TestOptions>, string]> = [
      [
        { referendum: '1', callToNotePreimageForGovernanceReferendum: '0xaa' },
        '--call-to-note-preimage-for-governance-referendum requires --call-to-create-governance-referendum',
      ],
      [
        { fellowship: '1', callToNotePreimageForFellowshipReferendum: '0xaa' },
        '--call-to-note-preimage-for-fellowship-referendum requires --call-to-create-fellowship-referendum',
      ],
      [{ referendum: '1', preOrigin: 'Root' }, '--pre-origin requires --pre-call'],
      [{ referendum: '1', postTestArgs: '{}' }, '--post-test-args requires --post-test'],
    ];
    for (const [options, message] of cases) {
      expect(
        () => buildSteps({ ...base, ...options }),
        'the tool would otherwise ignore the flag and run a different test than the user requested'
      ).toThrow(message);
    }
  });

  it('error for a pre-call on a step with two referenda', () => {
    expect(
      () => buildSteps({ ...base, referendum: '1', fellowship: '2', preCall: '0xcc' }),
      'the step cannot tell which of the two referenda the pre-call precedes'
    ).toThrow('--pre-call applies only to a step with one referendum');
  });

  it('call data with or without the 0x prefix', () => {
    expect(buildSteps({ ...base, callToCreateGovernanceReferendum: 'aabb' })).toEqual([
      { referenda: { kind: 'governance', governance: { kind: 'create', submitCall: '0xaabb' } } },
    ]);
  });

  it('error for call data that is not whole bytes of hex', () => {
    for (const call of ['0xzz', '0xabc', 'hello']) {
      expect(
        () => buildSteps({ ...base, callToCreateGovernanceReferendum: call }),
        'invalid call data must fail before the tool forks any chain'
      ).toThrow(`Invalid hex string for --call-to-create-governance-referendum: ${call}`);
    }
  });
});
