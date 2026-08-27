//! Raw storage key computation for zombienet genesis injection via `with_raw_spec_override()`.
//!
//! Computes hex-encoded storage keys and SCALE-encoded values for:
//! - `AhMigrator::AhMigrationStage` → `MigrationDone` (unlocks BaseCallFilter on Asset Hub)
//! - `FellowshipCollective::{Members, IdToIndex, IndexToId, MemberCount}` (registers Alice as fellow)
//! - A second "existing fellow" (Bob) registered in both `FellowshipCollective` AND
//!   `FellowshipCore::Member`, used to regression-test that the tool's storage injection
//!   does not wipe pre-existing fellows (see `fellowship_collective_override`).
//!
//! These are injected into `genesis.raw.top` so that by-number tests can submit
//! referenda directly to live zombienet nodes.

use serde_json::{json, Value};
use sp_crypto_hashing::{blake2_128, blake2_256, twox_128, twox_64};

/// Alice's raw AccountId (Sr25519 public key bytes).
const ALICE_ACCOUNT_ID: [u8; 32] = [
    0xd4, 0x35, 0x93, 0xc7, 0x15, 0xfd, 0xd3, 0x1c, 0x61, 0x14, 0x1a, 0xbd, 0x04, 0xa9, 0x9f, 0xd6,
    0x82, 0x2c, 0x85, 0x58, 0x85, 0x4c, 0xcd, 0xe3, 0x9a, 0x56, 0x84, 0xe7, 0xa5, 0x6d, 0xa2, 0x7d,
];

/// Bob's raw AccountId (Sr25519 public key bytes).
///
/// Seeded as a *pre-existing* fellow (rank 2) so a referendum proposal can target
/// him via `FellowshipCore::approve`. The tool's old storage injection wiped all
/// `FellowshipCollective` members before re-adding only Alice, which desynced the
/// collective from `FellowshipCore` and made Bob `Unranked` at enactment.
pub const BOB_ACCOUNT_ID: [u8; 32] = [
    0x8e, 0xaf, 0x04, 0x15, 0x16, 0x87, 0x73, 0x63, 0x26, 0xc9, 0xfe, 0xa1, 0x7e, 0x25, 0xfc, 0x52,
    0x87, 0x61, 0x36, 0x93, 0xc9, 0x12, 0x90, 0x9c, 0xb2, 0x26, 0xaa, 0x47, 0x94, 0xf2, 0x6a, 0x48,
];

/// The rank to assign Alice in FellowshipCollective (covers all tracks up to Fellowship9Dan).
const ALICE_FELLOWSHIP_RANK: u16 = 9;

/// The rank to assign the pre-existing fellow (Bob). Matches the `RetainAt2Dan` /
/// `FellowshipCore::approve(who, 2)` regression scenario.
pub const EXISTING_FELLOW_RANK: u16 = 2;

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

// ─── Approved Governance Referendum with Future Enactment ───────────────────
//
// Helpers below are intentionally self-contained so the override remains usable
// even if other genesis-injection helpers are removed.

/// SCALE-encode a compact unsigned integer (single-byte, two-byte, four-byte modes).
fn compact_encode_u32(value: u32) -> Vec<u8> {
    if value < 0x40 {
        vec![(value as u8) << 2]
    } else if value < 0x4000 {
        let v = ((value as u16) << 2) | 0x01;
        v.to_le_bytes().to_vec()
    } else if value < 0x4000_0000 {
        let v = (value << 2) | 0x02;
        v.to_le_bytes().to_vec()
    } else {
        let mut buf = vec![0x03];
        buf.extend_from_slice(&value.to_le_bytes());
        buf
    }
}

/// Build a StorageMap key with Identity hasher (key bytes appended raw, no hashing).
fn storage_map_key_identity(pallet: &str, item: &str, map_key: &[u8]) -> String {
    let mut key = storage_prefix(pallet, item);
    key.extend_from_slice(map_key);
    to_hex(&key)
}

