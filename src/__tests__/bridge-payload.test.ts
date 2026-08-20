import type { UnifiedMetadata } from '@polkadot-api/substrate-bindings';
import { describe, expect, it } from 'vitest';
import { findVersionedTypeId } from '../utils/bridge-payload';

/**
 * Build a minimal `UnifiedMetadata`-shaped object with just the lookup table populated.
 * Other fields are unused by `findVersionedTypeId`.
 */
function fakeMetadata(entries: Array<{ id: number; path: string[] }>): UnifiedMetadata {
  // The lookup entry shape includes more fields than we need (params, def, docs).
  // findVersionedTypeId only inspects `id` and `path`, so we cast through `unknown`.
  const lookup = entries.map((e) => ({
    ...e,
    params: [],
    def: { tag: 'composite', value: [] },
    docs: [],
  }));
  return { lookup } as unknown as UnifiedMetadata;
}

describe('findVersionedTypeId', () => {
  it('returns null when no entries match the leaf name', () => {
    const meta = fakeMetadata([
      { id: 0, path: ['some', 'OtherType'] },
      { id: 1, path: ['xcm', 'Junctions'] },
    ]);
    expect(findVersionedTypeId(meta, 'VersionedXcm')).toBeNull();
  });

  it('returns null when leaf matches but no path segment is xcm-flavored', () => {
    const meta = fakeMetadata([
      { id: 0, path: ['mypallet', 'VersionedXcm'] }, // wrong module
    ]);
    expect(findVersionedTypeId(meta, 'VersionedXcm')).toBeNull();
  });

  it('finds a type under the modern `xcm` module', () => {
    const meta = fakeMetadata([{ id: 7, path: ['xcm', 'VersionedXcm'] }]);
    expect(findVersionedTypeId(meta, 'VersionedXcm')).toBe(7);
  });

  it('finds a type under the legacy `staging_xcm` module', () => {
    const meta = fakeMetadata([{ id: 11, path: ['staging_xcm', 'VersionedXcm'] }]);
    expect(findVersionedTypeId(meta, 'VersionedXcm')).toBe(11);
  });

  it('finds VersionedInteriorLocation alongside VersionedXcm', () => {
    const meta = fakeMetadata([
      { id: 100, path: ['xcm', 'VersionedXcm'] },
      { id: 101, path: ['xcm', 'VersionedInteriorLocation'] },
      { id: 102, path: ['staging_xcm', 'v5', 'Junctions'] },
    ]);
    expect(findVersionedTypeId(meta, 'VersionedXcm')).toBe(100);
    expect(findVersionedTypeId(meta, 'VersionedInteriorLocation')).toBe(101);
  });

  it('prefers the shortest qualifying path when multiple candidates exist', () => {
    const meta = fakeMetadata([
      { id: 200, path: ['some_pallet', 'inner', 'xcm', 'VersionedXcm'] }, // length 4
      { id: 201, path: ['xcm', 'VersionedXcm'] }, // length 2 — preferred
      { id: 202, path: ['staging_xcm', 'wrap', 'VersionedXcm'] }, // length 3
    ]);
    expect(findVersionedTypeId(meta, 'VersionedXcm')).toBe(201);
  });

  it('does not match a type whose path segments only contain the leaf name in the middle', () => {
    const meta = fakeMetadata([
      { id: 300, path: ['xcm', 'VersionedXcm', 'Inner'] }, // leaf is "Inner", not "VersionedXcm"
    ]);
    expect(findVersionedTypeId(meta, 'VersionedXcm')).toBeNull();
  });

  it('handles an empty lookup gracefully', () => {
    const meta = fakeMetadata([]);
    expect(findVersionedTypeId(meta, 'VersionedXcm')).toBeNull();
  });
});
