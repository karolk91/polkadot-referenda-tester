import { describe, expect, it, vi } from 'vitest';
import { SimulationRunner } from '../services/simulation-runner';
import type { SimulationResult } from '../types';
import type { Logger } from '../utils/logger';

function createSilentLogger(): Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    isVerbose: () => false,
    startSpinner: vi.fn(),
    succeedSpinner: vi.fn(),
    failSpinner: vi.fn(),
    updateSpinner: vi.fn(),
    stopSpinner: vi.fn(),
    section: vi.fn(),
    table: vi.fn(),
  } as unknown as Logger;
}

describe('SimulationRunner', () => {
  describe('throwIfFailed()', () => {
    it('does not throw when execution succeeded', () => {
      const runner = new SimulationRunner(createSilentLogger());
      const result: SimulationResult = {
        referendumId: 1,
        executionSucceeded: true,
        events: [],
      };
      expect(() => runner.throwIfFailed(result, 'Test')).not.toThrow();
    });

    it('throws with label when execution failed', () => {
      const runner = new SimulationRunner(createSilentLogger());
      const result: SimulationResult = {
        referendumId: 1,
        executionSucceeded: false,
        events: [],
      };
      expect(() => runner.throwIfFailed(result, 'Governance referendum #42')).toThrow(
        'Governance referendum #42 execution failed'
      );
    });

    it('logs each error before throwing', () => {
      const logger = createSilentLogger();
      const runner = new SimulationRunner(logger);
      const result: SimulationResult = {
        referendumId: 1,
        executionSucceeded: false,
        events: [],
        errors: ['Module error: foo', 'Dispatch failed'],
      };
      try {
        runner.throwIfFailed(result, 'Test');
      } catch {
        // expected
      }
      expect(logger.error).toHaveBeenCalledWith('  Module error: foo');
      expect(logger.error).toHaveBeenCalledWith('  Dispatch failed');
    });
  });

  describe('createReferendumIfNeeded()', () => {
    it('returns undefined when no callHex is provided', async () => {
      const runner = new SimulationRunner(createSilentLogger());
      const result = await runner.createReferendumIfNeeded({
        api: {} as any,
        chopsticks: {} as any,
        callHex: undefined,
        preimageHex: undefined,
        isFellowship: false,
      });
      expect(result).toBeUndefined();
    });
  });
});
