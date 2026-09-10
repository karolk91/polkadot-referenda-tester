import { Command, CommanderError } from 'commander';
import type { ReferendumStep } from '../types';
import {
  STEP_FIELDS,
  STEP_FLAG_LIST,
  type StepOptions,
  stepFromOptions,
  THEN_FLAG,
  validateStep,
} from './referendum-steps';

export { THEN_FLAG };

/**
 * Referendum chaining — the command-line side.
 *
 *   test --governance-chain-url … --fellowship-chain-url … \
 *        -r 1942 -f 612 --post-test apply-authorized-upgrade \
 *        --then -r 1944 --post-test dump-chain-events
 *
 * Commander cannot parse repeated option groups, so the raw arguments are split on `--then`
 * first. The main segment goes through commander as usual; every later segment is parsed here
 * with the same {@link STEP_FIELDS}, so spellings, help text and validation stay identical.
 * Run-level flags (chain URLs, `--additional-chains`, `--no-cleanup`, `-v`, bridge URLs) belong
 * to the first segment only.
 */

export const THEN_HELP = `
Chaining referenda:
  Put ${THEN_FLAG} between referendum steps to run several of them, in order, on the same forked
  network. Every segment after ${THEN_FLAG} takes the same per-referendum flags as the first one
  (${STEP_FLAG_LIST}). Run-level flags (chain URLs, --additional-chains, --no-cleanup, -v, bridge
  URLs) go before the first ${THEN_FLAG}. Each step sees the state the previous steps (and their
  post-tests) left behind.

  Example — authorize an upgrade, apply it, then run a referendum that needs the new runtime:
    test --governance-chain-url <ah> --fellowship-chain-url <collectives> \\
         -r 1942 -f 612 --post-test apply-authorized-upgrade \\
           --post-test-args '{"release":"v2.5.0"}' \\
         ${THEN_FLAG} -r 1944 --post-test dump-chain-events
`;

/** Register the per-referendum flags on a command (the `test` command and every `--then` parser). */
export function addStepOptions(command: Command): Command {
  for (const { flags, description } of STEP_FIELDS) {
    command.option(flags, description);
  }
  return command;
}

/**
 * Split the raw CLI arguments (after `node script`) into the main segment and one segment per
 * `--then`. The `--then` tokens themselves are removed; commander never sees them.
 */
export function splitArgvOnThen(args: string[]): { main: string[]; segments: string[][] } {
  const main: string[] = [];
  const segments: string[][] = [];
  let current = main;
  for (const arg of args) {
    if (arg === THEN_FLAG) {
      current = [];
      segments.push(current);
    } else {
      current.push(arg);
    }
  }
  return { main, segments };
}

/**
 * Parse one `--then` segment. Anything that is not a per-referendum flag — a run-level flag such
 * as `--governance-chain-url`, a stray positional — is rejected with a message saying where it
 * belongs.
 */
export function parseThenSegment(args: string[], label: string): ReferendumStep {
  if (args.length === 0) {
    throw new Error(`${label}: no referendum flags given after ${THEN_FLAG}`);
  }
  const parser = addStepOptions(
    new Command()
      .exitOverride()
      .allowExcessArguments(false)
      .allowUnknownOption(false)
      .configureOutput({ writeErr: () => {}, writeOut: () => {} })
  );
  try {
    parser.parse(args, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      const detail = error.message.replace(/^error:\s*/i, '').trim();
      throw new Error(
        `${label}: ${detail}. A ${THEN_FLAG} segment takes only per-referendum flags (${STEP_FLAG_LIST}); run-level flags go before the first ${THEN_FLAG}.`
      );
    }
    throw error;
  }
  const step = stepFromOptions(parser.opts() as StepOptions, label);
  validateStep(step, label);
  return step;
}

/** Parse every `--then` segment, labelling them `--then #1`, `--then #2`, … */
export function parseThenSegments(segments: string[][]): ReferendumStep[] {
  return segments.map((segment, index) => parseThenSegment(segment, `${THEN_FLAG} #${index + 1}`));
}
