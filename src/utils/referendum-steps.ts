import * as path from 'path';
import type { ReferendumStep, TestOptions } from '../types';

/**
 * Referendum chaining — the step model.
 *
 * A run is an ordered list of {@link ReferendumStep}s executed on ONE forked network. On the
 * command line the steps are separated by a bare `--then`, and every segment uses the same
 * per-referendum flags (see {@link STEP_FIELDS}). This module is the pure part: the field table,
 * predicates, validation and the options → step conversion. Parsing `--then` segments with
 * commander lives in `then-args.ts` so services can import this module without pulling in the CLI
 * framework.
 */

export const THEN_FLAG = '--then';

/** One per-referendum CLI flag and the {@link ReferendumStep} field it feeds. */
export interface StepField {
  key: keyof ReferendumStep;
  flags: string;
  description: string;
}

/**
 * Single source of truth for the per-referendum options: the `test` command registers them, every
 * `--then` segment is parsed with them, help text lists them, and {@link stepFromOptions} maps them.
 */
export const STEP_FIELDS: ReadonlyArray<StepField> = [
  {
    key: 'referendum',
    flags: '-r, --referendum <id>',
    description: 'Main governance referendum ID to test',
  },
  {
    key: 'fellowship',
    flags: '-f, --fellowship <id>',
    description: 'Fellowship referendum ID (for whitelisting scenarios)',
  },
  {
    key: 'preCall',
    flags: '--pre-call <hex>',
    description: 'Hex string of call to execute before the main referendum (via Scheduler.Inline)',
  },
  {
    key: 'preOrigin',
    flags: '--pre-origin <origin>',
    description:
      'Origin for pre-execution call (e.g., "Root", "WhitelistedCaller", "Origins.Treasurer")',
  },
  {
    key: 'callToCreateGovernanceReferendum',
    flags: '--call-to-create-governance-referendum <hex>',
    description:
      'Call data to create a governance referendum (hex). Mutually exclusive with --referendum',
  },
  {
    key: 'callToNotePreimageForGovernanceReferendum',
    flags: '--call-to-note-preimage-for-governance-referendum <hex>',
    description: 'Call data to note preimage for governance referendum (hex, optional)',
  },
  {
    key: 'callToCreateFellowshipReferendum',
    flags: '--call-to-create-fellowship-referendum <hex>',
    description:
      'Call data to create a fellowship referendum (hex). Mutually exclusive with --fellowship',
  },
  {
    key: 'callToNotePreimageForFellowshipReferendum',
    flags: '--call-to-note-preimage-for-fellowship-referendum <hex>',
    description: 'Call data to note preimage for fellowship referendum (hex, optional)',
  },
  {
    key: 'postTest',
    flags: '--post-test <module>',
    description:
      'Post-referendum test module run against the live post-execution network: a bundled name (apply-authorized-upgrade, dump-chain-events) or a path to your own module (./my-post-test.mjs, .ts/.js/.cjs/.mjs). It exports a function (default/postTest/run) receiving { main, chains, args, step } where each chain has { label, specName, network, kind, wsEndpoint, chain }; it drives the forks via dev RPCs or the in-process chain and throws to fail.',
  },
  {
    key: 'postTestArgs',
    flags: '--post-test-args <json>',
    description:
      'Value passed to the post-test as `args` (parsed as JSON when possible, otherwise the raw string).',
  },
];

/** `-r, --referendum <id>` → `--referendum`. */
export function longFlag(flags: string): string {
  return flags.split(',').pop()!.trim().split(' ')[0];
}

/** Comma-separated long flags of every step field, for help and error text. */
export const STEP_FLAG_LIST = STEP_FIELDS.map((field) => longFlag(field.flags)).join(', ');

/** Fields that by themselves make a step a referendum (as opposed to modifiers of one). */
const REFERENDUM_KEYS: ReadonlySet<keyof ReferendumStep> = new Set([
  'referendum',
  'fellowship',
  'callToCreateGovernanceReferendum',
  'callToCreateFellowshipReferendum',
]);

export function stepHasGovernance(step: ReferendumStep): boolean {
  return step.referendum !== undefined || !!step.callToCreateGovernanceReferendum;
}

export function stepHasFellowship(step: ReferendumStep): boolean {
  return step.fellowship !== undefined || !!step.callToCreateFellowshipReferendum;
}

