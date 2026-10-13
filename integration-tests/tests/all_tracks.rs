use anyhow::Result;

use harness::calls::{
    self, lookup_proposal, Origin, ProposalReference, ReferendaPallet, ReferendumCalls, ROOT,
};
use harness::chains::{
    KUSAMA_NETWORK, POLKADOT_ASSET_HUB, POLKADOT_FELLOWSHIP_NETWORK, POLKADOT_GOVERNANCE_NETWORK,
};
use harness::context::{ChainEndpoint, TestContext};
use harness::genesis::{bob_account, EXISTING_FELLOW_RANK};
use harness::network_config::{runtime_path, spawn_network};
use harness::tool_runner::{sub_test, StepArgs, ToolArgs, ToolOutput, ToolRunner};
use harness::tracks::{
    Track, GOVERNANCE_TRACKS, KUSAMA_FELLOWSHIP_TRACKS, POLKADOT_FELLOWSHIP_TRACKS,
};

const POLKADOT_FELLOWSHIP_FIRST_HALF: usize = 15;

fn label(context: &TestContext, name: &str) -> String {
    format!("{}{name}", context.label_prefix)
}

async fn tool_output(args: ToolArgs) -> Result<ToolOutput> {
    ToolRunner::default().run(&args).await
}

fn governance_args(context: &TestContext, step: StepArgs) -> ToolArgs {
    ToolArgs {
        governance_chain_url: Some(context.governance.fork_point()),
        steps: vec![step],
        ..Default::default()
    }
}

fn fellowship_args(context: &TestContext, step: StepArgs) -> ToolArgs {
    ToolArgs {
        fellowship_chain_url: Some(context.fellowship().fork_point()),
        steps: vec![step],
        ..Default::default()
    }
}

fn governance_calls(
    chain: &ChainEndpoint,
    origin: Origin,
    proposal: &[u8],
    reference: ProposalReference,
) -> Result<ReferendumCalls> {
    calls::referendum_calls(
        &chain.client,
        ReferendaPallet::Governance,
        origin,
        proposal,
        reference,
    )
}

fn fellowship_calls(
    context: &TestContext,
    variant: &'static str,
    proposal: &[u8],
    reference: ProposalReference,
) -> Result<ReferendumCalls> {
    calls::referendum_calls(
        &context.fellowship().client,
        ReferendaPallet::Fellowship,
        Origin::fellowship(context.fellowship_origin_caller, variant),
        proposal,
        reference,
    )
}

fn authorize_upgrade_calls(context: &TestContext) -> Result<ReferendumCalls> {
    let proposal = calls::authorize_upgrade(&context.governance.client)?;
    governance_calls(
        &context.governance,
        ROOT,
        &proposal,
        ProposalReference::Lookup,
    )
}

fn fellows_remark_calls(context: &TestContext, text: &str) -> Result<ReferendumCalls> {
    let proposal = calls::remark(&context.fellowship().client, text)?;
    fellowship_calls(context, "Fellows", &proposal, ProposalReference::Lookup)
}

async fn governance_track_sub_tests(context: &TestContext) {
    for track in GOVERNANCE_TRACKS {
        sub_test(
            &label(context, &format!("gov_create_{}", track.name)),
            governance_track_creation(context, track),
        )
        .await;
        sub_test(
            &label(context, &format!("gov_bynum_{}", track.name)),
            governance_track_by_number(context, track),
        )
        .await;
    }
}

