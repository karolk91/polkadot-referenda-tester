#!/usr/bin/env node

import { Command } from 'commander';
import { testReferendum } from './commands/test-referendum';
import { listReferendums } from './commands/list-referendums';
import { version } from '../package.json';
import { enableBigIntSerialization } from './utils/json';

// Enable global BigInt serialization
enableBigIntSerialization();

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
    'Governance chain RPC endpoint URL. Format: url or url,block (e.g., wss://polkadot.io or wss://polkadot.io,12345)'
  )
  .option(
    '--fellowship-chain-url <url>',
    'Fellowship chain RPC endpoint URL. Format: url or url,block (only required when using --fellowship)'
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
    'Comma-separated list of additional chain URLs to monitor for XCM events. Format: url or url,block (e.g., wss://chain1.io,11111,wss://chain2.io)'
  )
  .action(testReferendum);

// List all referendums
program
  .command('list')
  .description('List all referendums and their current status')
  .option(
    '--governance-chain-url <url>',
    'Governance chain RPC endpoint URL. Format: url or url,block (e.g., wss://polkadot.io or wss://polkadot.io,12345)'
  )
  .option(
    '--fellowship-chain-url <url>',
    'Fellowship chain RPC endpoint URL. Format: url or url,block'
  )
  .option(
    '--status <status>',
    'Filter by status (e.g., ongoing, approved, rejected, cancelled, timedout, killed)'
  )
  .option('-v, --verbose', 'Enable verbose logging')
  .action(listReferendums);

program.parse();
