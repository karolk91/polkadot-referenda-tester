// Environment variables for binary paths.
pub const POLKADOT_BINARY_ENV: &str = "POLKADOT_BINARY_PATH";
pub const DEFAULT_POLKADOT_BINARY: &str = "polkadot";
pub const PARACHAIN_BINARY_ENV: &str = "POLKADOT_PARACHAIN_BINARY_PATH";
pub const DEFAULT_PARACHAIN_BINARY: &str = "polkadot-parachain";

// Environment variable for fast-runtime WASM directory.
// Default: ./runtimes/fast/ (relative to integration-tests crate root)
pub const RUNTIMES_DIR_ENV: &str = "FAST_RUNTIMES_DIR";

// Environment variable for pre-generated raw chain specs directory.
// When set and the directory contains cached specs, zombienet skips spec generation.
pub const CHAIN_SPECS_DIR_ENV: &str = "CHAIN_SPECS_DIR";

// Timeouts (seconds).
pub const TOOL_EXECUTION_TIMEOUT_SECS: u64 = 600; // 10 min for full referendum sim

// Prometheus metrics.
pub const BEST_BLOCK_METRIC: &str = "block_height{status=\"best\"}";

// WASM filenames produced by substrate-wasm-builder when building from Fellows repo.
const RELAY_WASM: &str = "polkadot_runtime.compact.compressed.wasm";
const ASSET_HUB_WASM: &str = "asset_hub_polkadot_runtime.compact.compressed.wasm";
const COLLECTIVES_WASM: &str = "collectives_polkadot_runtime.compact.compressed.wasm";

// Kusama WASM filenames.
const KUSAMA_RELAY_WASM: &str = "staging_kusama_runtime.compact.compressed.wasm";
const KUSAMA_ASSET_HUB_WASM: &str = "asset_hub_kusama_runtime.compact.compressed.wasm";

// Bridge Hub WASM filenames (bridged scenario).
const BRIDGE_HUB_POLKADOT_WASM: &str = "bridge_hub_polkadot_runtime.compact.compressed.wasm";
const BRIDGE_HUB_KUSAMA_WASM: &str = "bridge_hub_kusama_runtime.compact.compressed.wasm";

use anyhow::anyhow;
use serde_json::json;
use std::path::PathBuf;
use zombienet_configuration::shared::types::Arg;
use zombienet_sdk::{NetworkConfig, NetworkConfigBuilder};

use super::network::{get_parachain_binary_path, get_polkadot_binary_path};
use super::raw_storage;

/// Genesis overrides for the relay chain.
///
/// Core assignments are handled automatically by the `assign_coretime` call
/// during genesis (triggered by `paras` pallet for each registered parachain).
/// We only need to ensure `lookahead >= 2` so the claim queue has enough depth
/// for async backing and the slot-based collator can see upcoming scheduling.
fn relay_genesis_overrides() -> serde_json::Value {
    json!({
        "configuration": {
            "config": {
                "scheduler_params": {
                    "lookahead": 2
                }
            }
        }
    })
}

/// Genesis overrides for Asset Hub parachains.
///
/// Disables `devStakers` which otherwise generates 27K+ test staker accounts
/// during raw spec conversion, adding ~8 min and ~70 MB to the chain spec.
/// Our governance tests don't need staking test data.
fn parachain_genesis_overrides() -> serde_json::Value {
    json!({
        "staking": {
            "devStakers": null
        }
    })
}

