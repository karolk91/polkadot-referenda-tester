import { describe, expect, it } from 'vitest';
import type { TestOptions } from '../types';
import {
  buildSteps,
  describeStep,
  stepHasFellowship,
  stepHasGovernance,
} from '../utils/referendum-steps';
import { parseThenSegment, parseThenSegments, splitArgvOnThen } from '../utils/then-args';

const base: TestOptions = { port: '8000', cleanup: true, verbose: false };

describe('splitArgvOnThen', () => {
  it('returns everything as the main segment when --then is absent', () => {
    expect(splitArgvOnThen(['test', '-r', '1', '-v'])).toEqual({
      main: ['test', '-r', '1', '-v'],
      segments: [],
    });
  });

  it('splits into one segment per --then, dropping the separators', () => {
    expect(
      splitArgvOnThen([
        'test',
        '-r',
        '1942',
        '-f',
        '612',
        '--then',
        '-r',
        '1944',
        '--then',
        '-f',
        '613',
      ])
    ).toEqual({
      main: ['test', '-r', '1942', '-f', '612'],
      segments: [
        ['-r', '1944'],
        ['-f', '613'],
      ],
    });
  });

  it('keeps an empty segment for a trailing or doubled --then so it can be reported', () => {
    expect(splitArgvOnThen(['test', '-r', '1', '--then']).segments).toEqual([[]]);
    expect(splitArgvOnThen(['test', '-r', '1', '--then', '--then', '-r', '2']).segments).toEqual([
      [],
      ['-r', '2'],
    ]);
  });
});

describe('parseThenSegment', () => {
  it('accepts the short and long referendum flags', () => {
    expect(parseThenSegment(['-r', '1944'], '--then #1')).toEqual({ referendum: 1944 });
    expect(parseThenSegment(['--referendum', '1944'], '--then #1')).toEqual({ referendum: 1944 });
    expect(parseThenSegment(['-f', '613'], '--then #1')).toEqual({ fellowship: 613 });
  });

  it('accepts every per-referendum flag', () => {
    expect(
      parseThenSegment(
        [
          '-f',
          '613',
          '--call-to-create-governance-referendum',
          '0xaa',
          '--call-to-note-preimage-for-governance-referendum',
          '0xbb',
          '--pre-call',
          '0xcc',
          '--pre-origin',
          'Root',
          '--post-test',
          'post-tests/x.mjs',
          '--post-test-args',
          '{"blocks":2}',
        ],
        '--then #1'
      )
    ).toEqual({
      fellowship: 613,
      callToCreateGovernanceReferendum: '0xaa',
      callToNotePreimageForGovernanceReferendum: '0xbb',
      preCall: '0xcc',
      preOrigin: 'Root',
      postTest: 'post-tests/x.mjs',
      postTestArgs: '{"blocks":2}',
    });
  });

  it('rejects an empty segment', () => {
    expect(() => parseThenSegment([], '--then #2')).toThrow(
      '--then #2: no referendum flags given after --then'
    );
  });

  it('rejects run-level flags and says where they belong', () => {
    expect(() =>
      parseThenSegment(['--governance-chain-url', 'wss://x', '-r', '1'], '--then #1')
    ).toThrow(
      /--then #1: unknown option '--governance-chain-url'.*run-level flags go before the first --then/
    );
  });

  it('rejects stray positionals', () => {
    expect(() => parseThenSegment(['1944'], '--then #1')).toThrow(/--then #1: too many arguments/);
  });

  it('applies the same per-step validation as the top-level flags', () => {
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

  it('labels segments in order', () => {
    expect(() => parseThenSegments([['-r', '1'], []])).toThrow('--then #2: no referendum flags');
    expect(
      parseThenSegments([
        ['-r', '1'],
        ['-f', '2'],
      ])
    ).toEqual([{ referendum: 1 }, { fellowship: 2 }]);
  });
});

describe('buildSteps', () => {
  it('turns the top-level flags into the first step', () => {
    expect(
      buildSteps({
        ...base,
        referendum: '1942',
        fellowship: '612',
        postTest: 'a.mjs',
        postTestArgs: '{"x":1}',
      })
    ).toEqual([{ referendum: 1942, fellowship: 612, postTest: 'a.mjs', postTestArgs: '{"x":1}' }]);
  });

  it('appends the --then steps in order', () => {
    expect(
      buildSteps({
        ...base,
        referendum: '1942',
        fellowship: '612',
        thenSteps: [{ referendum: 1944 }, { callToCreateGovernanceReferendum: '0xaa' }],
      })
    ).toEqual([
      { referendum: 1942, fellowship: 612 },
      { referendum: 1944 },
      { callToCreateGovernanceReferendum: '0xaa' },
    ]);
  });

  it('allows a run made only of --then steps', () => {
    expect(buildSteps({ ...base, thenSteps: [{ referendum: 1 }, { referendum: 2 }] })).toEqual([
      { referendum: 1 },
      { referendum: 2 },
    ]);
  });

  it('rejects top-level post-test flags with no top-level referendum to attach to', () => {
    expect(() =>
      buildSteps({ ...base, postTest: 'a.mjs', thenSteps: [{ referendum: 1 }] })
    ).toThrow(
      '--post-test need a referendum in the same segment; move them after the --then they belong to'
    );
  });

  it('keeps the historical error messages for the top-level step', () => {
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

  it('validates chained steps with their label', () => {
    expect(() =>
      buildSteps({ ...base, referendum: '1', thenSteps: [{ postTest: 'x.mjs' }] })
    ).toThrow(/--then #1: At least one referendum/);
  });
});

describe('step helpers', () => {
  it('classifies steps', () => {
    expect(stepHasGovernance({ referendum: 1 })).toBe(true);
    expect(stepHasGovernance({ callToCreateGovernanceReferendum: '0x' })).toBe(true);
    expect(stepHasGovernance({ fellowship: 1 })).toBe(false);
    expect(stepHasFellowship({ fellowship: 1 })).toBe(true);
    expect(stepHasFellowship({ callToCreateFellowshipReferendum: '0x' })).toBe(true);
    expect(stepHasFellowship({ referendum: 1 })).toBe(false);
  });

  it('describes steps for logs', () => {
    expect(describeStep({ fellowship: 612, referendum: 1942 })).toBe(
      'fellowship #612 + governance #1942'
    );
    expect(
      describeStep({ callToCreateGovernanceReferendum: '0x', postTest: 'post-tests/dump.mjs' })
    ).toBe('create governance referendum + post-test dump.mjs');
  });
});
