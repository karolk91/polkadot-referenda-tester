//! Comprehensive integration tests.
//!
//! Each test function spawns a single zombienet network and runs all relevant
//! sub-tests against it sequentially. This avoids the ~5 min network spawn
//! overhead that would be incurred by separate test functions.
//!
//! Test suites:
//! - `polkadot_governance_all_tracks` — 16 governance tracks + scenario tests on Polkadot AH
//! - `polkadot_fellowship_tracks_part1` — fellowship tracks 1-15 on Polkadot Collectives
//! - `polkadot_fellowship_tracks_part2` — fellowship tracks 21-33 + multi-chain scenarios
//! - `kusama_governance_all_tracks` — 16 governance tracks + scenario tests on Kusama AH
//! - `kusama_fellowship_all_tracks` — 10 fellowship tracks + scenario tests on Kusama relay
//!
//! By-number tests are enabled by injecting raw storage into genesis via
//! `with_raw_spec_override()`:
//! - **AhMigrator**: `MigrationDone` unlocks `Referenda.submit` on Asset Hub
//! - **FellowshipCollective**: Alice registered as rank-9 fellow on Collectives/relay

use anyhow::Result;

use crate::common::call_data;
use crate::common::config;
use crate::common::context::{GovernanceTestContext, KusamaTestContext, MultiChainTestContext};
use crate::common::extrinsic_submitter;
use crate::common::network::{initialize_network, verify_binaries};
use crate::common::port_allocator;
use crate::common::run_and_bail;
use crate::common::tool_runner::{ToolArgs, ToolRunner};
use crate::common::tracks;

