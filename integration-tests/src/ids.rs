#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Network {
    Polkadot,
    Kusama,
}

impl Network {
    pub fn name(self) -> &'static str {
        match self {
            Network::Polkadot => "Polkadot",
            Network::Kusama => "Kusama",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParaId(pub u32);

pub const ASSET_HUB_PARA_ID: ParaId = ParaId(1000);
pub const COLLECTIVES_PARA_ID: ParaId = ParaId(1001);
pub const BRIDGE_HUB_PARA_ID: ParaId = ParaId(1002);
