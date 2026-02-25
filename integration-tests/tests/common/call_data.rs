//! Dynamic call data generation via subxt.
//!
//! Connects to spawned zombienet nodes and generates governance call data that matches
//! the exact runtime metadata, so tests never break due to pallet/call index changes.

use anyhow::{Context, Result};
use subxt::dynamic::{self, Value};
use subxt::{OnlineClient, PolkadotConfig};

/// Generate governance-only call data for a simple referendum test.
///
/// Returns (preimage_hex, gov_submit_hex) for a System.authorize_upgrade referendum on Asset Hub.
pub async fn generate_governance_call_data(
    ah_client: &OnlineClient<PolkadotConfig>,
) -> Result<(String, String)> {
    let dummy_code_hash = [1u8; 32];

    // Build System.authorize_upgrade call bytes.
    let authorize_upgrade_call = dynamic::tx(
        "System",
        "authorize_upgrade",
        vec![Value::from_bytes(dummy_code_hash)],
    );
    let authorize_bytes = ah_client
        .tx()
        .call_data(&authorize_upgrade_call)
        .context("Failed to encode System.authorize_upgrade call data")?;

    log::info!(
        "authorize_upgrade call data: {} bytes",
        authorize_bytes.len()
    );

    // Note the preimage.
    let preimage_call = dynamic::tx(
        "Preimage",
        "note_preimage",
        vec![Value::from_bytes(authorize_bytes.clone())],
    );
    let preimage_hex = encode_call_hex(ah_client, &preimage_call)
        .context("Failed to encode Preimage.note_preimage")?;

    // Compute proposal hash and length.
    let proposal_hash = blake2_256(&authorize_bytes);
    let proposal_len = authorize_bytes.len() as u32;

    log::info!(
        "Proposal hash: 0x{}, len: {}",
        hex::encode(proposal_hash),
        proposal_len
    );

    // Build Referenda.submit with Root origin.
    let gov_submit_call = dynamic::tx(
        "Referenda",
        "submit",
        vec![
            Value::unnamed_variant("system", vec![Value::unnamed_variant("Root", vec![])]),
            Value::unnamed_variant(
                "Lookup",
                vec![
                    Value::from_bytes(proposal_hash),
                    Value::u128(proposal_len as u128),
                ],
            ),
            Value::unnamed_variant("After", vec![Value::u128(0u128)]),
        ],
    );
    let gov_submit_hex = encode_call_hex(ah_client, &gov_submit_call)
        .context("Failed to encode Referenda.submit")?;

    Ok((preimage_hex, gov_submit_hex))
}

