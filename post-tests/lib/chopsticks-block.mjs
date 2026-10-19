// Shared helpers for post-tests that read the live chopsticks-core `Blockchain` passed to them
// as `chain.chain` (in-process, no WebSocket round-trips). Decoding uses the @polkadot/types
// registry attached to the block, so it stays correct across runtime upgrades.

import { hexToU8a } from '@polkadot/util';

export const RULE = '━'.repeat(70);
export const log = (...args) => console.log(...args);
export const section = (title) => log(`\n${RULE}\n${title}\n${RULE}`);

/** Per-block events that report nothing about a referendum or an upgrade. */
export const ROUTINE = new Set(['system.ExtrinsicSuccess']);

export function postTestArgs(ctx) {
  return ctx.args && typeof ctx.args === 'object' ? ctx.args : {};
}

export function selectedChains(ctx, args, { includeMain }) {
  const only = Array.isArray(args.only) ? new Set(args.only) : undefined;
  return ctx.chains.filter((chain) =>
    only ? only.has(chain.label) || only.has(chain.specName) : includeMain || chain.label !== ctx.main.label
  );
}

export function inProcessChain(postTestChain) {
  const { chain } = postTestChain;
  if (!chain || typeof chain.newBlock !== 'function') {
    throw new Error(`${postTestChain.label}: no in-process chopsticks Blockchain on the post-test chain object`);
  }
  return chain;
}

/** Decode a storage entry of `query` at `block` using the type recorded in metadata. */
export async function readStorage(block, meta, query, ...args) {
  const storageType = query.meta.type;
  const lookupId = storageType.isPlain ? storageType.asPlain : storageType.asMap.value;
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

export function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…(${text.length - maxLength} more chars)` : text;
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
  const extrinsics = await block.extrinsics;
  return extrinsics.map((hex) => {
    try {
      const extrinsic = registry.createType('GenericExtrinsic', hexToU8a(hex));
      const args = extrinsic.method.args.map((arg) => truncate(arg.toHex ? arg.toHex() : String(arg), 66));
      return `${extrinsic.method.section}.${extrinsic.method.method}(${args.join(', ')})${extrinsic.isSigned ? '' : ' [unsigned]'}`;
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
 * @param {RegExp} [opts.flag]   pattern over "key data" that marks an event as a probable failure ⚠️
 * @returns {{ events: any[], flagged: string[] }} all events (hidden ones included) and the flagged lines
 */
export async function printBlock(label, block, { max, tag, hide, mark, flag } = {}) {
  const extrinsics = await describeExtrinsics(block);
  const events = await readEvents(block);
  log(`\n  📦 ${label} block #${block.number} ${block.hash}${tag ? `   ← ${tag}` : ''}`);
  log(`     extrinsics (${extrinsics.length}):`);
  for (const extrinsic of extrinsics) log(`       • ${extrinsic}`);
  const shown = hide ? events.filter((record) => !hide.has(eventKey(record))) : events;
  log(
    `     events (${events.length}${hide ? `, ${events.length - shown.length} routine hidden` : ''}):`
  );
  const flagged = [];
  for (const record of shown) {
    const key = eventKey(record);
    const data = record.event.data.length ? ` ${humanJson(record.event.data, max ?? 300)}` : '';
    const isFlagged = flag ? flag.test(key) || flag.test(data) : false;
    if (isFlagged) flagged.push(`#${block.number} ${key}${data}`);
    const marker = isFlagged ? '   ⚠️' : mark?.has(key) ? ' ◀◀' : '';
    log(`       • ${key}${data}${marker}`);
  }
  return { events, flagged };
}
