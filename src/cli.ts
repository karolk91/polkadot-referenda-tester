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
import { listReferendums } from './commands/list-referendums';
import { testReferendum } from './commands/test-referendum';

const program = new Command();

program
  .name('polkadot-referenda-tester')
  .description('CLI tool to test Polkadot referenda execution using Chopsticks')
  .version(version);

// Single chain referendum test
program
  .command('test')
  .description('Test a referendum by simulating its execution')
  .option(
    '--governance-chain-url <url>',
    'Governance chain RPC endpoint URL. Format: url, url,block, or path to a chopsticks YAML config (with endpoint+wasm-override+import-storage+...) (e.g., wss://polkadot.io or wss://polkadot.io,12345)'
  )
  .option(
    '--fellowship-chain-url <url>',
    'Fellowship chain RPC endpoint URL. Format: url, url,block, or path to a chopsticks YAML config (with endpoint+wasm-override+import-storage+...) (only required when using --fellowship)'
  )
  .option('-r, --referendum <id>', 'Main governance referendum ID to test')
  .option('-f, --fellowship <id>', 'Fellowship referendum ID (for whitelisting scenarios)')
  .option('-p, --port <port>', 'Local Chopsticks starting port', '8000')
  .option(
    '--pre-call <hex>',
    'Hex string of call to execute before the main referendum (via Scheduler.Inline)'
  )
  .option(
    '--pre-origin <origin>',
    'Origin for pre-execution call (e.g., "Root", "WhitelistedCaller", "Origins.Treasurer")'
  )
  .option('--no-cleanup', 'Keep Chopsticks instance running after test')
  .option('-v, --verbose', 'Enable verbose logging')
  .option(
    '--additional-chains <urls>',
    'Comma-separated list of additional chain URLs to spawn alongside the primary chains. Use this for relays (e.g. Polkadot relay, REQUIRED for the bridged scenario) and for monitoring other chains. Each entry: url, url,block, or path to a chopsticks YAML config (with endpoint+wasm-override+import-storage+...). Relays are auto-detected by URL (no parachain prefix). E.g., wss://rpc.polkadot.io,wss://kusama-rpc.polkadot.io,./configs/some-chain.yml'
  )
  .option(
    '--call-to-create-governance-referendum <hex>',
    'Call data to create a governance referendum (hex). Mutually exclusive with --referendum'
  )
  .option(
    '--call-to-note-preimage-for-governance-referendum <hex>',
    'Call data to note preimage for governance referendum (hex, optional)'
  )
  .option(
    '--call-to-create-fellowship-referendum <hex>',
    'Call data to create a fellowship referendum (hex). Mutually exclusive with --fellowship'
  )
  .option(
    '--call-to-note-preimage-for-fellowship-referendum <hex>',
    'Call data to note preimage for fellowship referendum (hex, optional)'
  )
  .option(
    '--asset-hub-polkadot-url <url>',
    'Polkadot Asset Hub RPC endpoint URL. Required when the bridged scenario is detected. Format: url, url,block, or path to a chopsticks YAML config (with endpoint+wasm-override+import-storage+...)'
  )
  .option(
    '--bridge-hub-polkadot-url <url>',
    'Polkadot Bridge Hub RPC endpoint URL. Required when the bridged scenario is detected. Format: url, url,block, or path to a chopsticks YAML config (with endpoint+wasm-override+import-storage+...)'
  )
  .option(
    '--asset-hub-kusama-url <url>',
    'Kusama Asset Hub RPC endpoint URL. Optional — defaults to --governance-chain-url when bridged. Format: url, url,block, or path to a chopsticks YAML config (with endpoint+wasm-override+import-storage+...)'
  )
  .option(
    '--bridge-hub-kusama-url <url>',
    'Kusama Bridge Hub RPC endpoint URL. Required when the bridged scenario is detected. Format: url, url,block, or path to a chopsticks YAML config (with endpoint+wasm-override+import-storage+...)'
  )
  .option('--bridge-pump-rounds <n>', 'Max bridge pump rounds before giving up (default: 8)')
  .action(testReferendum);

// List all referendums
program
  .command('list')
  .description('List all referendums and their current status')
  .option(
    '--governance-chain-url <url>',
    'Governance chain RPC endpoint URL. Format: url, url,block, or path to a chopsticks YAML config (with endpoint+wasm-override+import-storage+...) (e.g., wss://polkadot.io or wss://polkadot.io,12345)'
  )
  .option(
    '--fellowship-chain-url <url>',
    'Fellowship chain RPC endpoint URL. Format: url, url,block, or path to a chopsticks YAML config (with endpoint+wasm-override+import-storage+...)'
  )
  .option(
    '--status <status>',
    'Filter by status (e.g., ongoing, approved, rejected, cancelled, timedout, killed)'
  )
  .option('-v, --verbose', 'Enable verbose logging')
  .action(listReferendums);

program.parse();
