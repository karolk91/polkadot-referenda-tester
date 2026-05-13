import { describe, expect, it } from 'vitest';
import { getEnactmentTaskName } from '../utils/scheduler-task-name';

describe('getEnactmentTaskName', () => {
  it('returns a 32-byte Uint8Array (blake2_256 output)', () => {
    const name = getEnactmentTaskName(0);
    expect(name).toBeInstanceOf(Uint8Array);
    expect(name.length).toBe(32);
  });

  it('is deterministic for the same referendum index', () => {
    expect(getEnactmentTaskName(1886)).toEqual(getEnactmentTaskName(1886));
  });

  it('produces different task names for different referendum indices', () => {
    const a = getEnactmentTaskName(1886);
    const b = getEnactmentTaskName(1887);
    const c = getEnactmentTaskName(0);
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
    expect(b).not.toEqual(c);
  });

  // Snapshot test: lock in the encoding so we catch accidental drift
  // (e.g. if scale-ts or @polkadot-api/substrate-bindings change behavior).
  // The bytes that get hashed are:
  //   "assembly" (8 raw bytes) || compact(9) || "enactment" (utf8) || u32_LE(index)
  it('matches blake2_256 over (b"assembly", "enactment", 0u32) — index 0', () => {
    const hex = Buffer.from(getEnactmentTaskName(0)).toString('hex');
    expect(hex).toBe('5a614cd58fac2c25d3f478ab06ba0748f0819a96726cc60e729b0c146dc562d6');
  });

  it('matches blake2_256 over (b"assembly", "enactment", 1886u32)', () => {
    const hex = Buffer.from(getEnactmentTaskName(1886)).toString('hex');
    expect(hex).toBe('545ce5fe57449a255c651b79da4a36ef97e483d6b153fc823a8f1ffbf7cf3bd9');
  });
});
