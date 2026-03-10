import { afterEach, describe, expect, it, vi } from 'vitest';

const mockTestWithFellowship = vi.fn();

vi.mock('../services/network-coordinator', () => ({
  NetworkCoordinator: vi.fn(function () {
    return { testWithFellowship: mockTestWithFellowship };
  }),
}));

vi.mock('../utils/chain-endpoint-parser', () => ({
  parseEndpoint: vi.fn((url: string) => ({ url, block: undefined })),
  parseMultipleEndpoints: vi.fn((urls: string) =>
    urls.split(',').map((u: string) => ({ url: u, block: undefined }))
  ),
}));

vi.mock('../utils/logger', () => {
  const MockLogger = vi.fn(function (this: Record<string, unknown>) {
    this.info = vi.fn();
    this.debug = vi.fn();
    this.warn = vi.fn();
    this.error = vi.fn();
    this.success = vi.fn();
    this.section = vi.fn();
    this.isVerbose = () => false;
    this.startSpinner = vi.fn();
    this.succeedSpinner = vi.fn();
    this.failSpinner = vi.fn();
    this.updateSpinner = vi.fn();
    this.stopSpinner = vi.fn();
    this.table = vi.fn();
  });
  return { Logger: MockLogger };
});

import { testReferendum } from '../commands/test-referendum';
import type { TestOptions } from '../types';

function makeOptions(overrides: Partial<TestOptions> = {}): TestOptions {
  return {
    referendum: '1',
    governanceChainUrl: 'wss://example.com',
    port: '8000',
    verbose: false,
    cleanup: true,
    ...overrides,
  };
}

describe('testReferendum process exit', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

  afterEach(() => {
    exitSpy.mockClear();
    mockTestWithFellowship.mockReset();
  });

  it('calls process.exit(0) after successful workflow with cleanup enabled', async () => {
    mockTestWithFellowship.mockResolvedValue(undefined);

    await testReferendum(makeOptions({ cleanup: true }));

    expect(mockTestWithFellowship).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('calls process.exit(1) when workflow throws an error', async () => {
    mockTestWithFellowship.mockRejectedValue(new Error('boom'));

    await testReferendum(makeOptions({ cleanup: true }));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not call process.exit when cleanup is disabled (no-cleanup mode)', async () => {
    mockTestWithFellowship.mockResolvedValue(undefined);

    await testReferendum(makeOptions({ cleanup: false }));

    expect(mockTestWithFellowship).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) on validation error (no referendum specified)', async () => {
    await testReferendum(
      makeOptions({
        referendum: undefined,
        fellowship: undefined,
      })
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