/// Generate all call data needed for a multi-chain referendum test.
///
/// This connects to Asset Hub and a fellowship chain to build:
/// 1. Preimage note call for `System.authorize_upgrade(code_hash)` (on Asset Hub)
/// 2. Referenda.submit call for a Root-origin referendum (on Asset Hub)
/// 3. Preimage note call for `System.remark(b"integration-test")` (on fellowship chain)
/// 4. FellowshipReferenda.submit call for a Fellows-origin referendum (on fellowship chain)
///
/// `fellowship_origin_variant` is the OriginCaller variant name for the fellowship origin:
/// - `"FellowshipOrigins"` on Polkadot Collectives parachain
/// - `"Origins"` on Kusama relay chain (where fellowship pallets live on relay)
///
/// Returns (gov_preimage_hex, gov_submit_hex, fellowship_preimage_hex, fellowship_submit_hex).
pub async fn generate_relay_upgrade_call_data(
    ah_client: &OnlineClient<PolkadotConfig>,
    coll_client: &OnlineClient<PolkadotConfig>,
    fellowship_origin_variant: &str,
) -> Result<(String, String, String, String)> {
    let dummy_code_hash = [1u8; 32];

    // === Governance (Asset Hub) ===

    let authorize_upgrade_call = dynamic::tx(
        "System",
        "authorize_upgrade",
        vec![Value::from_bytes(dummy_code_hash)],
    );
    let authorize_bytes = ah_client
        .tx()
        .call_data(&authorize_upgrade_call)
        .context("Failed to encode System.authorize_upgrade call data")?;

    log::info!(
        "authorize_upgrade call data: {} bytes",
        authorize_bytes.len()
    );

    let gov_preimage_call = dynamic::tx(
        "Preimage",
        "note_preimage",
        vec![Value::from_bytes(authorize_bytes.clone())],
    );
    let gov_preimage_hex = encode_call_hex(ah_client, &gov_preimage_call)
        .context("Failed to encode governance Preimage.note_preimage")?;

    let gov_proposal_hash = blake2_256(&authorize_bytes);
    let gov_proposal_len = authorize_bytes.len() as u32;

    log::info!(
        "Gov proposal hash: 0x{}, len: {}",
        hex::encode(gov_proposal_hash),
        gov_proposal_len
    );

    let gov_submit_call = dynamic::tx(
        "Referenda",
        "submit",
        vec![
            Value::unnamed_variant("system", vec![Value::unnamed_variant("Root", vec![])]),
            Value::unnamed_variant(
                "Lookup",
                vec![
                    Value::from_bytes(gov_proposal_hash),
                    Value::u128(gov_proposal_len as u128),
                ],
            ),
            Value::unnamed_variant("After", vec![Value::u128(0u128)]),
        ],
    );
    let gov_submit_hex = encode_call_hex(ah_client, &gov_submit_call)
        .context("Failed to encode Referenda.submit")?;

    // === Fellowship (Collectives) ===

    // Use System.remark as a simple fellowship proposal.
    // The exact call doesn't matter — we just need a valid proposal that can be
    // submitted, simulated, and executed to exercise the tool's multi-chain flow.
    let remark_call = dynamic::tx(
        "System",
        "remark",
        vec![Value::from_bytes(b"integration-test")],
    );
    let remark_bytes = coll_client
        .tx()
        .call_data(&remark_call)
        .context("Failed to encode System.remark on Collectives")?;

    log::info!("Fellowship remark call data: {} bytes", remark_bytes.len());

    let fellowship_preimage_call = dynamic::tx(
        "Preimage",
        "note_preimage",
        vec![Value::from_bytes(remark_bytes.clone())],
    );
    let fellowship_preimage_hex = encode_call_hex(coll_client, &fellowship_preimage_call)
        .context("Failed to encode fellowship Preimage.note_preimage")?;

    let fellowship_proposal_hash = blake2_256(&remark_bytes);
    let fellowship_proposal_len = remark_bytes.len() as u32;

    log::info!(
        "Fellowship proposal hash: 0x{}, len: {}",
        hex::encode(fellowship_proposal_hash),
        fellowship_proposal_len
    );

    let fellowship_submit_call = dynamic::tx(
        "FellowshipReferenda",
        "submit",
        vec![
            Value::unnamed_variant(
                fellowship_origin_variant,
                vec![Value::unnamed_variant("Fellows", vec![])],
            ),
            Value::unnamed_variant(
                "Lookup",
                vec![
                    Value::from_bytes(fellowship_proposal_hash),
                    Value::u128(fellowship_proposal_len as u128),
                ],
            ),
            Value::unnamed_variant("After", vec![Value::u128(0u128)]),
        ],
    );
    let fellowship_submit_hex = encode_call_hex(coll_client, &fellowship_submit_call)
        .context("Failed to encode FellowshipReferenda.submit")?;

    Ok((
        gov_preimage_hex,
        gov_submit_hex,
        fellowship_preimage_hex,
        fellowship_submit_hex,
    ))
}