// ═══════════════════════════════════════════════════════════════════════════
// Polkadot Governance — all 16 tracks + scenario tests
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn polkadot_governance_all_tracks() {
    env_logger::try_init().ok();
    verify_binaries().expect("binary verification failed");

    let network_config =
        config::build_polkadot_with_asset_hub().expect("failed to build network config");
    let network = initialize_network(network_config)
        .await
        .expect("failed to spawn zombienet");
    let mut ctx = GovernanceTestContext::from_network(&network)
        .await
        .expect("failed to build context");

    let runner = ToolRunner::new();
    let mut errors: Vec<String> = Vec::new();

    // ── Per-track tests (create + by-number for each track) ──────────────

    for track in tracks::GOVERNANCE_TRACKS {
        run_and_bail!(
            errors,
            format!("gov_create_{}", track.name),
            run_gov_create_test(&ctx, &runner, track)
        );
        run_and_bail!(
            errors,
            format!("gov_bynum_{}", track.name),
            run_gov_bynum_test(&ctx, &runner, track)
        );
    }

    // ── Scenario tests ───────────────────────────────────────────────────

    ctx.refresh_fork_blocks()
        .await
        .expect("failed to refresh fork blocks");

    run_and_bail!(
        errors,
        "gov_happy_path",
        run_governance_happy_path(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "gov_dispatch_failure",
        run_governance_dispatch_failure(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "gov_pre_call_remark",
        run_governance_with_pre_call(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "gov_remark_proposal",
        run_governance_remark_proposal(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "gov_invalid_hex",
        run_governance_invalid_hex(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "gov_pre_call_non_root_origin",
        run_governance_pre_call_non_root_origin(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "gov_pre_call_invalid_origin",
        run_governance_pre_call_invalid_origin(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "gov_create_no_preimage",
        run_governance_create_no_preimage(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "gov_inline_create",
        run_governance_inline_create(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "gov_inline_bynum",
        run_governance_inline_bynum(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "gov_bynum_lookup_execution",
        run_governance_bynum_lookup_execution(&ctx, &runner)
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Polkadot Fellowship — split into two halves for CI parallelism
// Each spawns its own network; scenarios run in part2 only.
// ═══════════════════════════════════════════════════════════════════════════

/// Tracks 1-15 (Members through RetainAt5Dan): 15 tracks × 2 = 30 sub-tests.
#[tokio::test(flavor = "multi_thread")]
async fn polkadot_fellowship_tracks_part1() {
    env_logger::try_init().ok();
    verify_binaries().expect("binary verification failed");

    let network_config =
        config::build_polkadot_with_system_parachains().expect("failed to build network config");
    let network = initialize_network(network_config)
        .await
        .expect("failed to spawn zombienet");
    let ctx = MultiChainTestContext::from_network(&network)
        .await
        .expect("failed to build context");

    let runner = ToolRunner::new();
    let mut errors: Vec<String> = Vec::new();

    for track in &tracks::POLKADOT_FELLOWSHIP_TRACKS[..15] {
        run_and_bail!(
            errors,
            format!("fell_create_{}", track.name),
            run_polkadot_fellowship_create_test(&ctx, &runner, track)
        );
        run_and_bail!(
            errors,
            format!("fell_bynum_{}", track.name),
            run_polkadot_fellowship_bynum_test(&ctx, &runner, track)
        );
    }
}

/// Tracks 21-33 (PromoteTo1Dan through FastPromoteTo3Dan): 9 tracks × 2 = 18 sub-tests
/// + 6 multi-chain scenario tests = 24 sub-tests total.
#[tokio::test(flavor = "multi_thread")]
async fn polkadot_fellowship_tracks_part2() {
    env_logger::try_init().ok();
    verify_binaries().expect("binary verification failed");

    let network_config =
        config::build_polkadot_with_system_parachains().expect("failed to build network config");
    let network = initialize_network(network_config)
        .await
        .expect("failed to spawn zombienet");
    let mut ctx = MultiChainTestContext::from_network(&network)
        .await
        .expect("failed to build context");

    let runner = ToolRunner::new();
    let mut errors: Vec<String> = Vec::new();

    for track in &tracks::POLKADOT_FELLOWSHIP_TRACKS[15..] {
        run_and_bail!(
            errors,
            format!("fell_create_{}", track.name),
            run_polkadot_fellowship_create_test(&ctx, &runner, track)
        );
        run_and_bail!(
            errors,
            format!("fell_bynum_{}", track.name),
            run_polkadot_fellowship_bynum_test(&ctx, &runner, track)
        );
    }

    // ── Multi-chain scenario tests ───────────────────────────────────────

    ctx.refresh_fork_blocks()
        .await
        .expect("failed to refresh fork blocks");

    run_and_bail!(
        errors,
        "multichain_happy_path",
        run_multichain_happy_path(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "fellowship_only",
        run_fellowship_only(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "nonexistent_referendum",
        run_nonexistent_referendum(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "fellowship_create_no_preimage",
        run_fellowship_create_no_preimage(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "gov_with_additional_chains",
        run_governance_with_additional_chains(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "fell_with_additional_chains",
        run_fellowship_with_additional_chains(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "fell_inline_create",
        run_fellowship_inline_create(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "fell_inline_bynum",
        run_fellowship_inline_bynum(&ctx, &runner)
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Kusama Governance — all 16 tracks + scenario tests
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn kusama_governance_all_tracks() {
    env_logger::try_init().ok();
    verify_binaries().expect("binary verification failed");

    let network_config =
        config::build_kusama_with_asset_hub().expect("failed to build network config");
    let network = initialize_network(network_config)
        .await
        .expect("failed to spawn zombienet");
    let mut ctx = KusamaTestContext::from_network(&network)
        .await
        .expect("failed to build context");

    let runner = ToolRunner::new();
    let mut errors: Vec<String> = Vec::new();

    // ── Per-track tests (create + by-number for each track) ──────────────

    for track in tracks::GOVERNANCE_TRACKS {
        run_and_bail!(
            errors,
            format!("ksm_gov_create_{}", track.name),
            run_kusama_gov_create_test(&ctx, &runner, track)
        );
        run_and_bail!(
            errors,
            format!("ksm_gov_bynum_{}", track.name),
            run_kusama_gov_bynum_test(&ctx, &runner, track)
        );
    }

    // ── Scenario test ────────────────────────────────────────────────────

    ctx.refresh_fork_blocks()
        .await
        .expect("failed to refresh fork blocks");

    run_and_bail!(
        errors,
        "ksm_gov_happy_path",
        run_kusama_governance_happy_path(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "ksm_gov_inline_create",
        run_kusama_governance_inline_create(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "ksm_gov_inline_bynum",
        run_kusama_governance_inline_bynum(&ctx, &runner)
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Kusama Fellowship — all 10 tracks + scenario tests
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn kusama_fellowship_all_tracks() {
    env_logger::try_init().ok();
    verify_binaries().expect("binary verification failed");

    let network_config =
        config::build_kusama_with_asset_hub().expect("failed to build network config");
    let network = initialize_network(network_config)
        .await
        .expect("failed to spawn zombienet");
    let mut ctx = KusamaTestContext::from_network(&network)
        .await
        .expect("failed to build context");

    let runner = ToolRunner::new();
    let mut errors: Vec<String> = Vec::new();

    // ── Per-track tests (create + by-number for each track) ──────────────

    for track in tracks::KUSAMA_FELLOWSHIP_TRACKS {
        run_and_bail!(
            errors,
            format!("ksm_fell_create_{}", track.name),
            run_kusama_fellowship_create_test(&ctx, &runner, track)
        );
        run_and_bail!(
            errors,
            format!("ksm_fell_bynum_{}", track.name),
            run_kusama_fellowship_bynum_test(&ctx, &runner, track)
        );
    }

    // ── Scenario tests ───────────────────────────────────────────────────

    ctx.refresh_fork_blocks()
        .await
        .expect("failed to refresh fork blocks");

    run_and_bail!(
        errors,
        "ksm_multichain_happy_path",
        run_kusama_multichain_happy_path(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "ksm_fellowship_on_relay",
        run_kusama_fellowship_on_relay(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "ksm_fell_inline_create",
        run_kusama_fellowship_inline_create(&ctx, &runner)
    );
    run_and_bail!(
        errors,
        "ksm_fell_inline_bynum",
        run_kusama_fellowship_inline_bynum(&ctx, &runner)
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Polkadot Governance (per-track create)
// ═══════════════════════════════════════════════════════════════════════════

async fn run_gov_create_test(
    ctx: &GovernanceTestContext,
    runner: &ToolRunner,
    track: &tracks::GovernanceTrack,
) -> Result<()> {
    log::info!(">>> gov_create_{} (track_id={})", track.name, track.id);

    let (preimage_hex, submit_hex) =
        call_data::generate_governance_track_call_data(&ctx.ah_client, track, "Origins").await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            call_to_create_governance_referendum: Some(submit_hex),
            call_to_note_preimage_for_governance_referendum: Some(preimage_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Polkadot Governance (per-track by-number)
// ═══════════════════════════════════════════════════════════════════════════

async fn run_gov_bynum_test(
    ctx: &GovernanceTestContext,
    runner: &ToolRunner,
    track: &tracks::GovernanceTrack,
) -> Result<()> {
    log::info!(">>> gov_bynum_{} (track_id={})", track.name, track.id);

    let submitted =
        extrinsic_submitter::submit_governance_referendum(&ctx.ah_client, track, "Origins").await?;

    let fork_url = format!("{},{}", ctx.asset_hub_ws_uri, submitted.block_number);

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(fork_url),
            referendum: Some(submitted.referendum_id.to_string()),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Polkadot Governance (scenarios)
// ═══════════════════════════════════════════════════════════════════════════

/// Happy path: create and simulate a System.authorize_upgrade referendum.
async fn run_governance_happy_path(ctx: &GovernanceTestContext, runner: &ToolRunner) -> Result<()> {
    log::info!("[gov_happy_path] Starting...");
    let (preimage_hex, gov_submit_hex) =
        call_data::generate_governance_call_data(&ctx.ah_client).await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            call_to_create_governance_referendum: Some(gov_submit_hex),
            call_to_note_preimage_for_governance_referendum: Some(preimage_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}

/// Negative: wrong preimage hash causes dispatch failure.
async fn run_governance_dispatch_failure(
    ctx: &GovernanceTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[gov_dispatch_failure] Starting...");
    let (preimage_hex, gov_submit_hex) =
        call_data::generate_governance_call_data_with_wrong_preimage(&ctx.ah_client).await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            call_to_create_governance_referendum: Some(gov_submit_hex),
            call_to_note_preimage_for_governance_referendum: Some(preimage_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_failure()?;
    output.check_stdout_contains("execution failed")?;
    Ok(())
}

/// Pre-call: execute a System.remark via --pre-call before the main referendum.
async fn run_governance_with_pre_call(
    ctx: &GovernanceTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[gov_pre_call_remark] Starting...");
    let (preimage_hex, gov_submit_hex) =
        call_data::generate_governance_call_data(&ctx.ah_client).await?;
    let pre_call_hex = call_data::generate_pre_call_remark_hex(&ctx.ah_client).await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            call_to_create_governance_referendum: Some(gov_submit_hex),
            call_to_note_preimage_for_governance_referendum: Some(preimage_hex),
            pre_call: Some(pre_call_hex),
            pre_origin: Some("Root".to_string()),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("Executing Pre-Call")?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}

/// Remark proposal: use System.remark instead of System.authorize_upgrade.
async fn run_governance_remark_proposal(
    ctx: &GovernanceTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[gov_remark_proposal] Starting...");
    let (preimage_hex, gov_submit_hex) =
        call_data::generate_remark_referendum_call_data(&ctx.ah_client).await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            call_to_create_governance_referendum: Some(gov_submit_hex),
            call_to_note_preimage_for_governance_referendum: Some(preimage_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}

/// Invalid hex: pass garbage call data, expect early failure.
async fn run_governance_invalid_hex(
    ctx: &GovernanceTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[gov_invalid_hex] Starting...");
    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            call_to_create_governance_referendum: Some("0xDEADBEEFCAFE".to_string()),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_failure()?;
    Ok(())
}

/// Pre-call with non-Root origin: execute a System.remark via --pre-call with Treasurer origin.
async fn run_governance_pre_call_non_root_origin(
    ctx: &GovernanceTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[gov_pre_call_non_root_origin] Starting...");
    let (preimage_hex, gov_submit_hex) =
        call_data::generate_governance_call_data(&ctx.ah_client).await?;
    let pre_call_hex = call_data::generate_pre_call_remark_hex(&ctx.ah_client).await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            call_to_create_governance_referendum: Some(gov_submit_hex),
            call_to_note_preimage_for_governance_referendum: Some(preimage_hex),
            pre_call: Some(pre_call_hex),
            pre_origin: Some("Treasurer".to_string()),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("Executing Pre-Call")?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}

/// Pre-call with invalid origin: should fail.
async fn run_governance_pre_call_invalid_origin(
    ctx: &GovernanceTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[gov_pre_call_invalid_origin] Starting...");
    let (preimage_hex, gov_submit_hex) =
        call_data::generate_governance_call_data(&ctx.ah_client).await?;
    let pre_call_hex = call_data::generate_pre_call_remark_hex(&ctx.ah_client).await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            call_to_create_governance_referendum: Some(gov_submit_hex),
            call_to_note_preimage_for_governance_referendum: Some(preimage_hex),
            pre_call: Some(pre_call_hex),
            pre_origin: Some("NonExistentOrigin".to_string()),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_failure()?;
    output.check_any_output_contains("unknown origin")?;
    Ok(())
}

/// Create governance referendum without noting preimage — execution should fail.
async fn run_governance_create_no_preimage(
    ctx: &GovernanceTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[gov_create_no_preimage] Starting...");
    let (_preimage_hex, gov_submit_hex) =
        call_data::generate_governance_call_data(&ctx.ah_client).await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            call_to_create_governance_referendum: Some(gov_submit_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_failure()?;
    output.check_stdout_contains("execution failed")?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Polkadot Governance (inline proposals)
// ═══════════════════════════════════════════════════════════════════════════

/// Inline proposal create: submit a governance referendum with Inline (no preimage).
async fn run_governance_inline_create(
    ctx: &GovernanceTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[gov_inline_create] Starting...");
    let gov_submit_hex =
        call_data::generate_governance_inline_call_data(&ctx.ah_client).await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            call_to_create_governance_referendum: Some(gov_submit_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}

/// Inline proposal by-number: submit inline referendum on zombienet, then test with --referendum.
async fn run_governance_inline_bynum(
    ctx: &GovernanceTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[gov_inline_bynum] Starting...");
    let submitted =
        extrinsic_submitter::submit_governance_referendum_inline(&ctx.ah_client).await?;

    let fork_url = format!("{},{}", ctx.asset_hub_ws_uri, submitted.block_number);

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(fork_url),
            referendum: Some(submitted.referendum_id.to_string()),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}

/// By-number test with a Lookup proposal on the Root track.
///
/// This test specifically validates that the scheduler can execute Lookup proposals
/// when the scheduler entry is moved via storage manipulation. On parachains, the
/// execute call is scheduled at relay_block + min_enactment_period, which may be
/// far in the future. Moving this Lookup entry via `dev.setStorage` can cause
/// `Scheduler.CallUnavailable` if the preimage lookup breaks during the move.
///
/// The test submits a referendum with a Lookup proposal (preimage-based) on the Root
/// track, then runs the tool by referendum ID and verifies:
/// 1. The tool succeeds (exit code 0)
/// 2. Output contains "executed successfully"
/// 3. Output does NOT contain "CallUnavailable"
async fn run_governance_bynum_lookup_execution(
    ctx: &GovernanceTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[gov_bynum_lookup_execution] Starting...");

    // Use Root track — it has the largest min_enactment_period, making the scheduler
    // move most significant and most likely to trigger preimage lookup issues.
    let root_track = tracks::GOVERNANCE_TRACKS
        .iter()
        .find(|t| t.is_root)
        .expect("Root track must exist in GOVERNANCE_TRACKS");

    let submitted =
        extrinsic_submitter::submit_governance_referendum(&ctx.ah_client, root_track, "Origins")
            .await?;

    let fork_url = format!("{},{}", ctx.asset_hub_ws_uri, submitted.block_number);

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(fork_url),
            referendum: Some(submitted.referendum_id.to_string()),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    output.check_any_output_not_contains("CallUnavailable")?;
    log::info!("[gov_bynum_lookup_execution] PASSED");
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Polkadot Fellowship (per-track create)
// ═══════════════════════════════════════════════════════════════════════════

async fn run_polkadot_fellowship_create_test(
    ctx: &MultiChainTestContext,
    runner: &ToolRunner,
    track: &tracks::FellowshipTrack,
) -> Result<()> {
    log::info!(">>> fell_create_{} (track_id={})", track.name, track.id);

    let (preimage_hex, submit_hex) = call_data::generate_fellowship_track_call_data(
        &ctx.coll_client,
        track,
        "FellowshipOrigins",
    )
    .await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            fellowship_chain_url: Some(ctx.fellowship_url_with_block()),
            call_to_create_fellowship_referendum: Some(submit_hex),
            call_to_note_preimage_for_fellowship_referendum: Some(preimage_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Polkadot Fellowship (per-track by-number)
// ═══════════════════════════════════════════════════════════════════════════

async fn run_polkadot_fellowship_bynum_test(
    ctx: &MultiChainTestContext,
    runner: &ToolRunner,
    track: &tracks::FellowshipTrack,
) -> Result<()> {
    log::info!(">>> fell_bynum_{} (track_id={})", track.name, track.id);

    let submitted = extrinsic_submitter::submit_fellowship_referendum(
        &ctx.coll_client,
        track,
        "FellowshipOrigins",
    )
    .await?;

    let fellowship_fork_url = format!("{},{}", ctx.collectives_ws_uri, submitted.block_number);

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            fellowship_chain_url: Some(fellowship_fork_url),
            fellowship: Some(submitted.referendum_id.to_string()),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Polkadot Multi-chain scenarios
// ═══════════════════════════════════════════════════════════════════════════

/// Multi-chain happy path: governance + fellowship referenda across AH and Collectives.
/// Also verifies relay chain events are displayed via --additional-chains.
async fn run_multichain_happy_path(ctx: &MultiChainTestContext, runner: &ToolRunner) -> Result<()> {
    log::info!("[multichain_happy_path] Starting...");
    let (gov_preimage_hex, gov_submit_hex, fellowship_preimage_hex, fellowship_submit_hex) =
        call_data::generate_relay_upgrade_call_data(
            &ctx.ah_client,
            &ctx.coll_client,
            "FellowshipOrigins",
        )
        .await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            fellowship_chain_url: Some(ctx.fellowship_url_with_block()),
            additional_chains: Some(ctx.relay_url_with_block()),
            call_to_create_governance_referendum: Some(gov_submit_hex),
            call_to_note_preimage_for_governance_referendum: Some(gov_preimage_hex),
            call_to_create_fellowship_referendum: Some(fellowship_submit_hex),
            call_to_note_preimage_for_fellowship_referendum: Some(fellowship_preimage_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    // Verify relay chain was monitored as an additional chain
    output.check_stdout_contains("Additional Chain Events")?;
    output.check_stdout_contains("Block #")?;
    Ok(())
}

/// Fellowship-only: create and simulate a fellowship referendum without governance.
async fn run_fellowship_only(ctx: &MultiChainTestContext, runner: &ToolRunner) -> Result<()> {
    log::info!("[fellowship_only] Starting...");
    let (preimage_hex, submit_hex) =
        call_data::generate_fellowship_only_call_data(&ctx.coll_client, "FellowshipOrigins")
            .await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            fellowship_chain_url: Some(ctx.fellowship_url_with_block()),
            call_to_create_fellowship_referendum: Some(submit_hex),
            call_to_note_preimage_for_fellowship_referendum: Some(preimage_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}

/// Governance-only + additional chains: governance referendum on AH with relay as additional chain.
async fn run_governance_with_additional_chains(
    ctx: &MultiChainTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[gov_with_additional_chains] Starting...");
    let (preimage_hex, gov_submit_hex) =
        call_data::generate_governance_call_data(&ctx.ah_client).await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            additional_chains: Some(ctx.relay_url_with_block()),
            call_to_create_governance_referendum: Some(gov_submit_hex),
            call_to_note_preimage_for_governance_referendum: Some(preimage_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    output.check_stdout_contains("Additional Chain Events")?;
    output.check_stdout_contains("Block #")?;
    Ok(())
}

/// Fellowship-only + additional chains: fellowship referendum on Collectives with relay as additional chain.
async fn run_fellowship_with_additional_chains(
    ctx: &MultiChainTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[fell_with_additional_chains] Starting...");
    let (preimage_hex, submit_hex) =
        call_data::generate_fellowship_only_call_data(&ctx.coll_client, "FellowshipOrigins")
            .await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            fellowship_chain_url: Some(ctx.fellowship_url_with_block()),
            additional_chains: Some(ctx.relay_url_with_block()),
            call_to_create_fellowship_referendum: Some(submit_hex),
            call_to_note_preimage_for_fellowship_referendum: Some(preimage_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    output.check_stdout_contains("Additional Chain Events")?;
    output.check_stdout_contains("Block #")?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Polkadot Fellowship (inline proposals)
// ═══════════════════════════════════════════════════════════════════════════

/// Inline fellowship create: submit a fellowship referendum with Inline (no preimage).
async fn run_fellowship_inline_create(
    ctx: &MultiChainTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[fell_inline_create] Starting...");
    let submit_hex =
        call_data::generate_fellowship_inline_call_data(&ctx.coll_client, "FellowshipOrigins")
            .await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            fellowship_chain_url: Some(ctx.fellowship_url_with_block()),
            call_to_create_fellowship_referendum: Some(submit_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}

/// Inline fellowship by-number: submit inline referendum on zombienet, then test with --fellowship.
async fn run_fellowship_inline_bynum(
    ctx: &MultiChainTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[fell_inline_bynum] Starting...");
    let submitted = extrinsic_submitter::submit_fellowship_referendum_inline(
        &ctx.coll_client,
        "FellowshipOrigins",
    )
    .await?;

    let fellowship_fork_url = format!("{},{}", ctx.collectives_ws_uri, submitted.block_number);

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            fellowship_chain_url: Some(fellowship_fork_url),
            fellowship: Some(submitted.referendum_id.to_string()),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}

/// Non-existent referendum: pass --referendum 999 which doesn't exist.
async fn run_nonexistent_referendum(
    ctx: &MultiChainTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[nonexistent_referendum] Starting...");
    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            referendum: Some("999".to_string()),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_failure()?;
    Ok(())
}

/// Create fellowship referendum without noting preimage — execution should fail.
async fn run_fellowship_create_no_preimage(
    ctx: &MultiChainTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[fellowship_create_no_preimage] Starting...");
    let (_preimage_hex, submit_hex) =
        call_data::generate_fellowship_only_call_data(&ctx.coll_client, "FellowshipOrigins")
            .await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            fellowship_chain_url: Some(ctx.fellowship_url_with_block()),
            call_to_create_fellowship_referendum: Some(submit_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_failure()?;
    output.check_stdout_contains("execution failed")?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Kusama Governance (per-track create)
// ═══════════════════════════════════════════════════════════════════════════

async fn run_kusama_gov_create_test(
    ctx: &KusamaTestContext,
    runner: &ToolRunner,
    track: &tracks::GovernanceTrack,
) -> Result<()> {
    log::info!(">>> ksm_gov_create_{} (track_id={})", track.name, track.id);

    let (preimage_hex, submit_hex) =
        call_data::generate_governance_track_call_data(&ctx.ah_client, track, "Origins").await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            call_to_create_governance_referendum: Some(submit_hex),
            call_to_note_preimage_for_governance_referendum: Some(preimage_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Kusama Governance (per-track by-number)
// ═══════════════════════════════════════════════════════════════════════════

async fn run_kusama_gov_bynum_test(
    ctx: &KusamaTestContext,
    runner: &ToolRunner,
    track: &tracks::GovernanceTrack,
) -> Result<()> {
    log::info!(">>> ksm_gov_bynum_{} (track_id={})", track.name, track.id);

    let submitted =
        extrinsic_submitter::submit_governance_referendum(&ctx.ah_client, track, "Origins").await?;

    let fork_url = format!("{},{}", ctx.asset_hub_ws_uri, submitted.block_number);

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(fork_url),
            referendum: Some(submitted.referendum_id.to_string()),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Kusama Governance (scenarios)
// ═══════════════════════════════════════════════════════════════════════════

/// Kusama governance happy path: System.authorize_upgrade referendum on Kusama AH.
async fn run_kusama_governance_happy_path(
    ctx: &KusamaTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[ksm_gov_happy_path] Starting...");
    let (preimage_hex, gov_submit_hex) =
        call_data::generate_governance_call_data(&ctx.ah_client).await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            call_to_create_governance_referendum: Some(gov_submit_hex),
            call_to_note_preimage_for_governance_referendum: Some(preimage_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Kusama Governance (inline proposals)
// ═══════════════════════════════════════════════════════════════════════════

/// Kusama governance inline create: submit with Inline proposal (no preimage).
async fn run_kusama_governance_inline_create(
    ctx: &KusamaTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[ksm_gov_inline_create] Starting...");
    let gov_submit_hex =
        call_data::generate_governance_inline_call_data(&ctx.ah_client).await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            call_to_create_governance_referendum: Some(gov_submit_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}

/// Kusama governance inline by-number: submit inline referendum, then test with --referendum.
async fn run_kusama_governance_inline_bynum(
    ctx: &KusamaTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[ksm_gov_inline_bynum] Starting...");
    let submitted =
        extrinsic_submitter::submit_governance_referendum_inline(&ctx.ah_client).await?;

    let fork_url = format!("{},{}", ctx.asset_hub_ws_uri, submitted.block_number);

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(fork_url),
            referendum: Some(submitted.referendum_id.to_string()),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Kusama Fellowship (per-track create)
// ═══════════════════════════════════════════════════════════════════════════

async fn run_kusama_fellowship_create_test(
    ctx: &KusamaTestContext,
    runner: &ToolRunner,
    track: &tracks::FellowshipTrack,
) -> Result<()> {
    log::info!(">>> ksm_fell_create_{} (track_id={})", track.name, track.id);

    // On Kusama, fellowship is on the relay chain; origin variant is "Origins"
    let (preimage_hex, submit_hex) =
        call_data::generate_fellowship_track_call_data(&ctx.relay_client, track, "Origins").await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            fellowship_chain_url: Some(ctx.fellowship_url_with_block()),
            call_to_create_fellowship_referendum: Some(submit_hex),
            call_to_note_preimage_for_fellowship_referendum: Some(preimage_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Kusama Fellowship (per-track by-number)
// ═══════════════════════════════════════════════════════════════════════════

async fn run_kusama_fellowship_bynum_test(
    ctx: &KusamaTestContext,
    runner: &ToolRunner,
    track: &tracks::FellowshipTrack,
) -> Result<()> {
    log::info!(">>> ksm_fell_bynum_{} (track_id={})", track.name, track.id);

    // On Kusama, fellowship is on the relay chain; origin variant is "Origins"
    let submitted =
        extrinsic_submitter::submit_fellowship_referendum(&ctx.relay_client, track, "Origins")
            .await?;

    let fellowship_fork_url = format!("{},{}", ctx.relay_ws_uri, submitted.block_number);

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            fellowship_chain_url: Some(fellowship_fork_url),
            fellowship: Some(submitted.referendum_id.to_string()),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Kusama Fellowship (scenarios)
// ═══════════════════════════════════════════════════════════════════════════

/// Kusama multichain happy path: governance on AH + fellowship on relay.
async fn run_kusama_multichain_happy_path(
    ctx: &KusamaTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[ksm_multichain_happy_path] Starting...");
    let (gov_preimage_hex, gov_submit_hex, fellowship_preimage_hex, fellowship_submit_hex) =
        call_data::generate_relay_upgrade_call_data(&ctx.ah_client, &ctx.relay_client, "Origins")
            .await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            fellowship_chain_url: Some(ctx.fellowship_url_with_block()),
            call_to_create_governance_referendum: Some(gov_submit_hex),
            call_to_note_preimage_for_governance_referendum: Some(gov_preimage_hex),
            call_to_create_fellowship_referendum: Some(fellowship_submit_hex),
            call_to_note_preimage_for_fellowship_referendum: Some(fellowship_preimage_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-test implementations — Kusama Fellowship (inline proposals)
// ═══════════════════════════════════════════════════════════════════════════

/// Kusama fellowship inline create: submit with Inline proposal (no preimage).
async fn run_kusama_fellowship_inline_create(
    ctx: &KusamaTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[ksm_fell_inline_create] Starting...");
    let submit_hex =
        call_data::generate_fellowship_inline_call_data(&ctx.relay_client, "Origins").await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            fellowship_chain_url: Some(ctx.fellowship_url_with_block()),
            call_to_create_fellowship_referendum: Some(submit_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}

/// Kusama fellowship inline by-number: submit inline referendum, then test with --fellowship.
async fn run_kusama_fellowship_inline_bynum(
    ctx: &KusamaTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[ksm_fell_inline_bynum] Starting...");
    let submitted =
        extrinsic_submitter::submit_fellowship_referendum_inline(&ctx.relay_client, "Origins")
            .await?;

    let fellowship_fork_url = format!("{},{}", ctx.relay_ws_uri, submitted.block_number);

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some(ctx.governance_url_with_block()),
            fellowship_chain_url: Some(fellowship_fork_url),
            fellowship: Some(submitted.referendum_id.to_string()),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}

/// Kusama fellowship-only: create and simulate a fellowship referendum on the relay.
async fn run_kusama_fellowship_on_relay(
    ctx: &KusamaTestContext,
    runner: &ToolRunner,
) -> Result<()> {
    log::info!("[ksm_fellowship_on_relay] Starting...");
    let (preimage_hex, submit_hex) =
        call_data::generate_fellowship_only_call_data(&ctx.relay_client, "Origins").await?;

    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum(ToolArgs {
            fellowship_chain_url: Some(ctx.fellowship_url_with_block()),
            call_to_create_fellowship_referendum: Some(submit_hex),
            call_to_note_preimage_for_fellowship_referendum: Some(preimage_hex),
            port: Some(port),
            verbose: true,
            ..Default::default()
        })
        .await?;

    output.check_success()?;
    output.check_stdout_contains("executed successfully")?;
    Ok(())
}
