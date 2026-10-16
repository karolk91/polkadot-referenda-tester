use serde_json::{json, Value};
use sp_crypto_hashing::{blake2_256, twox_128, twox_64};
use subxt::ext::codec::Encode;
use subxt::utils::AccountId32;
use subxt_signer::sr25519::dev;

use crate::calls::hex_of;
use crate::ids::{Network, ParaId, ASSET_HUB_PARA_ID, BRIDGE_HUB_PARA_ID};

const ALICE_FELLOWSHIP_RANK: u16 = 9;
pub const EXISTING_FELLOW_RANK: u16 = 2;

const XCM_VERSION: u32 = 5;
const DEV_ENDOWMENT: u128 = 1 << 60;
const SOVEREIGN_FUNDING: u128 = 250_000_000_000_000;
const LOWEST_SCHEDULE_PRIORITY: u8 = 63;

const ASSET_HUB_SOVEREIGN_AT_BRIDGE_HUB_POLKADOT: &str =
    "13cKp89SgdtqUngo2WiEijPrQWdHFhzYZLf2TJePKRvExk7o";
const BRIDGE_HUB_POLKADOT_LANE_THIS_CHAIN: &str =
    "13E5fui93Uyua5RtDv2LQj4aVBBHo6YREe3n6CBwYdqNqoxj";
const BRIDGE_HUB_POLKADOT_LANE_BRIDGED_CHAIN: &str =
    "13E5fui93Uyua5RtDv2c9kcAbfrVFeeHyJzHe8sn1Ti77Afd";
const ASSET_HUB_SOVEREIGN_AT_BRIDGE_HUB_KUSAMA: &str =
    "FBeL7EFTDeHnuViqaUHUXvhhUusN5FawDmHgfvzF97DXFr3";
const BRIDGE_HUB_KUSAMA_LANE_THIS_CHAIN: &str = "EoQBtnwp4jMtCEpV7C88rKrz6x1qMBh2z74ibGSqtZRnuMM";
const BRIDGE_HUB_KUSAMA_LANE_BRIDGED_CHAIN: &str =
    "EoQBtnwp4jMtCEpV7CPsssT6bdDHuHZmf3aGXxHJiSA4Dz3";

pub type StorageEntry = (String, String);

pub fn alice_account() -> [u8; 32] {
    dev::alice().public_key().0
}

pub fn bob_account() -> [u8; 32] {
    dev::bob().public_key().0
}

fn ss58(account: [u8; 32]) -> String {
    AccountId32(account).to_string()
}

fn twox64_concat(data: &[u8]) -> Vec<u8> {
    [&twox_64(data)[..], data].concat()
}

fn storage_entry(
    pallet: &str,
    item: &str,
    hashed_keys: &[&[u8]],
    value: impl Encode,
) -> StorageEntry {
    let mut key = [twox_128(pallet.as_bytes()), twox_128(item.as_bytes())].concat();
    for hashed_key in hashed_keys {
        key.extend_from_slice(hashed_key);
    }
    (hex_of(&key), hex_of(&value.encode()))
}

pub fn raw_spec_override(entries: Vec<StorageEntry>) -> Value {
    let top: serde_json::Map<String, Value> = entries
        .into_iter()
        .map(|(key, value)| (key, Value::String(value)))
        .collect();
    json!({ "genesis": { "raw": { "top": top } } })
}

fn enactment_task_name(referendum_index: u32) -> [u8; 32] {
    blake2_256(&(*b"assembly", "enactment", referendum_index).encode())
}

pub fn relay_genesis() -> Value {
    json!({ "configuration": { "config": { "scheduler_params": { "lookahead": 2 } } } })
}

fn supported_remote_version(remote: Network, para_id: ParaId) -> Value {
    json!([[
        { "parents": 2, "interior": { "X2": [
            { "GlobalConsensus": remote.name() },
            { "Parachain": para_id.0 },
        ] } },
        XCM_VERSION,
    ]])
}

fn asset_hub_genesis(remote: Network) -> Value {
    json!({
        "staking": { "devStakers": null },
        "polkadotXcm": {
            "safeXcmVersion": XCM_VERSION,
            "supportedVersion": supported_remote_version(remote, ASSET_HUB_PARA_ID),
        },
    })
}

pub fn asset_hub_polkadot_genesis() -> Value {
    asset_hub_genesis(Network::Kusama)
}