/// Generate governance call data with intentionally WRONG preimage hash.
///
/// Notes a valid preimage (so `Preimage.note_preimage` succeeds on-chain) but submits
/// the referendum with a mismatched hash (`[0u8; 32]`) and wrong length. This causes
/// the referendum to be created successfully but dispatch to fail when the runtime
/// tries to look up the preimage at execution time.
///
/// Returns (preimage_hex, gov_submit_hex) — same shape as `generate_governance_call_data`.
pub async fn generate_governance_call_data_with_wrong_preimage(
    ah_client: &OnlineClient<PolkadotConfig>,
) -> Result<(String, String)> {
    let dummy_code_hash = [1u8; 32];

    // Build a real System.authorize_upgrade call and note its preimage normally.
    let authorize_upgrade_call = dynamic::tx(
        "System",
        "authorize_upgrade",
        vec![Value::from_bytes(dummy_code_hash)],
    );
    let authorize_bytes = ah_client
        .tx()
        .call_data(&authorize_upgrade_call)
        .context("Failed to encode System.authorize_upgrade call data")?;

    let preimage_call = dynamic::tx(
        "Preimage",
        "note_preimage",
        vec![Value::from_bytes(authorize_bytes)],
    );
    let preimage_hex = encode_call_hex(ah_client, &preimage_call)
        .context("Failed to encode Preimage.note_preimage")?;

    // Submit referendum with WRONG hash — all zeros, doesn't match any noted preimage.
    let wrong_hash = [0u8; 32];
    let wrong_len = 999u32;

    log::info!(
        "Negative test: using wrong proposal hash 0x{}, len {}",
        hex::encode(wrong_hash),
        wrong_len
    );

    let gov_submit_call = dynamic::tx(
        "Referenda",
        "submit",
        vec![
            Value::unnamed_variant("system", vec![Value::unnamed_variant("Root", vec![])]),
            Value::unnamed_variant(
                "Lookup",
                vec![
                    Value::from_bytes(wrong_hash),
                    Value::u128(wrong_len as u128),
                ],
            ),
            Value::unnamed_variant("After", vec![Value::u128(0u128)]),
        ],
    );
    let gov_submit_hex = encode_call_hex(ah_client, &gov_submit_call)
        .context("Failed to encode Referenda.submit with wrong hash")?;

    Ok((preimage_hex, gov_submit_hex))
}

/// Generate governance call data using System.remark as the proposal.
///
/// Unlike `generate_governance_call_data` which uses `System.authorize_upgrade`,
/// this exercises a non-upgrade proposal type to verify the tool works with arbitrary calls.
///
/// Returns (preimage_hex, gov_submit_hex).
pub async fn generate_remark_referendum_call_data(
    ah_client: &OnlineClient<PolkadotConfig>,
) -> Result<(String, String)> {
    let remark_call = dynamic::tx(
        "System",
        "remark",
        vec![Value::from_bytes(b"integration-test-remark")],
    );
    let remark_bytes = ah_client
        .tx()
        .call_data(&remark_call)
        .context("Failed to encode System.remark")?;

    log::info!("Remark proposal call data: {} bytes", remark_bytes.len());

    let preimage_call = dynamic::tx(
        "Preimage",
        "note_preimage",
        vec![Value::from_bytes(remark_bytes.clone())],
    );
    let preimage_hex = encode_call_hex(ah_client, &preimage_call)
        .context("Failed to encode Preimage.note_preimage for remark")?;

    let proposal_hash = blake2_256(&remark_bytes);
    let proposal_len = remark_bytes.len() as u32;

    log::info!(
        "Remark proposal hash: 0x{}, len: {}",
        hex::encode(proposal_hash),
        proposal_len
    );

    let gov_submit_call = dynamic::tx(
        "Referenda",
        "submit",
        vec![
            Value::unnamed_variant("system", vec![Value::unnamed_variant("Root", vec![])]),
            Value::unnamed_variant(
                "Lookup",
                vec![
                    Value::from_bytes(proposal_hash),
                    Value::u128(proposal_len as u128),
                ],
            ),
            Value::unnamed_variant("After", vec![Value::u128(0u128)]),
        ],
    );
    let gov_submit_hex = encode_call_hex(ah_client, &gov_submit_call)
        .context("Failed to encode Referenda.submit for remark")?;

    Ok((preimage_hex, gov_submit_hex))
}

