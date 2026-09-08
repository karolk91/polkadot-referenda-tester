// Post-referendum test: apply the authorized runtime upgrade on every forked chain.
//
// Usage (after a referendum that emitted `System.UpgradeAuthorized` on the chains):
//
//   yarn cli test ... \
//     --post-test post-tests/apply-authorized-upgrade.mjs \
//     --post-test-args '{"release":"https://github.com/polkadot-fellows/runtimes/releases/tag/v2.5.0"}'
//
// For each chain handed to the post-test the script:
//   1. reads `System.AuthorizedUpgrade` (code_hash + check_version) — chains without one are skipped;
//   2. downloads the `*.compact.compressed.wasm` assets of the GitHub release (cached on disk),
//      blake2-256 hashes every asset and picks the one matching the on-chain authorized hash —
//      this IS the hash verification: the release artifact must hash to what governance approved;
//   3. submits an unsigned `System.apply_authorized_upgrade(code)` in a new block (in-process via
//      the live chopsticks `Blockchain`, so the block builder actually includes it);
//   4. keeps building blocks: relay chains switch code immediately (`System.CodeUpdated`), cumulus
//      parachains store a pending PVF first (`ParachainSystem.ValidationFunctionStored`) and chopsticks
//      delivers the relay `GoAhead` on the next block (`ValidationFunctionApplied` + `CodeUpdated`);
//      the block after `CodeUpdated` is the first one executed by the new runtime, i.e. where
//      `on_runtime_upgrade` single-block migrations run. If `MultiBlockMigrations` reports an active
//      cursor, it keeps building until the cursor clears (bounded by `maxMigrationBlocks`);
//   5. prints every block (extrinsics + decoded events), verifies `:code` now hashes to the authorized
//      hash and that `spec_version` matches the release asset, and prints a per-chain summary of the
//      post-upgrade activity (migration events, MBM progress, anything non-routine).
//
// Args (JSON via --post-test-args), all optional except a release/wasm source:
//   release            GitHub release URL ".../releases/tag/<tag>", "<owner>/<repo>@<tag>", or a bare
//                      tag (repo defaults to polkadot-fellows/runtimes)
//   wasmDir            local directory of *.wasm files to use instead of downloading
//   cacheDir           where downloaded assets go (default .cache/release-runtimes/<tag>)
//   blocksAfterUpgrade blocks to build after the code switch (default 3)
//   maxMigrationBlocks upper bound on extra blocks while MBM cursor is active (default 40)
//   only               array of labels/specNames to restrict the run to
//   failOnMissing      fail when a chain has an authorized upgrade but no matching asset (default true)
//
// Throws (=> tool exits non-zero) if any chain fails to apply/verify its upgrade.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { blake2AsHex } from '@polkadot/util-crypto';
import {
  eventKey,
  humanJson,
  log,
  printBlock,
  readStorage,
  ROUTINE,
  section,
} from './lib/chopsticks-block.mjs';

const DEFAULT_REPO = 'polkadot-fellows/runtimes';
const DEFAULT_BLOCKS_AFTER = 3;
const DEFAULT_MAX_MIGRATION_BLOCKS = 40;

// Events that carry the upgrade/migration story; everything else post-upgrade is reported as
// "other activity" so nothing is hidden, but these get highlighted.
const NOTABLE = new Set([
  'system.CodeUpdated',
  'parachainSystem.ValidationFunctionStored',
  'parachainSystem.ValidationFunctionApplied',
  'parachainSystem.ValidationFunctionDiscarded',
  'multiBlockMigrations.UpgradeStarted',
  'multiBlockMigrations.UpgradeCompleted',
  'multiBlockMigrations.UpgradeFailed',
  'multiBlockMigrations.MigrationSkipped',
  'multiBlockMigrations.MigrationAdvanced',
  'multiBlockMigrations.MigrationCompleted',
  'multiBlockMigrations.MigrationFailed',
  'multiBlockMigrations.HistoricCleared',
  'system.ExtrinsicFailed',
]);

// ---------------------------------------------------------------------------------------------
// Release resolution + download
// ---------------------------------------------------------------------------------------------

