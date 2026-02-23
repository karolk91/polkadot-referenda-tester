//! Scenario tests for CLI parameter validation and edge cases.
//!
//! The `validation_test_suite` requires NO network spawn — it exercises
//! CLI argument validation that fails before any connection is attempted.
//! All sub-tests run concurrently since they have no shared state.

use anyhow::Result;

use crate::common::tool_runner::{report_results, SubTestResult, ToolArgs, ToolRunner};

// ── Validation Test Suite ───────────────────────────────────────────────────

/// Suite: CLI argument validation tests — no network required.
///
/// Each sub-test invokes `yarn cli test` with intentionally invalid or
/// incomplete arguments and asserts that the tool fails with the expected
/// error message. All sub-tests run concurrently.
#[tokio::test(flavor = "multi_thread")]
async fn validation_test_suite() -> Result<()> {
    let _ = env_logger::try_init();

    log::info!("=== Validation Test Suite ===");

    // Run all validation tests concurrently — they are completely independent
    // (no shared ports, no network, no state).
    let (r1, r2, r3, r4, r5, r6, r7) = tokio::join!(
        run_no_args(),
        run_mutually_exclusive_gov(),
        run_mutually_exclusive_fellowship(),
        run_missing_governance_url(),
        run_missing_fellowship_url(),
        run_invalid_referendum_id(),
        run_invalid_fellowship_id(),
    );

    let results: Vec<SubTestResult> = vec![
        ("no_args", r1),
        ("mutually_exclusive_gov", r2),
        ("mutually_exclusive_fellowship", r3),
        ("missing_governance_url", r4),
        ("missing_fellowship_url", r5),
        ("invalid_referendum_id", r6),
        ("invalid_fellowship_id", r7),
    ];

    log::info!("=== Validation Suite Results ===");
    report_results(&results);
    Ok(())
}

/// No arguments at all — should fail with "at least one referendum must be specified".
async fn run_no_args() -> Result<()> {
    log::info!("[no_args] Starting...");
    let runner = ToolRunner::new();
    let output = runner
        .run_test_referendum(ToolArgs {
            verbose: true,
            ..Default::default()
        })
        .await?;

    log::info!("[no_args] exit code: {}", output.exit_code);
    output.check_failure()?;
    output.check_any_output_contains("at least one referendum must be specified")?;
    log::info!("[no_args] PASSED");
    Ok(())
}

/// Both --referendum and --call-to-create-governance-referendum — mutually exclusive.
async fn run_mutually_exclusive_gov() -> Result<()> {
    log::info!("[mutually_exclusive_gov] Starting...");
    let runner = ToolRunner::new();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some("ws://127.0.0.1:1,1".to_string()),
            referendum: Some("0".to_string()),
            call_to_create_governance_referendum: Some("0x00".to_string()),
            verbose: true,
            ..Default::default()
        })
        .await?;

    log::info!("[mutually_exclusive_gov] exit code: {}", output.exit_code);
    output.check_failure()?;
    output.check_any_output_contains("cannot specify both")?;
    log::info!("[mutually_exclusive_gov] PASSED");
    Ok(())
}

/// Both --fellowship and --call-to-create-fellowship-referendum — mutually exclusive.
async fn run_mutually_exclusive_fellowship() -> Result<()> {
    log::info!("[mutually_exclusive_fellowship] Starting...");
    let runner = ToolRunner::new();
    let output = runner
        .run_test_referendum(ToolArgs {
            fellowship_chain_url: Some("ws://127.0.0.1:1,1".to_string()),
            fellowship: Some("0".to_string()),
            call_to_create_fellowship_referendum: Some("0x00".to_string()),
            verbose: true,
            ..Default::default()
        })
        .await?;

    log::info!(
        "[mutually_exclusive_fellowship] exit code: {}",
        output.exit_code
    );
    output.check_failure()?;
    output.check_any_output_contains("cannot specify both")?;
    log::info!("[mutually_exclusive_fellowship] PASSED");
    Ok(())
}

/// --referendum without --governance-chain-url.
async fn run_missing_governance_url() -> Result<()> {
    log::info!("[missing_governance_url] Starting...");
    let runner = ToolRunner::new();
    let output = runner
        .run_test_referendum(ToolArgs {
            referendum: Some("0".to_string()),
            verbose: true,
            ..Default::default()
        })
        .await?;

    log::info!("[missing_governance_url] exit code: {}", output.exit_code);
    output.check_failure()?;
    output.check_any_output_contains("governance-chain-url is required")?;
    log::info!("[missing_governance_url] PASSED");
    Ok(())
}

/// --fellowship without --fellowship-chain-url.
async fn run_missing_fellowship_url() -> Result<()> {
    log::info!("[missing_fellowship_url] Starting...");
    let runner = ToolRunner::new();
    let output = runner
        .run_test_referendum(ToolArgs {
            fellowship: Some("0".to_string()),
            verbose: true,
            ..Default::default()
        })
        .await?;

    log::info!("[missing_fellowship_url] exit code: {}", output.exit_code);
    output.check_failure()?;
    output.check_any_output_contains("fellowship-chain-url is required")?;
    log::info!("[missing_fellowship_url] PASSED");
    Ok(())
}

/// --referendum abc — non-numeric ID.
async fn run_invalid_referendum_id() -> Result<()> {
    log::info!("[invalid_referendum_id] Starting...");
    let runner = ToolRunner::new();
    let output = runner
        .run_test_referendum(ToolArgs {
            governance_chain_url: Some("ws://127.0.0.1:1,1".to_string()),
            referendum: Some("abc".to_string()),
            verbose: true,
            ..Default::default()
        })
        .await?;

    log::info!("[invalid_referendum_id] exit code: {}", output.exit_code);
    output.check_failure()?;
    output.check_any_output_contains("invalid referendum id")?;
    log::info!("[invalid_referendum_id] PASSED");
    Ok(())
}

/// --fellowship xyz — non-numeric ID.
async fn run_invalid_fellowship_id() -> Result<()> {
    log::info!("[invalid_fellowship_id] Starting...");
    let runner = ToolRunner::new();
    let output = runner
        .run_test_referendum(ToolArgs {
            fellowship_chain_url: Some("ws://127.0.0.1:1,1".to_string()),
            fellowship: Some("xyz".to_string()),
            verbose: true,
            ..Default::default()
        })
        .await?;

    log::info!("[invalid_fellowship_id] exit code: {}", output.exit_code);
    output.check_failure()?;
    output.check_any_output_contains("invalid fellowship referendum id")?;
    log::info!("[invalid_fellowship_id] PASSED");
    Ok(())
}