/// Generate hex for a System.remark call, suitable for the `--pre-call` flag.
pub async fn generate_pre_call_remark_hex(
    ah_client: &OnlineClient<PolkadotConfig>,
) -> Result<String> {
    let remark_call = dynamic::tx(
        "System",
        "remark",
        vec![Value::from_bytes(b"pre-call-test")],
    );
    let bytes = ah_client
        .tx()
        .call_data(&remark_call)
        .context("Failed to encode System.remark for pre-call")?;
    Ok(format!("0x{}", hex::encode(bytes)))
}

/// Generate fellowship-only call data (no governance referendum).
///
/// Creates a System.remark proposal on the fellowship chain, notes its preimage, and
/// generates a FellowshipReferenda.submit call with Fellows origin.
///
/// `fellowship_origin_variant` is the OriginCaller variant name for the fellowship origin:
/// - `"FellowshipOrigins"` on Polkadot Collectives parachain
/// - `"Origins"` on Kusama relay chain (where fellowship pallets live on relay)
///
/// Returns (preimage_hex, submit_hex).
pub async fn generate_fellowship_only_call_data(
    coll_client: &OnlineClient<PolkadotConfig>,
    fellowship_origin_variant: &str,
) -> Result<(String, String)> {
    let remark_call = dynamic::tx(
        "System",
        "remark",
        vec![Value::from_bytes(b"fellowship-only-test")],
    );
    let remark_bytes = coll_client
        .tx()
        .call_data(&remark_call)
        .context("Failed to encode System.remark on Collectives")?;

    log::info!(
        "Fellowship-only remark call data: {} bytes",
        remark_bytes.len()
    );

    let preimage_call = dynamic::tx(
        "Preimage",
        "note_preimage",
        vec![Value::from_bytes(remark_bytes.clone())],
    );
    let preimage_hex = encode_call_hex(coll_client, &preimage_call)
        .context("Failed to encode fellowship Preimage.note_preimage")?;

    let proposal_hash = blake2_256(&remark_bytes);
    let proposal_len = remark_bytes.len() as u32;

    log::info!(
        "Fellowship-only proposal hash: 0x{}, len: {}",
        hex::encode(proposal_hash),
        proposal_len
    );

    let submit_call = dynamic::tx(
        "FellowshipReferenda",
        "submit",
        vec![
            Value::unnamed_variant(
                fellowship_origin_variant,
                vec![Value::unnamed_variant("Fellows", vec![])],
            ),
            Value::unnamed_variant(
                "Lookup",
                vec![
                    Value::from_bytes(proposal_hash),
                    Value::u128(proposal_len as u128),
                ],
            ),
            Value::unnamed_variant("After", vec![Value::u128(0u128)]),
        ],
    );
    let submit_hex = encode_call_hex(coll_client, &submit_call)
        .context("Failed to encode FellowshipReferenda.submit")?;

    Ok((preimage_hex, submit_hex))
}

