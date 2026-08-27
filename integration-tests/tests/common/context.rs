//! Shared test context structs that encapsulate zombienet network state.
//!
//! Created once per test suite after network spawn, then passed to all sub-tests.
//! This avoids duplicating the wait-for-readiness + subxt-connect boilerplate.

use anyhow::Result;
use std::time::Duration;
use subxt::{OnlineClient, PolkadotConfig};
use zombienet_sdk::{LocalFileSystem, Network};

use super::config::BEST_BLOCK_METRIC;

/// Wait until the chain's best block, as reported over the node's RPC, reaches
/// `min_height`, and return the current height.
///
/// The prometheus-based `wait_metric` readiness gate has been observed to pass
/// while the same node's RPC still reports block #0 (a parachain before its
/// first relay session change). A fork block captured at that moment is
/// unusable — chopsticks cannot fork block #0 because genesis has no
/// relay-parent validation data — so the fork point must be confirmed over the
/// same RPC connection it is read from.
async fn wait_for_rpc_height(
    client: &OnlineClient<PolkadotConfig>,
    name: &str,
    min_height: u32,
) -> Result<u32> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        let height = client.blocks().at_latest().await?.number();
        if height >= min_height {
            return Ok(height);
        }
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "{name} RPC best block stuck at #{height} (expected >= {min_height})"
        );
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

/// Shared context for governance-only test suites (relay + Asset Hub).
pub struct GovernanceTestContext {
    #[allow(dead_code)]
    pub relay_ws_uri: String,
    pub asset_hub_ws_uri: String,
    pub ah_client: OnlineClient<PolkadotConfig>,
    pub ah_fork_block: u32,
}

impl GovernanceTestContext {
    /// Build context from a running zombienet network.
    /// Waits for block production, connects subxt clients, captures fork blocks.
    pub async fn from_network(network: &Network<LocalFileSystem>) -> Result<Self> {
        let alice = network.get_node("alice")?;
        alice
            .wait_metric(BEST_BLOCK_METRIC, |b| b > 5.0)
            .await
            .map_err(|e| anyhow::anyhow!("Relay not producing blocks: {e}"))?;

        let ah_collator = network.get_node("asset-hub-collator")?;
        ah_collator
            .wait_metric(BEST_BLOCK_METRIC, |b| b > 5.0)
            .await
            .map_err(|e| anyhow::anyhow!("Asset Hub not producing blocks: {e}"))?;

        log::info!("Network ready:");
        log::info!("  Relay (alice): {}", alice.ws_uri());
        log::info!("  Asset Hub: {}", ah_collator.ws_uri());

        let ah_client = ah_collator
            .wait_client::<PolkadotConfig>()
            .await
            .map_err(|e| anyhow::anyhow!("subxt connect to Asset Hub failed: {e}"))?;

        let ah_fork_block = wait_for_rpc_height(&ah_client, "Asset Hub", 6).await?;
        log::info!("Asset Hub fork block: #{ah_fork_block}");

        Ok(Self {
            relay_ws_uri: alice.ws_uri().to_string(),
            asset_hub_ws_uri: ah_collator.ws_uri().to_string(),
            ah_client,
            ah_fork_block,
        })
    }

    /// Governance chain URL with fork block for Chopsticks.
    pub fn governance_url_with_block(&self) -> String {
        format!("{},{}", self.asset_hub_ws_uri, self.ah_fork_block)
    }

    /// Re-fetch the latest block number so Chopsticks doesn't try to fork from
    /// a block whose state has already been pruned by the zombienet node.
    pub async fn refresh_fork_blocks(&mut self) -> Result<()> {
        self.ah_fork_block = self.ah_client.blocks().at_latest().await?.number();
        log::info!("Refreshed fork blocks: AH=#{}", self.ah_fork_block);
        Ok(())
    }
}

/// Shared context for multi-chain test suites (relay + Asset Hub + Collectives).
pub struct MultiChainTestContext {
    pub relay_ws_uri: String,
    pub asset_hub_ws_uri: String,
    pub collectives_ws_uri: String,
    pub ah_client: OnlineClient<PolkadotConfig>,
    pub coll_client: OnlineClient<PolkadotConfig>,
    pub relay_client: OnlineClient<PolkadotConfig>,
    pub ah_fork_block: u32,
    pub coll_fork_block: u32,
    pub relay_fork_block: u32,
}

