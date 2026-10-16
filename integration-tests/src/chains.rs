use serde_json::Value;

use crate::genesis;
use crate::ids::{ParaId, ASSET_HUB_PARA_ID, BRIDGE_HUB_PARA_ID, COLLECTIVES_PARA_ID};

pub struct ChainDef {
    pub chain_name: &'static str,
    pub runtime_wasm: &'static str,
    pub genesis_override: Option<fn() -> Value>,
    pub raw_override: Option<fn() -> Value>,
}

pub struct RelayDef {
    pub chain: ChainDef,
    pub validators: [&'static str; 3],
}

impl RelayDef {
    pub fn first_validator(&self) -> &'static str {
        self.validators[0]
    }
}

pub struct ParachainDef {
    pub chain: ChainDef,
    pub id: ParaId,
    pub collator: &'static str,
}

pub struct NetworkDef {
    pub relay: &'static RelayDef,
    pub parachains: &'static [&'static ParachainDef],
}

impl NetworkDef {
    pub fn chains(&self) -> impl Iterator<Item = &'static ChainDef> {
        std::iter::once(&self.relay.chain)
            .chain(self.parachains.iter().map(|parachain| &parachain.chain))
    }
}

// A relay needs at least as many validators as parachain cores: backing groups are one
// validator each, so with two validators a third parachain's core gets no group and that
// parachain never produces blocks past #1.
pub static POLKADOT_RELAY: RelayDef = RelayDef {
    chain: ChainDef {
        chain_name: "polkadot-local",
        runtime_wasm: "polkadot_runtime.compact.compressed.wasm",
        genesis_override: Some(genesis::relay_genesis),
        raw_override: None,
    },
    validators: ["alice", "bob", "charlie"],
};

pub static POLKADOT_ASSET_HUB: ParachainDef = ParachainDef {
    chain: ChainDef {
        chain_name: "asset-hub-polkadot-local",
        runtime_wasm: "asset_hub_polkadot_runtime.compact.compressed.wasm",
        genesis_override: Some(genesis::asset_hub_polkadot_genesis),
        raw_override: None,
    },
    id: ASSET_HUB_PARA_ID,
    collator: "asset-hub-collator",
};

pub static POLKADOT_COLLECTIVES: ParachainDef = ParachainDef {
    chain: ChainDef {
        chain_name: "collectives-polkadot-local",
        runtime_wasm: "collectives_polkadot_runtime.compact.compressed.wasm",
        genesis_override: None,
        raw_override: Some(genesis::fellowship_collective_storage),
    },
    id: COLLECTIVES_PARA_ID,
    collator: "collectives-collator",
};

pub static POLKADOT_BRIDGE_HUB: ParachainDef = ParachainDef {
    chain: ChainDef {
        chain_name: "bridge-hub-polkadot-local",
        runtime_wasm: "bridge_hub_polkadot_runtime.compact.compressed.wasm",
        genesis_override: Some(genesis::bridge_hub_polkadot_genesis),
        raw_override: None,
    },
    id: BRIDGE_HUB_PARA_ID,
    collator: "bridge-hub-polkadot-collator",
};

// Node names must differ across networks: zombienet derives each node's libp2p key from its
// name, so a Kusama "alice" next to a Polkadot "alice" gets the same peer id and the two
// networks break each other's peer discovery.
pub static KUSAMA_RELAY: RelayDef = RelayDef {
    chain: ChainDef {
        chain_name: "kusama-local",
        runtime_wasm: "staging_kusama_runtime.compact.compressed.wasm",
        genesis_override: Some(genesis::relay_genesis),
        raw_override: Some(genesis::fellowship_collective_storage),
    },
    validators: ["alice-kusama", "bob-kusama", "charlie-kusama"],
};

pub static KUSAMA_ASSET_HUB: ParachainDef = ParachainDef {
    chain: ChainDef {
        chain_name: "asset-hub-kusama-local",
        runtime_wasm: "asset_hub_kusama_runtime.compact.compressed.wasm",
        genesis_override: Some(genesis::asset_hub_kusama_genesis),
        raw_override: None,
    },
    id: ASSET_HUB_PARA_ID,
    collator: "asset-hub-kusama-collator",
};

pub static KUSAMA_BRIDGE_HUB: ParachainDef = ParachainDef {
    chain: ChainDef {
        chain_name: "bridge-hub-kusama-local",
        runtime_wasm: "bridge_hub_kusama_runtime.compact.compressed.wasm",
        genesis_override: Some(genesis::bridge_hub_kusama_genesis),
        raw_override: None,
    },
    id: BRIDGE_HUB_PARA_ID,
    collator: "bridge-hub-kusama-collator",
};

pub static POLKADOT_GOVERNANCE_NETWORK: NetworkDef = NetworkDef {
    relay: &POLKADOT_RELAY,
    parachains: &[&POLKADOT_ASSET_HUB],
};

pub static POLKADOT_FELLOWSHIP_NETWORK: NetworkDef = NetworkDef {
    relay: &POLKADOT_RELAY,
    parachains: &[&POLKADOT_ASSET_HUB, &POLKADOT_COLLECTIVES],
};

pub static POLKADOT_BRIDGE_NETWORK: NetworkDef = NetworkDef {
    relay: &POLKADOT_RELAY,
    parachains: &[
        &POLKADOT_ASSET_HUB,
        &POLKADOT_COLLECTIVES,
        &POLKADOT_BRIDGE_HUB,
    ],
};

pub static KUSAMA_NETWORK: NetworkDef = NetworkDef {
    relay: &KUSAMA_RELAY,
    parachains: &[&KUSAMA_ASSET_HUB],
};

pub static KUSAMA_BRIDGE_NETWORK: NetworkDef = NetworkDef {
    relay: &KUSAMA_RELAY,
    parachains: &[&KUSAMA_ASSET_HUB, &KUSAMA_BRIDGE_HUB],
};

pub static SPEC_GENERATION_NETWORKS: [&NetworkDef; 2] =
    [&POLKADOT_BRIDGE_NETWORK, &KUSAMA_BRIDGE_NETWORK];
