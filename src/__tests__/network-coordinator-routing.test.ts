import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkCoordinator } from '../services/network-coordinator';

describe('NetworkCoordinator routing logic', () => {
  let coordinator: NetworkCoordinator;
  let mockTopology: Record<string, unknown>;

  const mockLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    section: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    startSpinner: vi.fn(),
    succeedSpinner: vi.fn(),
    failSpinner: vi.fn(),
  } as any;

  const spyOnRouting = () => ({
    runSingleChainTest: vi
      .spyOn(coordinator as any, 'runSingleChainTest')
      .mockResolvedValue(undefined),
    runSingleChainWithAdditionalChains: vi
      .spyOn(coordinator as any, 'runSingleChainWithAdditionalChains')
      .mockResolvedValue(undefined),
    testSameChainWithFellowship: vi
      .spyOn(coordinator as any, 'testSameChainWithFellowship')
      .mockResolvedValue(undefined),
    testMultiChain: vi.spyOn(coordinator as any, 'testMultiChain').mockResolvedValue(undefined),
  });

  beforeEach(() => {
    vi.restoreAllMocks();

    coordinator = new NetworkCoordinator(mockLogger, { additionalChains: [] });

    mockTopology = {
      getFellowshipEndpoint: vi.fn(),
      getGovernanceEndpoint: vi.fn(),
      getFellowshipBlock: vi.fn().mockReturnValue(undefined),
      getGovernanceBlock: vi.fn().mockReturnValue(undefined),
      hasAdditionalChains: vi.fn().mockReturnValue(false),
      detectChainTypes: vi.fn().mockResolvedValue(undefined),
      governanceChain: undefined,
      fellowshipChain: undefined,
    };
    (coordinator as any).topology = mockTopology;
  });

  describe('routing branches', () => {
    it('routes governance-only referendum to runSingleChainTest', async () => {
      (mockTopology.getGovernanceEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(
        'wss://gov.example.com'
      );
      const spies = spyOnRouting();

      await coordinator.testWithFellowship(1, undefined, true);

      expect(spies.runSingleChainTest).toHaveBeenCalledOnce();
      expect(spies.runSingleChainWithAdditionalChains).not.toHaveBeenCalled();
      expect(spies.testSameChainWithFellowship).not.toHaveBeenCalled();
      expect(spies.testMultiChain).not.toHaveBeenCalled();
    });

    it('routes governance-only with additional chains to runSingleChainWithAdditionalChains', async () => {
      (mockTopology.getGovernanceEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(
        'wss://gov.example.com'
      );
      (mockTopology.hasAdditionalChains as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const spies = spyOnRouting();

      await coordinator.testWithFellowship(1, undefined, true);

      expect(spies.runSingleChainWithAdditionalChains).toHaveBeenCalledOnce();
      expect(mockTopology.detectChainTypes).toHaveBeenCalledOnce();
      expect(spies.runSingleChainTest).not.toHaveBeenCalled();
    });

    it('routes fellowship-only referendum to runSingleChainTest', async () => {
      (mockTopology.getFellowshipEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(
        'wss://fell.example.com'
      );
      const spies = spyOnRouting();

      await coordinator.testWithFellowship(undefined, 5, true);

      expect(spies.runSingleChainTest).toHaveBeenCalledOnce();
      expect(spies.runSingleChainWithAdditionalChains).not.toHaveBeenCalled();
    });

    it('routes fellowship-only with additional chains to runSingleChainWithAdditionalChains', async () => {
      (mockTopology.getFellowshipEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(
        'wss://fell.example.com'
      );
      (mockTopology.hasAdditionalChains as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const spies = spyOnRouting();

      await coordinator.testWithFellowship(undefined, 5, true);

      expect(spies.runSingleChainWithAdditionalChains).toHaveBeenCalledOnce();
      expect(mockTopology.detectChainTypes).toHaveBeenCalledOnce();
      expect(spies.runSingleChainTest).not.toHaveBeenCalled();
    });

    it('routes dual referendum with same endpoint to testSameChainWithFellowship', async () => {
      (mockTopology.getGovernanceEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(
        'wss://same.example.com'
      );
      (mockTopology.getFellowshipEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(
        'wss://same.example.com'
      );
      (mockTopology.detectChainTypes as ReturnType<typeof vi.fn>).mockImplementation(() => {
        mockTopology.governanceChain = { label: 'collectives-polkadot' };
        mockTopology.fellowshipChain = { label: 'collectives-polkadot' };
        return Promise.resolve();
      });
      const spies = spyOnRouting();

      await coordinator.testWithFellowship(1, 5, true);

      expect(spies.testSameChainWithFellowship).toHaveBeenCalledOnce();
      expect(spies.testMultiChain).not.toHaveBeenCalled();
    });

    it('routes dual referendum with different endpoints to testMultiChain', async () => {
      (mockTopology.getGovernanceEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(
        'wss://gov.example.com'
      );
      (mockTopology.getFellowshipEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(
        'wss://fell.example.com'
      );
      (mockTopology.detectChainTypes as ReturnType<typeof vi.fn>).mockImplementation(() => {
        mockTopology.governanceChain = { label: 'asset-hub-polkadot' };
        mockTopology.fellowshipChain = { label: 'collectives-polkadot' };
        return Promise.resolve();
      });
      const spies = spyOnRouting();

      await coordinator.testWithFellowship(1, 5, true);

      expect(spies.testMultiChain).toHaveBeenCalledOnce();
      expect(spies.testSameChainWithFellowship).not.toHaveBeenCalled();
    });
  });

  describe('argument forwarding', () => {
    it('forwards correct arguments for governance single chain test', async () => {
      (mockTopology.getGovernanceEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(
        'wss://gov.example.com'
      );
      (mockTopology.getGovernanceBlock as ReturnType<typeof vi.fn>).mockReturnValue(100);
      const spies = spyOnRouting();

      await coordinator.testWithFellowship(42, undefined, false);

      expect(spies.runSingleChainTest).toHaveBeenCalledWith({
        endpoint: 'wss://gov.example.com',
        block: 100,
        referendumId: 42,
        isFellowship: false,
        storageInjection: undefined,
        createCallHex: undefined,
        createPreimageHex: undefined,
        options: undefined,
        cleanup: false,
      });
    });

    it('forwards correct arguments for fellowship single chain test with createCall', async () => {
      (mockTopology.getFellowshipEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(
        'wss://fell.example.com'
      );
      (mockTopology.getFellowshipBlock as ReturnType<typeof vi.fn>).mockReturnValue(200);
      const spies = spyOnRouting();
      const options = { callToCreateFellowshipReferendum: '0xdeadbeef' } as any;

      await coordinator.testWithFellowship(undefined, undefined, true, options);

      expect(spies.runSingleChainTest).toHaveBeenCalledWith({
        endpoint: 'wss://fell.example.com',
        block: 200,
        referendumId: undefined,
        isFellowship: true,
        storageInjection: 'fellowship',
        createCallHex: '0xdeadbeef',
        createPreimageHex: undefined,
        options,
        cleanup: true,
      });
    });
  });

  describe('options-based routing', () => {
    it('routes to governance path when callToCreateGovernanceReferendum is set', async () => {
      (mockTopology.getGovernanceEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(
        'wss://gov.example.com'
      );
      const spies = spyOnRouting();
      const options = { callToCreateGovernanceReferendum: '0xabcd' } as any;

      await coordinator.testWithFellowship(undefined, undefined, true, options);

      expect(spies.runSingleChainTest).toHaveBeenCalledOnce();
      const callArgs = spies.runSingleChainTest.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs.referendumId).toBeUndefined();
      expect(callArgs.isFellowship).toBe(false);
      expect(callArgs.storageInjection).toBe('alice-account');
      expect(callArgs.createCallHex).toBe('0xabcd');
    });

    it('routes to fellowship path when callToCreateFellowshipReferendum is set', async () => {
      (mockTopology.getFellowshipEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(
        'wss://fell.example.com'
      );
      const spies = spyOnRouting();
      const options = { callToCreateFellowshipReferendum: '0xbeef' } as any;

      await coordinator.testWithFellowship(undefined, undefined, true, options);

      expect(spies.runSingleChainTest).toHaveBeenCalledOnce();
      const callArgs = spies.runSingleChainTest.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs.referendumId).toBeUndefined();
      expect(callArgs.isFellowship).toBe(true);
      expect(callArgs.storageInjection).toBe('fellowship');
      expect(callArgs.createCallHex).toBe('0xbeef');
    });
  });

  describe('error paths', () => {
    it('throws when fellowship-only test has no fellowship endpoint', async () => {
      (mockTopology.getFellowshipEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      await expect(coordinator.testWithFellowship(undefined, 5, true)).rejects.toThrow(
        'Fellowship chain URL must be provided when testing fellowship referendum'
      );
    });

    it('throws when governance-only test has no governance endpoint', async () => {
      (mockTopology.getGovernanceEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      await expect(coordinator.testWithFellowship(1, undefined, true)).rejects.toThrow(
        'Governance endpoint must be set for single referendum testing'
      );
    });

    it('throws when dual test has no fellowship endpoint', async () => {
      (mockTopology.getGovernanceEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(
        'wss://gov.example.com'
      );
      (mockTopology.getFellowshipEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      await expect(coordinator.testWithFellowship(1, 5, true)).rejects.toThrow(
        'Fellowship chain URL must be provided when fellowship referendum ID is set'
      );
    });

    it('throws when dual test has no governance endpoint', async () => {
      (mockTopology.getGovernanceEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      (mockTopology.getFellowshipEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(
        'wss://fell.example.com'
      );

      await expect(coordinator.testWithFellowship(1, 5, true)).rejects.toThrow(
        'Governance chain URL must be provided when testing both referenda'
      );
    });
  });
});
