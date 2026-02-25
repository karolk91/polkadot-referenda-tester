//! Generate and cache raw chain specs using zombienet.
//!
//! This test spawns zombienet networks just long enough to generate complete raw
//! chain specs (with parachain genesis baked into the relay spec), then saves
//! them to the `integration-tests/chain-specs/` directory. On subsequent runs, the integration
//! tests load these cached specs via `with_chain_spec_path()` and skip the
//! expensive WASM execution + raw conversion (~3-5 min per chain).
//!
//! Usage:
//!   POLKADOT_BINARY_PATH=../bin/polkadot \
//!   POLKADOT_PARACHAIN_BINARY_PATH=../bin/polkadot-parachain \
//!   CHAIN_SPECS_DIR=./chain-specs \
//!   cargo test --test generate_chain_specs -- --nocapture

mod common;

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

use common::config;
use common::network::{initialize_network, verify_binaries};

/// Resolve the output directory for cached chain specs.
fn output_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CHAIN_SPECS_DIR") {
        PathBuf::from(dir)
    } else {
        let cwd = std::env::current_dir().expect("cannot get cwd");
        cwd.join("chain-specs")
    }
}

/// Copy a chain spec file from zombienet's temp dir to the output directory.
fn save_spec(base_dir: &str, spec_name: &str, output_name: &str, out_dir: &Path) -> Result<()> {
    let src = PathBuf::from(base_dir).join(format!("{spec_name}.json"));
    let dst = out_dir.join(format!("{output_name}-raw.json"));

    anyhow::ensure!(
        src.exists(),
        "Chain spec not found at {}, available files: {:?}",
        src.display(),
        list_json_files(base_dir)
    );

    std::fs::copy(&src, &dst).context(format!(
        "Failed to copy {} -> {}",
        src.display(),
        dst.display()
    ))?;

    let size = std::fs::metadata(&dst)?.len();
    log::info!(
        "  Saved {} ({:.1} MB)",
        dst.display(),
        size as f64 / 1_048_576.0
    );
    Ok(())
}

/// List all .json files in a directory (for diagnostics).
fn list_json_files(dir: &str) -> Vec<String> {
    std::fs::read_dir(dir)
        .ok()
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|name| name.ends_with(".json"))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread")]
async fn generate_chain_specs() {
    env_logger::try_init().ok();
    verify_binaries().expect("binary verification failed");

    let out_dir = output_dir();
    std::fs::create_dir_all(&out_dir).expect("failed to create output dir");

    log::info!("Output directory: {}", out_dir.display());

    // ── Polkadot (relay + Asset Hub + Collectives) ──────────────────────
    log::info!("Spawning Polkadot network to generate chain specs...");
    let polkadot_config = config::build_polkadot_with_system_parachains()
        .expect("failed to build Polkadot network config");
    let polkadot_network = initialize_network(polkadot_config)
        .await
        .expect("failed to spawn Polkadot network");

    let base_dir = polkadot_network
        .base_dir()
        .expect("no base_dir from zombienet");
    log::info!("Polkadot base_dir: {base_dir}");
    log::info!("  Files: {:?}", list_json_files(base_dir));

    save_spec(base_dir, "polkadot-local", "polkadot-local", &out_dir)
        .expect("failed to save Polkadot relay spec");
    save_spec(
        base_dir,
        "asset-hub-polkadot-local",
        "asset-hub-polkadot-local",
        &out_dir,
    )
    .expect("failed to save Asset Hub spec");
    save_spec(
        base_dir,
        "collectives-polkadot-local",
        "collectives-polkadot-local",
        &out_dir,
    )
    .expect("failed to save Collectives spec");

    // Drop Polkadot network before spawning Kusama
    drop(polkadot_network);
    log::info!("Polkadot network dropped.");

    // ── Kusama (relay + Asset Hub) ──────────────────────────────────────
    log::info!("Spawning Kusama network to generate chain specs...");
    let kusama_config =
        config::build_kusama_with_asset_hub().expect("failed to build Kusama network config");
    let kusama_network = initialize_network(kusama_config)
        .await
        .expect("failed to spawn Kusama network");

    let base_dir = kusama_network
        .base_dir()
        .expect("no base_dir from zombienet");
    log::info!("Kusama base_dir: {base_dir}");
    log::info!("  Files: {:?}", list_json_files(base_dir));

    save_spec(base_dir, "kusama-local", "kusama-local", &out_dir)
        .expect("failed to save Kusama relay spec");
    save_spec(
        base_dir,
        "asset-hub-kusama-local",
        "asset-hub-kusama-local",
        &out_dir,
    )
    .expect("failed to save Kusama Asset Hub spec");

    drop(kusama_network);
    log::info!("Kusama network dropped.");

    log::info!("All chain specs saved to {}", out_dir.display());
}
