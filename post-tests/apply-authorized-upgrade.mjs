// Post-referendum test: apply the authorized runtime upgrade on every forked chain.
//
// Usage (after a referendum that emitted `System.UpgradeAuthorized` on the chains):
//
//   npm run cli -- test ... \
//     --post-test post-tests/apply-authorized-upgrade.mjs \
//     --post-test-args '{"release":"https://github.com/polkadot-fellows/runtimes/releases/tag/v2.5.0"}'
//
// For each chain passed to the post-test the script:
//   1. reads `System.AuthorizedUpgrade` (code_hash + check_version) — chains without one are skipped;
//   2. downloads the `*.compact.compressed.wasm` assets of the GitHub release (cached on disk),
//      blake2-256 hashes every asset and picks the one matching the on-chain authorized hash.
//      This is the hash verification: the release artifact must hash to the value governance
//      approved;
//   3. submits an unsigned `System.apply_authorized_upgrade(code)` in a new block (in-process via
//      the live chopsticks `Blockchain`, so the block builder includes it);
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
//   cacheDir           directory for downloaded assets (default .cache/release-runtimes/<tag>)
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
import { blake2AsHex, cryptoWaitReady } from '@polkadot/util-crypto';
import {
  eventKey,
  humanJson,
  inProcessChain,
  log,
  postTestArgs,
  printBlock,
  readStorage,
  ROUTINE,
  section,
  selectedChains,
} from './lib/chopsticks-block.mjs';

const DEFAULT_REPO = 'polkadot-fellows/runtimes';
const DEFAULT_BLOCKS_AFTER = 3;
const DEFAULT_MAX_MIGRATION_BLOCKS = 40;