/// Build a StorageMap key with Blake2_128Concat hasher (used by `pallet-referenda`).
fn storage_map_key_blake2_128(pallet: &str, item: &str, map_key: &[u8]) -> String {
    let mut key = storage_prefix(pallet, item);
    key.extend_from_slice(&blake2_128(map_key));
    key.extend_from_slice(map_key);
    to_hex(&key)
}

/// Compute the Scheduler task name pallet-referenda uses for a referendum's enactment.
///
/// Mirrors substrate's:
///   schedule_named((b"assembly", "enactment", index).using_encoded(blake2_256), ...)
fn enactment_task_name(referendum_index: u32) -> [u8; 32] {
    // SCALE encode (b"assembly" /* [u8;8] */, "enactment" /* &str */, index /* u32 */)
    let mut encoded = Vec::with_capacity(8 + 1 + 9 + 4);
    encoded.extend_from_slice(b"assembly"); // [u8; 8] — fixed-size, no length prefix
    encoded.push((9u32 << 2) as u8); // compact(9) for "enactment".len()
    encoded.extend_from_slice(b"enactment");
    encoded.extend_from_slice(&referendum_index.to_le_bytes());
    blake2_256(&encoded)
}

/// Inject `Preimage::PreimageFor[(hash, len)]` and `Preimage::RequestStatusFor[hash]`
/// so a `Bounded::Lookup { hash, len }` call reference resolves at dispatch time.
fn inject_preimage_for_approved(top: &mut serde_json::Map<String, Value>, call_bytes: &[u8]) {
    let call_hash = blake2_256(call_bytes);
    let call_len = call_bytes.len() as u32;

    let mut preimage_map_key = Vec::with_capacity(36);
    preimage_map_key.extend_from_slice(&call_hash);
    preimage_map_key.extend_from_slice(&call_len.to_le_bytes());
    let preimage_storage_key =
        storage_map_key_identity("Preimage", "PreimageFor", &preimage_map_key);

    let mut preimage_value = compact_encode_u32(call_len);
    preimage_value.extend_from_slice(call_bytes);
    top.insert(preimage_storage_key, Value::String(to_hex(&preimage_value)));

    // RequestStatusFor[hash] = Unrequested { ticket: (Alice, 0), len }
    let status_storage_key =
        storage_map_key_identity("Preimage", "RequestStatusFor", &call_hash);
    let mut status_value = vec![0x00]; // Unrequested variant
    status_value.extend_from_slice(&ALICE_ACCOUNT_ID);
    status_value.extend_from_slice(&0u128.to_le_bytes());
    status_value.extend_from_slice(&call_len.to_le_bytes());
    top.insert(status_storage_key, Value::String(to_hex(&status_value)));
}

