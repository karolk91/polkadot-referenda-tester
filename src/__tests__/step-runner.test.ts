import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fork } from '../network/fork';
import { runPostTest } from '../network/post-test-runner';
import { type ForkedNetwork, runStepsOnNetwork, type StepOutcome } from '../network/step-runner';
import type { ReferendumStep } from '../types';
import { createTestLogger } from './helpers';

vi.mock('../network/post-test-runner', () => ({ runPostTest: vi.fn() }));

function fakeFork(label: string): Fork {
  return {
    manager: { context: { url: `ws://${label}`, chain: { label } } },
    client: {},
    api: {},
    info: {
      label,
      specName: label,
      endpoint: `wss://${label}`,
      network: 'polkadot',
      kind: 'parachain',
    },
  } as unknown as Fork;
}

function governanceStep(id: number, postTest?: string): ReferendumStep {
  return {
    referenda: { kind: 'governance', governance: { kind: 'existing', id } },
    ...(postTest && { postTest: { module: postTest } }),
  };
}

interface NetworkJournal {
  entries: string[];
  network: ForkedNetwork;
}

function journalNetwork(
  forks: Fork[],
  outcome: (step: ReferendumStep) => StepOutcome,
  failingStepNumber?: number
): NetworkJournal {
  const entries: string[] = [];
  let stepNumber = 0;
  const network: ForkedNetwork = {
    forks: () => forks,
    runStep: async (step) => {
      stepNumber++;
      entries.push(`step ${stepNumber}`);
      if (stepNumber === failingStepNumber) {
        throw new Error(`step ${stepNumber} failed`);
      }
      return outcome(step);
    },
    teardown: async (cleanup) => {
      entries.push(`teardown cleanup=${cleanup}`);
    },
  };
  return { entries, network };
}

describe('runStepsOnNetwork', () => {
  const assetHub = fakeFork('asset-hub');
  const collectives = fakeFork('collectives');
  const relay = fakeFork('relay');

  beforeEach(() => {
    vi.mocked(runPostTest).mockReset();
  });

  it('steps in order, each post-test before the next step, one teardown', async () => {
    const { entries, network } = journalNetwork([assetHub], () => ({ main: assetHub }));
    vi.mocked(runPostTest).mockImplementation(async (_logger, module) => {
      entries.push(`post-test ${module}`);
    });

    await runStepsOnNetwork(
      network,
      [
        governanceStep(1942, 'apply-authorized-upgrade'),
        governanceStep(1944),
        governanceStep(1945, 'dump-chain-events'),
      ],
      true,
      createTestLogger()
    );

    expect(entries, 'a post-test changes the state that the next step runs on').toEqual([
      'step 1',
      'post-test apply-authorized-upgrade',
      'step 2',
      'step 3',
      'post-test dump-chain-events',
      'teardown cleanup=true',
    ]);
  });

  it('no later step after a failing step, and teardown of the forks', async () => {
    const { entries, network } = journalNetwork([assetHub], () => ({ main: assetHub }), 1);

    await expect(
      runStepsOnNetwork(network, [governanceStep(1), governanceStep(2)], true, createTestLogger())
    ).rejects.toThrow('step 1 failed');

    expect(entries, 'the Chopsticks servers must stop even when a step fails').toEqual([
      'step 1',
      'teardown cleanup=true',
    ]);
  });

  it('error output before the pause of the forks without cleanup', async () => {
    const { entries, network } = journalNetwork([assetHub], () => ({ main: assetHub }), 1);
    const logger = createTestLogger();
    vi.mocked(logger.error).mockImplementation(() => {
      entries.push('error output');
    });

    await expect(runStepsOnNetwork(network, [governanceStep(1)], false, logger)).rejects.toThrow(
      'step 1 failed'
    );

    expect(
      entries,
      'the pause for manual inspection does not return, so the error must appear before it'
    ).toEqual(['step 1', 'error output', 'teardown cleanup=false']);
  });

  it('post-test context with the main chain, all chains, step position and referendum ids', async () => {
    const { network } = journalNetwork([collectives, assetHub, relay], () => ({
      main: assetHub,
      referendumId: 1942,
      fellowshipReferendumId: 612,
    }));
    const step: ReferendumStep = {
      referenda: {
        kind: 'fellowshipThenGovernance',
        fellowship: { kind: 'existing', id: 612 },
        governance: { kind: 'existing', id: 1942 },
      },
      postTest: { module: 'apply-authorized-upgrade', args: '{"release":"v2.5.0"}' },
    };

    await runStepsOnNetwork(network, [governanceStep(1), step], true, createTestLogger());

    const [, module, context, args] = vi.mocked(runPostTest).mock.calls[0];
    expect(module).toBe('apply-authorized-upgrade');
    expect(args).toBe('{"release":"v2.5.0"}');
    expect(context.main, 'the post-test acts on the chain where the referendum executed').toEqual(
      expect.objectContaining({ label: 'asset-hub', wsEndpoint: 'ws://asset-hub' })
    );
    expect(context.chains.map((chain) => chain.label)).toEqual([
      'collectives',
      'asset-hub',
      'relay',
    ]);
    expect(context.step).toEqual({
      index: 2,
      count: 2,
      referendumId: 1942,
      fellowshipReferendumId: 612,
    });
  });
});
