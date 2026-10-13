import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BRIDGE_URLS, type TestOptions } from '../commands/test-options';
import { testReferendum } from '../commands/test-referendum';
import { SingleConsensusNetwork } from '../network/single-consensus-network';
import { runStepsOnNetwork } from '../network/step-runner';

vi.mock('../network/single-consensus-network', () => ({
  SingleConsensusNetwork: { create: vi.fn(async () => ({})) },
}));
vi.mock('../network/step-runner', () => ({ runStepsOnNetwork: vi.fn() }));
vi.mock('../utils/logger', () => ({
  Logger: vi.fn(function (this: Record<string, unknown>) {
    const methods = ['info', 'debug', 'warn', 'error', 'success', 'section'];
    for (const method of [...methods, 'startSpinner', 'succeedSpinner', 'failSpinner']) {
      this[method] = vi.fn();
    }
    this.isVerbose = () => false;
  }),
}));

function options(overrides: Partial<TestOptions> = {}): TestOptions {
  return {
    referendum: '1',
    governanceChainUrl: 'wss://example.com',
    assetHubPolkadotUrl: DEFAULT_BRIDGE_URLS.assetHubPolkadot,
    bridgeHubPolkadotUrl: DEFAULT_BRIDGE_URLS.bridgeHubPolkadot,
    bridgeHubKusamaUrl: DEFAULT_BRIDGE_URLS.bridgeHubKusama,
    bridgePumpRounds: 8,
    cleanup: true,
    verbose: false,
    ...overrides,
  };
}

describe('testReferendum exit code', () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

  afterEach(() => {
    exit.mockClear();
    vi.mocked(runStepsOnNetwork).mockReset();
  });

  it('exit code 0 after a successful run with cleanup', async () => {
    vi.mocked(runStepsOnNetwork).mockResolvedValue(undefined);

    await testReferendum(options());

    expect(SingleConsensusNetwork.create).toHaveBeenCalledOnce();
    expect(exit, 'open RPC clients would otherwise prevent the process exit').toHaveBeenCalledWith(
      0
    );
  });

  it('exit code 1 for a failed run', async () => {
    vi.mocked(runStepsOnNetwork).mockRejectedValue(new Error('referendum failed'));

    await testReferendum(options());

    expect(
      exit,
      'CI and the integration tests read the result from the exit code'
    ).toHaveBeenCalledWith(1);
  });

  it('exit code 1 for invalid options', async () => {
    await testReferendum(options({ referendum: undefined }));

    expect(exit).toHaveBeenCalledWith(1);
    expect(runStepsOnNetwork).not.toHaveBeenCalled();
  });

  it('no exit after a successful run without cleanup', async () => {
    vi.mocked(runStepsOnNetwork).mockResolvedValue(undefined);

    await testReferendum(options({ cleanup: false }));

    expect(
      exit,
      'an exit would stop the forks that remain for manual inspection'
    ).not.toHaveBeenCalled();
  });
});
