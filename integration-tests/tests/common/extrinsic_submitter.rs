//! Submit signed extrinsics directly to zombienet nodes for the by-number test flow.
//!
//! These functions create referenda on-chain (not via Chopsticks) so that the tool
//! can be tested with `--referendum <id>` or `--fellowship <id>` flags.

use anyhow::{Context, Result};
use subxt::dynamic::{self, Value};
use subxt::{OnlineClient, PolkadotConfig};
use subxt_signer::sr25519::dev;

use super::tracks::{FellowshipTrack, GovernanceTrack};

/// Result of submitting a referendum to a live zombienet node.
pub struct SubmittedReferendum {
    /// The referendum ID (0-indexed).
    pub referendum_id: u32,
    /// Block number at or after which the referendum exists.
    pub block_number: u32,
}

/// Submit a governance referendum on Asset Hub for the given track.
///
/// Notes a preimage and submits a `Referenda.submit` extrinsic signed by Alice.
/// Returns the referendum ID and the block number to use as fork point.
///
/// Requires `AhMigrator::AhMigrationStage = MigrationDone` to be set in genesis
/// via `with_raw_spec_override()`, otherwise `Referenda.submit` is blocked by BaseCallFilter.
///
/// * `gov_origin_variant` — outer OriginCaller variant for non-Root governance origins
///   (e.g. `"Origins"` on both Polkadot AH and Kusama AH).
pub async fn submit_governance_referendum(
    client: &OnlineClient<PolkadotConfig>,
    track: &GovernanceTrack,
    gov_origin_variant: &str,
) -> Result<SubmittedReferendum> {
    let alice = dev::alice();

    // Build a System.remark call as the proposal
    let remark_call = dynamic::tx(
        "System",
        "remark",
        vec![Value::from_bytes(
            format!("bynum-gov-{}", track.name).into_bytes(),
        )],
    );
    let remark_bytes = client
        .tx()
        .call_data(&remark_call)
        .context("Failed to encode System.remark")?;

    // Note preimage
    let preimage_tx = dynamic::tx(
        "Preimage",
        "note_preimage",
        vec![Value::from_bytes(remark_bytes.clone())],
    );
    client
        .tx()
        .sign_and_submit_then_watch_default(&preimage_tx, &alice)
        .await
        .context("Failed to submit Preimage.note_preimage")?
        .wait_for_finalized_success()
        .await
        .context("Preimage.note_preimage not finalized")?;

    log::info!(
        "Preimage noted for governance track {} (id={})",
        track.name,
        track.id
    );

    // Build proposal origin
    let proposal_origin = if track.is_root {
        Value::unnamed_variant("system", vec![Value::unnamed_variant("Root", vec![])])
    } else {
        Value::unnamed_variant(
            gov_origin_variant,
            vec![Value::unnamed_variant(track.origin_variant, vec![])],
        )
    };

    let proposal_hash = sp_crypto_hashing::blake2_256(&remark_bytes);
    let proposal_len = remark_bytes.len() as u32;

    // Submit referendum
    let submit_tx = dynamic::tx(
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

    let tx_in_block = client
        .tx()
        .sign_and_submit_then_watch_default(&submit_tx, &alice)
        .await
        .context("Failed to submit Referenda.submit")?
        .wait_for_finalized()
        .await
        .context("Referenda.submit not finalized")?;

    let block_hash = tx_in_block.block_hash();
    let block = client.blocks().at(block_hash).await?;
    let block_number = block.number();

    // Verify extrinsic succeeded
    tx_in_block
        .wait_for_success()
        .await
        .context("Referenda.submit dispatch failed")?;

    // Determine referendum ID from ReferendumCount
    let count_query = dynamic::storage("Referenda", "ReferendumCount", ());
    let count_val = client
        .storage()
        .at_latest()
        .await?
        .fetch(&count_query)
        .await
        .context("Failed to read ReferendumCount")?
        .context("ReferendumCount not found")?;
    let referendum_id = count_val
        .as_type::<u32>()
        .context("Failed to decode ReferendumCount")?
        - 1;

    log::info!(
        "Governance referendum #{} created on track {} (id={}) at block #{}",
        referendum_id,
        track.name,
        track.id,
        block_number
    );

    Ok(SubmittedReferendum {
        referendum_id,
        block_number,
    })
}

/// Submit a governance referendum with an Inline proposal (no preimage).
///
/// Uses `System.remark` as a small proposal that fits within the inline size limit.
/// Submits a `Referenda.submit` extrinsic signed by Alice with Root origin.
pub async fn submit_governance_referendum_inline(
    client: &OnlineClient<PolkadotConfig>,
) -> Result<SubmittedReferendum> {
    let alice = dev::alice();

    let remark_call = dynamic::tx(
        "System",
        "remark",
        vec![Value::from_bytes(b"bynum-inline-gov")],
    );
    let remark_bytes = client
        .tx()
        .call_data(&remark_call)
        .context("Failed to encode System.remark")?;

    let submit_tx = dynamic::tx(
        "Referenda",
        "submit",
        vec![
            Value::unnamed_variant("system", vec![Value::unnamed_variant("Root", vec![])]),
            Value::unnamed_variant("Inline", vec![Value::from_bytes(remark_bytes)]),
            Value::unnamed_variant("After", vec![Value::u128(0u128)]),
        ],
    );

    let tx_in_block = client
        .tx()
        .sign_and_submit_then_watch_default(&submit_tx, &alice)
        .await
        .context("Failed to submit Referenda.submit (inline)")?
        .wait_for_finalized()
        .await
        .context("Referenda.submit (inline) not finalized")?;

    let block_hash = tx_in_block.block_hash();
    let block = client.blocks().at(block_hash).await?;
    let block_number = block.number();

    tx_in_block
        .wait_for_success()
        .await
        .context("Referenda.submit (inline) dispatch failed")?;

    let count_query = dynamic::storage("Referenda", "ReferendumCount", ());
    let count_val = client
        .storage()
        .at_latest()
        .await?
        .fetch(&count_query)
        .await
        .context("Failed to read ReferendumCount")?
        .context("ReferendumCount not found")?;
    let referendum_id = count_val
        .as_type::<u32>()
        .context("Failed to decode ReferendumCount")?
        - 1;

    log::info!(
        "Governance referendum #{} created with Inline proposal at block #{}",
        referendum_id,
        block_number
    );

    Ok(SubmittedReferendum {
        referendum_id,
        block_number,
    })
}

/// Submit a fellowship referendum for the given track.
///
/// Notes a preimage and submits a `FellowshipReferenda.submit` extrinsic signed by Alice.
/// Alice must be registered as a fellow with sufficient rank in genesis.
///
/// * `fellowship_origin_variant` — outer OriginCaller variant for fellowship origins
///   (e.g. `"FellowshipOrigins"` on Polkadot Collectives, `"Origins"` on Kusama relay).
pub async fn submit_fellowship_referendum(
    client: &OnlineClient<PolkadotConfig>,
    track: &FellowshipTrack,
    fellowship_origin_variant: &str,
) -> Result<SubmittedReferendum> {
    let alice = dev::alice();

    // Build a System.remark call as the proposal
    let remark_call = dynamic::tx(
        "System",
        "remark",
        vec![Value::from_bytes(
            format!("bynum-fell-{}", track.name).into_bytes(),
        )],
    );
    let remark_bytes = client
        .tx()
        .call_data(&remark_call)
        .context("Failed to encode System.remark")?;

    // Note preimage
    let preimage_tx = dynamic::tx(
        "Preimage",
        "note_preimage",
        vec![Value::from_bytes(remark_bytes.clone())],
    );
    client
        .tx()
        .sign_and_submit_then_watch_default(&preimage_tx, &alice)
        .await
        .context("Failed to submit Preimage.note_preimage")?
        .wait_for_finalized_success()
        .await
        .context("Preimage.note_preimage not finalized")?;

    log::info!(
        "Preimage noted for fellowship track {} (id={})",
        track.name,
        track.id
    );

    let proposal_hash = sp_crypto_hashing::blake2_256(&remark_bytes);
    let proposal_len = remark_bytes.len() as u32;

    // Submit fellowship referendum
    let submit_tx = dynamic::tx(
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

    let tx_in_block = client
        .tx()
        .sign_and_submit_then_watch_default(&submit_tx, &alice)
        .await
        .context("Failed to submit FellowshipReferenda.submit")?
        .wait_for_finalized()
        .await
        .context("FellowshipReferenda.submit not finalized")?;

    let block_hash = tx_in_block.block_hash();
    let block = client.blocks().at(block_hash).await?;
    let block_number = block.number();

    // Verify extrinsic succeeded
    tx_in_block
        .wait_for_success()
        .await
        .context("FellowshipReferenda.submit dispatch failed")?;

    // Determine referendum ID from FellowshipReferendumCount
    let count_query = dynamic::storage("FellowshipReferenda", "ReferendumCount", ());
    let count_val = client
        .storage()
        .at_latest()
        .await?
        .fetch(&count_query)
        .await
        .context("Failed to read FellowshipReferenda.ReferendumCount")?
        .context("FellowshipReferenda.ReferendumCount not found")?;
    let referendum_id = count_val
        .as_type::<u32>()
        .context("Failed to decode FellowshipReferenda.ReferendumCount")?
        - 1;

    log::info!(
        "Fellowship referendum #{} created on track {} (id={}) at block #{}",
        referendum_id,
        track.name,
        track.id,
        block_number
    );

    Ok(SubmittedReferendum {
        referendum_id,
        block_number,
    })
}

/// Submit a fellowship referendum with an Inline proposal (no preimage).
///
/// Uses `System.remark` as a small proposal that fits within the inline size limit.
/// Submits a `FellowshipReferenda.submit` extrinsic signed by Alice with Fellows origin.
///
/// * `fellowship_origin_variant` — outer OriginCaller variant for fellowship origins
///   (e.g. `"FellowshipOrigins"` on Polkadot Collectives, `"Origins"` on Kusama relay).
pub async fn submit_fellowship_referendum_inline(
    client: &OnlineClient<PolkadotConfig>,
    fellowship_origin_variant: &str,
) -> Result<SubmittedReferendum> {
    let alice = dev::alice();

    let remark_call = dynamic::tx(
        "System",
        "remark",
        vec![Value::from_bytes(b"bynum-inline-fell")],
    );
    let remark_bytes = client
        .tx()
        .call_data(&remark_call)
        .context("Failed to encode System.remark")?;

    let submit_tx = dynamic::tx(
        "FellowshipReferenda",
        "submit",
        vec![
            Value::unnamed_variant(
                fellowship_origin_variant,
                vec![Value::unnamed_variant("Fellows", vec![])],
            ),
            Value::unnamed_variant("Inline", vec![Value::from_bytes(remark_bytes)]),
            Value::unnamed_variant("After", vec![Value::u128(0u128)]),
        ],
    );

    let tx_in_block = client
        .tx()
        .sign_and_submit_then_watch_default(&submit_tx, &alice)
        .await
        .context("Failed to submit FellowshipReferenda.submit (inline)")?
        .wait_for_finalized()
        .await
        .context("FellowshipReferenda.submit (inline) not finalized")?;

    let block_hash = tx_in_block.block_hash();
    let block = client.blocks().at(block_hash).await?;
    let block_number = block.number();

    tx_in_block
        .wait_for_success()
        .await
        .context("FellowshipReferenda.submit (inline) dispatch failed")?;

    let count_query = dynamic::storage("FellowshipReferenda", "ReferendumCount", ());
    let count_val = client
        .storage()
        .at_latest()
        .await?
        .fetch(&count_query)
        .await
        .context("Failed to read FellowshipReferenda.ReferendumCount")?
        .context("FellowshipReferenda.ReferendumCount not found")?;
    let referendum_id = count_val
        .as_type::<u32>()
        .context("Failed to decode FellowshipReferenda.ReferendumCount")?
        - 1;

    log::info!(
        "Fellowship referendum #{} created with Inline proposal at block #{}",
        referendum_id,
        block_number
    );

    Ok(SubmittedReferendum {
        referendum_id,
        block_number,
    })
}

/// A subxt `Payload` whose encoded bytes are supplied verbatim.
///
/// `subxt::dynamic::tx` requires pallet/call names and structured field values; here
/// we already have the SCALE-encoded call data (e.g. produced by opengov-cli) and just
/// want subxt to wrap it in a signed envelope. The `Payload` trait only needs
/// `encode_call_data_to`, so a trivial impl that copies the bytes is enough.
struct RawCallData(Vec<u8>);

impl subxt::tx::Payload for RawCallData {
    fn encode_call_data_to(
        &self,
        _metadata: &subxt::Metadata,
        out: &mut Vec<u8>,
    ) -> std::result::Result<(), subxt::ext::subxt_core::Error> {
        out.extend_from_slice(&self.0);
        Ok(())
    }
}

/// Submit a fellowship referendum from a pre-encoded `FellowshipReferenda.submit` call
/// hex, optionally preceded by a `Preimage.note_preimage` call hex.
///
/// Use this when the proposal is something the test caller has constructed externally
/// (e.g. a bridged XCM call generated by opengov-cli) and we just want to land it on
/// the zombienet Collectives chain so it can later be referenced by `--fellowship <id>`.
///
/// `preimage_call_hex` is `None` for Inline-proposal submits (where the call data is
/// embedded in the submit call itself, no separate `note_preimage` needed).
pub async fn submit_fellowship_referendum_from_hex(
    client: &OnlineClient<PolkadotConfig>,
    preimage_call_hex: Option<&str>,
    submit_call_hex: &str,
) -> Result<SubmittedReferendum> {
    let alice = dev::alice();

    let submit_bytes = parse_hex(submit_call_hex).context("invalid submit hex")?;

    if let Some(preimage_hex) = preimage_call_hex {
        let preimage_bytes = parse_hex(preimage_hex).context("invalid preimage hex")?;
        let preimage_payload = RawCallData(preimage_bytes);
        client
            .tx()
            .sign_and_submit_then_watch_default(&preimage_payload, &alice)
            .await
            .context("Failed to submit prebuilt preimage extrinsic")?
            .wait_for_finalized_success()
            .await
            .context("Prebuilt preimage extrinsic not finalized")?;
        log::info!("Prebuilt preimage noted on fellowship chain");
    }

    let submit_payload = RawCallData(submit_bytes);
    let tx_in_block = client
        .tx()
        .sign_and_submit_then_watch_default(&submit_payload, &alice)
        .await
        .context("Failed to submit prebuilt FellowshipReferenda.submit")?
        .wait_for_finalized()
        .await
        .context("Prebuilt FellowshipReferenda.submit not finalized")?;

    let block_hash = tx_in_block.block_hash();
    let block = client.blocks().at(block_hash).await?;
    let block_number = block.number();

    tx_in_block
        .wait_for_success()
        .await
        .context("Prebuilt FellowshipReferenda.submit dispatch failed")?;

    let count_query = dynamic::storage("FellowshipReferenda", "ReferendumCount", ());
    let count_val = client
        .storage()
        .at_latest()
        .await?
        .fetch(&count_query)
        .await
        .context("Failed to read FellowshipReferenda.ReferendumCount")?
        .context("FellowshipReferenda.ReferendumCount not found")?;
    let referendum_id = count_val
        .as_type::<u32>()
        .context("Failed to decode FellowshipReferenda.ReferendumCount")?
        - 1;

    log::info!(
        "Fellowship referendum #{} (from prebuilt hex) created at block #{}",
        referendum_id,
        block_number
    );

    Ok(SubmittedReferendum {
        referendum_id,
        block_number,
    })
}

fn parse_hex(s: &str) -> Result<Vec<u8>> {
    let trimmed = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(trimmed).context("hex decode failed")
}
