//! Track definitions for all governance and fellowship referendum tracks.
//!
//! Shared by Polkadot and Kusama networks. The origin variant names must exactly
//! match the runtime's `OriginCaller` enum variants.

/// A governance referendum track on Asset Hub.
pub struct GovernanceTrack {
    pub id: u16,
    pub name: &'static str,
    /// The inner variant name for the proposal origin.
    /// For Root: "Root" (with outer variant "system").
    /// For all others: the variant name under "Origins".
    pub origin_variant: &'static str,
    /// Whether this track uses `system::Root` as the proposal origin.
    pub is_root: bool,
}

/// A fellowship referendum track.
pub struct FellowshipTrack {
    pub id: u16,
    pub name: &'static str,
    /// The inner variant name for the proposal origin (e.g. "Fellows", "Members").
    pub origin_variant: &'static str,
    /// Minimum rank associated with this track's origin.
    pub min_rank: u8,
}

// ---------------------------------------------------------------------------
// Governance tracks — shared by Polkadot AH and Kusama AH (same IDs, same names)
// ---------------------------------------------------------------------------

pub const GOVERNANCE_TRACKS: &[GovernanceTrack] = &[
    GovernanceTrack { id: 0,  name: "Root",                origin_variant: "Root",                is_root: true  },
    GovernanceTrack { id: 1,  name: "WhitelistedCaller",   origin_variant: "WhitelistedCaller",   is_root: false },
    GovernanceTrack { id: 2,  name: "WishForChange",       origin_variant: "WishForChange",       is_root: false },
    GovernanceTrack { id: 10, name: "StakingAdmin",        origin_variant: "StakingAdmin",        is_root: false },
    GovernanceTrack { id: 11, name: "Treasurer",           origin_variant: "Treasurer",           is_root: false },
    GovernanceTrack { id: 12, name: "LeaseAdmin",          origin_variant: "LeaseAdmin",          is_root: false },
    GovernanceTrack { id: 13, name: "FellowshipAdmin",     origin_variant: "FellowshipAdmin",     is_root: false },
    GovernanceTrack { id: 14, name: "GeneralAdmin",        origin_variant: "GeneralAdmin",        is_root: false },
    GovernanceTrack { id: 15, name: "AuctionAdmin",        origin_variant: "AuctionAdmin",        is_root: false },
    GovernanceTrack { id: 20, name: "ReferendumCanceller", origin_variant: "ReferendumCanceller", is_root: false },
    GovernanceTrack { id: 21, name: "ReferendumKiller",    origin_variant: "ReferendumKiller",    is_root: false },
    GovernanceTrack { id: 30, name: "SmallTipper",         origin_variant: "SmallTipper",         is_root: false },
    GovernanceTrack { id: 31, name: "BigTipper",           origin_variant: "BigTipper",           is_root: false },
    GovernanceTrack { id: 32, name: "SmallSpender",        origin_variant: "SmallSpender",        is_root: false },
    GovernanceTrack { id: 33, name: "MediumSpender",       origin_variant: "MediumSpender",       is_root: false },
    GovernanceTrack { id: 34, name: "BigSpender",          origin_variant: "BigSpender",          is_root: false },
];

// ---------------------------------------------------------------------------
// Polkadot Collectives fellowship tracks (24 tracks)
// Origin caller outer variant: "FellowshipOrigins"
// ---------------------------------------------------------------------------