/// Generate governance call data for any track.
///
/// Uses `System.remark` as a universal proposal that works with any origin.
/// The track's origin determines which referendum track the proposal targets.
///
/// * `gov_origin_variant` — outer OriginCaller variant for non-Root governance origins
///   (e.g. `"Origins"` on both Polkadot AH and Kusama AH).
pub async fn generate_governance_track_call_data(
    ah_client: &OnlineClient<PolkadotConfig>,
    track: &super::tracks::GovernanceTrack,
    gov_origin_variant: &str,
) -> Result<(String, String)> {
    let remark_call = dynamic::tx(
        "System",
        "remark",
        vec![Value::from_bytes(
            format!("gov-track-{}-test", track.name).into_bytes(),
        )],
    );
    let remark_bytes = ah_client
        .tx()
        .call_data(&remark_call)
        .context("Failed to encode System.remark")?;

    log::info!(
        "Gov track {} (id={}) remark call data: {} bytes",
        track.name,
        track.id,
        remark_bytes.len()
    );

    let preimage_call = dynamic::tx(
        "Preimage",
        "note_preimage",
        vec![Value::from_bytes(remark_bytes.clone())],
    );
    let preimage_hex = encode_call_hex(ah_client, &preimage_call)
        .context("Failed to encode Preimage.note_preimage")?;

    let proposal_hash = blake2_256(&remark_bytes);
    let proposal_len = remark_bytes.len() as u32;

    // Build the proposal origin based on the track type
    let proposal_origin = if track.is_root {
        Value::unnamed_variant("system", vec![Value::unnamed_variant("Root", vec![])])
    } else {
        Value::unnamed_variant(
            gov_origin_variant,
            vec![Value::unnamed_variant(track.origin_variant, vec![])],
        )
    };

    let gov_submit_call = dynamic::tx(
        "Referenda",
        "submit",
        vec![
            proposal_origin,
            Value::unnamed_variant(
                "Lookup",
                vec![
                    Value::from_bytes(proposal_hash),
                    Value::u128(proposal_len as u128),
                ],
            ),
            Value::unnamed_variant("After", vec![Value::u128(0u128)]),
        ],
    );
    let gov_submit_hex = encode_call_hex(ah_client, &gov_submit_call)
        .context("Failed to encode Referenda.submit")?;

    Ok((preimage_hex, gov_submit_hex))
}

/// Generate fellowship call data for any track.
///
/// Uses `System.remark` as a universal proposal.
///
/// * `fellowship_origin_variant` — outer OriginCaller variant for fellowship origins
///   (e.g. `"FellowshipOrigins"` on Polkadot Collectives, `"Origins"` on Kusama relay).
pub async fn generate_fellowship_track_call_data(
    client: &OnlineClient<PolkadotConfig>,
    track: &super::tracks::FellowshipTrack,
    fellowship_origin_variant: &str,
) -> Result<(String, String)> {
    let remark_call = dynamic::tx(
        "System",
        "remark",
        vec![Value::from_bytes(
            format!("fellowship-track-{}-test", track.name).into_bytes(),
        )],
    );
    let remark_bytes = client
        .tx()
        .call_data(&remark_call)
        .context("Failed to encode System.remark")?;

    log::info!(
        "Fellowship track {} (id={}) remark call data: {} bytes",
        track.name,
        track.id,
        remark_bytes.len()
    );

    let preimage_call = dynamic::tx(
        "Preimage",
        "note_preimage",
        vec![Value::from_bytes(remark_bytes.clone())],
    );
    let preimage_hex = encode_call_hex(client, &preimage_call)
        .context("Failed to encode Preimage.note_preimage")?;

    let proposal_hash = blake2_256(&remark_bytes);
    let proposal_len = remark_bytes.len() as u32;

    let submit_call = dynamic::tx(
        "FellowshipReferenda",
        "submit",
        vec![
            Value::unnamed_variant(
                fellowship_origin_variant,
                vec![Value::unnamed_variant(track.origin_variant, vec![])],
            ),
            Value::unnamed_variant(
                "Lookup",
                vec![
                    Value::from_bytes(proposal_hash),
                    Value::u128(proposal_len as u128),
                ],
            ),
            Value::unnamed_variant("After", vec![Value::u128(0u128)]),
        ],
    );
    let submit_hex = encode_call_hex(client, &submit_call)
        .context("Failed to encode FellowshipReferenda.submit")?;

    Ok((preimage_hex, submit_hex))
}

/// Encode a dynamic transaction payload to hex call data bytes.
fn encode_call_hex<Call: subxt::tx::Payload>(
    client: &OnlineClient<PolkadotConfig>,
    payload: &Call,
) -> Result<String> {
    let bytes = client
        .tx()
        .call_data(payload)
        .context("Failed to encode call data")?;
    Ok(format!("0x{}", hex::encode(bytes)))
}

/// Blake2-256 hash of data, matching the on-chain hashing used for preimage lookups.
fn blake2_256(data: &[u8]) -> [u8; 32] {
    sp_crypto_hashing::blake2_256(data)
}
