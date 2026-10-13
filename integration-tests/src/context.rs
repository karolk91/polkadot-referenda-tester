use anyhow::{Context, Result};
use std::time::Duration;
use subxt::{OnlineClient, PolkadotConfig};
use zombienet_sdk::{LocalFileSystem, Network, NetworkNode};

use crate::chains::{
    KUSAMA_ASSET_HUB, KUSAMA_RELAY, POLKADOT_ASSET_HUB, POLKADOT_COLLECTIVES, POLKADOT_RELAY,
};

pub const BEST_BLOCK_METRIC: &str = "block_height{status=\"best\"}";
const BLOCK_PRODUCTION_TIMEOUT_SECS: u64 = 600;
const RPC_HEIGHT_TIMEOUT: Duration = Duration::from_secs(300);
const RPC_HEIGHT_POLL_INTERVAL: Duration = Duration::from_secs(3);
const MIN_FORK_BLOCK: u32 = 6;

pub type Client = OnlineClient<PolkadotConfig>;

pub async fn node_with_blocks<'network>(
    network: &'network Network<LocalFileSystem>,
    name: &str,
) -> Result<&'network NetworkNode> {
    let node = network.get_node(name)?;
    node.wait_metric_with_timeout(
        BEST_BLOCK_METRIC,
        |height| height > 5.0,
        BLOCK_PRODUCTION_TIMEOUT_SECS,
    )
    .await
    .with_context(|| format!("{name} does not produce blocks"))?;
    Ok(node)
}

/// The prometheus-based `wait_metric` readiness gate has been observed to pass
/// while the same node's RPC still reports block #0 (a parachain before its
/// first relay session change). A fork block captured at that moment is
/// unusable — chopsticks cannot fork block #0 because genesis has no
/// relay-parent validation data — so the fork point must be confirmed over the
/// same RPC connection it is read from.
async fn rpc_height_at_least(client: &Client, name: &str, min_height: u32) -> Result<u32> {
    let deadline = tokio::time::Instant::now() + RPC_HEIGHT_TIMEOUT;
    loop {
        let height = client.blocks().at_latest().await?.number();
        if height >= min_height {
            return Ok(height);
        }
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "{name} RPC best block stuck at #{height} (expected >= {min_height})"
        );
        tokio::time::sleep(RPC_HEIGHT_POLL_INTERVAL).await;
    }
}

fn epoch_duration(client: &Client) -> Result<u32> {
    let epoch = client
        .constants()
        .at(&subxt::dynamic::constant("Babe", "EpochDuration"))
        .context("failed to read Babe::EpochDuration")?
        .as_type::<u64>()
        .context("failed to decode Babe::EpochDuration")?;
    Ok(u32::try_from(epoch)?)
}

pub struct ChainEndpoint {
    pub ws_uri: String,
    pub client: Client,
    pub fork_block: u32,
    session_boundary_epoch: Option<u32>,
}

impl ChainEndpoint {
    pub async fn connect(network: &Network<LocalFileSystem>, node_name: &str) -> Result<Self> {
        let node = node_with_blocks(network, node_name).await?;
        let client = node
            .wait_client::<PolkadotConfig>()
            .await
            .with_context(|| format!("subxt connection to {node_name} failed"))?;
        let fork_block = rpc_height_at_least(&client, node_name, MIN_FORK_BLOCK).await?;
        log::info!("{node_name}: {} at fork block #{fork_block}", node.ws_uri());
        Ok(Self {
            ws_uri: node.ws_uri().to_string(),
            client,
            fork_block,
            session_boundary_epoch: None,
        })
    }

    async fn connect_without_session_boundary_forks(
        network: &Network<LocalFileSystem>,
        node_name: &str,
    ) -> Result<Self> {
        let mut endpoint = Self::connect(network, node_name).await?;
        endpoint.session_boundary_epoch = Some(epoch_duration(&endpoint.client)?);
        endpoint.fork_block = endpoint.fork_block_before(endpoint.fork_block);
        Ok(endpoint)
    }

    fn fork_block_before(&self, latest: u32) -> u32 {
        match self.session_boundary_epoch {
            Some(epoch) if latest > 0 && latest.is_multiple_of(epoch) => latest - 1,
            _ => latest,
        }
    }

    pub fn fork_point(&self) -> String {
        self.fork_point_at(self.fork_block)
    }

    pub fn fork_point_at(&self, block: u32) -> String {
        format!("{},{block}", self.ws_uri)
    }

    pub async fn refresh_fork_block(&mut self) -> Result<()> {
        let latest = self.client.blocks().at_latest().await?.number();
        self.fork_block = self.fork_block_before(latest);
        Ok(())
    }
}

pub struct TestContext {
    pub governance: ChainEndpoint,
    pub fellowship: Option<ChainEndpoint>,
    pub relay: Option<ChainEndpoint>,
    pub fellowship_origin_caller: &'static str,
    pub label_prefix: &'static str,
}

impl TestContext {
    pub async fn polkadot_governance(network: &Network<LocalFileSystem>) -> Result<Self> {
        Ok(Self {
            governance: ChainEndpoint::connect(network, POLKADOT_ASSET_HUB.collator).await?,
            fellowship: None,
            relay: None,
            fellowship_origin_caller: "FellowshipOrigins",
            label_prefix: "",
        })
    }

    pub async fn polkadot_fellowship(network: &Network<LocalFileSystem>) -> Result<Self> {
        let [relay_node, ..] = POLKADOT_RELAY.validators;
        Ok(Self {
            governance: ChainEndpoint::connect(network, POLKADOT_ASSET_HUB.collator).await?,
            fellowship: Some(ChainEndpoint::connect(network, POLKADOT_COLLECTIVES.collator).await?),
            relay: Some(ChainEndpoint::connect(network, relay_node).await?),
            fellowship_origin_caller: "FellowshipOrigins",
            label_prefix: "",
        })
    }

    pub async fn kusama(network: &Network<LocalFileSystem>) -> Result<Self> {
        let [relay_node, ..] = KUSAMA_RELAY.validators;
        Ok(Self {
            governance: ChainEndpoint::connect(network, KUSAMA_ASSET_HUB.collator).await?,
            fellowship: Some(
                ChainEndpoint::connect_without_session_boundary_forks(network, relay_node).await?,
            ),
            relay: None,
            fellowship_origin_caller: "Origins",
            label_prefix: "ksm_",
        })
    }

    pub fn fellowship(&self) -> &ChainEndpoint {
        self.fellowship
            .as_ref()
            .expect("no fellowship chain in this test network")
    }

    pub fn relay(&self) -> &ChainEndpoint {
        self.relay
            .as_ref()
            .expect("no relay endpoint in this test network")
    }

    pub async fn refresh_fork_blocks(&mut self) -> Result<()> {
        self.governance.refresh_fork_block().await?;
        if let Some(fellowship) = self.fellowship.as_mut() {
            fellowship.refresh_fork_block().await?;
        }
        if let Some(relay) = self.relay.as_mut() {
            relay.refresh_fork_block().await?;
        }
        Ok(())
    }
}
