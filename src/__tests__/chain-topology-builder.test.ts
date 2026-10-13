import { describe, expect, it } from 'vitest';
import type { ChainKind } from '../network/chain-identity';
import { type DetectedChain, singleConsensusTopology } from '../network/chain-topology-builder';
import { createTestLogger } from './helpers';

function detectedChain(url: string, label: string, kind: ChainKind = 'parachain'): DetectedChain {
  return {
    endpoint: { url },
    info: { label, specName: label, endpoint: url, network: 'kusama', kind },
  };
}

const KUSAMA_RELAY = detectedChain('wss://kusama-rpc.example', 'kusama', 'relay');
const KUSAMA_RELAY_OTHER_HOST = detectedChain('wss://kusama.other.example', 'kusama', 'relay');
const ASSET_HUB = detectedChain('wss://asset-hub-kusama.example', 'asset-hub-kusama');
const PEOPLE = detectedChain('wss://people-kusama.example', 'people-kusama');
const POLKADOT_RELAY = detectedChain('wss://polkadot-rpc.example', 'polkadot', 'relay');

describe('singleConsensusTopology', () => {
  it('one fork with funded, ranked Alice for both referenda on one chain', () => {
    const topology = singleConsensusTopology(
      { governance: KUSAMA_RELAY, fellowship: KUSAMA_RELAY_OTHER_HOST, additional: [] },
      { governance: 'alice-account', fellowship: 'fellowship' },
      createTestLogger()
    );

    expect(
      topology.specs.map((spec) => spec.key),
      'two forks of one chain would diverge: the governance referendum would not see the fellowship result'
    ).toEqual(['governance']);
    expect(topology.fellowshipKey).toBe(topology.governanceKey);
    const importStorage = topology.specs[0].config['import-storage'];
    expect(importStorage, 'Alice pays the deposits of both referenda').toHaveProperty(
      'System.Account'
    );
    expect(importStorage, 'Alice submits the fellowship referendum').toHaveProperty(
      'FellowshipCollective.Members'
    );
  });

  it('one fork per chain with its own injection for referenda on two chains', () => {
    const topology = singleConsensusTopology(
      { governance: ASSET_HUB, fellowship: KUSAMA_RELAY, additional: [] },
      { governance: 'alice-account' },
      createTestLogger()
    );

    expect(topology.specs.map((spec) => [spec.key, spec.kind])).toEqual([
      ['governance', 'parachain'],
      ['fellowship', 'relay'],
    ]);
    expect(topology.specs[0].config['import-storage']).toHaveProperty('System.Account');
    expect(topology.specs[1].config).not.toHaveProperty('import-storage');
  });

  it('additional chains without duplicates of the primary chains or a second relay', () => {
    const logger = createTestLogger();
    const topology = singleConsensusTopology(
      {
        governance: ASSET_HUB,
        additional: [KUSAMA_RELAY, PEOPLE, ASSET_HUB, KUSAMA_RELAY_OTHER_HOST, POLKADOT_RELAY],
      },
      {},
      logger
    );

    expect(
      topology.additional.map(({ chain }) => chain.info.label),
      'a second fork of a chain would receive XCM that the first fork never sees'
    ).toEqual(['kusama', 'people-kusama']);
    expect(
      topology.specs.filter((spec) => spec.kind === 'relay'),
      'every parachain fork connects to the one relay fork'
    ).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('polkadot'));
  });
});