/// Raw spec override that puts an `Approved` governance referendum into Asset Hub genesis
/// whose enactment is scheduled at a future block, plus the AhMigrator unlock so the chain
/// accepts `Referenda.submit` (kept for parity with [`ah_migrator_override`]).
///
/// Lets integration tests exercise the tool's "approved with future enactment" code path
/// without driving a real referendum through voting + confirmation.
///
/// Injects:
/// - `AhMigrator::AhMigrationStage` = `MigrationDone`
/// - `Preimage::PreimageFor[(hash, len)]` = call_bytes
/// - `Preimage::RequestStatusFor[hash]` = Unrequested status
/// - `Referenda::ReferendumInfoFor[ref_id]` = `Approved(approval_block, None, None)`
/// - `Referenda::ReferendumCount` = `ref_id + 1`
/// - `Scheduler::Agenda[enactment_block]` = `[Some(Scheduled { maybe_id, Lookup, Root })]`
/// - `Scheduler::Lookup[task_name]` = `(enactment_block, 0)`
///
/// `task_name = blake2_256(SCALE_encode((b"assembly", "enactment", ref_id_u32)))` matches
/// pallet-referenda's `schedule_enactment` so the tool can locate the entry by name.
pub fn ah_approved_governance_referendum_override(
    call_bytes: &[u8],
    referendum_id: u32,
    approval_block: u32,
    enactment_block: u32,
) -> Value {
    let mut top = serde_json::Map::new();

    // ── AhMigrator unlock (mirrors `ah_migrator_override`) ───────────────────
    let migrator_key = storage_value_key("AhMigrator", "AhMigrationStage");
    top.insert(migrator_key, Value::String("0x02".to_string()));

    // ── Preimage for the proposal call ───────────────────────────────────────
    inject_preimage_for_approved(&mut top, call_bytes);

    let call_hash = blake2_256(call_bytes);
    let call_len = call_bytes.len() as u32;
    let task_name = enactment_task_name(referendum_id);

    // ── Referenda::ReferendumInfoFor[ref_id] = Approved(block, None, None) ───
    // Variant index 1 = Approved. Both deposit Options encoded as None (0x00).
    let ref_info_key =
        storage_map_key_blake2_128("Referenda", "ReferendumInfoFor", &referendum_id.to_le_bytes());
    let mut ref_info_value = vec![0x01]; // Approved variant
    ref_info_value.extend_from_slice(&approval_block.to_le_bytes());
    ref_info_value.push(0x00); // submission_deposit: None
    ref_info_value.push(0x00); // decision_deposit: None
    top.insert(ref_info_key, Value::String(to_hex(&ref_info_value)));

    // ── Referenda::ReferendumCount = ref_id + 1 ──────────────────────────────
    let count_key = storage_value_key("Referenda", "ReferendumCount");
    top.insert(
        count_key,
        Value::String(to_hex(&(referendum_id + 1).to_le_bytes())),
    );

    // ── Scheduler::Agenda[enactment_block] = [Some(Scheduled{...})] ──────────
    let agenda_key = storage_map_key("Scheduler", "Agenda", &enactment_block.to_le_bytes());
    let mut agenda_value = Vec::new();
    agenda_value.extend_from_slice(&compact_encode_u32(1)); // BoundedVec length = 1
    agenda_value.push(0x01); // Option::Some
    agenda_value.push(0x01); // maybe_id: Some
    agenda_value.extend_from_slice(&task_name); // [u8; 32] task name
    agenda_value.push(63); // priority (matches pallet-referenda's LOWEST_PRIORITY)
    agenda_value.push(0x02); // call: Bounded::Lookup
    agenda_value.extend_from_slice(&call_hash);
    agenda_value.extend_from_slice(&call_len.to_le_bytes());
    agenda_value.push(0x00); // maybe_periodic: None
    agenda_value.push(0x00); // origin: OriginCaller::system
    agenda_value.push(0x00); // RawOrigin::Root
    top.insert(agenda_key, Value::String(to_hex(&agenda_value)));

    // ── Scheduler::Lookup[task_name] = (enactment_block, 0) ──────────────────
    let lookup_key = storage_map_key_identity("Scheduler", "Lookup", &task_name);
    let mut lookup_value = Vec::with_capacity(8);
    lookup_value.extend_from_slice(&enactment_block.to_le_bytes());
    lookup_value.extend_from_slice(&0u32.to_le_bytes());
    top.insert(lookup_key, Value::String(to_hex(&lookup_value)));

    log::info!(
        "Approved-with-future-enactment injection: ref_id={}, approval_block={}, enactment_block={}, call_hash=0x{}, task_name=0x{}",
        referendum_id,
        approval_block,
        enactment_block,
        hex::encode(call_hash),
        hex::encode(task_name),
    );

    build_raw_override(top)
}

// ─── FellowshipCollective ────────────────────────────────────────────────────

