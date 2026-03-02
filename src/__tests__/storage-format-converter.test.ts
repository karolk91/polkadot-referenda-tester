import { describe, expect, it } from 'vitest';
import {
  convertAgendaToStorageFormat,
  convertCallToStorageFormat,
  convertOriginToStorageFormat,
  convertProposalToStorageFormat,
} from '../utils/storage-format-converter';

describe('convertOriginToStorageFormat', () => {
  it('returns non-objects unchanged', () => {
    expect(convertOriginToStorageFormat(null)).toBeNull();
    expect(convertOriginToStorageFormat(undefined)).toBeUndefined();
    expect(convertOriginToStorageFormat('Root')).toBe('Root');
  });

  it('converts polkadot-api format with nested type', () => {
    const origin = { type: 'Origins', value: { type: 'Treasurer' } };
    expect(convertOriginToStorageFormat(origin)).toEqual({ origins: 'Treasurer' });
  });

  it('converts polkadot-api format with simple value', () => {
    const origin = { type: 'System', value: 'Root' };
    expect(convertOriginToStorageFormat(origin)).toEqual({ system: 'Root' });
  });

  it('converts fellowship origins', () => {
    const origin = { type: 'FellowshipOrigins', value: { type: 'Fellows' } };
    expect(convertOriginToStorageFormat(origin)).toEqual({ fellowshiporigins: 'Fellows' });
  });

  it('passes through already-formatted origins', () => {
    const origin = { system: 'Root' };
    expect(convertOriginToStorageFormat(origin)).toEqual({ system: 'Root' });
  });
});

describe('convertProposalToStorageFormat', () => {
  it('returns non-objects unchanged', () => {
    expect(convertProposalToStorageFormat(null)).toBeNull();
    expect(convertProposalToStorageFormat(undefined)).toBeUndefined();
  });

  it('converts Lookup proposal', () => {
    const proposal = {
      type: 'Lookup',
      value: { hash: '0xabcd', len: 100 },
    };
    expect(convertProposalToStorageFormat(proposal)).toEqual({
      lookup: { hash: '0xabcd', len: 100 },
    });
  });

  it('converts Lookup proposal with Binary hash', () => {
    const proposal = {
      type: 'Lookup',
      value: { hash: { asHex: () => '0x1234' }, len: 50 },
    };
    expect(convertProposalToStorageFormat(proposal)).toEqual({
      lookup: { hash: '0x1234', len: 50 },
    });
  });

  it('converts Inline proposal', () => {
    const proposal = { type: 'Inline', value: '0xdeadbeef' };
    expect(convertProposalToStorageFormat(proposal)).toEqual({ inline: '0xdeadbeef' });
  });

  it('converts Inline proposal with Binary value', () => {
    const proposal = {
      type: 'Inline',
      value: { asHex: () => '0xcafe' },
    };
    expect(convertProposalToStorageFormat(proposal)).toEqual({ inline: '0xcafe' });
  });

  it('handles generic type', () => {
    const proposal = { type: 'Custom', value: 'data' };
    expect(convertProposalToStorageFormat(proposal)).toEqual({ custom: 'data' });
  });
});

describe('convertCallToStorageFormat', () => {
  it('returns non-objects unchanged', () => {
    expect(convertCallToStorageFormat(null)).toBeNull();
    expect(convertCallToStorageFormat('raw')).toBe('raw');
  });

  it('converts Inline call', () => {
    const call = { type: 'Inline', value: '0xabcd' };
    expect(convertCallToStorageFormat(call)).toEqual({ inline: '0xabcd' });
  });

  it('converts Inline call with Binary asHex', () => {
    const call = {
      type: 'Inline',
      value: { asHex: () => '0xbeef' },
    };
    expect(convertCallToStorageFormat(call)).toEqual({ inline: '0xbeef' });
  });

  it('converts Inline call with Binary toHex', () => {
    const call = {
      type: 'Inline',
      value: { toHex: () => '0xfeed' },
    };
    expect(convertCallToStorageFormat(call)).toEqual({ inline: '0xfeed' });
  });

  it('converts Lookup call', () => {
    const call = {
      type: 'Lookup',
      value: { hash: '0x1234', len: 200 },
    };
    expect(convertCallToStorageFormat(call)).toEqual({
      lookup: { hash: '0x1234', len: 200 },
    });
  });

  it('converts Legacy call', () => {
    const call = { type: 'Legacy', value: '0xold' };
    expect(convertCallToStorageFormat(call)).toEqual({ legacy: '0xold' });
  });

  it('passes through already-formatted calls', () => {
    const call = { inline: '0xabcd' };
    expect(convertCallToStorageFormat(call)).toEqual({ inline: '0xabcd' });
  });
});

describe('convertAgendaToStorageFormat', () => {
  it('handles non-array input', () => {
    expect(convertAgendaToStorageFormat('not-array' as any)).toBe('not-array');
  });

  it('passes through null items', () => {
    expect(convertAgendaToStorageFormat([null, null])).toEqual([null, null]);
  });

  it('converts agenda items with call and origin', () => {
    const items = [
      {
        call: { type: 'Inline', value: '0xaabb' },
        origin: { type: 'System', value: 'Root' },
        priority: 10,
        maybeId: null,
        maybePeriodic: null,
      },
    ];
    const result = convertAgendaToStorageFormat(items);
    expect(result).toEqual([
      {
        call: { inline: '0xaabb' },
        origin: { system: 'Root' },
        priority: 10,
        maybeId: null,
        maybePeriodic: null,
      },
    ]);
  });
});
