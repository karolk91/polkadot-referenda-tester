use anyhow::{Context, Result};
use std::path::Path;

use harness::chains::SPEC_GENERATION_NETWORKS;
use harness::network_config::{cached_spec_path, chain_specs_dir, spawn_network};

fn save_spec(zombienet_dir: &Path, chain_name: &str, destination: &Path) -> Result<()> {
    let source = zombienet_dir.join(format!("{chain_name}.json"));
    std::fs::copy(&source, destination).with_context(|| {
        format!(
            "failed to copy {} to {}",
            source.display(),
            destination.display()
        )
    })?;
    log::info!("saved {}", destination.display());
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let output_dir = chain_specs_dir();
    std::fs::create_dir_all(&output_dir)
        .with_context(|| format!("failed to create {}", output_dir.display()))?;

    for network_def in SPEC_GENERATION_NETWORKS {
        let cached: Vec<_> = network_def
            .chains()
            .map(cached_spec_path)
            .filter(|path| path.exists())
            .collect();
        anyhow::ensure!(
            cached.is_empty(),
            "cached specs exist ({cached:?}); delete them first, or the network spawns from the cache and saves the same specs again"
        );
        let network = spawn_network(network_def).await?;
        let zombienet_dir = Path::new(network.base_dir().context("no zombienet base dir")?);
        for chain in network_def.chains() {
            save_spec(zombienet_dir, chain.chain_name, &cached_spec_path(chain))?;
        }
    }
    log::info!("chain specs saved to {}", output_dir.display());
    Ok(())
}
