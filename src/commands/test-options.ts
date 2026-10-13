import { Command, CommanderError, InvalidArgumentError } from 'commander';
import type { HexString } from 'polkadot-api';
import type { PreCall, ReferendumSource, ReferendumStep, StepReferenda } from '../types';
import { listBundledPostTests } from '../utils/bundled-post-tests';

export const THEN_FLAG = '--then';

export const STEP_FIELDS = [
  {
    key: 'referendum',
    flags: '-r, --referendum <id>',
    description: 'Governance referendum ID to test',
  },
  {
    key: 'fellowship',
    flags: '-f, --fellowship <id>',
    description: 'Fellowship referendum ID (for whitelisting scenarios)',
  },
  {
    key: 'preCall',
    flags: '--pre-call <hex>',
    description:
      'Hex string of a call to execute before the referendum of a step with one referendum (via Scheduler.Inline)',
  },
  {
    key: 'preOrigin',
    flags: '--pre-origin <origin>',
    description:
      'Origin of the pre-call (e.g., "Root", "WhitelistedCaller", "Origins.Treasurer"); requires --pre-call',
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
    description:
      'Call data to note preimage for governance referendum (hex, optional; requires --call-to-create-governance-referendum)',
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
    description:
      'Call data to note preimage for fellowship referendum (hex, optional; requires --call-to-create-fellowship-referendum)',
  },
  {
    key: 'postTest',
    flags: '--post-test <module>',
    description: `Post-referendum test module run against the live post-execution network: a bundled name (${listBundledPostTests().join(', ') || 'none bundled'}) or a path to your own module (./my-post-test.mjs, .ts/.js/.cjs/.mjs). It exports a function (default/postTest/run) receiving { main, chains, args, step } where each chain has { label, specName, network, kind, wsEndpoint, chain }; it builds blocks on the forks via dev RPCs or the in-process chain and throws to report a failure.`,
  },
  {
    key: 'postTestArgs',
    flags: '--post-test-args <json>',
    description:
      'Value passed to the post-test as `args` (parsed as JSON when possible, otherwise the raw string); requires --post-test',
  },
] as const;

type StepField = (typeof STEP_FIELDS)[number];

export type StepOptions = { [Field in StepField as Field['key']]?: string };

export const DEFAULT_BRIDGE_URLS = {
  assetHubPolkadot: 'wss://polkadot-asset-hub-rpc.polkadot.io',
  bridgeHubPolkadot: 'wss://polkadot-bridge-hub-rpc.polkadot.io',
  bridgeHubKusama: 'wss://kusama-bridge-hub-rpc.polkadot.io',
} as const;

export interface RunOptions {
  governanceChainUrl?: string;
  fellowshipChainUrl?: string;
  additionalChains?: string;
  assetHubPolkadotUrl: string;
  bridgeHubPolkadotUrl: string;
  bridgeHubKusamaUrl: string;
  bridgePumpRounds: number;
  cleanup: boolean;
  verbose: boolean;
  thenSteps?: ReferendumStep[];
}

export type TestOptions = RunOptions & StepOptions;

const REFERENDUM_KEYS: ReadonlyArray<StepField['key']> = [
  'referendum',
  'fellowship',
  'callToCreateGovernanceReferendum',
  'callToCreateFellowshipReferendum',
];

function longFlag(flags: string): string {
  return flags.split(',').pop()!.trim().split(' ')[0];
}

const STEP_FLAG_LIST = STEP_FIELDS.map((field) => longFlag(field.flags)).join(', ');

export const THEN_HELP = `
Chaining referenda:
  Put ${THEN_FLAG} between referendum steps to run several of them, in order, on the same forked
  network. Every segment after ${THEN_FLAG} takes the same per-referendum flags as the first one
  (${STEP_FLAG_LIST}). Run-level flags (chain URLs, --additional-chains, --no-cleanup, -v, bridge
  URLs) go before the first ${THEN_FLAG}. Each step runs on the state the previous steps and
  their post-tests produced.

  Example: authorize an upgrade, apply it, then run a referendum that requires the new runtime:
    test --governance-chain-url <ah> --fellowship-chain-url <collectives> \\
         -r 1942 -f 612 --post-test apply-authorized-upgrade \\
           --post-test-args '{"release":"v2.5.0"}' \\
         ${THEN_FLAG} -r 1944 --post-test dump-chain-events
`;

export function positiveInteger(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidArgumentError('must be a positive integer.');
  }
  return value;
}