pub fn asset_hub_kusama_genesis() -> Value {
    asset_hub_genesis(Network::Polkadot)
}

fn bridge_hub_genesis(funded_accounts: &[&str], remote: Network) -> Value {
    let mut balances = vec![
        json!([ss58(alice_account()), DEV_ENDOWMENT]),
        json!([ss58(bob_account()), DEV_ENDOWMENT]),
    ];
    balances.extend(
        funded_accounts
            .iter()
            .map(|account| json!([account, SOVEREIGN_FUNDING])),
    );
    json!({
        "balances": { "balances": balances },
        "polkadotXcm": {
            "safeXcmVersion": XCM_VERSION,
            "supportedVersion": supported_remote_version(remote, BRIDGE_HUB_PARA_ID),
        },
    })
}

pub fn bridge_hub_polkadot_genesis() -> Value {
    bridge_hub_genesis(
        &[
            ASSET_HUB_SOVEREIGN_AT_BRIDGE_HUB_POLKADOT,
            BRIDGE_HUB_POLKADOT_LANE_THIS_CHAIN,
            BRIDGE_HUB_POLKADOT_LANE_BRIDGED_CHAIN,
        ],
        Network::Kusama,
    )
}

pub fn bridge_hub_kusama_genesis() -> Value {
    bridge_hub_genesis(
        &[
            ASSET_HUB_SOVEREIGN_AT_BRIDGE_HUB_KUSAMA,
            BRIDGE_HUB_KUSAMA_LANE_THIS_CHAIN,
            BRIDGE_HUB_KUSAMA_LANE_BRIDGED_CHAIN,
        ],
        Network::Polkadot,
    )
}

fn fellow_entries(account: [u8; 32], rank: u16, member_index: u32) -> Vec<StorageEntry> {
    let mut entries = vec![storage_entry(
        "FellowshipCollective",
        "Members",
        &[&twox64_concat(&account)],
        rank,
    )];
    for member_rank in 0..=rank {
        let rank_key = twox64_concat(&member_rank.encode());
        entries.push(storage_entry(
            "FellowshipCollective",
            "MemberCount",
            &[&rank_key],
            member_index + 1,
        ));
        entries.push(storage_entry(
            "FellowshipCollective",
            "IdToIndex",
            &[&rank_key, &twox64_concat(&account)],
            member_index,
        ));
        entries.push(storage_entry(
            "FellowshipCollective",
            "IndexToId",
            &[&rank_key, &twox64_concat(&member_index.encode())],
            account,
        ));
    }
    entries
}

fn fellowship_collective_entries() -> Vec<StorageEntry> {
    let mut entries = fellow_entries(alice_account(), ALICE_FELLOWSHIP_RANK, 0);
    entries.extend(fellow_entries(bob_account(), EXISTING_FELLOW_RANK, 1));
    entries.push(storage_entry(
        "FellowshipCore",
        "Member",
        &[&twox64_concat(&bob_account())],
        (true, 0u32, 0u32),
    ));
    entries
}

pub fn fellowship_collective_storage() -> Value {
    raw_spec_override(fellowship_collective_entries())
}

pub fn approved_governance_referendum_storage(
    call: &[u8],
    referendum_id: u32,
    approval_block: u32,
    enactment_block: u32,
) -> Value {
    let call_hash = hex_of(&blake2_256(call));
    let call_len = call.len() as u32;
    let task_name = hex_of(&enactment_task_name(referendum_id));
    json!({
        "Preimage": {
            "PreimageFor": [[[[call_hash, call_len]], hex_of(&call.to_vec().encode())]],
            "RequestStatusFor": [[[call_hash], {
                "Unrequested": { "ticket": [ss58(alice_account()), 0], "len": call_len },
            }]],
        },
        "Referenda": {
            "ReferendumInfoFor": [[[referendum_id], { "Approved": [approval_block, null, null] }]],
            "ReferendumCount": referendum_id + 1,
        },
        "Scheduler": {
            "Agenda": [[[enactment_block], [{
                "maybe_id": task_name,
                "priority": LOWEST_SCHEDULE_PRIORITY,
                "call": { "Lookup": { "hash": call_hash, "len": call_len } },
                "maybe_periodic": null,
                "origin": { "system": "Root" },
            }]]],
            "Lookup": [[[task_name], [enactment_block, 0]]],
        },
    })
}