export function stepHasReferendum(step: ReferendumStep): boolean {
  return stepHasGovernance(step) || stepHasFellowship(step);
}

/** Short human label for logs, e.g. `fellowship #612 + governance #1942 + post-test x.mjs`. */
export function describeStep(step: ReferendumStep): string {
  const parts: string[] = [];
  if (step.fellowship !== undefined) parts.push(`fellowship #${step.fellowship}`);
  else if (step.callToCreateFellowshipReferendum) parts.push('create fellowship referendum');
  if (step.referendum !== undefined) parts.push(`governance #${step.referendum}`);
  else if (step.callToCreateGovernanceReferendum) parts.push('create governance referendum');
  if (step.postTest) parts.push(`post-test ${path.basename(step.postTest)}`);
  return parts.join(' + ') || '(empty step)';
}

/**
 * Validate one step: an existing ID and a creation call are mutually exclusive per half, and a
 * step must name at least one referendum. `label` (e.g. `--then #2`) prefixes the message for
 * chained steps; the top-level step keeps the exact messages the tool has always produced.
 */
export function validateStep(step: ReferendumStep, label?: string): void {
  const prefix = label ? `${label}: ` : '';
  if (step.referendum !== undefined && step.callToCreateGovernanceReferendum) {
    throw new Error(
      `${prefix}Cannot specify both --referendum (existing ID) and --call-to-create-governance-referendum (create new). Use one or the other.`
    );
  }
  if (step.fellowship !== undefined && step.callToCreateFellowshipReferendum) {
    throw new Error(
      `${prefix}Cannot specify both --fellowship (existing ID) and --call-to-create-fellowship-referendum (create new). Use one or the other.`
    );
  }
  if (!stepHasReferendum(step)) {
    throw new Error(
      `${prefix}At least one referendum must be specified (--referendum, --fellowship) or created (--call-to-create-governance-referendum, --call-to-create-fellowship-referendum)`
    );
  }
}

function parseId(raw: string, key: 'referendum' | 'fellowship', label?: string): number {
  const id = /^\d+$/.test(raw.trim()) ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isNaN(id)) {
    const prefix = label ? `${label}: ` : '';
    throw new Error(
      key === 'referendum'
        ? `${prefix}Invalid referendum ID: ${raw}`
        : `${prefix}Invalid fellowship referendum ID`
    );
  }
  return id;
}

/** The per-referendum subset of the CLI options (top-level segment or a `--then` segment). */
export type StepOptions = Pick<TestOptions, keyof ReferendumStep>;

/** Convert parsed CLI options into a step (IDs parsed, absent fields omitted). Not validated. */
export function stepFromOptions(options: StepOptions, label?: string): ReferendumStep {
  const step: Record<string, unknown> = {};
  for (const { key } of STEP_FIELDS) {
    const raw = options[key];
    if (raw === undefined) continue;
    step[key] = key === 'referendum' || key === 'fellowship' ? parseId(raw, key, label) : raw;
  }
  return step as ReferendumStep;
}

/**
 * The ordered step list for a run: the top-level step (when it names a referendum) followed by
 * the already-parsed `--then` steps. Throws with the same messages a single-step invocation always
 * produced when the top-level flags are inconsistent.
 */
export function buildSteps(options: TestOptions): ReferendumStep[] {
  const first = stepFromOptions(options);
  const chained = options.thenSteps ?? [];
  const steps: ReferendumStep[] = [];

  if (stepHasReferendum(first) || chained.length === 0) {
    validateStep(first);
    steps.push(first);
  } else {
    // Top-level modifiers (pre-call, preimage, post-test) with no top-level referendum to attach to.
    const orphans = STEP_FIELDS.filter(
      (field) => !REFERENDUM_KEYS.has(field.key) && first[field.key] !== undefined
    ).map((field) => longFlag(field.flags));
    if (orphans.length > 0) {
      throw new Error(
        `${orphans.join(', ')} need a referendum in the same segment; move them after the ${THEN_FLAG} they belong to`
      );
    }
  }

  for (const [index, step] of chained.entries()) {
    validateStep(step, `${THEN_FLAG} #${index + 1}`);
  }
  steps.push(...chained);
  return steps;
}
