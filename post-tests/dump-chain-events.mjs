// Post-referendum test: dump decoded events from every forked chain, in-process.
//
// Reads events straight from the live chopsticks `Blockchain` objects instead of over the fork's
// WebSocket RPC, so it still works when the tool's own `--additional-chains` event collector hits a
// "No response received from RPC endpoint in 60s" timeout. For each chain it prints the events of
// the current head (the block the tool already built after the referendum), then builds `blocks`
// more blocks and prints those too, flagging anything that looks like a failure.
//
//   yarn cli test ... --post-test post-tests/dump-chain-events.mjs --post-test-args '{"blocks":1}'
//
// Args (JSON, all optional):
//   blocks   extra blocks to build per chain after printing the head (default 1)
//   only     array of labels/specNames to restrict to (default: every chain except `main`)
//   all      true to include `main` as well
//   verbose  print full event data (default: truncated to 300 chars, or ctx.verbose)
//
// Never throws on chain content — it is a reporter. It throws only if a chain has no usable
// in-process `chain` object.

import { log, printBlock, ROUTINE, RULE } from './lib/chopsticks-block.mjs';

const FAILISH = /Failed|Error|Incomplete|Overweight|BadOrigin|ItemFailed|WithErrors|Trapped/;

export default async function run(ctx) {
  const args = ctx.args && typeof ctx.args === 'object' ? ctx.args : {};
  const blocks = Number(args.blocks ?? 1);
  const max = args.verbose || ctx.verbose ? 4000 : 300;
  const only = Array.isArray(args.only) ? new Set(args.only) : undefined;
  const targets = ctx.chains.filter((c) => {
    if (only) return only.has(c.label) || only.has(c.specName);
    return args.all ? true : c.label !== ctx.main.label;
  });

  log(`\n${RULE}\nPost-test: dump chain events (${targets.map((c) => c.label).join(', ')})\n${RULE}`);
  const flagged = [];
  const dump = async (label, block, tag) => {
    const r = await printBlock(label, block, { max, tag, hide: ROUTINE, flag: FAILISH });
    flagged.push(...r.flagged);
  };
  for (const c of targets) {
    const chain = c.chain;
    if (!chain || typeof chain.newBlock !== 'function') {
      throw new Error(`${c.label}: no in-process chopsticks Blockchain available`);
    }
    log(`\n── ${c.label} (${c.specName}, ${c.kind}) ──`);
    await dump(c.label, chain.head, 'current head (built by the tool)');
    for (let i = 0; i < blocks; i++) {
      await dump(c.label, await chain.newBlock(), `+${i + 1}`);
    }
  }
  log(`\n${RULE}`);
  if (flagged.length) {
    log(`⚠️  ${flagged.length} failure-looking event(s):`);
    for (const f of flagged) log(`   • ${f}`);
  } else {
    log('✅ no failure-looking events on the dumped chains');
  }
}
