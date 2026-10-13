use anyhow::{Context, Result};
use std::path::PathBuf;

pub const POLKADOT_BINARY_ENV: &str = "POLKADOT_BINARY_PATH";
pub const PARACHAIN_BINARY_ENV: &str = "POLKADOT_PARACHAIN_BINARY_PATH";
const DEFAULT_POLKADOT_BINARY: &str = "polkadot";
const DEFAULT_PARACHAIN_BINARY: &str = "polkadot-parachain";

fn binary_path(env: &str, default: &str) -> String {
    let path = PathBuf::from(std::env::var(env).unwrap_or_else(|_| default.to_string()));
    if path.is_absolute() {
        return path.to_string_lossy().to_string();
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(&path))
        .and_then(|joined| joined.canonicalize())
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

pub fn polkadot_binary() -> String {
    binary_path(POLKADOT_BINARY_ENV, DEFAULT_POLKADOT_BINARY)
}

pub fn parachain_binary() -> String {
    binary_path(PARACHAIN_BINARY_ENV, DEFAULT_PARACHAIN_BINARY)
}

fn verify_binary(path: &str, env: &str) -> Result<()> {
    let output = std::process::Command::new(path)
        .arg("--version")
        .output()
        .with_context(|| format!("failed to execute '{path}' (set {env} to override)"))?;
    anyhow::ensure!(
        output.status.success(),
        "'{path}' --version exited with {}",
        output.status
    );
    log::info!("{path}: {}", String::from_utf8_lossy(&output.stdout).trim());
    Ok(())
}

pub fn verify_binaries() -> Result<()> {
    verify_binary(&polkadot_binary(), POLKADOT_BINARY_ENV)?;
    verify_binary(&parachain_binary(), PARACHAIN_BINARY_ENV)
}