impl MultiChainTestContext {
    /// Build context from a running zombienet network.
    pub async fn from_network(network: &Network<LocalFileSystem>) -> Result<Self> {
        let alice = network.get_node("alice")?;
        alice
            .wait_metric(BEST_BLOCK_METRIC, |b| b > 5.0)
            .await
            .map_err(|e| anyhow::anyhow!("Relay not producing blocks: {e}"))?;

        let ah_collator = network.get_node("asset-hub-collator")?;
        ah_collator
            .wait_metric(BEST_BLOCK_METRIC, |b| b > 5.0)
            .await
            .map_err(|e| anyhow::anyhow!("Asset Hub not producing blocks: {e}"))?;

        let coll_collator = network.get_node("collectives-collator")?;
        coll_collator
            .wait_metric(BEST_BLOCK_METRIC, |b| b > 5.0)
            .await
            .map_err(|e| anyhow::anyhow!("Collectives not producing blocks: {e}"))?;

        log::info!("Network ready:");
        log::info!("  Relay (alice): {}", alice.ws_uri());
        log::info!("  Asset Hub: {}", ah_collator.ws_uri());
        log::info!("  Collectives: {}", coll_collator.ws_uri());

        let ah_client = ah_collator
            .wait_client::<PolkadotConfig>()
            .await
            .map_err(|e| anyhow::anyhow!("subxt connect to Asset Hub failed: {e}"))?;
        let coll_client = coll_collator
            .wait_client::<PolkadotConfig>()
            .await
            .map_err(|e| anyhow::anyhow!("subxt connect to Collectives failed: {e}"))?;
        let relay_client = alice
            .wait_client::<PolkadotConfig>()
            .await
            .map_err(|e| anyhow::anyhow!("subxt connect to relay failed: {e}"))?;

        let ah_fork_block = wait_for_rpc_height(&ah_client, "Asset Hub", 6).await?;
        let coll_fork_block = wait_for_rpc_height(&coll_client, "Collectives", 6).await?;
        let relay_fork_block = wait_for_rpc_height(&relay_client, "Relay", 6).await?;

        log::info!(
            "Fork blocks: AH=#{ah_fork_block}, Coll=#{coll_fork_block}, Relay=#{relay_fork_block}"
        );

        Ok(Self {
            relay_ws_uri: alice.ws_uri().to_string(),
            asset_hub_ws_uri: ah_collator.ws_uri().to_string(),
            collectives_ws_uri: coll_collator.ws_uri().to_string(),
            ah_client,
            coll_client,
            relay_client,
            ah_fork_block,
            coll_fork_block,
            relay_fork_block,
        })
    }

    pub fn governance_url_with_block(&self) -> String {
        format!("{},{}", self.asset_hub_ws_uri, self.ah_fork_block)
    }

    pub fn fellowship_url_with_block(&self) -> String {
        format!("{},{}", self.collectives_ws_uri, self.coll_fork_block)
    }

    pub fn relay_url_with_block(&self) -> String {
        format!("{},{}", self.relay_ws_uri, self.relay_fork_block)
    }

    /// Re-fetch the latest block numbers so Chopsticks doesn't try to fork from
    /// blocks whose state has already been pruned by the zombienet nodes.
    pub async fn refresh_fork_blocks(&mut self) -> Result<()> {
        self.ah_fork_block = self.ah_client.blocks().at_latest().await?.number();
        self.coll_fork_block = self.coll_client.blocks().at_latest().await?.number();
        self.relay_fork_block = self.relay_client.blocks().at_latest().await?.number();
        log::info!(
            "Refreshed fork blocks: AH=#{}, Coll=#{}, Relay=#{}",
            self.ah_fork_block,
            self.coll_fork_block,
            self.relay_fork_block
        );
        Ok(())
    }
}

