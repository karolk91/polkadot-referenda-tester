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
//! sovereign accounts and remote XCM versions (see `common::config`). With both
//! Bridge Hubs starting from fresh lane state, the outbound nonce on BHP and
//! the inbound nonce on BHK are consistent by construction. The tool's bridge
//! pump writes BHP's para-head root into BHK directly, so no GRANDPA
//! initialization and no relayer process are needed.
//!
//! The networks spawn with no HRMP channels, and a parachain's XCMP router
//! refuses to send to a sibling without an egress channel in its relay-state
//! proof. The needed channels (Collectives↔AHP and AHP↔BHP on Polkadot,
//! AHK↔BHK on Kusama) are therefore opened post-spawn via the permissionless
//! `Hrmp::establish_system_channel` (see `common::hrmp` — the approach
//! parity-bridges-common uses in its zombienet-sdk bridge tests).

mod common;

use std::time::Duration;

use anyhow::Result;
use subxt::{OnlineClient, PolkadotConfig};
use zombienet_sdk::{LocalFileSystem, Network};

use common::config::{self, BEST_BLOCK_METRIC};
use common::extrinsic_submitter;
use common::hrmp;
use common::network::{initialize_network, verify_binaries};
use common::port_allocator;
use common::tool_runner::{ToolArgs, ToolRunner};

/// Canonical bridged-XCM `FellowshipReferenda.submit` (Inline proposal) call hex
/// produced by opengov-cli for the Polkadot→Kusama whitelist flow — the same hex
/// as the README's bridged example. The proposal is `PolkadotXcm.send` to sibling
/// Asset Hub carrying `InitiateTransfer { preserve_origin: true }` whose remote
/// XCM runs `Whitelist.whitelist_call(hash)` on Kusama Asset Hub. Enactment:
/// `After(10)`.
const BRIDGED_FELLOWSHIP_SUBMIT_HEX: &str = "0x3d003e0201fc1f0005010100a10f05082f0000310202090300a10f00010004060300885e003ad2bf340fd1fe8c8434d8ac346d6afc77e7bb2d1c76340d47a0c2983225e64b010a000000";

const ASSET_HUB_PARA_ID: u32 = 1000;
const COLLECTIVES_PARA_ID: u32 = 1001;
const BRIDGE_HUB_PARA_ID: u32 = 1002;

/// Tool timeout for the bridged run. The tool forks five chains, simulates the
/// fellowship referendum, and pumps the bridge to delivery — more work than the
/// single-network runs the default `TOOL_EXECUTION_TIMEOUT_SECS` budget covers.
const BRIDGED_TOOL_TIMEOUT: Duration = Duration::from_secs(900);

/// WebSocket endpoints and relay clients for both spawned networks.
struct BridgedContext {
    polkadot_relay_client: OnlineClient<PolkadotConfig>,
    kusama_relay_client: OnlineClient<PolkadotConfig>,
    coll_client: OnlineClient<PolkadotConfig>,
    collectives_ws: String,
    asset_hub_polkadot_ws: String,
    bridge_hub_polkadot_ws: String,
    asset_hub_kusama_ws: String,
    bridge_hub_kusama_ws: String,
}

/// Zombienet's native-provider readiness check can hang indefinitely on a node
/// that is in fact healthy, so each spawn attempt is bounded and retried
/// (parity-bridges-common wraps its spawns in a retry for the same reason).
const SPAWN_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(600);
const SPAWN_ATTEMPTS: u32 = 3;

async fn spawn_with_retry(
    label: &str,
    build_config: impl Fn() -> anyhow::Result<zombienet_sdk::NetworkConfig>,
) -> Result<Network<LocalFileSystem>> {
    for attempt in 1..=SPAWN_ATTEMPTS {
        log::info!("Spawning {label} network (attempt {attempt}/{SPAWN_ATTEMPTS})");
        let config = build_config()?;
        match tokio::time::timeout(SPAWN_ATTEMPT_TIMEOUT, initialize_network(config)).await {
            Ok(Ok(network)) => return Ok(network),
            Ok(Err(e)) => log::warn!("{label} spawn attempt {attempt} failed: {e:#}"),
            Err(_) => log::warn!(
                "{label} spawn attempt {attempt} timed out after {SPAWN_ATTEMPT_TIMEOUT:?}"
            ),
        }
    }
    anyhow::bail!("{label} network failed to spawn after {SPAWN_ATTEMPTS} attempts")
}

/// Wait until a node has produced a few blocks, then return its ws URI.
async fn node_ready(network: &Network<LocalFileSystem>, name: &str) -> Result<String> {
    let node = network.get_node(name)?;
    node.wait_metric(BEST_BLOCK_METRIC, |b| b > 5.0)
        .await
        .map_err(|e| anyhow::anyhow!("{name} not producing blocks: {e}"))?;
    Ok(node.ws_uri().to_string())
}

