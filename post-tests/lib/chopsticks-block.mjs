// Shared helpers for post-tests that read the live chopsticks-core `Blockchain` handed to them
// as `chain.chain` (in-process, no WebSocket round-trips). Everything decodes with the
// @polkadot/types registry the block itself carries, so it follows runtime upgrades.

import { hexToU8a } from '@polkadot/util';

export const RULE = '━'.repeat(70);
export const log = (...args) => console.log(...args);
export const section = (title) => log(`\n${RULE}\n${title}\n${RULE}`);

/** Per-block noise that says nothing about what a referendum or upgrade did. */
export const ROUTINE = new Set(['system.ExtrinsicSuccess']);

/** Decode a storage entry of `query` at `block` using the type recorded in metadata. */
export async function readStorage(block, meta, query, ...args) {
  const t = query.meta.type;
  const lookupId = t.isPlain ? t.asPlain : t.asMap.value;
  return block.read(meta.registry.createLookupType(lookupId), query, ...args);
}

export async function readEvents(block) {
  const meta = await block.meta;
  const events = await readStorage(block, meta, meta.query.system.events);
  return events ? events.toArray() : [];
}

export function eventKey(event) {
  return `${event.event.section}.${event.event.method}`;
}

export function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…(${s.length - n} more chars)` : s;
}

export function humanJson(codec, max) {
  try {
    return truncate(JSON.stringify(codec.toHuman()), max);
  } catch {
    return truncate(String(codec), max);
  }
}

export async function describeExtrinsics(block) {
  const registry = await block.registry;
  const exts = await block.extrinsics;
  return exts.map((hex) => {
    try {
      const ex = registry.createType('GenericExtrinsic', hexToU8a(hex));
      const args = ex.method.args.map((a) => truncate(a.toHex ? a.toHex() : String(a), 66));
      return `${ex.method.section}.${ex.method.method}(${args.join(', ')})${ex.isSigned ? '' : ' [unsigned]'}`;
    } catch {
      return truncate(hex, 66);
    }
  });
}

/**
 * Print one block's extrinsics and events.
 *
 * @param {object} opts
 * @param {number} opts.max      max chars of event data per line
 * @param {string} [opts.tag]    annotation after the header (e.g. "apply_authorized_upgrade")
 * @param {Set}    [opts.hide]   event keys to leave out (count is still reported)
 * @param {Set}    [opts.mark]   event keys to highlight with ◀◀
 * @param {RegExp} [opts.flag]   pattern over "key data" that marks an event as failure-looking ⚠️
 * @returns {{ events: any[], flagged: string[] }} all events (hidden ones included) and the flagged lines
 */
export async function printBlock(label, block, { max, tag, hide, mark, flag } = {}) {
  const exts = await describeExtrinsics(block);
  const events = await readEvents(block);
  log(`\n  📦 ${label} block #${block.number} ${block.hash}${tag ? `   ← ${tag}` : ''}`);
  log(`     extrinsics (${exts.length}):`);
  for (const e of exts) log(`       • ${e}`);
  const shown = hide ? events.filter((ev) => !hide.has(eventKey(ev))) : events;
  log(
    `     events (${events.length}${hide ? `, ${events.length - shown.length} routine hidden` : ''}):`
  );
  const flagged = [];
  for (const ev of shown) {
    const key = eventKey(ev);
    const data = ev.event.data.length ? ` ${humanJson(ev.event.data, max ?? 300)}` : '';
    const bad = flag ? flag.test(key) || flag.test(data) : false;
    if (bad) flagged.push(`#${block.number} ${key}${data}`);
    const marker = bad ? '   ⚠️' : mark?.has(key) ? ' ◀◀' : '';
    log(`       • ${key}${data}${marker}`);
  }
  return { events, flagged };
}
