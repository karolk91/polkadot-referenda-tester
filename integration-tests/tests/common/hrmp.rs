//! HRMP channel management on the private zombienet relays.
//!
//! The zombienet networks spawn with no HRMP channels between their parachains.
//! Pre-opening channels at genesis via the `hrmp.preopenHrmpChannels` genesis key
//! does not work: the recipient parachain starts with a downward-message-queue MQC
//! head it cannot reconcile on its first block, so `set_validation_data` traps and
//! the chain never builds block #1 — the failure mode parity-bridges-common
//! documents in its zombienet-sdk bridge tests. Following that project's
//! approach, channels are instead opened *after* spawn through the live HRMP
//! pipeline via the permissionless `Hrmp::establish_system_channel` extrinsic
//! (no sudo/root needed when both endpoints are system parachains). The channels
//! materialize at the next session boundary — with fast-runtime that is at most
//! one 20-block epoch (~2 min) away.

use anyhow::{Context, Result};
use std::time::Duration;
use subxt::dynamic::{self, Value};
use subxt::{OnlineClient, PolkadotConfig};
use subxt_signer::sr25519::dev;

/// How long to wait for the channels to appear in `Hrmp::HrmpChannels` after the
/// `establish_system_channel` calls finalize. Channels open at the next session
/// boundary (fast-runtime epoch = 20 relay blocks ≈ 2 min); 5 min covers a
/// worst-case boundary plus slow block production under load.
const CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(300);
const CHANNEL_POLL_INTERVAL: Duration = Duration::from_secs(6);

/// Open bidirectional HRMP channels between the given system-parachain pairs on
/// one relay.
///
/// Submits `Hrmp::establish_system_channel(a, b)` and `(b, a)` for every pair,
/// signed by Alice (sequentially — the calls share the signer nonce), then polls
/// the relay's `Hrmp::HrmpChannels` until every direction exists. Batching all
/// pairs up front means they all open at the same session boundary.
pub async fn open_system_hrmp_channels(
    relay: &OnlineClient<PolkadotConfig>,
    pairs: &[(u32, u32)],
) -> Result<()> {
    let mut directions: Vec<(u32, u32)> = Vec::with_capacity(pairs.len() * 2);
    for &(a, b) in pairs {
        directions.push((a, b));
        directions.push((b, a));
    }

    let alice = dev::alice();
    for &(sender, recipient) in &directions {
        let tx = dynamic::tx(
            "Hrmp",
            "establish_system_channel",
            vec![Value::u128(sender as u128), Value::u128(recipient as u128)],
        );
        relay
            .tx()
            .sign_and_submit_then_watch_default(&tx, &alice)
            .await
            .with_context(|| format!("submit establish_system_channel({sender}, {recipient})"))?
            .wait_for_finalized_success()
            .await
            .with_context(|| {
                format!("establish_system_channel({sender}, {recipient}) dispatch failed")
            })?;
        log::info!("HRMP establish_system_channel({sender} -> {recipient}) accepted");
    }

    log::info!("Waiting for HRMP channels {pairs:?} to open (next session boundary)");
    let deadline = tokio::time::Instant::now() + CHANNEL_OPEN_TIMEOUT;
    loop {
        let mut open = 0;
        for &(sender, recipient) in &directions {
            if hrmp_channel_exists(relay, sender, recipient).await? {
                open += 1;
            }
        }
        if open == directions.len() {
            log::info!("All HRMP channels {pairs:?} open on the relay");
            return Ok(());
        }
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "HRMP channels {pairs:?} did not open within {CHANNEL_OPEN_TIMEOUT:?} \
             ({open}/{} directions open) — no session change, or the establish calls were no-ops?",
            directions.len()
        );
        tokio::time::sleep(CHANNEL_POLL_INTERVAL).await;
    }
}

/// True when the relay's `Hrmp::HrmpChannels[(sender, recipient)]` entry exists.
async fn hrmp_channel_exists(
    relay: &OnlineClient<PolkadotConfig>,
    sender: u32,
    recipient: u32,
) -> Result<bool> {
    let channel_id = Value::named_composite([
        ("sender", Value::u128(sender as u128)),
        ("recipient", Value::u128(recipient as u128)),
    ]);
    let query = dynamic::storage("Hrmp", "HrmpChannels", vec![channel_id]);
    let value = relay
        .storage()
        .at_latest()
        .await?
        .fetch(&query)
        .await
        .context("read Hrmp.HrmpChannels")?;
    Ok(value.is_some())
}