pub const POLKADOT_FELLOWSHIP_TRACKS: &[FellowshipTrack] = &[
    FellowshipTrack { id: 1,  name: "Members",            origin_variant: "Members",            min_rank: 1 },
    FellowshipTrack { id: 2,  name: "Fellowship2Dan",     origin_variant: "Fellowship2Dan",     min_rank: 2 },
    FellowshipTrack { id: 3,  name: "Fellows",            origin_variant: "Fellows",            min_rank: 3 },
    FellowshipTrack { id: 4,  name: "Architects",         origin_variant: "Architects",         min_rank: 4 },
    FellowshipTrack { id: 5,  name: "Fellowship5Dan",     origin_variant: "Fellowship5Dan",     min_rank: 5 },
    FellowshipTrack { id: 6,  name: "Fellowship6Dan",     origin_variant: "Fellowship6Dan",     min_rank: 6 },
    FellowshipTrack { id: 7,  name: "Masters",            origin_variant: "Masters",            min_rank: 7 },
    FellowshipTrack { id: 8,  name: "Fellowship8Dan",     origin_variant: "Fellowship8Dan",     min_rank: 8 },
    FellowshipTrack { id: 9,  name: "Fellowship9Dan",     origin_variant: "Fellowship9Dan",     min_rank: 9 },
    FellowshipTrack { id: 11, name: "RetainAt1Dan",       origin_variant: "RetainAt1Dan",       min_rank: 1 },
    FellowshipTrack { id: 12, name: "RetainAt2Dan",       origin_variant: "RetainAt2Dan",       min_rank: 2 },
    FellowshipTrack { id: 13, name: "RetainAt3Dan",       origin_variant: "RetainAt3Dan",       min_rank: 3 },
    FellowshipTrack { id: 14, name: "RetainAt4Dan",       origin_variant: "RetainAt4Dan",       min_rank: 4 },
    FellowshipTrack { id: 15, name: "RetainAt5Dan",       origin_variant: "RetainAt5Dan",       min_rank: 5 },
    FellowshipTrack { id: 16, name: "RetainAt6Dan",       origin_variant: "RetainAt6Dan",       min_rank: 6 },
    FellowshipTrack { id: 21, name: "PromoteTo1Dan",      origin_variant: "PromoteTo1Dan",      min_rank: 1 },
    FellowshipTrack { id: 22, name: "PromoteTo2Dan",      origin_variant: "PromoteTo2Dan",      min_rank: 2 },
    FellowshipTrack { id: 23, name: "PromoteTo3Dan",      origin_variant: "PromoteTo3Dan",      min_rank: 3 },
    FellowshipTrack { id: 24, name: "PromoteTo4Dan",      origin_variant: "PromoteTo4Dan",      min_rank: 4 },
    FellowshipTrack { id: 25, name: "PromoteTo5Dan",      origin_variant: "PromoteTo5Dan",      min_rank: 5 },
    FellowshipTrack { id: 26, name: "PromoteTo6Dan",      origin_variant: "PromoteTo6Dan",      min_rank: 6 },
    FellowshipTrack { id: 31, name: "FastPromoteTo1Dan",  origin_variant: "FastPromoteTo1Dan",  min_rank: 1 },
    FellowshipTrack { id: 32, name: "FastPromoteTo2Dan",  origin_variant: "FastPromoteTo2Dan",  min_rank: 2 },
    FellowshipTrack { id: 33, name: "FastPromoteTo3Dan",  origin_variant: "FastPromoteTo3Dan",  min_rank: 3 },
];

// ---------------------------------------------------------------------------
// Kusama relay fellowship tracks (10 tracks)
// Origin caller outer variant: "Origins"
// ---------------------------------------------------------------------------

pub const KUSAMA_FELLOWSHIP_TRACKS: &[FellowshipTrack] = &[
    FellowshipTrack { id: 0, name: "FellowshipInitiates", origin_variant: "FellowshipInitiates", min_rank: 0 },
    FellowshipTrack { id: 1, name: "Fellowship1Dan",      origin_variant: "Fellowship1Dan",      min_rank: 1 },
    FellowshipTrack { id: 2, name: "Fellowship2Dan",      origin_variant: "Fellowship2Dan",      min_rank: 2 },
    FellowshipTrack { id: 3, name: "Fellows",             origin_variant: "Fellows",             min_rank: 3 },
    FellowshipTrack { id: 4, name: "Fellowship4Dan",      origin_variant: "Fellowship4Dan",      min_rank: 4 },
    FellowshipTrack { id: 5, name: "FellowshipExperts",   origin_variant: "FellowshipExperts",   min_rank: 5 },
    FellowshipTrack { id: 6, name: "Fellowship6Dan",      origin_variant: "Fellowship6Dan",      min_rank: 6 },
    FellowshipTrack { id: 7, name: "FellowshipMasters",   origin_variant: "FellowshipMasters",   min_rank: 7 },
    FellowshipTrack { id: 8, name: "Fellowship8Dan",      origin_variant: "Fellowship8Dan",      min_rank: 8 },
    FellowshipTrack { id: 9, name: "Fellowship9Dan",      origin_variant: "Fellowship9Dan",      min_rank: 9 },
];
