import { describe, expect, it, vi } from 'vitest';
import { ReferendumSimulator } from '../services/referendum-simulator';
import type { ReferendumInfo } from '../types';
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
    cleanup: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    waitForChainReady: vi.fn().mockResolvedValue(undefined),
    getContext: vi.fn().mockReturnValue({ ws: { endpoint: 'ws://localhost:8000' } }),
  } as any;
}

function createMockApi(overrides: Record<string, unknown> = {}) {
  return {
    query: {
      System: {
        Number: { getValue: vi.fn().mockResolvedValue(100) },
        Events: { getValue: vi.fn().mockResolvedValue([]) },
      },
      Balances: {
        TotalIssuance: { getValue: vi.fn().mockResolvedValue(1000000n) },
      },
      Referenda: {
        ReferendumInfoFor: { getValue: vi.fn() },
        ReferendumCount: { getValue: vi.fn() },
      },
      FellowshipReferenda: {
        ReferendumInfoFor: { getValue: vi.fn() },
        ReferendumCount: { getValue: vi.fn() },
      },
      Scheduler: {
        Agenda: { getEntries: vi.fn().mockResolvedValue([]) },
        Lookup: { getValue: vi.fn() },
      },
    },
    txFromCallData: vi.fn(),
    ...overrides,
  } as any;
}

function makeReferendum(overrides: Partial<ReferendumInfo> = {}): ReferendumInfo {
  return {
    id: 42,
    status: 'ongoing',
    track: 0,
    origin: 'Root',
    proposal: { type: 'Inline', hash: '0xabcd', len: 10 },
    ...overrides,
  } as ReferendumInfo;
}

// ═══════════════════════════════════════════════════════════════════════
// simulate() - top-level entry point
// ═══════════════════════════════════════════════════════════════════════

