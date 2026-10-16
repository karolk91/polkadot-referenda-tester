use anyhow::{Context, Result};
use serde_json::json;

use harness::calls;
use harness::chains::POLKADOT_GOVERNANCE_NETWORK;
use harness::context::TestContext;
use harness::genesis::approved_governance_referendum_storage;
use harness::network_config::spawn_network;
use harness::tool_runner::{StepArgs, ToolArgs, ToolRunner};

const REFERENDUM_ID: u32 = 42;
const APPROVAL_BLOCK: u32 = 0;
const ENACTMENT_BLOCK: u32 = 1_000_000;

#[tokio::test(flavor = "multi_thread")]
async fn polkadot_governance_approved_future_enactment() -> Result<()> {
    let network = spawn_network(&POLKADOT_GOVERNANCE_NETWORK).await?;
    let context = TestContext::polkadot_governance(&network).await?;

    let fork_config = json!({
        "endpoint": context.governance.ws_uri,
        "block": context.governance.fork_block,
        "import-storage": approved_governance_referendum_storage(
            &calls::remark(&context.governance.client, "approved-future-test")?,
            REFERENDUM_ID,
            APPROVAL_BLOCK,
            ENACTMENT_BLOCK,
        ),
    });
    let fork_config_path = std::env::temp_dir().join(format!(
        "approved-future-enactment-{}.yml",
        std::process::id()
    ));
    std::fs::write(&fork_config_path, fork_config.to_string())
        .with_context(|| format!("failed to write {}", fork_config_path.display()))?;

    let output = ToolRunner::default()
        .run(&ToolArgs {
            governance_chain_url: Some(fork_config_path.display().to_string()),
            steps: vec![StepArgs::default().governance_referendum(REFERENDUM_ID)],
            ..Default::default()
        })
        .await?;
    output.check_executed()?;
    output.check_stdout_contains("approved with scheduled enactment at block")?;
    output.check_stdout_contains("Pre-Approved, Move Enactment Forward")
}
