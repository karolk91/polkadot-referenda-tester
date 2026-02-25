use anyhow::{Context, Result};
use std::path::PathBuf;
use zombienet_sdk::{LocalFileSystem, Network, NetworkConfig, NetworkConfigExt};

use super::config::*;

/// Spawn a zombienet network using the native provider (local binaries, no Docker).
pub async fn initialize_network(config: NetworkConfig) -> Result<Network<LocalFileSystem>> {
    let network = config.spawn_native().await?;
    Ok(network)
}

/// Read an env var with a fallback default.
pub fn env_or_default(var: &str, default: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| default.to_string())
}

/// Resolve a potentially relative binary path to an absolute path.
fn resolve_binary_path(path_str: &str) -> String {
    let path = PathBuf::from(path_str);
    if path.is_absolute() {
        path_str.to_string()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(&path))
            .and_then(|p| p.canonicalize())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| path_str.to_string())
    }
}

pub fn get_polkadot_binary_path() -> String {
    let path_str = env_or_default(POLKADOT_BINARY_ENV, DEFAULT_POLKADOT_BINARY);
    resolve_binary_path(&path_str)
}

pub fn get_parachain_binary_path() -> String {
    let path_str = env_or_default(PARACHAIN_BINARY_ENV, DEFAULT_PARACHAIN_BINARY);
    resolve_binary_path(&path_str)
}

/// Verify that a binary exists and runs with `--version`.
fn verify_binary(path: &str) -> Result<()> {
    let output = std::process::Command::new(path)
        .arg("--version")
        .output()
        .context(format!("Failed to execute '{path}'"))?;
    if !output.status.success() {
        anyhow::bail!("'{path}' exited with status: {}", output.status);
    }
    let version = String::from_utf8_lossy(&output.stdout);
    log::info!("  {path}: {}", version.trim());
    Ok(())
}

/// Verify all required binaries are present and runnable.
pub fn verify_binaries() -> Result<()> {
    log::info!("Verifying binaries...");

    let polkadot = get_polkadot_binary_path();
    verify_binary(&polkadot).context(format!(
        "Polkadot binary '{polkadot}' (set {POLKADOT_BINARY_ENV} to override)"
    ))?;

    let parachain = get_parachain_binary_path();
    verify_binary(&parachain).context(format!(
        "Parachain binary '{parachain}' (set {PARACHAIN_BINARY_ENV} to override)"
    ))?;

    Ok(())
}
