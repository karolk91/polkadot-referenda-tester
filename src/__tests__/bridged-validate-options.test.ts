import { describe, expect, it, vi } from 'vitest';
import { validateOptions } from '../commands/test-referendum';
import type { TestOptions } from '../types';

// Stub the post-connect network fallback so unknown-network URLs don't attempt a
// real WebSocket connection during option validation.
vi.mock('../services/chain-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chain-registry')>();
  return {
    ...actual,
    fetchNetworkFromEndpoint: vi.fn().mockResolvedValue('unknown' as const),
  };
});

const base: TestOptions = {
  port: '8000',
  cleanup: true,
  verbose: false,
};

const POLKADOT_COLLECTIVES = 'wss://polkadot-collectives-rpc.polkadot.io';
const KUSAMA_AH = 'wss://kusama-asset-hub-rpc.polkadot.io';
const POLKADOT_AH = 'wss://polkadot-asset-hub-rpc.polkadot.io';
const KUSAMA_COLLECTIVES = 'wss://kusama-collectives-rpc.polkadot.io';

function bridgedOptions(overrides: Partial<TestOptions> = {}): TestOptions {
  // Minimal bridged invocation — AHP / BHP / BHK default to canonical polkadot.io
  // RPCs inside the tool, so the user only has to supply fellowship + governance.
  return {
    ...base,
    fellowshipChainUrl: POLKADOT_COLLECTIVES,
    governanceChainUrl: KUSAMA_AH,
    callToCreateFellowshipReferendum: '0xdeadbeef',
    ...overrides,
  };
}

describe('validateOptions — bridged scenario', () => {
  it('passes with just fellowship + governance URLs (AHP/BHP/BHK default)', async () => {
    await expect(validateOptions(bridgedOptions())).resolves.toHaveLength(1);
  });

  it('accepts explicit AHP / BHP / BHK overrides', async () => {
    await expect(
      validateOptions(
        bridgedOptions({
          assetHubPolkadotUrl: POLKADOT_AH,
          bridgeHubPolkadotUrl: 'wss://polkadot-bridge-hub-rpc.polkadot.io',
          bridgeHubKusamaUrl: 'wss://kusama-bridge-hub-rpc.polkadot.io',
        })
      )
    ).resolves.toHaveLength(1);
  });

  it('rejects when bridged scenario has no fellowship referendum (only a governance one)', async () => {
    // Need some referendum to be specified (else a different validation trips first),
    // so provide a governance-side hex but omit the fellowship side.
    const opts = bridgedOptions();
    delete opts.callToCreateFellowshipReferendum;
    opts.callToCreateGovernanceReferendum = '0xfeedface';
    await expect(validateOptions(opts)).rejects.toThrow(/requires a fellowship referendum/);
  });

  it('rejects when --asset-hub-kusama-url disagrees with --governance-chain-url', async () => {
    await expect(
      validateOptions(
        bridgedOptions({
          assetHubKusamaUrl: 'wss://different.example.com',
        })
      )
    ).rejects.toThrow(/must match --governance-chain-url/);
  });
});

describe('validateOptions — unsupported reverse direction', () => {
  it('rejects Kusama fellowship + Polkadot AH governance with a clear error', async () => {
    await expect(
      validateOptions({
        ...base,
        fellowshipChainUrl: KUSAMA_COLLECTIVES,
        governanceChainUrl: POLKADOT_AH,
        callToCreateFellowshipReferendum: '0xdeadbeef',
        callToCreateGovernanceReferendum: '0xfeedface',
      })
    ).rejects.toThrow(/Unsupported direction/);
  });

  it('does NOT trigger the reverse-direction error when both URLs are on the same network', async () => {
    // Polkadot Collectives + Polkadot AH — same-network multi-chain, valid scenario.
    await expect(
      validateOptions({
        ...base,
        fellowshipChainUrl: POLKADOT_COLLECTIVES,
        governanceChainUrl: POLKADOT_AH,
        callToCreateFellowshipReferendum: '0xdeadbeef',
        callToCreateGovernanceReferendum: '0xfeedface',
      })
    ).resolves.toHaveLength(1);
  });

  it('does NOT trigger when one URL has unknown network', async () => {
    // Unknown-network endpoint (e.g. local devnet) shouldn't trip the reverse check.
    await expect(
      validateOptions({
        ...base,
        fellowshipChainUrl: 'wss://local-devnet.example.com',
        governanceChainUrl: POLKADOT_AH,
        callToCreateFellowshipReferendum: '0xdeadbeef',
        callToCreateGovernanceReferendum: '0xfeedface',
      })
    ).resolves.toHaveLength(1);
  });
});
