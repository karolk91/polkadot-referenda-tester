import { describe, expect, it, vi } from 'vitest';
import { isBridgedScenario } from '../commands/test-referendum';
import type { TestOptions } from '../types';

// Short-circuit the post-connect fallback so unknown-network URLs return 'unknown'
// without opening a real WebSocket (which would slow the test or hang on DNS).
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

describe('isBridgedScenario', () => {
  it('returns true when fellowship is on Polkadot Collectives and governance is on Kusama AH', async () => {
    await expect(
      isBridgedScenario({
        ...base,
        fellowshipChainUrl: 'wss://polkadot-collectives-rpc.polkadot.io',
        governanceChainUrl: 'wss://kusama-asset-hub-rpc.polkadot.io',
      })
    ).resolves.toBe(true);
  });

  it('returns false when both URLs are on Polkadot (single-network)', async () => {
    await expect(
      isBridgedScenario({
        ...base,
        fellowshipChainUrl: 'wss://polkadot-collectives-rpc.polkadot.io',
        governanceChainUrl: 'wss://polkadot-asset-hub-rpc.polkadot.io',
      })
    ).resolves.toBe(false);
  });

  it('returns false when both URLs are on Kusama', async () => {
    await expect(
      isBridgedScenario({
        ...base,
        fellowshipChainUrl: 'wss://kusama-collectives-rpc.example',
        governanceChainUrl: 'wss://kusama-asset-hub-rpc.polkadot.io',
      })
    ).resolves.toBe(false);
  });

  it('returns false when governance URL is missing', async () => {
    await expect(
      isBridgedScenario({
        ...base,
        fellowshipChainUrl: 'wss://polkadot-collectives-rpc.polkadot.io',
      })
    ).resolves.toBe(false);
  });

  it('returns false when fellowship URL is missing', async () => {
    await expect(
      isBridgedScenario({
        ...base,
        governanceChainUrl: 'wss://kusama-asset-hub-rpc.polkadot.io',
      })
    ).resolves.toBe(false);
  });

  it('returns false for reverse direction (Kusama fellowship → Polkadot AH)', async () => {
    // Not currently supported — only Polkadot → Kusama is plumbed today.
    await expect(
      isBridgedScenario({
        ...base,
        fellowshipChainUrl: 'wss://kusama-fellowship.example',
        governanceChainUrl: 'wss://polkadot-asset-hub-rpc.polkadot.io',
      })
    ).resolves.toBe(false);
  });

  it('returns false when URL networks cannot be inferred and runtime fallback yields unknown', async () => {
    // collectives.example.com / asset-hub.example.com have no polkadot/kusama token.
    // The post-connect fallback is mocked to return 'unknown', so neither side
    // resolves to a known network and bridged scenario does not match.
    await expect(
      isBridgedScenario({
        ...base,
        fellowshipChainUrl: 'wss://collectives.example.com',
        governanceChainUrl: 'wss://asset-hub.example.com',
      })
    ).resolves.toBe(false);
  });
});