describe('ReferendumSimulator', () => {
  describe('simulate()', () => {
    it('returns success immediately when already-approved referendum has no scheduled enactment left', async () => {
      const logger = createSilentLogger();
      const chopsticks = createMockChopsticks();
      const api = createMockApi();

      const simulator = new ReferendumSimulator(logger, chopsticks, api, false);
      // hash 'unknown' indicates the fetcher could not locate a future scheduled enactment
      // (i.e. the call has already been dispatched on-chain).
      const referendum = makeReferendum({
        status: 'approved',
        proposal: { type: 'Lookup', hash: 'unknown', call: undefined },
      });

      const result = await simulator.simulate(referendum);

      expect(result.executionSucceeded).toBe(true);
      expect(result.referendumId).toBe(42);
      expect(result.blockExecuted).toBe(0);
      expect(result.events).toEqual([]);
      // Should NOT have interacted with chopsticks at all
      expect(chopsticks.newBlock).not.toHaveBeenCalled();
      expect(chopsticks.setStorageBatch).not.toHaveBeenCalled();
    });

    it('skips applyPassingState and the nudge step when status is approved with a known proposal hash', async () => {
      const logger = createSilentLogger();
      const chopsticks = createMockChopsticks();
      const api = createMockApi();
      const simulator = new ReferendumSimulator(logger, chopsticks, api, false);

      // Stub out the heavy machinery: we only want to verify which sub-steps fire.
      const applyPassingState = vi
        .spyOn(simulator as any, 'applyPassingState')
        .mockResolvedValue(undefined);
      const scheduleAndExecute = vi
        .spyOn(simulator as any, 'scheduleAndExecuteProposal')
        .mockResolvedValue({
          events: [
            { section: 'Scheduler', method: 'Dispatched', data: { result: { success: true } } },
          ],
          executionBlock: 200,
          scheduledBlock: 199,
          scheduledTaskIndex: 0,
          scheduledTaskId: undefined,
        });

      const referendum = makeReferendum({
        status: 'approved',
        // hash !== 'unknown' indicates the fetcher located the future scheduled enactment
        proposal: { type: 'Lookup', hash: '0xdeadbeef', call: undefined, len: 10 },
      });

      await simulator.simulate(referendum);

      // applyPassingState must be skipped — the referendum is already approved on-chain
      expect(applyPassingState).not.toHaveBeenCalled();
      // scheduleAndExecuteProposal must be called with skipNudge=true (its second arg)
      expect(scheduleAndExecute).toHaveBeenCalledTimes(1);
      expect(scheduleAndExecute.mock.calls[0][1]).toBe(true);
    });

    it('catches thrown errors and returns them in result', async () => {
      const logger = createSilentLogger();
      const chopsticks = createMockChopsticks();
      const api = createMockApi();

      // Make ReferendumInfoFor.getValue throw so applyPassingState fails
      api.query.Referenda.ReferendumInfoFor.getValue.mockRejectedValue(
        new Error('RPC connection lost')
      );

      const simulator = new ReferendumSimulator(logger, chopsticks, api, false);
      const referendum = makeReferendum();

      const result = await simulator.simulate(referendum);

      expect(result.executionSucceeded).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // verifyReferendumApproval() - nudge block verification
  // ═══════════════════════════════════════════════════════════════════════

  describe('verifyReferendumApproval()', () => {
    function callVerify(
      isFellowship: boolean,
      events: Array<{ section: string; method: string; data?: unknown }>,
      referendumId: number
    ) {
      const logger = createSilentLogger();
      const chopsticks = createMockChopsticks();
      const api = createMockApi();
      const simulator = new ReferendumSimulator(logger, chopsticks, api, isFellowship);
      // Access private method via cast
      return (simulator as any).verifyReferendumApproval(events, referendumId);
    }

    it('passes when Confirmed event matches referendum ID', () => {
      const events = [{ section: 'Referenda', method: 'Confirmed', data: { index: 42 } }];
      expect(() => callVerify(false, events, 42)).not.toThrow();
    });

    it('passes when Approved event matches referendum ID', () => {
      const events = [{ section: 'Referenda', method: 'Approved', data: { index: 42 } }];
      expect(() => callVerify(false, events, 42)).not.toThrow();
    });

    it('passes with FellowshipReferenda pallet for fellowship', () => {
      const events = [{ section: 'FellowshipReferenda', method: 'Confirmed', data: { index: 7 } }];
      expect(() => callVerify(true, events, 7)).not.toThrow();
    });

    it('throws when no Confirmed or Approved event exists', () => {
      const events = [
        { section: 'System', method: 'ExtrinsicSuccess', data: {} },
        { section: 'Scheduler', method: 'Dispatched', data: {} },
      ];
      expect(() => callVerify(false, events, 42)).toThrow(
        'was not confirmed or approved after nudge'
      );
    });

    it('throws when Confirmed event is for a different referendum', () => {
      const events = [{ section: 'Referenda', method: 'Confirmed', data: { index: 99 } }];
      expect(() => callVerify(false, events, 42)).toThrow('fired for referendum #99');
    });

    it('throws when Approved event is for a different referendum', () => {
      const events = [{ section: 'Referenda', method: 'Approved', data: { index: 99 } }];
      expect(() => callVerify(false, events, 42)).toThrow('fired for referendum #99');
    });

    it('passes when event has no index field (graceful)', () => {
      // Some runtimes might not include the index — treat as acceptable
      const events = [{ section: 'Referenda', method: 'Confirmed', data: { tally: {} } }];
      expect(() => callVerify(false, events, 42)).not.toThrow();
    });

    it('includes available events in error message when missing', () => {
      const events = [{ section: 'Balances', method: 'Transfer', data: {} }];
      try {
        callVerify(false, events, 42);
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('Balances.Transfer');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // parseOriginString() - origin format parsing
  // ═══════════════════════════════════════════════════════════════════════

  describe('parseOriginString()', () => {
    function callParse(originString: string) {
      const logger = createSilentLogger();
      const chopsticks = createMockChopsticks();
      const api = createMockApi();
      const simulator = new ReferendumSimulator(logger, chopsticks, api, false);
      return (simulator as any).parseOriginString(originString);
    }

    it('parses "Root" as System.Root', () => {
      expect(callParse('Root')).toEqual({ System: 'Root' });
    });

    it('parses dotted format "Origins.WhitelistedCaller"', () => {
      expect(callParse('Origins.WhitelistedCaller')).toEqual({
        Origins: 'WhitelistedCaller',
      });
    });

    it('parses custom dotted format "Council.Members"', () => {
      expect(callParse('Council.Members')).toEqual({
        Council: 'Members',
      });
    });

    it('recognizes known governance origins without dot notation', () => {
      expect(callParse('Treasurer')).toEqual({ Origins: 'Treasurer' });
      expect(callParse('BigSpender')).toEqual({ Origins: 'BigSpender' });
      expect(callParse('WhitelistedCaller')).toEqual({ Origins: 'WhitelistedCaller' });
      expect(callParse('SmallTipper')).toEqual({ Origins: 'SmallTipper' });
    });

    it('falls back to System origin for unknown strings', () => {
      const result = callParse('SomeWeirdOrigin');
      expect(result).toEqual({ System: 'SomeWeirdOrigin' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // buildPassingReferendumStorage() - storage construction
  // ═══════════════════════════════════════════════════════════════════════

  describe('buildPassingReferendumStorage()', () => {
    function callBuild(isFellowship: boolean, totalIssuance: bigint, currentBlock: number) {
      const logger = createSilentLogger();
      const chopsticks = createMockChopsticks();
      const api = createMockApi();
      const simulator = new ReferendumSimulator(logger, chopsticks, api, isFellowship);

      const ongoingData = {
        track: 1,
        origin: { type: 'system', value: { type: 'Root' } },
        proposal: { type: 'Inline', value: new Uint8Array([0xab, 0xcd]) },
        submitted: 50,
        submission_deposit: { who: '0x1234', amount: 100n },
        decision_deposit: { who: '0x1234', amount: 200n },
        in_queue: false,
      };

      return (simulator as any).buildPassingReferendumStorage(
        ongoingData,
        totalIssuance,
        currentBlock
      );
    }

    it('builds governance tally with totalIssuance-based votes', () => {
      const result = callBuild(false, 1000000n, 100);
      const tally = result.ongoing.tally;

      expect(tally.ayes).toBe('999999');
      expect(tally.nays).toBe('0');
      expect(tally.support).toBe('999999');
      // Should NOT have fellowship fields
      expect(tally.bare_ayes).toBeUndefined();
    });

    it('builds fellowship tally with fixed values', () => {
      const result = callBuild(true, 1000000n, 100);
      const tally = result.ongoing.tally;

      expect(tally.bare_ayes).toBe(100);
      expect(tally.ayes).toBe(1000);
      expect(tally.nays).toBe(0);
      // Should NOT have governance fields
      expect(tally.support).toBeUndefined();
    });

    it('sets enactment to immediate (after: 0)', () => {
      const result = callBuild(false, 1000000n, 100);
      expect(result.ongoing.enactment).toEqual({ after: 0 });
    });

    it('sets deciding.since and deciding.confirming to currentBlock - 1', () => {
      const result = callBuild(false, 1000000n, 100);
      expect(result.ongoing.deciding.since).toBe(99);
      expect(result.ongoing.deciding.confirming).toBe(99);
    });

    it('sets alarm to currentBlock + 1', () => {
      const result = callBuild(false, 1000000n, 100);
      expect(result.ongoing.alarm).toEqual([101, [101, 0]]);
    });

    it('preserves track and submitted fields from ongoing data', () => {
      const result = callBuild(false, 1000000n, 100);
      expect(result.ongoing.track).toBe(1);
      expect(result.ongoing.submitted).toBe(50);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // applyPassingState() - state transitions
  // ═══════════════════════════════════════════════════════════════════════

  describe('applyPassingState()', () => {
    function makeSimulator(refInfoReturn: unknown) {
      const logger = createSilentLogger();
      const chopsticks = createMockChopsticks();
      const api = createMockApi();

      api.query.Referenda.ReferendumInfoFor.getValue.mockResolvedValue(refInfoReturn);
      api.query.System.Number.getValue.mockResolvedValue(100);

      const simulator = new ReferendumSimulator(logger, chopsticks, api, false);
      return { simulator, logger, chopsticks, api };
    }

    it('throws when referendum is not found', async () => {
      const { simulator } = makeSimulator(null);
      const referendum = makeReferendum({ id: 99 });

      await expect((simulator as any).applyPassingState(referendum)).rejects.toThrow(
        'Referendum 99 not found'
      );
    });

    it('throws when referendum is in Rejected state', async () => {
      const { simulator } = makeSimulator({ type: 'Rejected' });
      const referendum = makeReferendum({ id: 42 });

      await expect((simulator as any).applyPassingState(referendum)).rejects.toThrow(
        'not in Ongoing state (current state: Rejected)'
      );
    });

    it('throws when referendum is in Cancelled state', async () => {
      const { simulator } = makeSimulator({ type: 'Cancelled' });
      const referendum = makeReferendum({ id: 42 });

      await expect((simulator as any).applyPassingState(referendum)).rejects.toThrow(
        'not in Ongoing state (current state: Cancelled)'
      );
    });

    it('returns early without error when referendum is already Approved', async () => {
      const { simulator, chopsticks, logger } = makeSimulator({ type: 'Approved' });
      const referendum = makeReferendum({ id: 42 });

      // Should not throw
      await (simulator as any).applyPassingState(referendum);

      // Should not have written any storage
      expect(chopsticks.setStorageBatch).not.toHaveBeenCalled();
      // Should have logged the skip
      expect(logger.succeedSpinner).toHaveBeenCalledWith(
        expect.stringContaining('skipping state update')
      );
    });
  });
});
