use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;
use std::time::Duration;
use zombienet_configuration::shared::types::Arg;
use zombienet_sdk::{
    LocalFileSystem, Network, NetworkConfig, NetworkConfigBuilder, NetworkConfigExt,
};

use crate::binaries::{parachain_binary, polkadot_binary, verify_binaries};
use crate::chains::{ChainDef, NetworkDef};

const CHAIN_SPECS_DIR_ENV: &str = "CHAIN_SPECS_DIR";
const RUNTIMES_DIR_ENV: &str = "FAST_RUNTIMES_DIR";
const SPAWN_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(600);
const SPAWN_ATTEMPTS: u32 = 3;

enum ChainSpec {
    Cached(String),
    Runtime(String),
}

fn directory(env: &str, default: &str) -> PathBuf {
    std::env::var(env)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(default))
}

pub fn chain_specs_dir() -> PathBuf {
    directory(CHAIN_SPECS_DIR_ENV, "chain-specs")
}

pub fn cached_spec_path(chain: &ChainDef) -> PathBuf {
    chain_specs_dir().join(format!("{}-raw.json", chain.chain_name))
}

pub fn runtime_path(chain: &ChainDef) -> Result<String> {
    let path = directory(RUNTIMES_DIR_ENV, "runtimes/fast").join(chain.runtime_wasm);
    let absolute = path.canonicalize().with_context(|| {
        format!(
            "fast-runtime WASM {} not found; run scripts/build-fast-runtimes.sh or set {RUNTIMES_DIR_ENV}",
            path.display()
        )
    })?;
    Ok(absolute.to_string_lossy().to_string())
}

fn chain_specs(network: &NetworkDef) -> Result<Vec<ChainSpec>> {
    let cached: Vec<Option<PathBuf>> = network
        .chains()
        .map(|chain| cached_spec_path(chain).canonicalize().ok())
        .collect();
    if cached.iter().all(Option::is_some) {
        return Ok(cached
            .into_iter()
            .flatten()
            .map(|path| ChainSpec::Cached(path.to_string_lossy().to_string()))
            .collect());
    }
    if cached.iter().any(Option::is_some) {
        log::warn!(
            "generating all chain specs of the network: a cached relay spec registers the genesis heads of the cached parachain specs, so a partial cache cannot work"
        );
    }
    network
        .chains()
        .map(|chain| runtime_path(chain).map(ChainSpec::Runtime))
        .collect()
}

fn archive_args() -> Vec<Arg> {
    vec![Arg::Option("--state-pruning".into(), "archive".into())]
}

fn collator_args() -> Vec<Arg> {
    vec![
        Arg::Option("--authoring".into(), "slot-based".into()),
        Arg::Option("--state-pruning".into(), "archive".into()),
    ]
}

pub fn network_config(network: &NetworkDef) -> Result<NetworkConfig> {
    let polkadot = polkadot_binary();
    let parachain = parachain_binary();
    let specs = chain_specs(network)?;
    let relay = network.relay;
    let [first_validator, second_validator, third_validator] = relay.validators;

    let mut builder = NetworkConfigBuilder::new().with_relaychain(|relaychain| {
        let builder = relaychain
            .with_chain(relay.chain.chain_name)
            .with_default_command(polkadot.as_str());
        let builder = match (&specs[0], relay.chain.genesis_override) {
            (ChainSpec::Cached(path), _) => builder.with_chain_spec_path(path.as_str()),
            (ChainSpec::Runtime(path), genesis) => {
                let builder = builder.with_chain_spec_runtime(path.as_str(), None);
                match genesis {
                    Some(genesis) => builder.with_genesis_overrides(genesis()),
                    None => builder,
                }
            }
        };
        let builder = match relay.chain.raw_override {
            Some(raw_override) => builder.with_raw_spec_override(raw_override()),
            None => builder,
        };
        builder
            .with_validator(|node| node.with_name(first_validator).with_args(archive_args()))
            .with_validator(|node| node.with_name(second_validator).with_args(archive_args()))
            .with_validator(|node| node.with_name(third_validator).with_args(archive_args()))
    });

    for (parachain_def, spec) in network.parachains.iter().zip(&specs[1..]) {
        builder = builder.with_parachain(|builder| {
            let builder = builder
                .with_id(parachain_def.id.0)
                .with_chain(parachain_def.chain.chain_name)
                .with_default_command(parachain.as_str());
            let builder = match (spec, parachain_def.chain.genesis_override) {
                (ChainSpec::Cached(path), _) => builder.with_chain_spec_path(path.as_str()),
                (ChainSpec::Runtime(path), genesis) => {
                    let builder = builder.with_chain_spec_runtime(path.as_str(), None);
                    match genesis {
                        Some(genesis) => builder.with_genesis_overrides(genesis()),
                        None => builder,
                    }
                }
            };
            let builder = match parachain_def.chain.raw_override {
                Some(raw_override) => builder.with_raw_spec_override(raw_override()),
                None => builder,
            };
            builder.cumulus_based(true).with_collator(|collator| {
                collator
                    .with_name(parachain_def.collator)
                    .with_command(parachain.as_str())
                    .with_args(collator_args())
            })
        });
    }

    builder.build().map_err(|errors| {
        let messages: Vec<String> = errors.iter().map(ToString::to_string).collect();
        anyhow!("invalid network config: {}", messages.join(", "))
    })
}

pub async fn spawn_network(network: &NetworkDef) -> Result<Network<LocalFileSystem>> {
    env_logger::try_init().ok();
    verify_binaries()?;
    let label = network.relay.chain.chain_name;
    for attempt in 1..=SPAWN_ATTEMPTS {
        log::info!("spawning {label} network (attempt {attempt}/{SPAWN_ATTEMPTS})");
        let spawn = network_config(network)?.spawn_native();
        match tokio::time::timeout(SPAWN_ATTEMPT_TIMEOUT, spawn).await {
            Ok(Ok(network)) => return Ok(network),
            Ok(Err(error)) => log::warn!("{label} spawn attempt {attempt} failed: {error:#}"),
            Err(_) => log::warn!(
                "{label} spawn attempt {attempt} timed out after {SPAWN_ATTEMPT_TIMEOUT:?}"
            ),
        }
    }
    anyhow::bail!("{label} network failed to spawn after {SPAWN_ATTEMPTS} attempts")
}