/// Shared context for Kusama test suites (relay + Asset Hub).
///
/// On Kusama, FellowshipReferenda and FellowshipCollective pallets live on the
/// relay chain itself, not on a separate Collectives parachain. This context
/// reflects that topology: fellowship_url_with_block() returns the relay URL.
pub struct KusamaTestContext {
    pub relay_ws_uri: String,
    pub asset_hub_ws_uri: String,
    pub relay_client: OnlineClient<PolkadotConfig>,
    pub ah_client: OnlineClient<PolkadotConfig>,
    pub relay_fork_block: u32,
    pub ah_fork_block: u32,
}

impl KusamaTestContext {
    /// Build context from a running Kusama zombienet network.
    pub async fn from_network(network: &Network<LocalFileSystem>) -> Result<Self> {
        let alice = network.get_node("alice-kusama")?;
        alice
            .wait_metric(BEST_BLOCK_METRIC, |b| b > 5.0)
            .await
            .map_err(|e| anyhow::anyhow!("Kusama relay not producing blocks: {e}"))?;

        let ah_collator = network.get_node("asset-hub-kusama-collator")?;
        ah_collator
            .wait_metric(BEST_BLOCK_METRIC, |b| b > 5.0)
            .await
            .map_err(|e| anyhow::anyhow!("Kusama Asset Hub not producing blocks: {e}"))?;

        log::info!("Kusama network ready:");
        log::info!("  Relay (alice): {}", alice.ws_uri());
        log::info!("  Asset Hub: {}", ah_collator.ws_uri());

        let relay_client = alice
            .wait_client::<PolkadotConfig>()
            .await
            .map_err(|e| anyhow::anyhow!("subxt connect to Kusama relay failed: {e}"))?;

        let ah_client = ah_collator
            .wait_client::<PolkadotConfig>()
            .await
            .map_err(|e| anyhow::anyhow!("subxt connect to Kusama Asset Hub failed: {e}"))?;

        let mut relay_fork_block = wait_for_rpc_height(&relay_client, "Kusama relay", 6).await?;
        let ah_fork_block = wait_for_rpc_height(&ah_client, "Kusama Asset Hub", 6).await?;

        // Avoid forking at a session boundary block. Chopsticks has issues with
        // preimage availability when the fork point is exactly on a session boundary
        // (a multiple of the epoch length). Subtract 1 if we're on a boundary.
        const FAST_RUNTIME_EPOCH: u32 = 20;
        if relay_fork_block > 0 && relay_fork_block % FAST_RUNTIME_EPOCH == 0 {
            relay_fork_block -= 1;
            log::info!("Adjusted relay fork block to avoid session boundary: {relay_fork_block}");
        }

        log::info!("Kusama fork blocks: Relay=#{relay_fork_block}, AH=#{ah_fork_block}");

        Ok(Self {
            relay_ws_uri: alice.ws_uri().to_string(),
            asset_hub_ws_uri: ah_collator.ws_uri().to_string(),
            relay_client,
            ah_client,
            relay_fork_block,
            ah_fork_block,
        })
    }

    /// Governance chain URL (Asset Hub — has Referenda pallet).
    pub fn governance_url_with_block(&self) -> String {
        format!("{},{}", self.asset_hub_ws_uri, self.ah_fork_block)
    }

    /// Fellowship chain URL (Relay — has FellowshipReferenda pallet on Kusama).
    pub fn fellowship_url_with_block(&self) -> String {
        format!("{},{}", self.relay_ws_uri, self.relay_fork_block)
    }

    /// Re-fetch the latest block numbers so Chopsticks doesn't try to fork from
    /// blocks whose state has already been pruned by the zombienet nodes.
    pub async fn refresh_fork_blocks(&mut self) -> Result<()> {
        self.relay_fork_block = self.relay_client.blocks().at_latest().await?.number();
        self.ah_fork_block = self.ah_client.blocks().at_latest().await?.number();

        // Avoid forking at a session boundary block (same as from_network)
        const FAST_RUNTIME_EPOCH: u32 = 20;
        if self.relay_fork_block > 0 && self.relay_fork_block % FAST_RUNTIME_EPOCH == 0 {
            self.relay_fork_block -= 1;
            log::info!(
                "Adjusted relay fork block to avoid session boundary: {}",
                self.relay_fork_block
            );
        }

        log::info!(
            "Refreshed Kusama fork blocks: Relay=#{}, AH=#{}",
            self.relay_fork_block,
            self.ah_fork_block
        );
        Ok(())
    }
}