function referendumId(raw: string, description: string, prefix: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${prefix}Invalid ${description} ID: ${raw}`);
  }
  return Number(raw);
}

function callHex(raw: string, flag: string, prefix: string): HexString {
  const hex = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) {
    throw new Error(`${prefix}Invalid hex string for ${flag}: ${raw}`);
  }
  return hex as HexString;
}

interface SourceFlags {
  description: string;
  id: string;
  create: string;
  preimage: string;
}

const GOVERNANCE_FLAGS: SourceFlags = {
  description: 'referendum',
  id: '--referendum',
  create: '--call-to-create-governance-referendum',
  preimage: '--call-to-note-preimage-for-governance-referendum',
};

const FELLOWSHIP_FLAGS: SourceFlags = {
  description: 'fellowship referendum',
  id: '--fellowship',
  create: '--call-to-create-fellowship-referendum',
  preimage: '--call-to-note-preimage-for-fellowship-referendum',
};

function referendumSource(
  idRaw: string | undefined,
  createRaw: string | undefined,
  preimageRaw: string | undefined,
  flags: SourceFlags,
  prefix: string
): ReferendumSource | undefined {
  if (idRaw !== undefined && createRaw !== undefined) {
    throw new Error(
      `${prefix}Cannot specify both ${flags.id} (existing ID) and ${flags.create} (create new). Use one or the other.`
    );
  }
  if (preimageRaw !== undefined && createRaw === undefined) {
    throw new Error(`${prefix}${flags.preimage} requires ${flags.create}`);
  }
  if (idRaw !== undefined) {
    return { kind: 'existing', id: referendumId(idRaw, flags.description, prefix) };
  }
  if (createRaw === undefined) {
    return undefined;
  }
  const submitCall = callHex(createRaw, flags.create, prefix);
  return preimageRaw === undefined
    ? { kind: 'create', submitCall }
    : { kind: 'create', submitCall, preimageCall: callHex(preimageRaw, flags.preimage, prefix) };
}

function stepReferenda(
  governance: ReferendumSource | undefined,
  fellowship: ReferendumSource | undefined,
  preCall: PreCall | undefined,
  prefix: string
): StepReferenda {
  if (governance && fellowship) {
    if (preCall) {
      throw new Error(`${prefix}--pre-call applies only to a step with one referendum`);
    }
    return { kind: 'fellowshipThenGovernance', fellowship, governance };
  }
  if (governance) {
    return preCall
      ? { kind: 'governance', governance, preCall }
      : { kind: 'governance', governance };
  }
  if (fellowship) {
    return preCall
      ? { kind: 'fellowship', fellowship, preCall }
      : { kind: 'fellowship', fellowship };
  }
  throw new Error(
    `${prefix}At least one referendum must be specified (--referendum, --fellowship) or created (--call-to-create-governance-referendum, --call-to-create-fellowship-referendum)`
  );
}

export function stepFromOptions(options: StepOptions, label?: string): ReferendumStep {
  const prefix = label ? `${label}: ` : '';
  const governance = referendumSource(
    options.referendum,
    options.callToCreateGovernanceReferendum,
    options.callToNotePreimageForGovernanceReferendum,
    GOVERNANCE_FLAGS,
    prefix
  );
  const fellowship = referendumSource(
    options.fellowship,
    options.callToCreateFellowshipReferendum,
    options.callToNotePreimageForFellowshipReferendum,
    FELLOWSHIP_FLAGS,
    prefix
  );
  if (options.preOrigin !== undefined && options.preCall === undefined) {
    throw new Error(`${prefix}--pre-origin requires --pre-call`);
  }
  if (options.postTestArgs !== undefined && options.postTest === undefined) {
    throw new Error(`${prefix}--post-test-args requires --post-test`);
  }
  const preCall: PreCall | undefined =
    options.preCall === undefined
      ? undefined
      : { call: callHex(options.preCall, '--pre-call', prefix), origin: options.preOrigin };
  const referenda = stepReferenda(governance, fellowship, preCall, prefix);
  return options.postTest === undefined
    ? { referenda }
    : { referenda, postTest: { module: options.postTest, args: options.postTestArgs } };
}

export function buildSteps(options: TestOptions): ReferendumStep[] {
  const chained = options.thenSteps ?? [];
  const hasTopLevelReferendum = REFERENDUM_KEYS.some((key) => options[key] !== undefined);
  if (hasTopLevelReferendum || chained.length === 0) {
    return [stepFromOptions(options), ...chained];
  }
  const orphans = STEP_FIELDS.filter((field) => options[field.key] !== undefined).map((field) =>
    longFlag(field.flags)
  );
  if (orphans.length > 0) {
    throw new Error(
      `Step flags without a referendum in the same segment: ${orphans.join(', ')}. Move them after the ${THEN_FLAG} for their referendum.`
    );
  }
  return chained;
}

export function addStepOptions(command: Command): Command {
  for (const { flags, description } of STEP_FIELDS) {
    command.option(flags, description);
  }
  return command;
}

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

export function parseThenSegment(args: string[], label: string): ReferendumStep {
  if (args.length === 0) {
    throw new Error(`${label}: no referendum flags after ${THEN_FLAG}`);
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
  return stepFromOptions(parser.opts() as StepOptions, label);
}

export function parseThenSegments(segments: string[][]): ReferendumStep[] {
  return segments.map((segment, index) => parseThenSegment(segment, `${THEN_FLAG} #${index + 1}`));
}
