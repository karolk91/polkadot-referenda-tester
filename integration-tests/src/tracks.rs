#[derive(Clone, Copy, Debug)]
pub struct Track {
    pub id: u16,
    pub name: &'static str,
}

const fn track(id: u16, name: &'static str) -> Track {
    Track { id, name }
}

pub const GOVERNANCE_TRACKS: &[Track] = &[
    track(0, "Root"),
    track(1, "WhitelistedCaller"),
    track(2, "WishForChange"),
    track(10, "StakingAdmin"),
    track(11, "Treasurer"),
    track(12, "LeaseAdmin"),
    track(13, "FellowshipAdmin"),
    track(14, "GeneralAdmin"),
    track(15, "AuctionAdmin"),
    track(20, "ReferendumCanceller"),
    track(21, "ReferendumKiller"),
    track(30, "SmallTipper"),
    track(31, "BigTipper"),
    track(32, "SmallSpender"),
    track(33, "MediumSpender"),
    track(34, "BigSpender"),
];

pub const POLKADOT_FELLOWSHIP_TRACKS: &[Track] = &[
    track(1, "Members"),
    track(2, "Fellowship2Dan"),
    track(3, "Fellows"),
    track(4, "Architects"),
    track(5, "Fellowship5Dan"),
    track(6, "Fellowship6Dan"),
    track(7, "Masters"),
    track(8, "Fellowship8Dan"),
    track(9, "Fellowship9Dan"),
    track(11, "RetainAt1Dan"),
    track(12, "RetainAt2Dan"),
    track(13, "RetainAt3Dan"),
    track(14, "RetainAt4Dan"),
    track(15, "RetainAt5Dan"),
    track(16, "RetainAt6Dan"),
    track(21, "PromoteTo1Dan"),
    track(22, "PromoteTo2Dan"),
    track(23, "PromoteTo3Dan"),
    track(24, "PromoteTo4Dan"),
    track(25, "PromoteTo5Dan"),
    track(26, "PromoteTo6Dan"),
    track(31, "FastPromoteTo1Dan"),
    track(32, "FastPromoteTo2Dan"),
    track(33, "FastPromoteTo3Dan"),
];

pub const KUSAMA_FELLOWSHIP_TRACKS: &[Track] = &[
    track(0, "FellowshipInitiates"),
    track(1, "Fellowship1Dan"),
    track(2, "Fellowship2Dan"),
    track(3, "Fellows"),
    track(4, "Fellowship4Dan"),
    track(5, "FellowshipExperts"),
    track(6, "Fellowship6Dan"),
    track(7, "FellowshipMasters"),
    track(8, "Fellowship8Dan"),
    track(9, "Fellowship9Dan"),
];
