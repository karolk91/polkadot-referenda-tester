import { describe, expect, it } from 'vitest';
import { enactmentTaskName } from '../utils/scheduler-task-name';

describe('enactmentTaskName', () => {
  it.each([
    [0, '0x5a614cd58fac2c25d3f478ab06ba0748f0819a96726cc60e729b0c146dc562d6'],
    [1886, '0x545ce5fe57449a255c651b79da4a36ef97e483d6b153fc823a8f1ffbf7cf3bd9'],
  ])('task name of referendum %i', (referendumIndex, expected) => {
    expect(
      enactmentTaskName(referendumIndex),
      'must equal blake2_256((b"assembly", "enactment", index)) as pallet-referenda computes it'
    ).toBe(expected);
  });
});