impl BridgedContext {
    async fn from_networks(
        polkadot: &Network<LocalFileSystem>,
        kusama: &Network<LocalFileSystem>,
    ) -> Result<Self> {
        // All seven nodes come up concurrently; parachains need the first relay
        // session change before producing blocks.
        let (
            polkadot_relay_ws,
            asset_hub_polkadot_ws,
            collectives_ws,
            bridge_hub_polkadot_ws,
            kusama_relay_ws,
            asset_hub_kusama_ws,
            bridge_hub_kusama_ws,
        ) = tokio::try_join!(
            node_ready(polkadot, "alice"),
            node_ready(polkadot, "asset-hub-collator"),
            node_ready(polkadot, "collectives-collator"),
            node_ready(polkadot, "bridge-hub-polkadot-collator"),
            node_ready(kusama, "alice"),
            node_ready(kusama, "asset-hub-collator"),
            node_ready(kusama, "bridge-hub-kusama-collator"),
        )?;

        log::info!("Both networks ready:");
        log::info!("  Polkadot relay: {polkadot_relay_ws}");
        log::info!("  Asset Hub Polkadot: {asset_hub_polkadot_ws}");
        log::info!("  Collectives: {collectives_ws}");
        log::info!("  Bridge Hub Polkadot: {bridge_hub_polkadot_ws}");
        log::info!("  Kusama relay: {kusama_relay_ws}");
        log::info!("  Asset Hub Kusama: {asset_hub_kusama_ws}");
        log::info!("  Bridge Hub Kusama: {bridge_hub_kusama_ws}");

        let polkadot_relay_client = polkadot
            .get_node("alice")?
            .wait_client::<PolkadotConfig>()
            .await
            .map_err(|e| anyhow::anyhow!("subxt connect to Polkadot relay failed: {e}"))?;
        let kusama_relay_client = kusama
            .get_node("alice")?
            .wait_client::<PolkadotConfig>()
            .await
            .map_err(|e| anyhow::anyhow!("subxt connect to Kusama relay failed: {e}"))?;
        let coll_client = polkadot
            .get_node("collectives-collator")?
            .wait_client::<PolkadotConfig>()
            .await
            .map_err(|e| anyhow::anyhow!("subxt connect to Collectives failed: {e}"))?;

        Ok(Self {
            polkadot_relay_client,
            kusama_relay_client,
            coll_client,
            collectives_ws,
            asset_hub_polkadot_ws,
            bridge_hub_polkadot_ws,
            asset_hub_kusama_ws,
            bridge_hub_kusama_ws,
        })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn bridged_fellowship_by_id() {
    env_logger::try_init().ok();
    verify_binaries().expect("binary verification failed");

    let polkadot_network = spawn_with_retry("Polkadot", config::build_polkadot_bridged)
        .await
        .expect("failed to spawn Polkadot zombienet");
    let kusama_network = spawn_with_retry("Kusama", config::build_kusama_bridged)
        .await
        .expect("failed to spawn Kusama zombienet");

    // Bound the readiness wait: a parachain that never produces blocks (e.g. a
    // relay with fewer validators than parachain cores) would otherwise hang
    // this poll loop forever.
    let ctx = tokio::time::timeout(
        Duration::from_secs(600),
        BridgedContext::from_networks(&polkadot_network, &kusama_network),
    )
    .await
    .expect("networks did not become ready within 10 minutes")
    .expect("failed to build context");

    // Open the HRMP channels each hop of the bridged flow needs. Batched per
    // relay so every channel opens at the same session boundary; the two relays
    // proceed concurrently.
    tokio::try_join!(
        hrmp::open_system_hrmp_channels(
            &ctx.polkadot_relay_client,
            &[
                (COLLECTIVES_PARA_ID, ASSET_HUB_PARA_ID),
                (ASSET_HUB_PARA_ID, BRIDGE_HUB_PARA_ID),
            ],
        ),
        hrmp::open_system_hrmp_channels(
            &ctx.kusama_relay_client,
            &[(ASSET_HUB_PARA_ID, BRIDGE_HUB_PARA_ID)],
        ),
    )
    .expect("failed to open HRMP channels");

    // Land the canonical bridged referendum on the private Collectives (Inline
    // proposal — no preimage). The fork block is read after submission so the
    // fork both contains the referendum and post-dates the HRMP opening.
    let submitted = extrinsic_submitter::submit_fellowship_referendum_from_hex(
        &ctx.coll_client,
        None,
        BRIDGED_FELLOWSHIP_SUBMIT_HEX,
    )
    .await
    .expect("failed to submit bridged fellowship referendum");

    let coll_fork_block = ctx
        .coll_client
        .blocks()
        .at_latest()
        .await
        .expect("read latest Collectives block")
        .number();
    let fellowship_url = format!("{},{coll_fork_block}", ctx.collectives_ws);

    let runner = ToolRunner::new();
    let port = port_allocator::next_port();
    let output = runner
        .run_test_referendum_with_timeout(
            ToolArgs {
                fellowship_chain_url: Some(fellowship_url),
                fellowship: Some(submitted.referendum_id.to_string()),
                governance_chain_url: Some(ctx.asset_hub_kusama_ws.clone()),
                asset_hub_polkadot_url: Some(ctx.asset_hub_polkadot_ws.clone()),
                bridge_hub_polkadot_url: Some(ctx.bridge_hub_polkadot_ws.clone()),
                bridge_hub_kusama_url: Some(ctx.bridge_hub_kusama_ws.clone()),
                port: Some(port),
                verbose: true,
                ..Default::default()
            },
            BRIDGED_TOOL_TIMEOUT,
        )
        .await
        .expect("tool invocation failed");

    output.check_success().expect("tool exited non-zero");
    output
        .check_any_output_contains("Bridge delivery verified")
        .expect("bridge delivery not verified");
}