async fn fellowship_track_sub_tests(context: &TestContext, tracks: &[Track]) {
    for track in tracks {
        sub_test(
            &label(context, &format!("fell_create_{}", track.name)),
            fellowship_track_creation(context, track),
        )
        .await;
        sub_test(
            &label(context, &format!("fell_bynum_{}", track.name)),
            fellowship_track_by_number(context, track),
        )
        .await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn polkadot_governance_all_tracks() {
    let network = spawn_network(&POLKADOT_GOVERNANCE_NETWORK)
        .await
        .expect("zombienet spawn failed");
    let mut context = TestContext::polkadot_governance(&network)
        .await
        .expect("test network not ready");

    governance_track_sub_tests(&context).await;
    context
        .refresh_fork_blocks()
        .await
        .expect("fork block refresh failed");
    sub_test("gov_happy_path", governance_happy_path(&context)).await;
    sub_test(
        "gov_dispatch_failure",
        governance_dispatch_failure(&context),
    )
    .await;
    sub_test("gov_pre_call_remark", governance_pre_call(&context, "Root")).await;
    sub_test(
        "gov_pre_call_non_root_origin",
        governance_pre_call(&context, "Treasurer"),
    )
    .await;
    sub_test(
        "gov_pre_call_invalid_origin",
        governance_pre_call_invalid_origin(&context),
    )
    .await;
    sub_test("gov_remark_proposal", governance_remark_proposal(&context)).await;
    sub_test("gov_invalid_hex", governance_invalid_call_data(&context)).await;
    sub_test(
        "gov_create_no_preimage",
        governance_without_preimage(&context),
    )
    .await;
    sub_test("gov_inline_create", governance_inline_creation(&context)).await;
    sub_test("gov_inline_bynum", governance_inline_by_number(&context)).await;
    sub_test(
        "gov_steps_with_post_test",
        governance_steps_with_post_test(&context),
    )
    .await;
    sub_test(
        "gov_apply_authorized_upgrade",
        governance_upgrade_with_post_test(&context),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn polkadot_fellowship_tracks_part1() {
    let network = spawn_network(&POLKADOT_FELLOWSHIP_NETWORK)
        .await
        .expect("zombienet spawn failed");
    let context = TestContext::polkadot_fellowship(&network)
        .await
        .expect("test network not ready");

    fellowship_track_sub_tests(
        &context,
        &POLKADOT_FELLOWSHIP_TRACKS[..POLKADOT_FELLOWSHIP_FIRST_HALF],
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn polkadot_fellowship_tracks_part2() {
    let network = spawn_network(&POLKADOT_FELLOWSHIP_NETWORK)
        .await
        .expect("zombienet spawn failed");
    let mut context = TestContext::polkadot_fellowship(&network)
        .await
        .expect("test network not ready");

    fellowship_track_sub_tests(
        &context,
        &POLKADOT_FELLOWSHIP_TRACKS[POLKADOT_FELLOWSHIP_FIRST_HALF..],
    )
    .await;
    context
        .refresh_fork_blocks()
        .await
        .expect("fork block refresh failed");
    sub_test(
        "multichain_happy_path",
        fellowship_then_governance(&context),
    )
    .await;
    sub_test("fellowship_only", fellowship_only(&context)).await;
    sub_test("nonexistent_referendum", nonexistent_referendum(&context)).await;
    sub_test(
        "fellowship_create_no_preimage",
        fellowship_without_preimage(&context),
    )
    .await;
    sub_test(
        "gov_with_additional_chains",
        governance_with_relay_events(&context),
    )
    .await;
    sub_test(
        "fell_with_additional_chains",
        fellowship_with_relay_events(&context),
    )
    .await;
    sub_test("fell_inline_create", fellowship_inline_creation(&context)).await;
    sub_test("fell_inline_bynum", fellowship_inline_by_number(&context)).await;
    sub_test(
        "fell_core_approve_existing_member",
        fellowship_core_approve_existing_member(&context),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn kusama_governance_all_tracks() {
    let network = spawn_network(&KUSAMA_NETWORK)
        .await
        .expect("zombienet spawn failed");
    let mut context = TestContext::kusama(&network)
        .await
        .expect("test network not ready");

    governance_track_sub_tests(&context).await;
    context
        .refresh_fork_blocks()
        .await
        .expect("fork block refresh failed");
    sub_test("ksm_gov_happy_path", governance_happy_path(&context)).await;
    sub_test(
        "ksm_gov_inline_create",
        governance_inline_creation(&context),
    )
    .await;
    sub_test(
        "ksm_gov_inline_bynum",
        governance_inline_by_number(&context),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn kusama_fellowship_all_tracks() {
    let network = spawn_network(&KUSAMA_NETWORK)
        .await
        .expect("zombienet spawn failed");
    let mut context = TestContext::kusama(&network)
        .await
        .expect("test network not ready");

    fellowship_track_sub_tests(&context, KUSAMA_FELLOWSHIP_TRACKS).await;
    context
        .refresh_fork_blocks()
        .await
        .expect("fork block refresh failed");
    sub_test(
        "ksm_multichain_happy_path",
        fellowship_then_governance(&context),
    )
    .await;
    sub_test("ksm_fellowship_on_relay", fellowship_only(&context)).await;
    sub_test(
        "ksm_fell_inline_create",
        fellowship_inline_creation(&context),
    )
    .await;
    sub_test(
        "ksm_fell_inline_bynum",
        fellowship_inline_by_number(&context),
    )
    .await;
}

async fn governance_track_creation(context: &TestContext, track: &Track) -> Result<()> {
    let proposal = calls::remark(
        &context.governance.client,
        &format!("gov-track-{}-test", track.name),
    )?;
    let calls = governance_calls(
        &context.governance,
        Origin::governance_track(track),
        &proposal,
        ProposalReference::Lookup,
    )?;
    tool_output(governance_args(
        context,
        StepArgs::default().governance_creation(&calls),
    ))
    .await?
    .check_executed()
}

async fn governance_track_by_number(context: &TestContext, track: &Track) -> Result<()> {
    let client = &context.governance.client;
    let proposal = calls::remark(client, &format!("bynum-gov-{}", track.name))?;
    let calls = governance_calls(
        &context.governance,
        Origin::governance_track(track),
        &proposal,
        ProposalReference::Lookup,
    )?;
    let submitted = calls::submit_referendum(client, ReferendaPallet::Governance, &calls).await?;
    tool_output(ToolArgs {
        governance_chain_url: Some(context.governance.fork_point_at(submitted.block_number)),
        steps: vec![StepArgs::default().governance_referendum(submitted.referendum_id)],
        ..Default::default()
    })
    .await?
    .check_executed()
}

async fn fellowship_track_creation(context: &TestContext, track: &Track) -> Result<()> {
    let proposal = calls::remark(
        &context.fellowship().client,
        &format!("fellowship-track-{}-test", track.name),
    )?;
    let calls = fellowship_calls(context, track.name, &proposal, ProposalReference::Lookup)?;
    tool_output(fellowship_args(
        context,
        StepArgs::default().fellowship_creation(&calls),
    ))
    .await?
    .check_executed()
}

async fn fellowship_track_by_number(context: &TestContext, track: &Track) -> Result<()> {
    let fellowship = context.fellowship();
    let proposal = calls::remark(&fellowship.client, &format!("bynum-fell-{}", track.name))?;
    let calls = fellowship_calls(context, track.name, &proposal, ProposalReference::Lookup)?;
    let submitted =
        calls::submit_referendum(&fellowship.client, ReferendaPallet::Fellowship, &calls).await?;
    tool_output(ToolArgs {
        fellowship_chain_url: Some(fellowship.fork_point_at(submitted.block_number)),
        steps: vec![StepArgs::default().fellowship_referendum(submitted.referendum_id)],
        ..Default::default()
    })
    .await?
    .check_executed()
}

async fn governance_happy_path(context: &TestContext) -> Result<()> {
    let calls = authorize_upgrade_calls(context)?;
    tool_output(governance_args(
        context,
        StepArgs::default().governance_creation(&calls),
    ))
    .await?
    .check_executed()
}

async fn governance_dispatch_failure(context: &TestContext) -> Result<()> {
    let calls = ReferendumCalls {
        submit: calls::submit_call(
            &context.governance.client,
            ReferendaPallet::Governance,
            ROOT,
            lookup_proposal([0; 32], 999),
        )?,
        ..authorize_upgrade_calls(context)?
    };
    let output = tool_output(governance_args(
        context,
        StepArgs::default().governance_creation(&calls),
    ))
    .await?;
    output.check_failure()?;
    output.check_stdout_contains("execution failed")
}

async fn governance_pre_call(context: &TestContext, origin: &str) -> Result<()> {
    let calls = authorize_upgrade_calls(context)?;
    let pre_call = calls::remark(&context.governance.client, "pre-call-test")?;
    let output = tool_output(governance_args(
        context,
        StepArgs::default()
            .governance_creation(&calls)
            .pre_call(format!("0x{}", hex::encode(pre_call)), origin),
    ))
    .await?;
    output.check_executed()?;
    output.check_stdout_contains("Executing Pre-Call")
}

async fn governance_pre_call_invalid_origin(context: &TestContext) -> Result<()> {
    let calls = authorize_upgrade_calls(context)?;
    let pre_call = calls::remark(&context.governance.client, "pre-call-test")?;
    let output = tool_output(governance_args(
        context,
        StepArgs::default()
            .governance_creation(&calls)
            .pre_call(format!("0x{}", hex::encode(pre_call)), "NonExistentOrigin"),
    ))
    .await?;
    output.check_failure()?;
    output.check_output_contains("unknown origin")
}

async fn governance_remark_proposal(context: &TestContext) -> Result<()> {
    let proposal = calls::remark(&context.governance.client, "integration-test-remark")?;
    let calls = governance_calls(
        &context.governance,
        ROOT,
        &proposal,
        ProposalReference::Lookup,
    )?;
    tool_output(governance_args(
        context,
        StepArgs::default().governance_creation(&calls),
    ))
    .await?
    .check_executed()
}

async fn governance_invalid_call_data(context: &TestContext) -> Result<()> {
    let calls = ReferendumCalls {
        preimage: None,
        submit: "0xDEADBEEFCAFE".to_string(),
    };
    let output = tool_output(governance_args(
        context,
        StepArgs::default().governance_creation(&calls),
    ))
    .await?;
    output.check_failure()?;
    output.check_stdout_contains("Invalid referendum submit call data")
}

async fn governance_without_preimage(context: &TestContext) -> Result<()> {
    let calls = ReferendumCalls {
        preimage: None,
        ..authorize_upgrade_calls(context)?
    };
    let output = tool_output(governance_args(
        context,
        StepArgs::default().governance_creation(&calls),
    ))
    .await?;
    output.check_failure()?;
    output.check_stdout_contains("execution failed")
}

async fn governance_inline_creation(context: &TestContext) -> Result<()> {
    let proposal = calls::remark(&context.governance.client, "inline-gov-test")?;
    let calls = governance_calls(
        &context.governance,
        ROOT,
        &proposal,
        ProposalReference::Inline,
    )?;
    tool_output(governance_args(
        context,
        StepArgs::default().governance_creation(&calls),
    ))
    .await?
    .check_executed()
}

async fn governance_inline_by_number(context: &TestContext) -> Result<()> {
    let client = &context.governance.client;
    let proposal = calls::remark(client, "bynum-inline-gov")?;
    let calls = governance_calls(
        &context.governance,
        ROOT,
        &proposal,
        ProposalReference::Inline,
    )?;
    let submitted = calls::submit_referendum(client, ReferendaPallet::Governance, &calls).await?;
    tool_output(ToolArgs {
        governance_chain_url: Some(context.governance.fork_point_at(submitted.block_number)),
        steps: vec![StepArgs::default().governance_referendum(submitted.referendum_id)],
        ..Default::default()
    })
    .await?
    .check_executed()
}

async fn governance_steps_with_post_test(context: &TestContext) -> Result<()> {
    let client = &context.governance.client;
    let first = governance_calls(
        &context.governance,
        ROOT,
        &calls::remark(client, "first-step-remark")?,
        ProposalReference::Lookup,
    )?;
    let second = governance_calls(
        &context.governance,
        ROOT,
        &calls::remark(client, "second-step-remark")?,
        ProposalReference::Inline,
    )?;
    let output = tool_output(ToolArgs {
        governance_chain_url: Some(context.governance.fork_point()),
        steps: vec![
            StepArgs::default()
                .governance_creation(&first)
                .post_test("dump-chain-events", Some(r#"{"all":true,"blocks":1}"#)),
            StepArgs::default().governance_creation(&second),
        ],
        ..Default::default()
    })
    .await?;
    output.check_success()?;
    output.check_stdout_contains("Step 2/2")?;
    output.check_stdout_contains("Running post-test")?;
    anyhow::ensure!(
        output.stdout.matches("executed successfully").count() == 2,
        "the run of two steps does not report two executed referenda\n{}",
        output.stdout
    );
    Ok(())
}

async fn governance_upgrade_with_post_test(context: &TestContext) -> Result<()> {
    let runtime = std::path::PathBuf::from(runtime_path(&POLKADOT_ASSET_HUB.chain)?);
    let code_hash = sp_crypto_hashing::blake2_256(&std::fs::read(&runtime)?);
    let proposal = calls::authorize_upgrade_without_checks(&context.governance.client, code_hash)?;
    let calls = governance_calls(
        &context.governance,
        ROOT,
        &proposal,
        ProposalReference::Lookup,
    )?;
    let post_test_args = serde_json::json!({
        "wasmDir": runtime.parent().map(|directory| directory.display().to_string()),
        "blocksAfterUpgrade": 2,
    })
    .to_string();
    let output = tool_output(governance_args(
        context,
        StepArgs::default()
            .governance_creation(&calls)
            .post_test("apply-authorized-upgrade", Some(&post_test_args)),
    ))
    .await?;
    output.check_executed()?;
    output.check_stdout_contains("hash verified")?;
    output.check_stdout_contains(":code hash == authorized hash")?;
    output.check_stdout_contains("1/1 chains upgraded")
}

async fn fellowship_then_governance(context: &TestContext) -> Result<()> {
    let governance = authorize_upgrade_calls(context)?;
    let fellowship = fellows_remark_calls(context, "integration-test")?;
    let output = tool_output(ToolArgs {
        governance_chain_url: Some(context.governance.fork_point()),
        fellowship_chain_url: Some(context.fellowship().fork_point()),
        additional_chains: context.relay.as_ref().map(ChainEndpoint::fork_point),
        steps: vec![StepArgs::default()
            .fellowship_creation(&fellowship)
            .governance_creation(&governance)],
        ..Default::default()
    })
    .await?;
    output.check_executed()?;
    if context.relay.is_some() {
        output.check_stdout_contains("Additional Chain Events")?;
        output.check_stdout_contains("Block #")?;
    }
    Ok(())
}

async fn fellowship_only(context: &TestContext) -> Result<()> {
    let calls = fellows_remark_calls(context, "fellowship-only-test")?;
    tool_output(fellowship_args(
        context,
        StepArgs::default().fellowship_creation(&calls),
    ))
    .await?
    .check_executed()
}

async fn nonexistent_referendum(context: &TestContext) -> Result<()> {
    let output = tool_output(governance_args(
        context,
        StepArgs::default().governance_referendum(999),
    ))
    .await?;
    output.check_failure()?;
    output.check_stdout_contains("Referendum #999 not found")
}

async fn fellowship_without_preimage(context: &TestContext) -> Result<()> {
    let calls = ReferendumCalls {
        preimage: None,
        ..fellows_remark_calls(context, "fellowship-only-test")?
    };
    let output = tool_output(fellowship_args(
        context,
        StepArgs::default().fellowship_creation(&calls),
    ))
    .await?;
    output.check_failure()?;
    output.check_stdout_contains("execution failed")
}

async fn governance_with_relay_events(context: &TestContext) -> Result<()> {
    let calls = authorize_upgrade_calls(context)?;
    let output = tool_output(ToolArgs {
        additional_chains: Some(context.relay().fork_point()),
        ..governance_args(context, StepArgs::default().governance_creation(&calls))
    })
    .await?;
    output.check_executed()?;
    output.check_stdout_contains("Additional Chain Events")?;
    output.check_stdout_contains("Block #")
}

async fn fellowship_with_relay_events(context: &TestContext) -> Result<()> {
    let calls = fellows_remark_calls(context, "fellowship-only-test")?;
    let output = tool_output(ToolArgs {
        additional_chains: Some(context.relay().fork_point()),
        ..fellowship_args(context, StepArgs::default().fellowship_creation(&calls))
    })
    .await?;
    output.check_executed()?;
    output.check_stdout_contains("Additional Chain Events")?;
    output.check_stdout_contains("Block #")
}

async fn fellowship_inline_creation(context: &TestContext) -> Result<()> {
    let proposal = calls::remark(&context.fellowship().client, "inline-fell-test")?;
    let calls = fellowship_calls(context, "Fellows", &proposal, ProposalReference::Inline)?;
    tool_output(fellowship_args(
        context,
        StepArgs::default().fellowship_creation(&calls),
    ))
    .await?
    .check_executed()
}

async fn fellowship_inline_by_number(context: &TestContext) -> Result<()> {
    let fellowship = context.fellowship();
    let proposal = calls::remark(&fellowship.client, "bynum-inline-fell")?;
    let calls = fellowship_calls(context, "Fellows", &proposal, ProposalReference::Inline)?;
    let submitted =
        calls::submit_referendum(&fellowship.client, ReferendaPallet::Fellowship, &calls).await?;
    tool_output(ToolArgs {
        fellowship_chain_url: Some(fellowship.fork_point_at(submitted.block_number)),
        steps: vec![StepArgs::default().fellowship_referendum(submitted.referendum_id)],
        ..Default::default()
    })
    .await?
    .check_executed()
}

async fn fellowship_core_approve_existing_member(context: &TestContext) -> Result<()> {
    let proposal = calls::fellowship_core_approve(
        &context.fellowship().client,
        bob_account(),
        EXISTING_FELLOW_RANK,
    )?;
    let calls = fellowship_calls(
        context,
        "RetainAt2Dan",
        &proposal,
        ProposalReference::Inline,
    )?;
    let output = tool_output(fellowship_args(
        context,
        StepArgs::default().fellowship_creation(&calls),
    ))
    .await?;
    output.check_executed()?;
    output.check_output_does_not_contain("Unranked")
}
