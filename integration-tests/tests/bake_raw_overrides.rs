//! Bake the `with_raw_spec_override()` entries into the committed raw chain specs.
//!
//! The integration tests load pre-generated raw specs via `with_chain_spec_path()` and
//! then layer `raw_storage::*_override()` maps on top with `with_raw_spec_override()`.
//! When an override key is *missing* from the loaded spec, zombienet logs a WARN that
//! dumps the entire `genesis.raw.top` map on a single line — several MB for one log
//! line. Under GitHub Actions that stalls log ingestion, backs up the test process's
//! stdout pipe, and the job hangs until `timeout-minutes` kills it.
//!
//! So every key an override injects must already be present in the committed spec with
//! the same value. This tool keeps them in sync: it applies the same override maps the
//! network builders in `common::config` use, per spec, and rewrites the spec in place.
//! Re-run it whenever a `raw_storage` override gains or changes a key.
//!
//! Unlike `generate_chain_specs`, this needs no binaries and spawns no network.
//!
//! Usage:
//!   cd integration-tests
//!   cargo test --test bake_raw_overrides -- --nocapture

mod common;

use anyhow::{Context, Result};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

use common::raw_storage;

/// Resolve the directory holding the cached raw chain specs.
fn specs_dir() -> PathBuf {
    if let Ok(dir) = std::env::var(common::config::CHAIN_SPECS_DIR_ENV) {
        PathBuf::from(dir)
    } else {
        let cwd = std::env::current_dir().expect("cannot get cwd");
        cwd.join("chain-specs")
    }
}

/// Which overrides each cached spec must have baked in.
///
/// Mirrors the `with_raw_spec_override()` calls in `common::config`:
/// - `asset-hub-*`            → `ah_migrator_override()`
/// - `collectives-polkadot`   → `fellowship_collective_override()` (Polkadot fellowship)
/// - `kusama-local` (relay)   → `fellowship_collective_override()` (Kusama fellowship)
/// - `polkadot-local` (relay) → none
///
/// `approved_future_enactment`'s `ah_approved_governance_referendum_override()` is
/// parameterized per test run and cannot be pre-baked.
fn spec_overrides() -> Vec<(&'static str, Vec<Value>)> {
    vec![
        (
            "asset-hub-polkadot-local-raw.json",
            vec![raw_storage::ah_migrator_override()],
        ),
        (
            "collectives-polkadot-local-raw.json",
            vec![raw_storage::fellowship_collective_override()],
        ),
        (
            "kusama-local-raw.json",
            vec![raw_storage::fellowship_collective_override()],
        ),
        (
            "asset-hub-kusama-local-raw.json",
            vec![raw_storage::ah_migrator_override()],
        ),
        ("polkadot-local-raw.json", vec![]),
    ]
}

/// Pull the `genesis.raw.top` entries out of an override value built by `raw_storage`.
fn override_top(override_value: &Value) -> Result<Map<String, Value>> {
    override_value
        .pointer("/genesis/raw/top")
        .and_then(Value::as_object)
        .cloned()
        .context("override value has no genesis.raw.top object")
}

#[derive(Default)]
struct Stats {
    added: usize,
    updated: usize,
    unchanged: usize,
}

impl Stats {
    fn dirty(&self) -> bool {
        self.added > 0 || self.updated > 0
    }
}

/// Merge `overrides` into a spec's `genesis.raw.top`, rewriting the file if anything changed.
fn bake(path: &Path, overrides: &[Value]) -> Result<Stats> {
    let original = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let mut spec: Value = serde_json::from_str(&original)
        .with_context(|| format!("failed to parse {}", path.display()))?;

    // The committed specs are `serde_json::to_string_pretty` output with no trailing
    // newline (that is how zombienet writes them), and `genesis.raw.top` is a BTreeMap
    // so keys are already sorted. A byte-identical round-trip therefore keeps the git
    // diff down to just the touched keys. If that ever stops holding, fail loudly
    // rather than silently reformatting a multi-MB file.
    let roundtrip = serde_json::to_string_pretty(&spec)?;
    anyhow::ensure!(
        roundtrip == original,
        "{} is not byte-identical under a serde_json pretty round-trip; \
         rewriting it would reformat the whole file",
        path.display()
    );

    let mut stats = Stats::default();
    let mut pending: Vec<(String, Value)> = Vec::new();

    {
        let top = spec
            .pointer("/genesis/raw/top")
            .and_then(Value::as_object)
            .with_context(|| format!("{} has no genesis.raw.top", path.display()))?;

        for override_value in overrides {
            for (key, value) in override_top(override_value)? {
                match top.get(&key) {
                    Some(existing) if *existing == value => stats.unchanged += 1,
                    Some(_) => {
                        log::info!("  update {key}");
                        stats.updated += 1;
                        pending.push((key, value));
                    }
                    None => {
                        log::info!("  add    {key}");
                        stats.added += 1;
                        pending.push((key, value));
                    }
                }
            }
        }
    }

    if !stats.dirty() {
        log::info!(
            "  {} already in sync ({} keys)",
            path.display(),
            stats.unchanged
        );
        return Ok(stats);
    }

    let top = spec
        .pointer_mut("/genesis/raw/top")
        .and_then(Value::as_object_mut)
        .expect("genesis.raw.top present, checked above");
    for (key, value) in pending {
        top.insert(key, value);
    }

    let updated = serde_json::to_string_pretty(&spec)?;
    std::fs::write(path, &updated)
        .with_context(|| format!("failed to write {}", path.display()))?;

    log::info!(
        "  wrote {} (+{} added, {} updated, {} unchanged, {:.1} MB)",
        path.display(),
        stats.added,
        stats.updated,
        stats.unchanged,
        updated.len() as f64 / 1_048_576.0
    );
    Ok(stats)
}

#[test]
fn bake_raw_overrides() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init()
        .ok();

    let dir = specs_dir();
    assert!(
        dir.is_dir(),
        "chain specs directory not found: {} (set {})",
        dir.display(),
        common::config::CHAIN_SPECS_DIR_ENV
    );
    log::info!("Chain specs directory: {}", dir.display());

    let mut total = Stats::default();
    for (spec_name, overrides) in spec_overrides() {
        let path = dir.join(spec_name);
        if !path.exists() {
            log::warn!("skipping {spec_name}: not present");
            continue;
        }
        if overrides.is_empty() {
            log::info!("{spec_name}: no raw overrides applied by config.rs, nothing to bake");
            continue;
        }
        log::info!("{spec_name}:");
        let stats = bake(&path, &overrides).expect("failed to bake overrides");
        total.added += stats.added;
        total.updated += stats.updated;
        total.unchanged += stats.unchanged;
    }

    log::info!(
        "Done: {} key(s) added, {} updated, {} already correct",
        total.added,
        total.updated,
        total.unchanged
    );
}