/** Parse the `release` arg into { owner, repo, tag }. */
export function parseRelease(release) {
  if (!release) throw new Error('post-test args need `release` (GitHub release URL/tag) or `wasmDir`');
  const url = release.match(/github\.com\/([^/]+)\/([^/]+)\/releases\/tag\/([^/?#]+)/);
  if (url) return { owner: url[1], repo: url[2], tag: decodeURIComponent(url[3]) };
  const at = release.match(/^([^/@\s]+)\/([^/@\s]+)@(.+)$/);
  if (at) return { owner: at[1], repo: at[2], tag: at[3] };
  const [owner, repo] = DEFAULT_REPO.split('/');
  return { owner, repo, tag: release };
}

function ghHeaders() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'polkadot-referenda-tester' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Download every `*.compact.compressed.wasm` asset of the release into cacheDir (skips cached files). */
export async function fetchReleaseWasms({ owner, repo, tag }, cacheDir) {
  const api = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetch(api, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${api}: ${(await res.text()).slice(0, 200)}`);
  const release = await res.json();
  const assets = (release.assets ?? []).filter((a) => /\.compact\.compressed\.wasm$/.test(a.name));
  if (assets.length === 0) throw new Error(`Release ${owner}/${repo}@${tag} has no *.compact.compressed.wasm assets`);
  mkdirSync(cacheDir, { recursive: true });

  const files = [];
  // Modest parallelism; the assets are ~1–2.5 MB each.
  const queue = [...assets];
  const workers = Array.from({ length: 4 }, async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      const file = path.join(cacheDir, a.name);
      if (existsSync(file) && statSync(file).size === a.size) {
        files.push({ name: a.name, file, cached: true });
        continue;
      }
      const dl = await fetch(a.browser_download_url, { headers: { 'User-Agent': 'polkadot-referenda-tester' } });
      if (!dl.ok) throw new Error(`Download failed ${dl.status}: ${a.browser_download_url}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      if (buf.length !== a.size) throw new Error(`Size mismatch for ${a.name}: got ${buf.length}, expected ${a.size}`);
      writeFileSync(file, buf);
      files.push({ name: a.name, file, cached: false });
    }
  });
  await Promise.all(workers);
  return { release: { owner, repo, tag, name: release.name, publishedAt: release.published_at }, files };
}

/** Load wasm files from a local directory. */
export function loadLocalWasms(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.wasm'))
    .map((f) => ({ name: f, file: path.join(dir, f), cached: true }));
  if (files.length === 0) throw new Error(`No *.wasm files in ${dir}`);
  return { release: { tag: `local:${dir}` }, files };
}

/**
 * Hash every wasm (blake2-256, what `authorize_upgrade` commits to) and index by hash. Only the
 * hash and the path are kept; the matched asset's bytes are read again when it is applied.
 */
export function indexWasmsByHash(files) {
  const byHash = new Map();
  for (const f of files) {
    const bytes = readFileSync(f.file);
    const specVersion = f.name.match(/-v(\d+)\./)?.[1];
    byHash.set(blake2AsHex(bytes, 256), {
      ...f,
      size: bytes.length,
      hash: blake2AsHex(bytes, 256),
      specVersion: specVersion ? Number(specVersion) : undefined,
    });
  }
  return byHash;
}

// ---------------------------------------------------------------------------------------------
// Chain state readers
// ---------------------------------------------------------------------------------------------

async function runtimeVersionOf(block) {
  const v = await block.runtimeVersion;
  return { specName: String(v.specName), specVersion: Number(v.specVersion), transactionVersion: Number(v.transactionVersion) };
}

async function codeHashOf(block) {
  return blake2AsHex(hexToU8a(await block.wasm), 256);
}

async function mbmCursor(block) {
  const meta = await block.meta;
  const q = meta.query.multiBlockMigrations?.cursor;
  if (!q) return { supported: false, active: false };
  const cursor = await readStorage(block, meta, q);
  return { supported: true, active: !!cursor, cursor: cursor ? humanJson(cursor, 400) : undefined };
}

// ---------------------------------------------------------------------------------------------
// Per-chain upgrade flow
// ---------------------------------------------------------------------------------------------

async function upgradeChain(ptChain, wasmsByHash, opts) {
  const { label, specName, kind } = ptChain;
  const chain = ptChain.chain;
  const result = { label, specName, kind, status: 'unknown', notes: [], notable: [], other: new Map() };

  if (!chain || typeof chain.newBlock !== 'function') {
    result.status = 'error';
    result.notes.push('no in-process chopsticks Blockchain on the post-test chain object');
    return result;
  }

  section(`${label} (${specName}, ${kind})`);
  let head = chain.head;
  let meta = await head.meta;
  const before = await runtimeVersionOf(head);
  const lastUpgradeBefore = await readStorage(head, meta, meta.query.system.lastRuntimeUpgrade);
  log(`  head: #${head.number} ${head.hash}`);
  log(`  runtime before: ${before.specName} v${before.specVersion} (tx v${before.transactionVersion})`);
  if (lastUpgradeBefore) log(`  System.LastRuntimeUpgrade before: ${humanJson(lastUpgradeBefore, 200)}`);

  // 1. Authorized upgrade on chain?
  const authorized = await readStorage(head, meta, meta.query.system.authorizedUpgrade);
  if (!authorized) {
    result.status = 'skipped';
    result.notes.push('no System.AuthorizedUpgrade in storage — nothing to apply');
    log(`  ⏭  ${result.notes[0]}`);
    return result;
  }
  const authorizedHash = authorized.codeHash.toHex();
  const checkVersion = authorized.checkVersion.isTrue;
  result.authorizedHash = authorizedHash;
  log(`  System.AuthorizedUpgrade: code_hash=${authorizedHash} check_version=${checkVersion}`);

  // 2. Match a release asset by hash (this is the hash verification).
  const asset = wasmsByHash.get(authorizedHash);
  if (!asset) {
    result.status = opts.failOnMissing ? 'failed' : 'skipped';
    result.notes.push(`no release asset hashes to ${authorizedHash}`);
    log(`  ❌ ${result.notes[0]}`);
    log(`     assets available: ${[...wasmsByHash.values()].map((a) => `${a.name}=${a.hash.slice(0, 10)}…`).join(', ')}`);
    return result;
  }
  const code = readFileSync(asset.file);
  result.asset = asset.name;
  log(`  ✅ hash verified: ${asset.name} blake2-256 == authorized code_hash`);
  log(`     size=${code.length} bytes sha256=${createHash('sha256').update(code).digest('hex')}${asset.specVersion ? ` asset spec_version=${asset.specVersion}` : ''}`);
  if (checkVersion && asset.specVersion !== undefined && asset.specVersion <= before.specVersion) {
    result.notes.push(`asset spec_version ${asset.specVersion} is not greater than current ${before.specVersion}; check_version=true will reject it`);
    log(`  ⚠️  ${result.notes.at(-1)}`);
  }

  // 3. Build the unsigned apply_authorized_upgrade extrinsic and include it in a block.
  const call = meta.tx.system.applyAuthorizedUpgrade(u8aToHex(code));
  const xtHex = meta.registry.createType('GenericExtrinsic', call).toHex();
  log(`  ⛏  building block with System.apply_authorized_upgrade (${code.length} bytes, unsigned)…`);
  const applyBlock = await chain.newBlock({ transactions: [xtHex] });
  const included = (await applyBlock.extrinsics).includes(xtHex);
  if (!included) {
    // The block builder drops extrinsics whose apply_extrinsic result is Err; dry-run for the reason.
    let reason = 'unknown';
    try {
      const { outcome } = await chain.dryRunExtrinsic(xtHex);
      reason = humanJson(outcome, 500);
    } catch (e) {
      reason = `dry-run threw: ${e.message}`;
    }
    result.status = 'failed';
    result.notes.push(`apply_authorized_upgrade was NOT included in block #${applyBlock.number}: ${reason}`);
    log(`  ❌ ${result.notes.at(-1)}`);
    await printBlock(label, applyBlock, { max: opts.max, tag: 'apply block (extrinsic dropped)', mark: NOTABLE });
    return result;
  }

  // 4. Walk blocks: the apply block, then enough blocks past the code switch (which lands one
  //    block later on parachains), extending while MBM is active.
  let codeUpdatedAt;
  let pvfStoredAt;
  let pvfAppliedAt;
  const collect = (blockNumber, events) => {
    const isPostUpgrade = codeUpdatedAt !== undefined && blockNumber > codeUpdatedAt;
    for (const ev of events) {
      const key = eventKey(ev);
      if (NOTABLE.has(key)) {
        result.notable.push(`#${blockNumber} ${key}${ev.event.data.length ? ` ${humanJson(ev.event.data, 300)}` : ''}`);
        if (key === 'system.CodeUpdated') codeUpdatedAt = codeUpdatedAt ?? blockNumber;
        if (key === 'parachainSystem.ValidationFunctionStored') pvfStoredAt = pvfStoredAt ?? blockNumber;
        if (key === 'parachainSystem.ValidationFunctionApplied') pvfAppliedAt = pvfAppliedAt ?? blockNumber;
        // MBM can start and finish inside one block, so the cursor poll below never sees it active.
        if (key === 'multiBlockMigrations.UpgradeStarted') result.mbmSeenActive = true;
      } else if (isPostUpgrade && !ROUTINE.has(key)) {
        result.other.set(key, (result.other.get(key) ?? 0) + 1);
      }
    }
  };

  const dump = async (block, tag) => {
    const { events } = await printBlock(label, block, { max: opts.max, tag, mark: NOTABLE });
    collect(block.number, events);
  };
  await dump(applyBlock, 'apply_authorized_upgrade');

  let last = applyBlock;
  let mbm = { supported: false, active: false };
  const sinceSwitch = () => last.number - (codeUpdatedAt ?? applyBlock.number);
  const extra = () => last.number - applyBlock.number;
  while (sinceSwitch() < opts.blocksAfterUpgrade || (mbm.active && extra() < opts.maxMigrationBlocks)) {
    last = await chain.newBlock();
    const tag = last.number === codeUpdatedAt + 1 ? 'first block on NEW runtime (on_runtime_upgrade runs here)' : undefined;
    await dump(last, tag);
    mbm = await mbmCursor(last);
    if (mbm.active) {
      result.mbmSeenActive = true;
      log(`     ⏳ MultiBlockMigrations cursor active: ${mbm.cursor}`);
    } else if (mbm.supported && result.mbmSeenActive) {
      log(`     ✅ MultiBlockMigrations cursor cleared`);
    }
  }
  if (mbm.active) result.notes.push(`stopped after ${extra()} extra blocks; MBM cursor still active`);
  result.blocks = { first: applyBlock.number, last: last.number };

  // 5. Verify the new code + version at head.
  head = chain.head;
  const after = await runtimeVersionOf(head);
  const headCodeHash = await codeHashOf(head);
  meta = await head.meta;
  const lastUpgradeAfter = await readStorage(head, meta, meta.query.system.lastRuntimeUpgrade);
  const stillAuthorized = await readStorage(head, meta, meta.query.system.authorizedUpgrade);
  result.before = before;
  result.after = after;
  result.codeUpdatedAt = codeUpdatedAt;
  result.pvfStoredAt = pvfStoredAt;
  result.pvfAppliedAt = pvfAppliedAt;
  result.mbm = mbm;

  log(`\n  runtime after:  ${after.specName} v${after.specVersion} (tx v${after.transactionVersion})`);
  if (lastUpgradeAfter) log(`  System.LastRuntimeUpgrade after: ${humanJson(lastUpgradeAfter, 200)}`);
  log(`  :code blake2-256 at head: ${headCodeHash}`);

  const checks = [];
  checks.push([codeUpdatedAt !== undefined, `System.CodeUpdated observed${codeUpdatedAt !== undefined ? ` at #${codeUpdatedAt}` : ''}`]);
  checks.push([headCodeHash === authorizedHash, `:code hash == authorized hash`]);
  if (asset.specVersion !== undefined) checks.push([after.specVersion === asset.specVersion, `spec_version ${after.specVersion} == asset ${asset.specVersion}`]);
  checks.push([after.specVersion > before.specVersion, `spec_version increased ${before.specVersion} → ${after.specVersion}`]);
  checks.push([after.specName === before.specName, `spec_name unchanged (${after.specName})`]);
  checks.push([!stillAuthorized, `System.AuthorizedUpgrade cleared`]);
  if (kind !== 'relay') checks.push([pvfStoredAt !== undefined && pvfAppliedAt !== undefined, `PVF stored (#${pvfStoredAt}) and applied (#${pvfAppliedAt})`]);
  if (mbm.supported) checks.push([!mbm.active, mbm.active ? `MBM cursor still active: ${mbm.cursor}` : `MBM cursor idle${result.mbmSeenActive ? ' (ran and completed)' : ' (no multi-block migrations queued)'}`]);
  for (const [ok, text] of checks) log(`  ${ok ? '✅' : '❌'} ${text}`);
  result.checks = checks;
  result.status = checks.every(([ok]) => ok) ? 'upgraded' : 'failed';
  return result;
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export default async function run(ctx) {
  const args = ctx.args && typeof ctx.args === 'object' ? ctx.args : {};
  const opts = {
    blocksAfterUpgrade: Number(args.blocksAfterUpgrade ?? DEFAULT_BLOCKS_AFTER),
    maxMigrationBlocks: Number(args.maxMigrationBlocks ?? DEFAULT_MAX_MIGRATION_BLOCKS),
    failOnMissing: args.failOnMissing !== false,
    max: ctx.verbose ? 2000 : 300,
  };

  section('Post-test: apply authorized runtime upgrades');
  let source;
  if (args.wasmDir) {
    source = loadLocalWasms(path.resolve(args.wasmDir));
    log(`  wasm source: local dir ${args.wasmDir}`);
  } else {
    const rel = parseRelease(args.release);
    const cacheDir = path.resolve(args.cacheDir ?? path.join('.cache', 'release-runtimes', rel.tag));
    log(`  release: ${rel.owner}/${rel.repo}@${rel.tag}  (cache: ${cacheDir})`);
    source = await fetchReleaseWasms(rel, cacheDir);
    log(`  release "${source.release.name}" published ${source.release.publishedAt}`);
  }
  const wasmsByHash = indexWasmsByHash(source.files);
  log(`  ${source.files.length} wasm asset(s) hashed (${source.files.filter((f) => f.cached).length} from cache):`);
  for (const a of [...wasmsByHash.values()].sort((x, y) => x.name.localeCompare(y.name))) {
    log(`    ${a.hash}  ${a.name}  (${a.size} bytes)`);
  }

  const only = Array.isArray(args.only) ? new Set(args.only) : undefined;
  const targets = ctx.chains.filter((c) => !only || only.has(c.label) || only.has(c.specName));
  log(`\n  chains: ${targets.map((c) => c.label).join(', ')}`);

  const results = [];
  for (const c of targets) {
    try {
      results.push(await upgradeChain(c, wasmsByHash, opts));
    } catch (e) {
      results.push({ label: c.label, specName: c.specName, kind: c.kind, status: 'error', notes: [e.stack || String(e)], notable: [], other: new Map() });
      log(`  💥 ${c.label}: ${e.message}`);
    }
  }

  section('Summary');
  for (const r of results) {
    const icon = r.status === 'upgraded' ? '✅' : r.status === 'skipped' ? '⏭ ' : '❌';
    const ver = r.before && r.after ? ` ${r.before.specVersion} → ${r.after.specVersion}` : '';
    log(`\n${icon} ${r.label} (${r.specName}) — ${r.status}${ver}`);
    if (r.asset) log(`   asset: ${r.asset}`);
    if (r.authorizedHash) log(`   authorized hash: ${r.authorizedHash}`);
    if (r.blocks) log(`   blocks built: #${r.blocks.first}…#${r.blocks.last} (${r.blocks.last - r.blocks.first + 1})`);
    if (r.codeUpdatedAt !== undefined) log(`   CodeUpdated at #${r.codeUpdatedAt}; first block on new runtime: #${r.codeUpdatedAt + 1}`);
    if (r.notable.length) {
      log('   upgrade/migration events:');
      for (const n of r.notable) log(`     • ${n}`);
    }
    if (r.other.size) {
      log('   other post-upgrade activity (event counts on the new runtime):');
      for (const [k, v] of [...r.other.entries()].sort((a, b) => b[1] - a[1])) log(`     • ${k} ×${v}`);
    } else if (r.status === 'upgraded') {
      log('   no non-routine events on the new runtime beyond the ones listed above');
    }
    for (const n of r.notes) log(`   note: ${n}`);
  }

  const failed = results.filter((r) => r.status === 'failed' || r.status === 'error');
  const upgraded = results.filter((r) => r.status === 'upgraded').length;
  log(`\n${failed.length === 0 ? '✅' : '❌'} ${upgraded}/${results.length} chains upgraded${failed.length ? `, ${failed.length} failed` : ''}`);
  if (failed.length) {
    throw new Error(`apply-authorized-upgrade failed on: ${failed.map((r) => `${r.label} (${r.notes[0] ?? r.status})`).join('; ')}`);
  }
}