// Events that indicate upgrade or migration progress. Everything else after the upgrade is
// reported as "other activity", so no event is omitted; these events are highlighted.
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
function parseRelease(release) {
  if (!release) throw new Error('post-test args need `release` (GitHub release URL/tag) or `wasmDir`');
  const releaseUrl = release.match(/github\.com\/([^/]+)\/([^/]+)\/releases\/tag\/([^/?#]+)/);
  if (releaseUrl) return { owner: releaseUrl[1], repo: releaseUrl[2], tag: decodeURIComponent(releaseUrl[3]) };
  const repoAtTag = release.match(/^([^/@\s]+)\/([^/@\s]+)@(.+)$/);
  if (repoAtTag) return { owner: repoAtTag[1], repo: repoAtTag[2], tag: repoAtTag[3] };
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
async function fetchReleaseWasms({ owner, repo, tag }, cacheDir) {
  const api = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const response = await fetch(api, { headers: ghHeaders() });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${api}: ${(await response.text()).slice(0, 200)}`);
  const release = await response.json();
  const assets = (release.assets ?? []).filter((asset) => /\.compact\.compressed\.wasm$/.test(asset.name));
  if (assets.length === 0) throw new Error(`Release ${owner}/${repo}@${tag} has no *.compact.compressed.wasm assets`);
  mkdirSync(cacheDir, { recursive: true });

  const files = [];
  // Limit parallelism; the assets are ~1-2.5 MB each.
  const queue = [...assets];
  const workers = Array.from({ length: 4 }, async () => {
    for (let asset = queue.shift(); asset; asset = queue.shift()) {
      const file = path.join(cacheDir, asset.name);
      if (existsSync(file) && statSync(file).size === asset.size) {
        files.push({ name: asset.name, file, cached: true });
        continue;
      }
      const download = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'polkadot-referenda-tester' } });
      if (!download.ok) throw new Error(`Download failed ${download.status}: ${asset.browser_download_url}`);
      const bytes = Buffer.from(await download.arrayBuffer());
      if (bytes.length !== asset.size) throw new Error(`Size mismatch for ${asset.name}: got ${bytes.length}, expected ${asset.size}`);
      writeFileSync(file, bytes);
      files.push({ name: asset.name, file, cached: false });
    }
  });
  await Promise.all(workers);
  return { release: { owner, repo, tag, name: release.name, publishedAt: release.published_at }, files };
}

/** Load wasm files from a local directory. */
function loadLocalWasms(dir) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.wasm'))
    .map((name) => ({ name, file: path.join(dir, name), cached: true }));
  if (files.length === 0) throw new Error(`No *.wasm files in ${dir}`);
  return { release: { tag: `local:${dir}` }, files };
}

/**
 * Hash every wasm (blake2-256, the value `authorize_upgrade` commits to) and index by hash.
 * Stores only the hash and the path, and re-reads the matched asset's bytes when applying it.
 */
function indexWasmsByHash(files) {
  const byHash = new Map();
  for (const wasm of files) {
    const bytes = readFileSync(wasm.file);
    const specVersion = wasm.name.match(/-v(\d+)\./)?.[1];
    const hash = blake2AsHex(bytes, 256);
    byHash.set(hash, {
      ...wasm,
      size: bytes.length,
      hash,
      specVersion: specVersion ? Number(specVersion) : undefined,
    });
  }
  return byHash;
}

// ---------------------------------------------------------------------------------------------
// Chain state readers
// ---------------------------------------------------------------------------------------------

async function runtimeVersionOf(block) {
  const version = await block.runtimeVersion;
  return { specName: String(version.specName), specVersion: Number(version.specVersion), transactionVersion: Number(version.transactionVersion) };
}

async function codeHashOf(block) {
  return blake2AsHex(hexToU8a(await block.wasm), 256);
}

async function mbmCursor(block) {
  const meta = await block.meta;
  const cursorQuery = meta.query.multiBlockMigrations?.cursor;
  if (!cursorQuery) return { supported: false, active: false };
  const cursor = await readStorage(block, meta, cursorQuery);
  return { supported: true, active: !!cursor, cursor: cursor ? humanJson(cursor, 400) : undefined };
}

// ---------------------------------------------------------------------------------------------
// Per-chain upgrade flow
// ---------------------------------------------------------------------------------------------

function chainResult({ label, specName, kind }, status, notes) {
  return { label, specName, kind, status, notes, notable: [], other: new Map() };
}

async function readAuthorization(chain, wasmsByHash, opts) {
  const head = chain.head;
  const meta = await head.meta;
  const before = await runtimeVersionOf(head);
  const lastUpgradeBefore = await readStorage(head, meta, meta.query.system.lastRuntimeUpgrade);
  log(`  head: #${head.number} ${head.hash}`);
  log(`  runtime before: ${before.specName} v${before.specVersion} (tx v${before.transactionVersion})`);
  if (lastUpgradeBefore) log(`  System.LastRuntimeUpgrade before: ${humanJson(lastUpgradeBefore, 200)}`);

  const authorized = await readStorage(head, meta, meta.query.system.authorizedUpgrade);
  if (!authorized) {
    const note = 'no System.AuthorizedUpgrade in storage — nothing to apply';
    log(`  ⏭  ${note}`);
    return { status: 'skipped', notes: [note] };
  }
  const authorizedHash = authorized.codeHash.toHex();
  const checkVersion = authorized.checkVersion.isTrue;
  log(`  System.AuthorizedUpgrade: code_hash=${authorizedHash} check_version=${checkVersion}`);

  const asset = wasmsByHash.get(authorizedHash);
  if (!asset) {
    const note = `no release asset hashes to ${authorizedHash}`;
    log(`  ❌ ${note}`);
    log(`     assets available: ${[...wasmsByHash.values()].map((wasm) => `${wasm.name}=${wasm.hash.slice(0, 10)}…`).join(', ')}`);
    return { status: opts.failOnMissing ? 'failed' : 'skipped', notes: [note], authorizedHash };
  }
  const code = readFileSync(asset.file);
  log(`  ✅ hash verified: ${asset.name} blake2-256 == authorized code_hash`);
  log(`     size=${code.length} bytes sha256=${createHash('sha256').update(code).digest('hex')}${asset.specVersion ? ` asset spec_version=${asset.specVersion}` : ''}`);
  const notes = [];
  if (checkVersion && asset.specVersion !== undefined && asset.specVersion <= before.specVersion) {
    notes.push(`asset spec_version ${asset.specVersion} is not greater than current ${before.specVersion}; check_version=true will reject it`);
    log(`  ⚠️  ${notes.at(-1)}`);
  }
  return { status: 'authorized', notes, authorizedHash, checkVersion, asset, code, before };
}

async function dryRunFailure(chain, extrinsic) {
  try {
    const { outcome } = await chain.dryRunExtrinsic(extrinsic);
    return humanJson(outcome, 500);
  } catch (error) {
    return `dry-run threw: ${error.message}`;
  }
}

async function applyUpgrade(chain, label, code, opts) {
  const meta = await chain.head.meta;
  const call = meta.tx.system.applyAuthorizedUpgrade(u8aToHex(code));
  const extrinsic = meta.registry.createType('GenericExtrinsic', call).toHex();
  log(`  ⛏  building block with System.apply_authorized_upgrade (${code.length} bytes, unsigned)…`);
  const applyBlock = await chain.newBlock({ transactions: [extrinsic] });
  if (!(await applyBlock.extrinsics).includes(extrinsic)) {
    const note = `apply_authorized_upgrade was NOT included in block #${applyBlock.number}: ${await dryRunFailure(chain, extrinsic)}`;
    log(`  ❌ ${note}`);
    await printBlock(label, applyBlock, { max: opts.max, tag: 'apply block (extrinsic dropped)', mark: NOTABLE });
    return { included: false, note };
  }

  const application = {
    included: true,
    firstBlock: applyBlock.number,
    lastBlock: applyBlock.number,
    notable: [],
    other: new Map(),
    notes: [],
    mbmSeenActive: false,
  };
  const recordEvents = (blockNumber, events) => {
    const isPostUpgrade = application.codeUpdatedAt !== undefined && blockNumber > application.codeUpdatedAt;
    for (const record of events) {
      const key = eventKey(record);
      if (NOTABLE.has(key)) {
        application.notable.push(`#${blockNumber} ${key}${record.event.data.length ? ` ${humanJson(record.event.data, 300)}` : ''}`);
        if (key === 'system.CodeUpdated') application.codeUpdatedAt ??= blockNumber;
        if (key === 'parachainSystem.ValidationFunctionStored') application.pvfStoredAt ??= blockNumber;
        if (key === 'parachainSystem.ValidationFunctionApplied') application.pvfAppliedAt ??= blockNumber;
        // MBM can start and finish inside one block, so the cursor poll below never reads it as
        // active.
        if (key === 'multiBlockMigrations.UpgradeStarted') application.mbmSeenActive = true;
      } else if (isPostUpgrade && !ROUTINE.has(key)) {
        application.other.set(key, (application.other.get(key) ?? 0) + 1);
      }
    }
  };
  const printAndRecord = async (block, tag) => {
    const { events } = await printBlock(label, block, { max: opts.max, tag, mark: NOTABLE });
    recordEvents(block.number, events);
  };
  await printAndRecord(applyBlock, 'apply_authorized_upgrade');

  let mbm = { supported: false, active: false };
  const blocksSinceSwitch = () => application.lastBlock - (application.codeUpdatedAt ?? applyBlock.number);
  const extraBlocks = () => application.lastBlock - applyBlock.number;
  while (blocksSinceSwitch() < opts.blocksAfterUpgrade || (mbm.active && extraBlocks() < opts.maxMigrationBlocks)) {
    const block = await chain.newBlock();
    application.lastBlock = block.number;
    const tag = block.number === application.codeUpdatedAt + 1 ? 'first block on NEW runtime (on_runtime_upgrade runs here)' : undefined;
    await printAndRecord(block, tag);
    mbm = await mbmCursor(block);
    if (mbm.active) {
      application.mbmSeenActive = true;
      log(`     ⏳ MultiBlockMigrations cursor active: ${mbm.cursor}`);
    } else if (mbm.supported && application.mbmSeenActive) {
      log(`     ✅ MultiBlockMigrations cursor cleared`);
    }
  }
  if (mbm.active) application.notes.push(`stopped after ${extraBlocks()} extra blocks; MBM cursor still active`);
  application.mbm = mbm;
  return application;
}

async function verifyUpgrade(chain, kind, authorization, application) {
  const head = chain.head;
  const meta = await head.meta;
  const { authorizedHash, asset, before, checkVersion } = authorization;
  const { codeUpdatedAt, pvfStoredAt, pvfAppliedAt, mbm, mbmSeenActive } = application;
  const after = await runtimeVersionOf(head);
  const headCodeHash = await codeHashOf(head);
  const lastUpgradeAfter = await readStorage(head, meta, meta.query.system.lastRuntimeUpgrade);
  const stillAuthorized = await readStorage(head, meta, meta.query.system.authorizedUpgrade);
  log(`\n  runtime after:  ${after.specName} v${after.specVersion} (tx v${after.transactionVersion})`);
  if (lastUpgradeAfter) log(`  System.LastRuntimeUpgrade after: ${humanJson(lastUpgradeAfter, 200)}`);
  log(`  :code blake2-256 at head: ${headCodeHash}`);

  const checks = [
    [codeUpdatedAt !== undefined, `System.CodeUpdated observed${codeUpdatedAt !== undefined ? ` at #${codeUpdatedAt}` : ''}`],
    [headCodeHash === authorizedHash, ':code hash == authorized hash'],
    ...(asset.specVersion !== undefined
      ? [[after.specVersion === asset.specVersion, `spec_version ${after.specVersion} == asset ${asset.specVersion}`]]
      : []),
    ...(checkVersion
      ? [[after.specVersion > before.specVersion, `spec_version increased ${before.specVersion} → ${after.specVersion}`]]
      : []),
    [after.specName === before.specName, `spec_name unchanged (${after.specName})`],
    [!stillAuthorized, 'System.AuthorizedUpgrade cleared'],
    ...(kind !== 'relay'
      ? [[pvfStoredAt !== undefined && pvfAppliedAt !== undefined, `PVF stored (#${pvfStoredAt}) and applied (#${pvfAppliedAt})`]]
      : []),
    ...(mbm.supported
      ? [[!mbm.active, mbm.active ? `MBM cursor still active: ${mbm.cursor}` : `MBM cursor idle${mbmSeenActive ? ' (ran and completed)' : ' (no multi-block migrations queued)'}`]]
      : []),
  ];
  for (const [isPassed, text] of checks) log(`  ${isPassed ? '✅' : '❌'} ${text}`);
  return { after, isPassed: checks.every(([isPassed]) => isPassed) };
}

async function upgradeChain(postTestChain, wasmsByHash, opts) {
  const { label, specName, kind } = postTestChain;
  const chain = inProcessChain(postTestChain);
  section(`${label} (${specName}, ${kind})`);

  const authorization = await readAuthorization(chain, wasmsByHash, opts);
  if (authorization.status !== 'authorized') {
    return { ...chainResult(postTestChain, authorization.status, authorization.notes), authorizedHash: authorization.authorizedHash };
  }
  const application = await applyUpgrade(chain, label, authorization.code, opts);
  if (!application.included) {
    return { ...chainResult(postTestChain, 'failed', [...authorization.notes, application.note]), authorizedHash: authorization.authorizedHash, asset: authorization.asset.name };
  }
  const verification = await verifyUpgrade(chain, kind, authorization, application);
  return {
    ...chainResult(postTestChain, verification.isPassed ? 'upgraded' : 'failed', [...authorization.notes, ...application.notes]),
    authorizedHash: authorization.authorizedHash,
    asset: authorization.asset.name,
    before: authorization.before,
    after: verification.after,
    blocks: { first: application.firstBlock, last: application.lastBlock },
    codeUpdatedAt: application.codeUpdatedAt,
    notable: application.notable,
    other: application.other,
  };
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export default async function run(ctx) {
  // Without this, @polkadot/util-crypto uses the pure-JS blake2, about 10x slower than the wasm
  // implementation. This script hashes every release asset and each chain's 2 MB `:code`.
  await cryptoWaitReady();
  const args = postTestArgs(ctx);
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
    const release = parseRelease(args.release);
    const cacheDir = path.resolve(args.cacheDir ?? path.join('.cache', 'release-runtimes', release.tag));
    log(`  release: ${release.owner}/${release.repo}@${release.tag}  (cache: ${cacheDir})`);
    source = await fetchReleaseWasms(release, cacheDir);
    log(`  release "${source.release.name}" published ${source.release.publishedAt}`);
  }
  const wasmsByHash = indexWasmsByHash(source.files);
  log(`  ${source.files.length} wasm asset(s) hashed (${source.files.filter((wasm) => wasm.cached).length} from cache):`);
  for (const wasm of [...wasmsByHash.values()].sort((first, second) => first.name.localeCompare(second.name))) {
    log(`    ${wasm.hash}  ${wasm.name}  (${wasm.size} bytes)`);
  }

  const targets = selectedChains(ctx, args, { includeMain: true });
  log(`\n  chains: ${targets.map((target) => target.label).join(', ')}`);

  const results = [];
  for (const target of targets) {
    try {
      results.push(await upgradeChain(target, wasmsByHash, opts));
    } catch (error) {
      results.push(chainResult(target, 'error', [error.stack || String(error)]));
      log(`  💥 ${target.label}: ${error.message}`);
    }
  }

  section('Summary');
  for (const result of results) {
    const icon = result.status === 'upgraded' ? '✅' : result.status === 'skipped' ? '⏭ ' : '❌';
    const versions = result.before && result.after ? ` ${result.before.specVersion} → ${result.after.specVersion}` : '';
    log(`\n${icon} ${result.label} (${result.specName}) — ${result.status}${versions}`);
    if (result.asset) log(`   asset: ${result.asset}`);
    if (result.authorizedHash) log(`   authorized hash: ${result.authorizedHash}`);
    if (result.blocks) log(`   blocks built: #${result.blocks.first}…#${result.blocks.last} (${result.blocks.last - result.blocks.first + 1})`);
    if (result.codeUpdatedAt !== undefined) log(`   CodeUpdated at #${result.codeUpdatedAt}; first block on new runtime: #${result.codeUpdatedAt + 1}`);
    if (result.notable.length) {
      log('   upgrade/migration events:');
      for (const notable of result.notable) log(`     • ${notable}`);
    }
    if (result.other.size) {
      log('   other post-upgrade activity (event counts on the new runtime):');
      for (const [key, count] of [...result.other.entries()].sort((first, second) => second[1] - first[1])) log(`     • ${key} ×${count}`);
    } else if (result.status === 'upgraded') {
      log('   no non-routine events on the new runtime beyond the ones listed above');
    }
    for (const note of result.notes) log(`   note: ${note}`);
  }

  const failed = results.filter((result) => result.status === 'failed' || result.status === 'error');
  const upgraded = results.filter((result) => result.status === 'upgraded').length;
  log(`\n${failed.length === 0 ? '✅' : '❌'} ${upgraded}/${results.length} chains upgraded${failed.length ? `, ${failed.length} failed` : ''}`);
  if (failed.length) {
    throw new Error(`apply-authorized-upgrade failed on: ${failed.map((result) => `${result.label} (${result.notes[0] ?? result.status})`).join('; ')}`);
  }
}
