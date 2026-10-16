use anyhow::{Context, Result};
use serde_json::{Map, Value};
use std::path::Path;

use harness::chains::SPEC_GENERATION_NETWORKS;
use harness::network_config::cached_spec_path;

const CHECK_FLAG: &str = "--check";
const RAW_TOP_POINTER: &str = "/genesis/raw/top";

fn raw_top(spec: &Value) -> Result<&Map<String, Value>> {
    spec.pointer(RAW_TOP_POINTER)
        .and_then(Value::as_object)
        .context("no genesis.raw.top object")
}

fn raw_top_mut(spec: &mut Value) -> Result<&mut Map<String, Value>> {
    spec.pointer_mut(RAW_TOP_POINTER)
        .and_then(Value::as_object_mut)
        .context("no genesis.raw.top object")
}

fn out_of_sync_entries(spec: &Value, raw_override: &Value) -> Result<Map<String, Value>> {
    let top = raw_top(spec)?;
    Ok(raw_top(raw_override)?
        .iter()
        .filter(|(key, value)| top.get(*key) != Some(*value))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect())
}

fn bake(path: &Path, raw_override: &Value, rewrite: bool) -> Result<usize> {
    let original = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let mut spec: Value = serde_json::from_str(&original)
        .with_context(|| format!("failed to parse {}", path.display()))?;
    anyhow::ensure!(
        serde_json::to_string_pretty(&spec)? == original,
        "{} changes under a serde_json round trip, so a rewrite would reformat the whole file",
        path.display()
    );

    let stale = out_of_sync_entries(&spec, raw_override)?;
    for key in stale.keys() {
        log::info!("{}: out of sync key {key}", path.display());
    }
    let stale_count = stale.len();
    if !rewrite || stale_count == 0 {
        return Ok(stale_count);
    }
    raw_top_mut(&mut spec)?.extend(stale);
    std::fs::write(path, serde_json::to_string_pretty(&spec)?)
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(stale_count)
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let check_only = std::env::args().any(|arg| arg == CHECK_FLAG);
    let mut unwritten_count = 0;
    for network in SPEC_GENERATION_NETWORKS {
        let chains = std::iter::once((&network.relay.chain, !check_only)).chain(
            network
                .parachains
                .iter()
                .map(|parachain| (&parachain.chain, false)),
        );
        for (chain, rewrite) in chains {
            let Some(raw_override) = chain.raw_override else {
                continue;
            };
            let path = cached_spec_path(chain);
            anyhow::ensure!(path.exists(), "no cached spec {}", path.display());
            let stale_count = bake(&path, &raw_override(), rewrite)?;
            if !rewrite {
                unwritten_count += stale_count;
            }
        }
    }
    anyhow::ensure!(
        unwritten_count == 0,
        "{unwritten_count} raw override key(s) out of sync with the cached specs; a parachain spec change desyncs it from the relay spec, so regenerate all specs with generate_chain_specs"
    );
    log::info!("cached specs in sync with the raw overrides");
    Ok(())
}
