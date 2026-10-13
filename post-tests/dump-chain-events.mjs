// Post-referendum test: dump decoded events from every forked chain, in-process.
//
// Reads events directly from the live chopsticks `Blockchain` objects instead of over the fork's
// WebSocket RPC, so it still works when the tool's own `--additional-chains` event collector
// reports a "No response received from RPC endpoint in 60s" timeout. For each chain it prints the events of
// the current head (the block the tool already built after the referendum), then builds `blocks`
// more blocks and prints those too, flagging every event that matches the failure pattern.
//
//   npm run cli -- test ... --post-test post-tests/dump-chain-events.mjs --post-test-args '{"blocks":1}'
//
// Args (JSON, all optional):
//   blocks   extra blocks to build per chain after printing the head (default 1)
//   only     array of labels/specNames to restrict to (default: every chain except `main`)
//   all      true to include `main` as well
//   verbose  print full event data (default: truncated to 300 chars, or ctx.verbose)
//
// Never throws on chain content; this script only reports. It throws only when a chain has no
// usable in-process `chain` object.

import {
  inProcessChain,
  log,
  postTestArgs,
  printBlock,
  ROUTINE,
  RULE,
  section,
  selectedChains,
} from './lib/chopsticks-block.mjs';

const FAILISH = /Failed|Error|Incomplete|Overweight|BadOrigin|ItemFailed|WithErrors|Trapped/;

export default async function run(ctx) {
  const args = postTestArgs(ctx);
  const blocks = Number(args.blocks ?? 1);
  const max = args.verbose || ctx.verbose ? 4000 : 300;
  const targets = selectedChains(ctx, args, { includeMain: Boolean(args.all) });

  section(`Post-test: dump chain events (${targets.map((target) => target.label).join(', ')})`);
  const flagged = [];
  const dump = async (label, block, tag) => {
    const printed = await printBlock(label, block, { max, tag, hide: ROUTINE, flag: FAILISH });
    flagged.push(...printed.flagged);
  };
  for (const target of targets) {
    const chain = inProcessChain(target);
    log(`\n── ${target.label} (${target.specName}, ${target.kind}) ──`);
    await dump(target.label, chain.head, 'current head (built by the tool)');
    for (let blockIndex = 0; blockIndex < blocks; blockIndex++) {
      await dump(target.label, await chain.newBlock(), `+${blockIndex + 1}`);
    }
  }
  log(`\n${RULE}`);
  if (flagged.length) {
    log(`⚠️  ${flagged.length} failure-looking event(s):`);
    for (const line of flagged) log(`   • ${line}`);
  } else {
    log('✅ no failure-looking events on the dumped chains');
  }
}
