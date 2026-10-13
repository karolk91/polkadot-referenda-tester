//! Hermetic bridged-scenario integration test: a fellowship referendum on a
//! private zombienet Polkadot Collectives drives `Whitelist.whitelist_call`
//! across the Polkadot→Kusama bridge to a private zombienet Kusama Asset Hub,
//! exercised through the tool's `--fellowship <id>` (by-ID) path. No public
//! RPCs are involved — both ecosystems run locally:
//!
//! - **Polkadot zombienet**: relay + Asset Hub (1000) + Collectives (1001) +
//!   Bridge Hub (1002).
//! - **Kusama zombienet**: relay + Asset Hub (1000) + Bridge Hub (1002).
//!
//! The fellows `-local` genesis presets pre-open the AH<>AH bridge (lane
//! `[0,0,0,1]`) on both Bridge Hubs, and chain-spec generation adds the funded
//! sovereign accounts and remote XCM versions (see `harness::genesis`). With both
//! Bridge Hubs starting from fresh lane state, the outbound nonce on BHP and
//! the inbound nonce on BHK are consistent by construction. The tool's bridge
//! pump writes BHP's para-head root into BHK directly, so no GRANDPA
//! initialization and no relayer process are needed.
//!
//! The networks spawn with no HRMP channels, and a parachain's XCMP router
//! refuses to send to a sibling without an egress channel in its relay-state
//! proof. The needed channels (Collectives↔AHP and AHP↔BHP on Polkadot,
//! AHK↔BHK on Kusama) are therefore opened post-spawn via the permissionless
//! `Hrmp::establish_system_channel` (see `harness::hrmp` — the approach
//! parity-bridges-common uses in its zombienet-sdk bridge tests).

use std::time::Duration;

use harness::calls::{self, ReferendaPallet, ReferendumCalls};
use harness::chains::{
    KUSAMA_ASSET_HUB, KUSAMA_BRIDGE_HUB, KUSAMA_BRIDGE_NETWORK, KUSAMA_RELAY, POLKADOT_ASSET_HUB,
    POLKADOT_BRIDGE_HUB, POLKADOT_BRIDGE_NETWORK, POLKADOT_COLLECTIVES, POLKADOT_RELAY,
};
use harness::context::ChainEndpoint;
use harness::hrmp;
use harness::ids::{ASSET_HUB_PARA_ID, BRIDGE_HUB_PARA_ID, COLLECTIVES_PARA_ID};
use harness::network_config::spawn_network;
use harness::tool_runner::{StepArgs, ToolArgs, ToolRunner};

/// Canonical bridged-XCM `FellowshipReferenda.submit` (Inline proposal) call hex
/// produced by opengov-cli for the Polkadot→Kusama whitelist flow — the same hex
/// as the README's bridged example. The proposal is `PolkadotXcm.send` to sibling
/// Asset Hub carrying `InitiateTransfer { preserve_origin: true }` whose remote
/// XCM runs `Whitelist.whitelist_call(hash)` on Kusama Asset Hub. Enactment:
/// `After(10)`.
const BRIDGED_FELLOWSHIP_SUBMIT_HEX: &str = "0x3d003e0201fc1f0005010100a10f05082f0000310202090300a10f00010004060300885e003ad2bf340fd1fe8c8434d8ac346d6afc77e7bb2d1c76340d47a0c2983225e64b010a000000";

const BRIDGED_TOOL_TIMEOUT: Duration = Duration::from_secs(900);

#[tokio::test(flavor = "multi_thread")]
async fn bridged_fellowship_by_id() {
    let polkadot_network = spawn_network(&POLKADOT_BRIDGE_NETWORK)
        .await
        .expect("Polkadot zombienet spawn failed");
    let kusama_network = spawn_network(&KUSAMA_BRIDGE_NETWORK)
        .await
        .expect("Kusama zombienet spawn failed");
    let [polkadot_relay_node, ..] = POLKADOT_RELAY.validators;
    let [kusama_relay_node, ..] = KUSAMA_RELAY.validators;
    let (
        polkadot_relay,
        mut collectives,
        asset_hub_polkadot,
        bridge_hub_polkadot,
        kusama_relay,
        asset_hub_kusama,
        bridge_hub_kusama,
    ) = tokio::try_join!(
        ChainEndpoint::connect(&polkadot_network, polkadot_relay_node),
        ChainEndpoint::connect(&polkadot_network, POLKADOT_COLLECTIVES.collator),
        ChainEndpoint::connect(&polkadot_network, POLKADOT_ASSET_HUB.collator),
        ChainEndpoint::connect(&polkadot_network, POLKADOT_BRIDGE_HUB.collator),
        ChainEndpoint::connect(&kusama_network, kusama_relay_node),
        ChainEndpoint::connect(&kusama_network, KUSAMA_ASSET_HUB.collator),
        ChainEndpoint::connect(&kusama_network, KUSAMA_BRIDGE_HUB.collator),
    )
    .expect("bridged networks not ready");

    tokio::try_join!(
        hrmp::open_system_hrmp_channels(
            &polkadot_relay.client,
            &[
                (COLLECTIVES_PARA_ID, ASSET_HUB_PARA_ID),
                (ASSET_HUB_PARA_ID, BRIDGE_HUB_PARA_ID),
            ],
        ),
        hrmp::open_system_hrmp_channels(
            &kusama_relay.client,
            &[(ASSET_HUB_PARA_ID, BRIDGE_HUB_PARA_ID)],
        ),
    )
    .expect("HRMP channels did not open");

    let submitted = calls::submit_referendum(
        &collectives.client,
        ReferendaPallet::Fellowship,
        &ReferendumCalls {
            preimage: None,
            submit: BRIDGED_FELLOWSHIP_SUBMIT_HEX.to_string(),
        },
    )
    .await
    .expect("bridged fellowship referendum submission failed");
    collectives
        .refresh_fork_block()
        .await
        .expect("Collectives fork block refresh failed");

    let output = ToolRunner::default()
        .run_with_timeout(
            &ToolArgs {
                fellowship_chain_url: Some(collectives.fork_point()),
                governance_chain_url: Some(asset_hub_kusama.ws_uri.clone()),
                asset_hub_polkadot_url: Some(asset_hub_polkadot.ws_uri.clone()),
                bridge_hub_polkadot_url: Some(bridge_hub_polkadot.ws_uri.clone()),
                bridge_hub_kusama_url: Some(bridge_hub_kusama.ws_uri.clone()),
                steps: vec![StepArgs::default().fellowship_referendum(submitted.referendum_id)],
                ..Default::default()
            },
            BRIDGED_TOOL_TIMEOUT,
        )
        .await
        .expect("tool run failed");
    output.check_success().expect("tool exit code not 0");
    output
        .check_output_contains("Bridge delivery verified")
        .expect("bridge delivery not verified");
}
