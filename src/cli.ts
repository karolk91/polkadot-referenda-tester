#!/usr/bin/env node

// Force blocking writes on stdout/stderr. When the CLI is launched as a subprocess
// (e.g. from integration tests) Node defaults to block-buffered output on pipes —
// up to 64 KB of progress logs can sit in a buffer for minutes before flushing,
// which makes a live `tail -F` of the captured output go silent and hides what
// stage the tool is at when a long-running invocation times out. Setting the
// underlying handle to blocking mode makes every `console.log` reach the pipe
// immediately. Guarded so it's a no-op when the handle doesn't expose
// `setBlocking` (e.g. when redirected through certain wrappers).
for (const stream of [process.stdout, process.stderr] as const) {
  const handle = (stream as unknown as { _handle?: { setBlocking?: (b: boolean) => void } })
    ._handle;
  if (handle && typeof handle.setBlocking === 'function') {
    handle.setBlocking(true);
  }
}

import { Command } from 'commander';
import { version } from '../package.json';
import { DEFAULT_MAX_PUMP_ROUNDS } from './bridge/bridge-pump';
import { listReferendums } from './commands/list-referendums';
import {
  addStepOptions,
  DEFAULT_BRIDGE_URLS,
  parseThenSegments,
  positiveInteger,
  splitArgvOnThen,
  THEN_FLAG,
  THEN_HELP,
} from './commands/test-options';
import { testReferendum } from './commands/test-referendum';

const ENDPOINT_FORMAT =
  'url, url,block, or path to a chopsticks YAML config (endpoint, wasm-override, import-storage, ...)';

function addChainOptions(command: Command): Command {
  return command
    .option(
      '--governance-chain-url <url>',
      `Governance chain RPC endpoint URL. Format: ${ENDPOINT_FORMAT}`
    )
    .option(
      '--fellowship-chain-url <url>',
      `Fellowship chain RPC endpoint URL. Format: ${ENDPOINT_FORMAT}`
    )
    .option('-v, --verbose', 'Enable verbose logging');
}

const program = new Command();

program
  .name('polkadot-referenda-tester')
  .description('CLI tool to test Polkadot referenda execution using Chopsticks')
  .version(version);

// `--then` splits the `test` arguments into referendum steps that all use the same per-referendum
// flags. Commander cannot parse repeated option groups, so split first: commander parses the main
// segment, and the `test` preAction hook below parses the later segments.
const { main: mainArgs, segments: thenSegments } = splitArgvOnThen(process.argv.slice(2));

const testCommand = addChainOptions(
  addStepOptions(
    program
      .command('test')
      .description(
        'Test a referendum by simulating its execution. Chain several referenda with --then (see below).'
      )
  )
)
  .option('--no-cleanup', 'Leave the Chopsticks forks running after the run for manual inspection')
  .option(
    '--additional-chains <urls>',
    `Comma-separated list of additional chains to fork alongside the primary chains, such as relay chains or other chains whose events matter. Relay chains are detected from their runtime spec_name. Each entry: ${ENDPOINT_FORMAT}. E.g., wss://rpc.polkadot.io,wss://kusama-rpc.polkadot.io,./configs/some-chain.yml`
  )
  .option(
    '--asset-hub-polkadot-url <url>',
    `Polkadot Asset Hub RPC endpoint URL for the bridged scenario. Format: ${ENDPOINT_FORMAT}`,
    DEFAULT_BRIDGE_URLS.assetHubPolkadot
  )
  .option(
    '--bridge-hub-polkadot-url <url>',
    `Polkadot Bridge Hub RPC endpoint URL for the bridged scenario. Format: ${ENDPOINT_FORMAT}`,
    DEFAULT_BRIDGE_URLS.bridgeHubPolkadot
  )
  .option(
    '--bridge-hub-kusama-url <url>',
    `Kusama Bridge Hub RPC endpoint URL for the bridged scenario. Format: ${ENDPOINT_FORMAT}`,
    DEFAULT_BRIDGE_URLS.bridgeHubKusama
  )
  .option(
    '--bridge-pump-rounds <n>',
    'Max bridge pump rounds before giving up',
    positiveInteger,
    DEFAULT_MAX_PUMP_ROUNDS
  )
  .addHelpText('after', THEN_HELP)
  // The `--then` segments become `options.thenSteps`; parse errors use commander's own reporting.
  .hook('preAction', (command) => {
    try {
      command.setOptionValue('thenSteps', parseThenSegments(thenSegments));
    } catch (error) {
      command.error(`error: ${(error as Error).message}`);
    }
  })
  .action(testReferendum);

program.hook('preAction', (_program, actionCommand) => {
  if (thenSegments.length > 0 && actionCommand !== testCommand) {
    actionCommand.error(`error: ${THEN_FLAG} is only supported by the "test" command`);
  }
});

addChainOptions(
  program.command('list').description('List all referendums and their current status')
)
  .option(
    '--status <status>',
    'Filter by status (e.g., ongoing, approved, rejected, cancelled, timedout, killed)'
  )
  .action(listReferendums);

program.parse(mainArgs, { from: 'user' });
