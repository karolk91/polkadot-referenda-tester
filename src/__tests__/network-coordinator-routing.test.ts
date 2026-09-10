import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkCoordinator } from '../services/network-coordinator';
import type { ReferendumStep } from '../types';

describe('NetworkCoordinator step routing', () => {
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

  const fakeNetwork = { additional: [] };

  const spyOnRunner = () => ({
    setupForkedNetwork: vi
      .spyOn(coordinator as any, 'setupForkedNetwork')
      .mockResolvedValue(fakeNetwork),
    runStep: vi.spyOn(coordinator as any, 'runStep').mockResolvedValue(undefined),
    teardownForkedNetwork: vi
      .spyOn(coordinator as any, 'teardownForkedNetwork')
      .mockResolvedValue(undefined),
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

  const withEndpoints = (governance?: string, fellowship?: string) => {
    (mockTopology.getGovernanceEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(governance);
    (mockTopology.getFellowshipEndpoint as ReturnType<typeof vi.fn>).mockReturnValue(fellowship);
  };

  describe('network shape from the union of steps', () => {
    it('forks only the governance chain for a governance-only step', async () => {
      withEndpoints('wss://gov.example.com');
      const spies = spyOnRunner();

      await coordinator.runSteps([{ referendum: 1 }]);

      expect(mockTopology.detectChainTypes).toHaveBeenCalledOnce();
      expect(spies.setupForkedNetwork).toHaveBeenCalledWith(true, false, {
        governance: undefined,
        fellowship: undefined,
      });
      expect(spies.runStep).toHaveBeenCalledOnce();
      expect(spies.runStep).toHaveBeenCalledWith(fakeNetwork, { referendum: 1 }, 0, 1, false);
    });

    it('forks only the fellowship chain for a fellowship-only step', async () => {
      withEndpoints(undefined, 'wss://fell.example.com');
      const spies = spyOnRunner();

      await coordinator.runSteps([{ fellowship: 5 }]);

      expect(spies.setupForkedNetwork).toHaveBeenCalledWith(false, true, {
        governance: undefined,
        fellowship: undefined,
      });
    });

    it('forks both chains when any step needs each of them', async () => {
      withEndpoints('wss://gov.example.com', 'wss://fell.example.com');
      const spies = spyOnRunner();

      await coordinator.runSteps([{ referendum: 1 }, { fellowship: 5 }]);

      expect(spies.setupForkedNetwork).toHaveBeenCalledWith(true, true, expect.anything());
    });

    it('funds signers up front for every creation call in the run', async () => {
      withEndpoints('wss://gov.example.com', 'wss://fell.example.com');
      const spies = spyOnRunner();

      await coordinator.runSteps([
        { referendum: 1 },
        { callToCreateFellowshipReferendum: '0xbeef' },
        { callToCreateGovernanceReferendum: '0xabcd' },
      ]);

      expect(spies.setupForkedNetwork).toHaveBeenCalledWith(true, true, {
        governance: 'alice-account',
        fellowship: 'fellowship',
      });
    });
  });

  describe('step execution', () => {
    it('runs the steps in order on the same network, then tears down once', async () => {
      withEndpoints('wss://gov.example.com', 'wss://fell.example.com');
      const spies = spyOnRunner();
      const steps: ReferendumStep[] = [
        { referendum: 1942, fellowship: 612, postTest: 'a.mjs' },
        { referendum: 1944 },
        { callToCreateGovernanceReferendum: '0xaa' },
      ];

      await coordinator.runSteps(steps, false, { verbose: true } as any);

      expect(spies.setupForkedNetwork).toHaveBeenCalledOnce();
      expect(spies.runStep.mock.calls.map((call) => [call[1], call[2], call[3]])).toEqual([
        [steps[0], 0, 3],
        [steps[1], 1, 3],
        [steps[2], 2, 3],
      ]);
      for (const call of spies.runStep.mock.calls) {
        expect(call[0]).toBe(fakeNetwork);
        expect(call[4]).toBe(true);
      }
      expect(spies.teardownForkedNetwork).toHaveBeenCalledOnce();
      expect(spies.teardownForkedNetwork).toHaveBeenCalledWith(fakeNetwork, false);
    });

    it('stops at the first failing step but still tears the network down', async () => {
      withEndpoints('wss://gov.example.com');
      const spies = spyOnRunner();
      spies.runStep.mockRejectedValueOnce(new Error('step 1 boom'));

      await expect(
        coordinator.runSteps([{ referendum: 1 }, { referendum: 2 }], true)
      ).rejects.toThrow('step 1 boom');

      expect(spies.runStep).toHaveBeenCalledOnce();
      expect(spies.teardownForkedNetwork).toHaveBeenCalledWith(fakeNetwork, true);
    });

    it('rejects an empty step list', async () => {
      await expect(coordinator.runSteps([])).rejects.toThrow(
        'At least one referendum step is required'
      );
    });
  });

  describe('runStep', () => {
    const makeChain = (label: string) => ({
      manager: { id: `${label}-manager` },
      client: { destroy: vi.fn() },
      api: { id: `${label}-api` },
      info: {
        label,
        specName: label,
        endpoint: `wss://${label}`,
        network: 'polkadot',
        kind: 'system-parachain',
        id: label,
      },
    });

    it('runs a governance-only step, settles XCM on the other forks and runs its post-test', async () => {
      const governance = makeChain('asset-hub');
      const fellowship = makeChain('collectives');
      const extra = { label: 'bridge-hub', manager: { id: 'bridge-hub-manager' } };
      const network = { governance, fellowship, additional: [extra] };
      const fetchAndSimulate = vi.fn().mockResolvedValue({ referendumId: 1944, events: [] });
      const collectAdditionalChainEvents = vi.fn().mockResolvedValue(undefined);
      (coordinator as any).runner = { fetchAndSimulate };
      (coordinator as any).eventCollector = { collectAdditionalChainEvents };
      const postTest = vi
        .spyOn(coordinator as any, 'maybeRunPostTest')
        .mockResolvedValue(undefined);
      const step: ReferendumStep = {
        referendum: 1944,
        postTest: 'dump.mjs',
        postTestArgs: '{"blocks":1}',
      };

      await (coordinator as any).runStep(network, step, 1, 2, true);

      expect(fetchAndSimulate).toHaveBeenCalledWith(
        expect.objectContaining({
          api: governance.api,
          chopsticks: governance.manager,
          referendumId: 1944,
          isFellowship: false,
        })
      );
      // The fellowship fork and the additional chain both build a block to process the XCM.
      const settled = collectAdditionalChainEvents.mock.calls[0][0] as Map<string, unknown>;
      expect([...settled.keys()]).toEqual(['collectives', 'bridge-hub']);
      expect(postTest).toHaveBeenCalledWith(
        step,
        { mainLabel: 'asset-hub', referendumId: 1944, fellowshipReferendumId: undefined },
        { index: 2, count: 2 },
        expect.any(Array),
        true
      );
      const forks = postTest.mock.calls[0][3] as Array<{ label: string }>;
      expect(forks.map((fork) => fork.label)).toEqual(['asset-hub', 'collectives', 'bridge-hub']);
    });

    it('runs fellowship then governance for a dual step on distinct chains', async () => {
      const governance = makeChain('asset-hub');
      const fellowship = makeChain('collectives');
      const network = { governance, fellowship, additional: [] };
      const createReferendumIfNeeded = vi
        .fn()
        .mockResolvedValueOnce(undefined) // fellowship: existing ID
        .mockResolvedValueOnce(1950); // governance: created
      const simulateMultiChainReferenda = vi.fn().mockResolvedValue(undefined);
      const displayPostExecutionEvents = vi.fn().mockResolvedValue(undefined);
      (coordinator as any).runner = { createReferendumIfNeeded, simulateMultiChainReferenda };
      (coordinator as any).eventCollector = { displayPostExecutionEvents };
      const postTest = vi
        .spyOn(coordinator as any, 'maybeRunPostTest')
        .mockResolvedValue(undefined);

      await (coordinator as any).runStep(
        network,
        { fellowship: 612, callToCreateGovernanceReferendum: '0xaa' },
        0,
        1,
        false
      );

      expect(simulateMultiChainReferenda).toHaveBeenCalledWith({
        fellowship: expect.objectContaining({ referendumId: 612, label: 'collectives' }),
        governance: expect.objectContaining({ referendumId: 1950, label: 'asset-hub' }),
      });
      expect(displayPostExecutionEvents).toHaveBeenCalledOnce();
      expect(postTest).toHaveBeenCalledWith(
        expect.anything(),
        { mainLabel: 'asset-hub', referendumId: 1950, fellowshipReferendumId: 612 },
        { index: 1, count: 1 },
        expect.any(Array),
        false
      );
    });

    it('runs a dual step sequentially when both referenda share one fork', async () => {
      const shared = makeChain('kusama');
      const network = { governance: shared, fellowship: shared, additional: [] };
      const createReferendumIfNeeded = vi.fn().mockResolvedValue(undefined);
      const simulateSequentialReferenda = vi.fn().mockResolvedValue(undefined);
      const collectAdditionalChainEvents = vi.fn().mockResolvedValue(undefined);
      (coordinator as any).runner = { createReferendumIfNeeded, simulateSequentialReferenda };
      (coordinator as any).eventCollector = { collectAdditionalChainEvents };
      vi.spyOn(coordinator as any, 'maybeRunPostTest').mockResolvedValue(undefined);

      await (coordinator as any).runStep(network, { fellowship: 7, referendum: 9 }, 0, 1, false);

      expect(simulateSequentialReferenda).toHaveBeenCalledWith(shared.api, shared.manager, 7, 9);
    });

    it('fails clearly when a step needs a chain that was not forked', async () => {
      const network = { governance: makeChain('asset-hub'), additional: [] };
      await expect(
        (coordinator as any).runStep(network, { fellowship: 1 }, 0, 1, false)
      ).rejects.toThrow('Step needs the fellowship chain but it was not forked');
    });
  });

  describe('endpoint validation', () => {
    it('throws when a fellowship step has no fellowship endpoint', async () => {
      withEndpoints('wss://gov.example.com', undefined);

      await expect(coordinator.runSteps([{ fellowship: 5 }])).rejects.toThrow(
        'Fellowship chain URL must be provided when testing fellowship referendum'
      );
    });

    it('throws when a governance step has no governance endpoint', async () => {
      withEndpoints(undefined, 'wss://fell.example.com');

      await expect(coordinator.runSteps([{ referendum: 1 }])).rejects.toThrow(
        'Governance chain URL must be provided when testing governance referendum'
      );
    });
  });
});
