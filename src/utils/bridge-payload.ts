import { getDynamicBuilder, getLookupFn } from '@polkadot-api/metadata-builders';
import {
  decAnyMetadata,
  type UnifiedMetadata,
  unifyMetadata,
} from '@polkadot-api/substrate-bindings';
import { type Codec, Tuple } from 'scale-ts';

/**
 * Decoded `BridgeMessage` payload as it appears in `pallet_bridge_messages::OutboundMessages`
 * on a Bridge Hub.
 *
 * Wire format (concatenated SCALE):
 *   `BridgeMessage { universal_dest: VersionedInteriorLocation, message: VersionedXcm<()> }`
 *
 * Definition: polkadot-sdk/polkadot/xcm/xcm-builder/src/universal_exports.rs:499-506.
 */
export interface DecodedBridgeMessage {
  /** Universal destination of the bridged XCM (begins with `GlobalConsensus(...)`). */
  universalDest: unknown;
  /** The carried XCM, wrapped in its versioned envelope. */
  message: unknown;
}

/**
 * Codec for `BridgeMessage` derived from a Bridge Hub runtime's metadata.
 *
 * The payload's wire format is two concatenated SCALE values: a `VersionedInteriorLocation`
 * followed by a `VersionedXcm<()>`. We locate both types in the runtime's lookup table
 * (rather than hard-coding versions) so the codec stays correct across XCM version bumps.
 */
export class BridgePayloadCodec {
  private readonly codec: Codec<[unknown, unknown]>;

  constructor(unified: UnifiedMetadata) {
    const lookup = getLookupFn(unified);
    const builder = getDynamicBuilder(lookup);

    const interiorId = findVersionedTypeId(unified, 'VersionedInteriorLocation');
    if (interiorId === null) {
      throw new Error(
        'Could not locate `VersionedInteriorLocation` in metadata lookup; ' +
          'is this a Bridge Hub runtime?'
      );
    }

    const xcmId = findVersionedTypeId(unified, 'VersionedXcm');
    if (xcmId === null) {
      throw new Error(
        'Could not locate `VersionedXcm` in metadata lookup; is this a Bridge Hub runtime?'
      );
    }

    const interiorCodec = builder.buildDefinition(interiorId);
    const xcmCodec = builder.buildDefinition(xcmId);
    this.codec = Tuple(interiorCodec, xcmCodec) as unknown as Codec<[unknown, unknown]>;
  }

  /**
   * Decode raw bridge payload bytes (as stored in `OutboundMessages`'s value).
   */
  decode(bytes: Uint8Array | string): DecodedBridgeMessage {
    const [universalDest, message] = this.codec.dec(bytes);
    return { universalDest, message };
  }

  /**
   * Encode a decoded payload back to the wire format. Round-trip stable.
   */
  encode(value: DecodedBridgeMessage): Uint8Array {
    return this.codec.enc([value.universalDest, value.message]);
  }
}

/**
 * Build a {@link BridgePayloadCodec} from raw SCALE-encoded metadata bytes
 * (as returned by the `state_getMetadata` JSON-RPC method).
 */
export function buildBridgePayloadCodec(rawMetadata: Uint8Array | string): BridgePayloadCodec {
  const decoded = decAnyMetadata(rawMetadata);
  const unified = unifyMetadata(decoded);
  return new BridgePayloadCodec(unified);
}

/**
 * Find the lookup ID for an XCM versioned type by its trailing path segment.
 *
 * XCM types live under either `xcm` or `staging_xcm` modules depending on the runtime's
 * vintage. Match by the final path segment AND require an `xcm`-flavored ancestor to
 * avoid colliding with unrelated types that happen to share a name.
 *
 * Exported for unit testing.
 */
export function findVersionedTypeId(metadata: UnifiedMetadata, leafName: string): number | null {
  const candidates: Array<{ id: number; pathLen: number }> = [];
  for (const entry of metadata.lookup) {
    const path = entry.path;
    if (path.length === 0) continue;
    if (path[path.length - 1] !== leafName) continue;
    if (!path.some((seg) => seg === 'xcm' || seg === 'staging_xcm')) continue;
    candidates.push({ id: entry.id, pathLen: path.length });
  }
  if (candidates.length === 0) return null;
  // Prefer the shortest path (typically `["xcm", "VersionedXcm"]` over deeper variants).
  candidates.sort((a, b) => a.pathLen - b.pathLen);
  return candidates[0].id;
}