/// Raw spec override: register Alice as a rank-9 fellow in `FellowshipCollective`,
/// plus Bob as a pre-existing rank-2 fellow tracked in both `FellowshipCollective`
/// and `FellowshipCore`.
///
/// Injects storage entries for `Members`, `MemberCount`, `IdToIndex`, and `IndexToId`
/// for ranks 0 through 9 (a rank-N fellow is also a member at all lower ranks).
///
/// Bob exists so a referendum proposal can call `FellowshipCore::approve(Bob, 2)`:
/// the tool's injection must leave Bob's collective membership intact (additive),
/// otherwise enactment fails with `FellowshipCore::Unranked`.
pub fn fellowship_collective_override() -> Value {
    let mut top = serde_json::Map::new();

    // Members[Alice] = MemberRecord { rank: 9 }
    // MemberRecord is a struct with a single u16 field, SCALE-encoded as 2 bytes LE.
    let members_key = storage_map_key("FellowshipCollective", "Members", &ALICE_ACCOUNT_ID);
    top.insert(
        members_key,
        Value::String(to_hex(&ALICE_FELLOWSHIP_RANK.to_le_bytes())),
    );

    // For each rank 0..=9 (Alice is member index 0 at every rank):
    for rank in 0..=ALICE_FELLOWSHIP_RANK {
        let rank_encoded = rank.to_le_bytes(); // u16 LE

        // MemberCount[rank] = 1u32 (Alice only; Bob bumps the low ranks below)
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

    seed_existing_fellow(&mut top);

    build_raw_override(top)
}

/// Seed Bob as a pre-existing rank-2 fellow, consistent across both pallets.
///
/// In `FellowshipCollective` Bob is member index 1 at ranks 0..=2 (Alice is index 0),
/// so `MemberCount` for those ranks becomes 2. In `FellowshipCore` Bob is an active
/// tracked member, which is required for `FellowshipCore::approve(Bob, 2)` to reach
/// the rank check (otherwise it fails earlier with `NotTracked`).
fn seed_existing_fellow(top: &mut serde_json::Map<String, Value>) {
    // FellowshipCollective::Members[Bob] = MemberRecord { rank: 2 }
    let members_key = storage_map_key("FellowshipCollective", "Members", &BOB_ACCOUNT_ID);
    top.insert(
        members_key,
        Value::String(to_hex(&EXISTING_FELLOW_RANK.to_le_bytes())),
    );

    // Bob is a member at ranks 0..=2, occupying member index 1 (after Alice at index 0).
    for rank in 0..=EXISTING_FELLOW_RANK {
        let rank_encoded = rank.to_le_bytes();

        // MemberCount[rank] = 2 (Alice + Bob)
        let count_key = storage_map_key("FellowshipCollective", "MemberCount", &rank_encoded);
        top.insert(count_key, Value::String(to_hex(&2u32.to_le_bytes())));

        // IdToIndex[rank, Bob] = 1
        let id_to_idx_key = storage_double_map_key(
            "FellowshipCollective",
            "IdToIndex",
            &rank_encoded,
            &BOB_ACCOUNT_ID,
        );
        top.insert(id_to_idx_key, Value::String(to_hex(&1u32.to_le_bytes())));

        // IndexToId[rank, 1] = Bob
        let idx_to_id_key = storage_double_map_key(
            "FellowshipCollective",
            "IndexToId",
            &rank_encoded,
            &1u32.to_le_bytes(),
        );
        top.insert(idx_to_id_key, Value::String(to_hex(&BOB_ACCOUNT_ID)));
    }

    // FellowshipCore::Member[Bob] = MemberStatus { is_active: true, last_promotion: 0, last_proof: 0 }
    // SCALE: bool (1 byte) ++ u32 LE ++ u32 LE.
    let mut member_status = Vec::with_capacity(9);
    member_status.push(0x01); // is_active = true
    member_status.extend_from_slice(&0u32.to_le_bytes()); // last_promotion
    member_status.extend_from_slice(&0u32.to_le_bytes()); // last_proof
    let core_member_key = storage_map_key("FellowshipCore", "Member", &BOB_ACCOUNT_ID);
    top.insert(core_member_key, Value::String(to_hex(&member_status)));
}
