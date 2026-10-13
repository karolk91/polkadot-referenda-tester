use anyhow::Result;

use harness::tool_runner::{StepArgs, ToolArgs, ToolRunner};

struct ValidationCase {
    label: &'static str,
    args: ToolArgs,
    expected_output: &'static str,
}

const UNREACHABLE_FORK_POINT: &str = "ws://127.0.0.1:1,1";

fn validation_cases() -> Vec<ValidationCase> {
    let unreachable = Some(UNREACHABLE_FORK_POINT.to_string());
    vec![
        ValidationCase {
            label: "no_args",
            args: ToolArgs::default(),
            expected_output: "at least one referendum must be specified",
        },
        ValidationCase {
            label: "mutually_exclusive_gov",
            args: ToolArgs {
                governance_chain_url: unreachable.clone(),
                steps: vec![StepArgs {
                    referendum: Some("0".to_string()),
                    call_to_create_governance_referendum: Some("0x00".to_string()),
                    ..Default::default()
                }],
                ..Default::default()
            },
            expected_output: "cannot specify both",
        },
        ValidationCase {
            label: "mutually_exclusive_fellowship",
            args: ToolArgs {
                fellowship_chain_url: unreachable.clone(),
                steps: vec![StepArgs {
                    fellowship: Some("0".to_string()),
                    call_to_create_fellowship_referendum: Some("0x00".to_string()),
                    ..Default::default()
                }],
                ..Default::default()
            },
            expected_output: "cannot specify both",
        },
        ValidationCase {
            label: "missing_governance_url",
            args: ToolArgs {
                steps: vec![StepArgs::default().governance_referendum(0)],
                ..Default::default()
            },
            expected_output: "governance-chain-url is required",
        },
        ValidationCase {
            label: "missing_fellowship_url",
            args: ToolArgs {
                steps: vec![StepArgs::default().fellowship_referendum(0)],
                ..Default::default()
            },
            expected_output: "fellowship-chain-url is required",
        },
        ValidationCase {
            label: "invalid_referendum_id",
            args: ToolArgs {
                governance_chain_url: unreachable.clone(),
                steps: vec![StepArgs {
                    referendum: Some("abc".to_string()),
                    ..Default::default()
                }],
                ..Default::default()
            },
            expected_output: "invalid referendum id",
        },
        ValidationCase {
            label: "invalid_fellowship_id",
            args: ToolArgs {
                fellowship_chain_url: unreachable,
                steps: vec![StepArgs {
                    fellowship: Some("xyz".to_string()),
                    ..Default::default()
                }],
                ..Default::default()
            },
            expected_output: "invalid fellowship referendum id",
        },
    ]
}

async fn validation_outcome(case: &ValidationCase) -> Result<()> {
    let output = ToolRunner::default().run(&case.args).await?;
    output.check_failure()?;
    output.check_output_contains(case.expected_output)
}

#[tokio::test(flavor = "multi_thread")]
async fn validation_test_suite() {
    env_logger::try_init().ok();
    let mut tasks = tokio::task::JoinSet::new();
    for case in validation_cases() {
        tasks.spawn(async move { (case.label, validation_outcome(&case).await) });
    }
    let mut failures = Vec::new();
    while let Some(joined) = tasks.join_next().await {
        let (label, outcome) = joined.expect("validation task panicked");
        match outcome {
            Ok(()) => log::info!("PASS: {label}"),
            Err(error) => {
                log::error!("FAIL: {label}: {error:#}");
                failures.push(label);
            }
        }
    }
    assert!(failures.is_empty(), "failed validation cases: {failures:?}");
}
