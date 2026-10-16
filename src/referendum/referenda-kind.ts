import type { ReferendaPallet, SubstrateApi } from '../types/substrate-api';

const FELLOWSHIP_PASSING_BARE_AYES = 100;
const FELLOWSHIP_PASSING_AYES = 1000;

export interface ReferendaKind {
  palletName: 'Referenda' | 'FellowshipReferenda';
  label: 'Governance' | 'Fellowship';
  pallet(api: SubstrateApi): ReferendaPallet;
  passingTally(totalIssuance: bigint): Record<string, bigint | number>;
}

export const GOVERNANCE: ReferendaKind = {
  palletName: 'Referenda',
  label: 'Governance',
  pallet: (api) => api.query.Referenda,
  passingTally: (totalIssuance) => ({
    ayes: totalIssuance - 1n,
    nays: 0n,
    support: totalIssuance - 1n,
  }),
};

export const FELLOWSHIP: ReferendaKind = {
  palletName: 'FellowshipReferenda',
  label: 'Fellowship',
  pallet: (api) => api.query.FellowshipReferenda,
  passingTally: () => ({
    bare_ayes: FELLOWSHIP_PASSING_BARE_AYES,
    ayes: FELLOWSHIP_PASSING_AYES,
    nays: 0,
  }),
};
