//! Raw storage key computation for zombienet genesis injection via `with_raw_spec_override()`.
//!
//! Computes hex-encoded storage keys and SCALE-encoded values for:
//! - `AhMigrator::AhMigrationStage` → `MigrationDone` (unlocks BaseCallFilter on Asset Hub)
//! - `FellowshipCollective::{Members, IdToIndex, IndexToId, MemberCount}` (registers Alice as fellow)
//!
//! These are injected into `genesis.raw.top` so that by-number tests can submit
//! referenda directly to live zombienet nodes.

use serde_json::{json, Value};
use sp_crypto_hashing::{twox_128, twox_64};

/// Alice's raw AccountId (Sr25519 public key bytes).
const ALICE_ACCOUNT_ID: [u8; 32] = [
    0xd4, 0x35, 0x93, 0xc7, 0x15, 0xfd, 0xd3, 0x1c, 0x61, 0x14, 0x1a, 0xbd, 0x04, 0xa9, 0x9f, 0xd6,
    0x82, 0x2c, 0x85, 0x58, 0x85, 0x4c, 0xcd, 0xe3, 0x9a, 0x56, 0x84, 0xe7, 0xa5, 0x6d, 0xa2, 0x7d,
];

/// The rank to assign Alice in FellowshipCollective (covers all tracks up to Fellowship9Dan).
const ALICE_FELLOWSHIP_RANK: u16 = 9;

// ─── Storage key primitives ──────────────────────────────────────────────────

/// Compute the 32-byte storage prefix for a pallet + item (two twox_128 hashes).
fn storage_prefix(pallet: &str, item: &str) -> Vec<u8> {
    let mut key = Vec::with_capacity(32);
    key.extend_from_slice(&twox_128(pallet.as_bytes()));
    key.extend_from_slice(&twox_128(item.as_bytes()));
    key
}

/// Twox64Concat transparent hash: `twox_64(data) ++ data`.
fn twox64_concat(data: &[u8]) -> Vec<u8> {
    let hash = twox_64(data);
    let mut result = Vec::with_capacity(8 + data.len());
    result.extend_from_slice(&hash);
    result.extend_from_slice(data);
    result
}

/// Hex-encode bytes with `0x` prefix.
fn to_hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Build a StorageValue key (pallet prefix + item prefix).
fn storage_value_key(pallet: &str, item: &str) -> String {
    to_hex(&storage_prefix(pallet, item))
}

/// Build a StorageMap key with Twox64Concat hasher.
fn storage_map_key(pallet: &str, item: &str, map_key: &[u8]) -> String {
    let mut key = storage_prefix(pallet, item);
    key.extend_from_slice(&twox64_concat(map_key));
    to_hex(&key)
}

/// Build a StorageDoubleMap key with Twox64Concat for both hashers.
fn storage_double_map_key(pallet: &str, item: &str, key1: &[u8], key2: &[u8]) -> String {
    let mut key = storage_prefix(pallet, item);
    key.extend_from_slice(&twox64_concat(key1));
    key.extend_from_slice(&twox64_concat(key2));
    to_hex(&key)
}

/// Wrap a `genesis.raw.top` entries map into the full raw spec override structure.
fn build_raw_override(top: serde_json::Map<String, Value>) -> Value {
    json!({
        "genesis": {
            "raw": {
                "top": top
            }
        }
    })
}

// ─── AhMigrator ──────────────────────────────────────────────────────────────

/// Raw spec override: set `AhMigrator::AhMigrationStage = MigrationDone`.
///
/// `MigrationDone` is enum variant index 2, SCALE-encoded as `0x02`.
/// This unlocks Asset Hub's `BaseCallFilter`, allowing `Referenda.submit`.
pub fn ah_migrator_override() -> Value {
    let key = storage_value_key("AhMigrator", "AhMigrationStage");
    let mut top = serde_json::Map::new();
    top.insert(key, Value::String("0x02".to_string()));
    build_raw_override(top)
}

// ─── FellowshipCollective ────────────────────────────────────────────────────

/// Raw spec override: register Alice as a rank-9 fellow in `FellowshipCollective`.
///
/// Injects storage entries for `Members`, `MemberCount`, `IdToIndex`, and `IndexToId`
/// for ranks 0 through 9 (a rank-N fellow is also a member at all lower ranks).
pub fn fellowship_collective_override() -> Value {
    let mut top = serde_json::Map::new();

    // Members[Alice] = MemberRecord { rank: 9 }
    // MemberRecord is a struct with a single u16 field, SCALE-encoded as 2 bytes LE.
    let members_key = storage_map_key("FellowshipCollective", "Members", &ALICE_ACCOUNT_ID);
    top.insert(
        members_key,
        Value::String(to_hex(&ALICE_FELLOWSHIP_RANK.to_le_bytes())),
    );

    // For each rank 0..=9:
    for rank in 0..=ALICE_FELLOWSHIP_RANK {
        let rank_encoded = rank.to_le_bytes(); // u16 LE

        // MemberCount[rank] = 1u32
        let count_key = storage_map_key("FellowshipCollective", "MemberCount", &rank_encoded);
        top.insert(count_key, Value::String(to_hex(&1u32.to_le_bytes())));

        // IdToIndex[rank, Alice] = 0u32
        let id_to_idx_key = storage_double_map_key(
            "FellowshipCollective",
            "IdToIndex",
            &rank_encoded,
            &ALICE_ACCOUNT_ID,
        );
        top.insert(id_to_idx_key, Value::String(to_hex(&0u32.to_le_bytes())));

        // IndexToId[rank, 0] = Alice
        let idx_to_id_key = storage_double_map_key(
            "FellowshipCollective",
            "IndexToId",
            &rank_encoded,
            &0u32.to_le_bytes(),
        );
        top.insert(idx_to_id_key, Value::String(to_hex(&ALICE_ACCOUNT_ID)));
    }

    build_raw_override(top)
}
