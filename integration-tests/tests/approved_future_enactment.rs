//! Integration test: tool simulates an Approved governance referendum whose
//! scheduled enactment is still in the future.
//!
//! Bakes into Asset Hub genesis (via `with_raw_spec_override`):
//! - `Referenda::ReferendumInfoFor[42] = Approved(0, None, None)`
//! - `Referenda::ReferendumCount = 43`
//! - `Preimage::PreimageFor[(hash, len)]` for a `System.remark` call
//! - `Scheduler::Agenda[1_000_000]` containing the named enactment task
//! - `Scheduler::Lookup[task_name] = (1_000_000, 0)`
//!
//! With this state, the tool's `--referendum 42` flow:
//! 1. Reads `ReferendumInfoFor[42]` → sees `Approved`
//! 2. Computes `task_name = blake2_256(("assembly", "enactment", 42u32))`
//! 3. Looks up `Scheduler::Lookup[task_name]` → finds `(1_000_000, 0)`
//! 4. Reads the agenda entry, extracts the proposal hash
//! 5. Skips applyPassingState + nudge, moves the enactment to next block, executes it
//!
//! This exercises the regression fix for the bug where the tool incorrectly
//! treated `Approved` as a terminal state and skipped simulation.

mod common;

use anyhow::Result;

use common::config;
use common::network::{initialize_network, verify_binaries};
use common::port_allocator;
use common::raw_storage;
use common::tool_runner::{ToolArgs, ToolRunner};

/// SCALE-encoded `System.remark(b"approved-future-test")` for Asset Hub Polkadot.
///
/// Layout: `<pallet=0> <call=0> <compact_len=20> <utf8 bytes>`.
/// System pallet is at index 0 and `remark` is `call_index(0)` in the AH Polkadot runtime —
/// these have been stable across the supported `polkadot-stable` releases.
fn system_remark_call_bytes() -> Vec<u8> {
    let payload = b"approved-future-test";
    let mut bytes = Vec::with_capacity(2 + 1 + payload.len());
    bytes.push(0x00); // pallet index: System
    bytes.push(0x00); // call index: remark
    // Compact-encoded length for a 20-byte payload (single-byte mode: len << 2):
    bytes.push((payload.len() as u8) << 2);
    bytes.extend_from_slice(payload);
    bytes
}

#[tokio::test(flavor = "multi_thread")]
async fn polkadot_governance_approved_future_enactment() -> Result<()> {
    env_logger::try_init().ok();
    verify_binaries().expect("binary verification failed");

    const REFERENDUM_ID: u32 = 42;
    const APPROVAL_BLOCK: u32 = 0;
    const ENACTMENT_BLOCK: u32 = 1_000_000;

    let call_bytes = system_remark_call_bytes();

    let ah_override = raw_storage::ah_approved_governance_referendum_override(
        &call_bytes,
        REFERENDUM_ID,
        APPROVAL_BLOCK,
        ENACTMENT_BLOCK,
    );

    let network_config = config::build_polkadot_with_asset_hub_raw_override(ah_override)
        .expect("failed to build network config");
    let network = initialize_network(network_config)
        .await
        .expect("failed to spawn zombienet");

    let ah_collator = network.get_node("asset-hub-collator")?;
    ah_collator
        .wait_metric(config::BEST_BLOCK_METRIC, |b| b > 5.0)
        .await
        .map_err(|e| anyhow::anyhow!("Asset Hub not producing blocks: {e}"))?;

    // Wait for the chopsticks-fork-safe gap so the AH collator's archive doesn't
    // get pruned out from under us.
    let ah_ws_uri = ah_collator.ws_uri().to_string();
    log::info!("Asset Hub WS endpoint: {ah_ws_uri}");

    let runner = ToolRunner::new();
    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ah_ws_uri),
            referendum: Some(REFERENDUM_ID.to_string()),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    // The tool must take the new code path, not the legacy "already executed" early-return.
    output.check_stdout_contains("approved with scheduled enactment at block")?;
    output.check_stdout_contains("Pre-Approved, Move Enactment Forward")?;
    output.check_stdout_contains("executed successfully")?;

    Ok(())
}
