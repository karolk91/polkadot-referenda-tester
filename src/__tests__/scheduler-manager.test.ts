import { describe, expect, it, vi } from 'vitest';
import { SchedulerManager } from '../services/scheduler-manager';
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

function createMockChopsticks() {
  return {
    newBlock: vi.fn().mockResolvedValue(undefined),
    setStorageBatch: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockApi(overrides: Record<string, unknown> = {}) {
  return {
    query: {
      System: {
        Number: { getValue: vi.fn().mockResolvedValue(100) },
      },
      ParachainSystem: undefined as any,
      Scheduler: {
        Agenda: { getEntries: vi.fn().mockResolvedValue([]) },
        Lookup: { getValue: vi.fn().mockResolvedValue(null) },
      },
    },
    txFromCallData: vi.fn(),
    ...overrides,
  } as any;
}

// ═══════════════════════════════════════════════════════════════════════
// getSchedulingBlocks() - block number selection
// ═══════════════════════════════════════════════════════════════════════

describe('SchedulerManager', () => {
  describe('getSchedulingBlocks()', () => {
    it('returns parachain blocks when no ParachainSystem pallet exists', async () => {
      const api = createMockApi();
      api.query.ParachainSystem = undefined;

      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );
      const result = await manager.getSchedulingBlocks();

      expect(result.currentBlock).toBe(100);
      expect(result.targetBlock).toBe(101);
    });

    it('returns parachain blocks for fellowship even when relay blocks available', async () => {
      const api = createMockApi();
      api.query.ParachainSystem = {
        LastRelayChainBlockNumber: { getValue: vi.fn().mockResolvedValue(5000) },
      };

      // isFellowship=true should skip relay block logic
      const manager = new SchedulerManager(createSilentLogger(), createMockChopsticks(), api, true);
      const result = await manager.getSchedulingBlocks();

      expect(result.currentBlock).toBe(100);
      expect(result.targetBlock).toBe(101);
    });

    it('uses relay chain blocks for governance on parachains', async () => {
      const api = createMockApi();
      api.query.ParachainSystem = {
        LastRelayChainBlockNumber: { getValue: vi.fn().mockResolvedValue(5000) },
      };

      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );
      const result = await manager.getSchedulingBlocks();

      // relayBlock=5000, so currentBlock=4999, targetBlock=5000
      expect(result.currentBlock).toBe(4999);
      expect(result.targetBlock).toBe(5000);
    });

    it('falls back to parachain blocks if LastRelayChainBlockNumber read fails', async () => {
      const api = createMockApi();
      api.query.ParachainSystem = {
        LastRelayChainBlockNumber: {
          getValue: vi.fn().mockRejectedValue(new Error('decode error')),
        },
      };

      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );
      const result = await manager.getSchedulingBlocks();

      expect(result.currentBlock).toBe(100);
      expect(result.targetBlock).toBe(101);
    });

    it('falls back to parachain blocks if relay block is null', async () => {
      const api = createMockApi();
      api.query.ParachainSystem = {
        LastRelayChainBlockNumber: { getValue: vi.fn().mockResolvedValue(null) },
      };

      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );
      const result = await manager.getSchedulingBlocks();

      expect(result.currentBlock).toBe(100);
      expect(result.targetBlock).toBe(101);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // moveScheduledCallToNextBlock() - error messages
  // ═══════════════════════════════════════════════════════════════════════

  describe('moveScheduledCallToNextBlock()', () => {
    it('throws diagnostic error when agenda is empty', async () => {
      const api = createMockApi();
      api.query.Scheduler.Agenda.getEntries.mockResolvedValue([]);

      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );

      await expect(manager.moveScheduledCallToNextBlock(42, 'nudge')).rejects.toThrow(
        'Searched 0 agenda blocks (0 total items)'
      );
    });

    it('includes block numbers in diagnostic error', async () => {
      const api = createMockApi();
      api.query.Scheduler.Agenda.getEntries.mockResolvedValue([
        { keyArgs: [200], value: [{ call: { type: 'Inline', value: new Uint8Array([0]) } }] },
        { keyArgs: [300], value: [{ call: { type: 'Inline', value: new Uint8Array([1]) } }] },
      ]);
      // txFromCallData will fail to decode, so nothing matches
      api.txFromCallData.mockRejectedValue(new Error('decode fail'));

      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );

      await expect(manager.moveScheduledCallToNextBlock(42, 'nudge')).rejects.toThrow(
        'at blocks: [200, 300]'
      );
    });

    it('includes item count in diagnostic error', async () => {
      const api = createMockApi();
      api.query.Scheduler.Agenda.getEntries.mockResolvedValue([
        {
          keyArgs: [200],
          value: [
            { call: { type: 'Inline', value: new Uint8Array([0]) } },
            { call: { type: 'Inline', value: new Uint8Array([1]) } },
          ],
        },
      ]);
      api.txFromCallData.mockRejectedValue(new Error('decode fail'));

      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );

      await expect(manager.moveScheduledCallToNextBlock(42, 'nudge')).rejects.toThrow(
        '2 total items'
      );
    });

    it('finds and moves a matching nudge call', async () => {
      const api = createMockApi();
      const chopsticks = createMockChopsticks();

      // Create a call that matches via txFromCallData decode
      const callBytes = new Uint8Array([0xab, 0xcd]);
      api.query.Scheduler.Agenda.getEntries.mockResolvedValue([
        {
          keyArgs: [500],
          value: [
            {
              call: { type: 'Inline', value: callBytes },
              maybeId: undefined,
            },
          ],
        },
      ]);

      api.txFromCallData.mockResolvedValue({
        decodedCall: {
          type: 'Referenda',
          value: {
            type: 'nudge_referendum',
            value: { index: 42 },
          },
        },
      });

      const manager = new SchedulerManager(createSilentLogger(), chopsticks, api, false);
      const result = await manager.moveScheduledCallToNextBlock(42, 'nudge');

      expect(result.block).toBe(101); // parachain block 100 + 1
      expect(result.taskIndex).toBe(0);
      expect(chopsticks.setStorageBatch).toHaveBeenCalled();
    });

    it('finds a Lookup execute call matching proposal hash', async () => {
      const api = createMockApi();
      const chopsticks = createMockChopsticks();

      api.query.Scheduler.Agenda.getEntries.mockResolvedValue([
        {
          keyArgs: [600],
          value: [
            {
              call: {
                type: 'Lookup',
                value: { hash: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]) },
              },
              maybeId: undefined,
            },
          ],
        },
      ]);

      const manager = new SchedulerManager(createSilentLogger(), chopsticks, api, false);
      const result = await manager.moveScheduledCallToNextBlock(42, 'execute', '0xaabbccdd');

      expect(result.block).toBe(101);
      expect(result.taskIndex).toBe(0);
    });

    it('updates Lookup when scheduledEntry has maybeId', async () => {
      const api = createMockApi();
      const chopsticks = createMockChopsticks();
      const taskId = new Uint8Array([1, 2, 3, 4]);

      api.query.Scheduler.Agenda.getEntries.mockResolvedValue([
        {
          keyArgs: [500],
          value: [
            {
              call: { type: 'Lookup', value: { hash: new Uint8Array([0xaa]) } },
              maybeId: taskId,
            },
          ],
        },
      ]);
      api.query.Scheduler.Lookup.getValue.mockResolvedValue([500, 0]);

      const manager = new SchedulerManager(createSilentLogger(), chopsticks, api, false);
      await manager.moveScheduledCallToNextBlock(42, 'execute');

      // Should have been called twice: once for agenda, once for lookup
      expect(chopsticks.setStorageBatch).toHaveBeenCalledTimes(2);
      const lookupCall = chopsticks.setStorageBatch.mock.calls[1][0];
      expect(lookupCall.Scheduler.Lookup).toBeDefined();
    });

    it('skips Lookup update when lookup query fails', async () => {
      const api = createMockApi();
      const chopsticks = createMockChopsticks();
      const taskId = new Uint8Array([1, 2, 3, 4]);

      api.query.Scheduler.Agenda.getEntries.mockResolvedValue([
        {
          keyArgs: [500],
          value: [
            {
              call: { type: 'Lookup', value: { hash: new Uint8Array([0xaa]) } },
              maybeId: taskId,
            },
          ],
        },
      ]);
      api.query.Scheduler.Lookup.getValue.mockRejectedValue(new Error('not found'));

      const manager = new SchedulerManager(createSilentLogger(), chopsticks, api, false);
      await manager.moveScheduledCallToNextBlock(42, 'execute');

      // Only the agenda update, no lookup update
      expect(chopsticks.setStorageBatch).toHaveBeenCalledTimes(1);
    });

    it('skips entries with no call', async () => {
      const api = createMockApi();
      api.query.Scheduler.Agenda.getEntries.mockResolvedValue([
        {
          keyArgs: [200],
          value: [
            null, // null entry
            { call: null }, // entry with null call
          ],
        },
      ]);

      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );

      await expect(manager.moveScheduledCallToNextBlock(42, 'nudge')).rejects.toThrow(
        'call not found'
      );
    });

    it('skips entries with empty value array', async () => {
      const api = createMockApi();
      api.query.Scheduler.Agenda.getEntries.mockResolvedValue([
        { keyArgs: [200], value: [] },
        { keyArgs: [300], value: null },
      ]);

      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );

      await expect(manager.moveScheduledCallToNextBlock(42, 'nudge')).rejects.toThrow(
        'call not found'
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // isNudgeReferendumCall() - nudge detection strategies
  // ═══════════════════════════════════════════════════════════════════════

  describe('nudge call detection', () => {
    it('detects nudge via txFromCallData decode (strategy 1)', async () => {
      const api = createMockApi();
      api.txFromCallData.mockResolvedValue({
        decodedCall: {
          type: 'Referenda',
          value: {
            type: 'nudge_referendum',
            value: { index: 42 },
          },
        },
      });

      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );
      const result = await (manager as any).isNudgeReferendumCall(
        { type: 'Inline', value: new Uint8Array([1, 2]) },
        42
      );
      expect(result).toBe(true);
    });

    it('rejects nudge for different referendum ID', async () => {
      const api = createMockApi();
      api.txFromCallData.mockResolvedValue({
        decodedCall: {
          type: 'Referenda',
          value: {
            type: 'nudge_referendum',
            value: { index: 99 }, // different ID
          },
        },
      });

      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );
      const result = await (manager as any).isNudgeReferendumCall(
        { type: 'Inline', value: new Uint8Array([1, 2]) },
        42
      );
      expect(result).toBe(false);
    });

    it('falls back to property matching when decode fails', async () => {
      const api = createMockApi();
      api.txFromCallData.mockRejectedValue(new Error('decode fail'));

      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );
      const result = await (manager as any).isNudgeReferendumCall(
        {
          type: 'Inline',
          value: {
            type: 'Referenda',
            value: { type: 'nudge_referendum', value: {} },
          },
        },
        42
      );
      expect(result).toBe(true);
    });

    it('detects nudge via method property (strategy 2)', async () => {
      const api = createMockApi();
      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );

      const result = await (manager as any).isNudgeReferendumCall(
        { method: 'nudge_referendum' },
        42
      );
      expect(result).toBe(true);
    });

    it('detects nudge via pallet + method value (strategy 2)', async () => {
      const api = createMockApi();
      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );

      const result = await (manager as any).isNudgeReferendumCall(
        {
          type: 'Referenda',
          value: { type: 'nudgeReferendum' },
        },
        42
      );
      expect(result).toBe(true);
    });

    it('uses FellowshipReferenda pallet for fellowship', async () => {
      const api = createMockApi();
      api.txFromCallData.mockResolvedValue({
        decodedCall: {
          type: 'FellowshipReferenda',
          value: {
            type: 'nudge_referendum',
            value: { index: 7 },
          },
        },
      });

      const manager = new SchedulerManager(createSilentLogger(), createMockChopsticks(), api, true);
      const result = await (manager as any).isNudgeReferendumCall(
        { type: 'Inline', value: new Uint8Array([1, 2]) },
        7
      );
      expect(result).toBe(true);
    });

    it('returns false for non-nudge call', async () => {
      const api = createMockApi();
      api.txFromCallData.mockResolvedValue({
        decodedCall: {
          type: 'Referenda',
          value: {
            type: 'submit',
            value: { index: 42 },
          },
        },
      });

      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );
      const result = await (manager as any).isNudgeReferendumCall(
        { type: 'Inline', value: new Uint8Array([1, 2]) },
        42
      );
      expect(result).toBe(false);
    });

    it('returns false for null call data', async () => {
      const api = createMockApi();
      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );
      const result = await (manager as any).isNudgeReferendumCall(null, 42);
      expect(result).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // isProposalExecutionCall() - proposal hash matching
  // ═══════════════════════════════════════════════════════════════════════

  describe('proposal execution call detection', () => {
    it('matches Lookup call by hash', () => {
      const api = createMockApi();
      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );

      const result = (manager as any).isProposalExecutionCall(
        { type: 'Lookup', value: { hash: new Uint8Array([0xaa, 0xbb]) } },
        '0xaabb'
      );
      expect(result).toBe(true);
    });

    it('rejects Lookup call with non-matching hash', () => {
      const api = createMockApi();
      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );

      const result = (manager as any).isProposalExecutionCall(
        { type: 'Lookup', value: { hash: new Uint8Array([0xaa, 0xbb]) } },
        '0xccdd'
      );
      expect(result).toBe(false);
    });

    it('accepts any Lookup call when no proposalHash given', () => {
      const api = createMockApi();
      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );

      const result = (manager as any).isProposalExecutionCall(
        { type: 'Lookup', value: { hash: new Uint8Array([0xaa]) } },
        undefined
      );
      expect(result).toBe(true);
    });

    it('accepts any Inline call when no proposalHash given', () => {
      const api = createMockApi();
      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );

      const result = (manager as any).isProposalExecutionCall(
        { type: 'Inline', value: new Uint8Array([0xab, 0xcd]) },
        undefined
      );
      expect(result).toBe(true);
    });

    it('matches Inline call data against proposalHash', () => {
      const api = createMockApi();
      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );

      const result = (manager as any).isProposalExecutionCall(
        { type: 'Inline', value: new Uint8Array([0xab, 0xcd]) },
        '0xabcd'
      );
      expect(result).toBe(true);
    });

    it('performs case-insensitive matching for Inline calls', () => {
      const api = createMockApi();
      const manager = new SchedulerManager(
        createSilentLogger(),
        createMockChopsticks(),
        api,
        false
      );

      const result = (manager as any).isProposalExecutionCall(
        { type: 'Inline', value: new Uint8Array([0xab, 0xcd]) },
        '0xABCD'
      );
      expect(result).toBe(true);
    });
  });
});