/// Resolve the directory containing pre-generated raw chain specs, if available.
fn get_chain_specs_dir() -> Option<PathBuf> {
    let dir = if let Ok(dir) = std::env::var(CHAIN_SPECS_DIR_ENV) {
        PathBuf::from(dir)
    } else {
        let cwd = std::env::current_dir().expect("cannot get cwd");
        cwd.join("chain-specs")
    };
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// Get the path to a pre-generated raw chain spec, if it exists.
///
/// Returns `Some(path)` when a cached `<name>-raw.json` file is found in the
/// chain specs directory. When present, zombienet loads the raw spec directly
/// and skips WASM execution + raw conversion (~3-5 min savings per chain).
///
/// **Important**: Cached relay specs must include parachain genesis data.
/// Use `generate_chain_specs` test to generate specs via zombienet, which
/// bakes parachain genesis (code + head) into the relay spec automatically.
fn cached_chain_spec(name: &str) -> Option<String> {
    let dir = get_chain_specs_dir()?;
    let path = dir.join(format!("{name}-raw.json"));
    if path.exists() {
        let abs = path.canonicalize().unwrap_or(path);
        Some(abs.to_string_lossy().to_string())
    } else {
        None
    }
}

/// Resolve the directory containing fast-runtime WASM files.
fn get_runtimes_dir() -> PathBuf {
    if let Ok(dir) = std::env::var(RUNTIMES_DIR_ENV) {
        PathBuf::from(dir)
    } else {
        // Default: ./runtimes/fast/ (relative to integration-tests crate root)
        let cwd = std::env::current_dir().expect("cannot get cwd");
        cwd.join("runtimes").join("fast")
    }
}

/// Get absolute path to a local WASM runtime file.
///
/// Zombienet's `with_chain_spec_runtime()` accepts plain paths (parsed as
/// `AssetLocation::FilePath`) which are read via `tokio::fs::read`.
fn runtime_file_path(filename: &str) -> String {
    let runtimes_dir = get_runtimes_dir();
    let wasm_path = runtimes_dir.join(filename);

    if !wasm_path.exists() {
        panic!(
            "Fast-runtime WASM not found: {}\n\
             Run ./integration-tests/scripts/build-fast-runtimes.sh to build them, or set {} to point to the directory.",
            wasm_path.display(),
            RUNTIMES_DIR_ENV
        );
    }

    // Canonicalize to get absolute path
    let abs_path = wasm_path.canonicalize().unwrap_or(wasm_path);
    abs_path.to_string_lossy().to_string()
}

pub fn polkadot_runtime_url() -> String {
    runtime_file_path(RELAY_WASM)
}

pub fn asset_hub_runtime_url() -> String {
    runtime_file_path(ASSET_HUB_WASM)
}

pub fn collectives_runtime_url() -> String {
    runtime_file_path(COLLECTIVES_WASM)
}

pub fn kusama_runtime_url() -> String {
    runtime_file_path(KUSAMA_RELAY_WASM)
}

pub fn kusama_asset_hub_runtime_url() -> String {
    runtime_file_path(KUSAMA_ASSET_HUB_WASM)
}

pub fn bridge_hub_polkadot_runtime_url() -> String {
    runtime_file_path(BRIDGE_HUB_POLKADOT_WASM)
}

pub fn bridge_hub_kusama_runtime_url() -> String {
    runtime_file_path(BRIDGE_HUB_KUSAMA_WASM)
}

// ─── Bridged-scenario genesis constants ──────────────────────────────────────
//
// Mirrors parity-bridges-common's `testing/zombienet-sdk-tests` Kusama<>Polkadot
// environment. The fellows `-local` genesis presets already open the AH<>AH
// bridge (lane `[0,0,0,1]`) on both Bridge Hubs and set `safeXcmVersion`; what
// they do NOT provide is (a) funded sovereign/reward accounts on the Bridge
// Hubs and (b) `polkadotXcm.supportedVersion` entries for the remote (bridged)
// locations — without which the bridged send fails with `SendFailure`. Both are
// baked in below at chain-spec generation time.

/// Target XCM version recorded for every remote bridged location.
const XCM_VERSION: u32 = 5;

/// Well-known dev accounts endowed on the Bridge Hubs (the SS58 prefix is
/// decorative — only the underlying 32 bytes matter). Alice signs
/// `receive_messages_proof` on Bridge Hub Kusama.
const ALICE: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB: &str = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const DEV_ENDOWMENT: u128 = 1u128 << 60;

/// Sibling Asset Hub sovereign account on each Bridge Hub (pays XCM execution
/// for the `ExportMessage`), plus the lane reward accounts. Values copied from
/// parity-bridges-common's environment constants.
const ASSET_HUB_SOVEREIGN_AT_BRIDGE_HUB_POLKADOT: &str =
    "13cKp89SgdtqUngo2WiEijPrQWdHFhzYZLf2TJePKRvExk7o";
const BHP_LANE_THIS_CHAIN: &str = "13E5fui93Uyua5RtDv2LQj4aVBBHo6YREe3n6CBwYdqNqoxj";
const BHP_LANE_BRIDGED_CHAIN: &str = "13E5fui93Uyua5RtDv2c9kcAbfrVFeeHyJzHe8sn1Ti77Afd";
const ASSET_HUB_SOVEREIGN_AT_BRIDGE_HUB_KUSAMA: &str =
    "FBeL7EFTDeHnuViqaUHUXvhhUusN5FawDmHgfvzF97DXFr3";
const BHK_LANE_THIS_CHAIN: &str = "EoQBtnwp4jMtCEpV7C88rKrz6x1qMBh2z74ibGSqtZRnuMM";
const BHK_LANE_BRIDGED_CHAIN: &str = "EoQBtnwp4jMtCEpV7CPsssT6bdDHuHZmf3aGXxHJiSA4Dz3";
const SOVEREIGN_FUNDING: u128 = 250_000_000_000_000;

/// Genesis `supportedVersion` entry for the remote bridged
/// `(parents: 2, GlobalConsensus(network) / Parachain(para_id))` — the sudo-free
/// equivalent of `force_xcm_version`.
fn supported_remote_version(remote_network: &str, para_id: u32) -> serde_json::Value {
    json!([[
        { "parents": 2, "interior": { "X2": [
            { "GlobalConsensus": remote_network },
            { "Parachain": para_id },
        ] } },
        XCM_VERSION,
    ]])
}

/// Bridge Hub genesis override: endow the dev + sovereign/reward accounts and
/// record the remote Bridge Hub's XCM version. NOTE: the balances array
/// *replaces* the preset's endowed list, so the dev accounts must be re-listed.
fn bridge_hub_genesis_overrides(
    sovereign_accounts: &[&str],
    remote_network: &str,
    remote_bridge_hub_para_id: u32,
) -> serde_json::Value {
    let mut balances: Vec<serde_json::Value> =
        vec![json!([ALICE, DEV_ENDOWMENT]), json!([BOB, DEV_ENDOWMENT])];
    for account in sovereign_accounts {
        balances.push(json!([account, SOVEREIGN_FUNDING]));
    }
    json!({
        "balances": { "balances": balances },
        "polkadotXcm": {
            "safeXcmVersion": XCM_VERSION,
            "supportedVersion":
                supported_remote_version(remote_network, remote_bridge_hub_para_id),
        },
    })
}

/// Asset Hub genesis override: disables `devStakers` (see
/// [`parachain_genesis_overrides`]) and records the remote (bridged) Asset
/// Hub's XCM version, which the bridged send needs.
fn asset_hub_bridging_genesis_overrides(remote_network: &str) -> serde_json::Value {
    json!({
        "staking": { "devStakers": null },
        "polkadotXcm": {
            "safeXcmVersion": XCM_VERSION,
            "supportedVersion": supported_remote_version(remote_network, 1000),
        },
    })
}

/// Build a NetworkConfig with Polkadot relay + Asset Hub (para 1000) only.
///
/// Lighter config for governance-only tests (no Collectives needed).
pub fn build_polkadot_with_asset_hub() -> anyhow::Result<NetworkConfig> {
    build_polkadot_with_asset_hub_raw_override(raw_storage::ah_migrator_override())
}

/// Variant of [`build_polkadot_with_asset_hub`] that takes a custom raw spec override
/// for Asset Hub. Use this to bake additional state (e.g. an Approved referendum with
/// future enactment) into AH's genesis.
pub fn build_polkadot_with_asset_hub_raw_override(
    ah_raw_override: serde_json::Value,
) -> anyhow::Result<NetworkConfig> {
    let relay_binary = get_polkadot_binary_path();
    let para_binary = get_parachain_binary_path();

    log::info!("Relay binary: {relay_binary}");
    log::info!("Parachain binary: {para_binary}");

    let cached_relay = cached_chain_spec("polkadot-local");
    let cached_ah = cached_chain_spec("asset-hub-polkadot-local");

    NetworkConfigBuilder::new()
        .with_relaychain(|relaychain| {
            let r = relaychain
                .with_chain("polkadot-local")
                .with_default_command(relay_binary.as_str());
            let r = if let Some(ref spec) = cached_relay {
                log::info!("Using cached relay chain spec: {spec}");
                r.with_chain_spec_path(spec.as_str())
            } else {
                let url = polkadot_runtime_url();
                log::info!("Generating relay chain spec from runtime: {url}");
                r.with_chain_spec_runtime(url.as_str(), None)
                    .with_genesis_overrides(relay_genesis_overrides())
            };
            r.with_validator(|node| {
                node.with_name("alice").with_args(vec![Arg::Option(
                    "--state-pruning".into(),
                    "archive".into(),
                )])
            })
            .with_validator(|node| {
                node.with_name("bob").with_args(vec![Arg::Option(
                    "--state-pruning".into(),
                    "archive".into(),
                )])
            })
            // A relay needs at least as many validators as parachain cores —
            // backing groups are one validator each, so with only two
            // validators a third parachain's core gets no group and that
            // parachain silently never produces blocks past #1.
            .with_validator(|node| {
                node.with_name("charlie").with_args(vec![Arg::Option(
                    "--state-pruning".into(),
                    "archive".into(),
                )])
            })
        })
        .with_parachain(|parachain| {
            let p = parachain
                .with_id(1000)
                .with_chain("asset-hub-polkadot-local")
                .with_default_command(para_binary.as_str());
            let p = if let Some(ref spec) = cached_ah {
                log::info!("Using cached Asset Hub chain spec: {spec}");
                p.with_chain_spec_path(spec.as_str())
            } else {
                let url = asset_hub_runtime_url();
                log::info!("Generating Asset Hub chain spec from runtime: {url}");
                p.with_chain_spec_runtime(url.as_str(), None)
                    .with_genesis_overrides(parachain_genesis_overrides())
            };
            p.with_raw_spec_override(ah_raw_override.clone())
                .cumulus_based(true)
                .with_collator(|c| {
                    c.with_name("asset-hub-collator")
                        .with_command(para_binary.as_str())
                        .with_args(vec![
                            Arg::Option("--authoring".into(), "slot-based".into()),
                            Arg::Option("--state-pruning".into(), "archive".into()),
                        ])
                })
        })
        .build()
        .map_err(|errs| {
            let message = errs
                .into_iter()
                .map(|e| e.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            anyhow!("NetworkConfig build errors: {message}")
        })
}

/// Build a NetworkConfig with Polkadot relay + Asset Hub (para 1000) + Collectives (para 1001).
///
/// Uses `with_chain_spec_runtime()` to load real production runtimes from fellows releases,
/// so the test chains have the actual governance pallets (Referenda, FellowshipReferenda, etc.).
pub fn build_polkadot_with_system_parachains() -> anyhow::Result<NetworkConfig> {
    build_polkadot_network(false)
}

/// Superset of [`build_polkadot_with_system_parachains`] that also spawns Bridge Hub
/// Polkadot (para 1002) for the bridged scenario. Chain-spec generation runs
/// with this superset so the cached relay spec registers all three parachains; the
/// non-bridged tests leave the Bridge Hub unspawned.
pub fn build_polkadot_bridged() -> anyhow::Result<NetworkConfig> {
    build_polkadot_network(true)
}

fn build_polkadot_network(with_bridge_hub: bool) -> anyhow::Result<NetworkConfig> {
    let relay_binary = get_polkadot_binary_path();
    let para_binary = get_parachain_binary_path();

    log::info!("Relay binary: {relay_binary}");
    log::info!("Parachain binary: {para_binary}");

    let cached_relay = cached_chain_spec("polkadot-local");
    let cached_ah = cached_chain_spec("asset-hub-polkadot-local");
    let cached_coll = cached_chain_spec("collectives-polkadot-local");
    let cached_bhp = cached_chain_spec("bridge-hub-polkadot-local");

    let builder = NetworkConfigBuilder::new()
        .with_relaychain(|relaychain| {
            let r = relaychain
                .with_chain("polkadot-local")
                .with_default_command(relay_binary.as_str());
            let r = if let Some(ref spec) = cached_relay {
                log::info!("Using cached relay chain spec: {spec}");
                r.with_chain_spec_path(spec.as_str())
            } else {
                let url = polkadot_runtime_url();
                log::info!("Generating relay chain spec from runtime: {url}");
                r.with_chain_spec_runtime(url.as_str(), None)
                    .with_genesis_overrides(relay_genesis_overrides())
            };
            r.with_validator(|node| {
                node.with_name("alice").with_args(vec![Arg::Option(
                    "--state-pruning".into(),
                    "archive".into(),
                )])
            })
            .with_validator(|node| {
                node.with_name("bob").with_args(vec![Arg::Option(
                    "--state-pruning".into(),
                    "archive".into(),
                )])
            })
            // A relay needs at least as many validators as parachain cores —
            // backing groups are one validator each, so with only two
            // validators a third parachain's core gets no group and that
            // parachain silently never produces blocks past #1.
            .with_validator(|node| {
                node.with_name("charlie").with_args(vec![Arg::Option(
                    "--state-pruning".into(),
                    "archive".into(),
                )])
            })
        })
        .with_parachain(|parachain| {
            let p = parachain
                .with_id(1000)
                .with_chain("asset-hub-polkadot-local")
                .with_default_command(para_binary.as_str());
            let p = if let Some(ref spec) = cached_ah {
                log::info!("Using cached Asset Hub chain spec: {spec}");
                p.with_chain_spec_path(spec.as_str())
            } else {
                let url = asset_hub_runtime_url();
                log::info!("Generating Asset Hub chain spec from runtime: {url}");
                p.with_chain_spec_runtime(url.as_str(), None)
                    .with_genesis_overrides(asset_hub_bridging_genesis_overrides("Kusama"))
            };
            p.with_raw_spec_override(raw_storage::ah_migrator_override())
                .cumulus_based(true)
                .with_collator(|c| {
                    c.with_name("asset-hub-collator")
                        .with_command(para_binary.as_str())
                        .with_args(vec![
                            Arg::Option("--authoring".into(), "slot-based".into()),
                            Arg::Option("--state-pruning".into(), "archive".into()),
                        ])
                })
        })
        .with_parachain(|parachain| {
            let p = parachain
                .with_id(1001)
                .with_chain("collectives-polkadot-local")
                .with_default_command(para_binary.as_str());
            let p = if let Some(ref spec) = cached_coll {
                log::info!("Using cached Collectives chain spec: {spec}");
                p.with_chain_spec_path(spec.as_str())
            } else {
                let url = collectives_runtime_url();
                log::info!("Generating Collectives chain spec from runtime: {url}");
                p.with_chain_spec_runtime(url.as_str(), None)
            };
            p.with_raw_spec_override(raw_storage::fellowship_collective_override())
                .cumulus_based(true)
                .with_collator(|c| {
                    c.with_name("collectives-collator")
                        .with_command(para_binary.as_str())
                        .with_args(vec![
                            Arg::Option("--authoring".into(), "slot-based".into()),
                            Arg::Option("--state-pruning".into(), "archive".into()),
                        ])
                })
        });

    let builder = if with_bridge_hub {
        builder.with_parachain(|parachain| {
            let p = parachain
                .with_id(1002)
                .with_chain("bridge-hub-polkadot-local")
                .with_default_command(para_binary.as_str());
            let p = if let Some(ref spec) = cached_bhp {
                log::info!("Using cached Bridge Hub Polkadot chain spec: {spec}");
                p.with_chain_spec_path(spec.as_str())
            } else {
                let url = bridge_hub_polkadot_runtime_url();
                log::info!("Generating Bridge Hub Polkadot chain spec from runtime: {url}");
                p.with_chain_spec_runtime(url.as_str(), None)
                    .with_genesis_overrides(bridge_hub_genesis_overrides(
                        &[
                            ASSET_HUB_SOVEREIGN_AT_BRIDGE_HUB_POLKADOT,
                            BHP_LANE_THIS_CHAIN,
                            BHP_LANE_BRIDGED_CHAIN,
                        ],
                        "Kusama",
                        1002,
                    ))
            };
            p.cumulus_based(true).with_collator(|c| {
                c.with_name("bridge-hub-polkadot-collator")
                    .with_command(para_binary.as_str())
                    .with_args(vec![
                        Arg::Option("--authoring".into(), "slot-based".into()),
                        Arg::Option("--state-pruning".into(), "archive".into()),
                    ])
            })
        })
    } else {
        builder
    };

    builder.build().map_err(|errs| {
        let message = errs
            .into_iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        anyhow!("NetworkConfig build errors: {message}")
    })
}

/// Build a NetworkConfig with Kusama relay + Asset Hub (para 1000).
///
/// On Kusama, the Fellowship pallets (FellowshipReferenda, FellowshipCollective)
/// live on the relay chain itself, so no Collectives parachain is needed.
pub fn build_kusama_with_asset_hub() -> anyhow::Result<NetworkConfig> {
    build_kusama_network(false)
}

/// Superset of [`build_kusama_with_asset_hub`] that also spawns Bridge Hub Kusama
/// (para 1002) for the bridged scenario.
pub fn build_kusama_bridged() -> anyhow::Result<NetworkConfig> {
    build_kusama_network(true)
}

fn build_kusama_network(with_bridge_hub: bool) -> anyhow::Result<NetworkConfig> {
    let relay_binary = get_polkadot_binary_path();
    let para_binary = get_parachain_binary_path();

    log::info!("Relay binary: {relay_binary}");
    log::info!("Parachain binary: {para_binary}");

    let cached_relay = cached_chain_spec("kusama-local");
    let cached_ah = cached_chain_spec("asset-hub-kusama-local");
    let cached_bhk = cached_chain_spec("bridge-hub-kusama-local");

    let builder = NetworkConfigBuilder::new()
        .with_relaychain(|relaychain| {
            let r = relaychain
                .with_chain("kusama-local")
                .with_default_command(relay_binary.as_str());
            let r = if let Some(ref spec) = cached_relay {
                log::info!("Using cached Kusama relay chain spec: {spec}");
                r.with_chain_spec_path(spec.as_str())
            } else {
                let url = kusama_runtime_url();
                log::info!("Generating Kusama relay chain spec from runtime: {url}");
                r.with_chain_spec_runtime(url.as_str(), None)
                    .with_genesis_overrides(relay_genesis_overrides())
            };
            r.with_raw_spec_override(raw_storage::fellowship_collective_override())
                .with_validator(|node| {
                    node.with_name("alice").with_args(vec![Arg::Option(
                        "--state-pruning".into(),
                        "archive".into(),
                    )])
                })
                .with_validator(|node| {
                    node.with_name("bob").with_args(vec![Arg::Option(
                        "--state-pruning".into(),
                        "archive".into(),
                    )])
                })
                // See the Polkadot relay: one validator per parachain core, or
                // the extra core never gets a backing group.
                .with_validator(|node| {
                    node.with_name("charlie").with_args(vec![Arg::Option(
                        "--state-pruning".into(),
                        "archive".into(),
                    )])
                })
        })
        .with_parachain(|parachain| {
            let p = parachain
                .with_id(1000)
                .with_chain("asset-hub-kusama-local")
                .with_default_command(para_binary.as_str());
            let p = if let Some(ref spec) = cached_ah {
                log::info!("Using cached Kusama Asset Hub chain spec: {spec}");
                p.with_chain_spec_path(spec.as_str())
            } else {
                let url = kusama_asset_hub_runtime_url();
                log::info!("Generating Kusama Asset Hub chain spec from runtime: {url}");
                p.with_chain_spec_runtime(url.as_str(), None)
                    .with_genesis_overrides(asset_hub_bridging_genesis_overrides("Polkadot"))
            };
            p.with_raw_spec_override(raw_storage::ah_migrator_override())
                .cumulus_based(true)
                .with_collator(|c| {
                    c.with_name("asset-hub-collator")
                        .with_command(para_binary.as_str())
                        .with_args(vec![
                            Arg::Option("--authoring".into(), "slot-based".into()),
                            Arg::Option("--state-pruning".into(), "archive".into()),
                        ])
                })
        });

    let builder = if with_bridge_hub {
        builder.with_parachain(|parachain| {
            let p = parachain
                .with_id(1002)
                .with_chain("bridge-hub-kusama-local")
                .with_default_command(para_binary.as_str());
            let p = if let Some(ref spec) = cached_bhk {
                log::info!("Using cached Bridge Hub Kusama chain spec: {spec}");
                p.with_chain_spec_path(spec.as_str())
            } else {
                let url = bridge_hub_kusama_runtime_url();
                log::info!("Generating Bridge Hub Kusama chain spec from runtime: {url}");
                p.with_chain_spec_runtime(url.as_str(), None)
                    .with_genesis_overrides(bridge_hub_genesis_overrides(
                        &[
                            ASSET_HUB_SOVEREIGN_AT_BRIDGE_HUB_KUSAMA,
                            BHK_LANE_THIS_CHAIN,
                            BHK_LANE_BRIDGED_CHAIN,
                        ],
                        "Polkadot",
                        1002,
                    ))
            };
            p.cumulus_based(true).with_collator(|c| {
                c.with_name("bridge-hub-kusama-collator")
                    .with_command(para_binary.as_str())
                    .with_args(vec![
                        Arg::Option("--authoring".into(), "slot-based".into()),
                        Arg::Option("--state-pruning".into(), "archive".into()),
                    ])
            })
        })
    } else {
        builder
    };

    builder.build().map_err(|errs| {
        let message = errs
            .into_iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        anyhow!("NetworkConfig build errors: {message}")
    })
}
