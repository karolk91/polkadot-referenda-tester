import { describe, expect, it, vi } from 'vitest';
import { ReferendaFetcher } from '../services/referenda-fetcher';
import type { Logger } from '../utils/logger';
import { getEnactmentTaskName } from '../utils/scheduler-task-name';

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

function createMockApi(overrides: Record<string, unknown> = {}) {
  return {
    query: {
      System: {
        Number: { getValue: vi.fn().mockResolvedValue(1000) },
        Events: { getValue: vi.fn().mockResolvedValue([]) },
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
        Agenda: { getEntries: vi.fn().mockResolvedValue([]), getValue: vi.fn() },
        Lookup: { getValue: vi.fn() },
      },
      Balances: {
        TotalIssuance: { getValue: vi.fn().mockResolvedValue(1_000_000n) },
      },
    },
    constants: {
      Referenda: { Tracks: vi.fn().mockResolvedValue([[0, { name: 'root' }]]) },
      FellowshipReferenda: { Tracks: vi.fn().mockResolvedValue([[0, { name: 'members' }]]) },
    },
    txFromCallData: vi.fn(),
    ...overrides,
  } as any;
}

describe('ReferendaFetcher.fetchReferendum (Approved)', () => {
  it('returns a stub when the scheduled enactment is no longer in Scheduler.Lookup (already executed)', async () => {
    const logger = createSilentLogger();
    const api = createMockApi();
    api.query.Referenda.ReferendumInfoFor.getValue.mockResolvedValue({
      type: 'Approved',
      value: [12345, undefined, undefined],
    });
    api.query.Scheduler.Lookup.getValue.mockResolvedValue(undefined);

    const fetcher = new ReferendaFetcher(logger);
    const result = await fetcher.fetchReferendum(api, 1886, false);

    expect(result).toBeDefined();
    expect(result?.status).toBe('approved');
    expect(result?.proposal.hash).toBe('unknown');
    expect(api.query.Scheduler.Lookup.getValue).toHaveBeenCalledTimes(1);
    expect(api.query.Scheduler.Agenda.getValue).not.toHaveBeenCalled();
    expect(api.query.Scheduler.Agenda.getEntries).toHaveBeenCalledTimes(1);
  });

  it('returns proposal info from the Scheduler agenda when the enactment is still scheduled in the future', async () => {
    const logger = createSilentLogger();
    const api = createMockApi();
    api.query.Referenda.ReferendumInfoFor.getValue.mockResolvedValue({
      type: 'Approved',
      value: [12345, undefined, undefined],
    });
    // scheduledBlock=99999, agendaIndex=0
    api.query.Scheduler.Lookup.getValue.mockResolvedValue([99999, 0]);
    // Agenda returns one entry whose call references a Lookup proposal
    const proposalHash = new Uint8Array(32);
    proposalHash[0] = 0xab;
    proposalHash[31] = 0xcd;
    const agendaEntry = {
      call: {
        type: 'Lookup',
        value: { hash: proposalHash, len: 42 },
      },
      maybeId: undefined,
      origin: undefined,
    };
    api.query.Scheduler.Agenda.getValue.mockResolvedValue([agendaEntry]);

    const fetcher = new ReferendaFetcher(logger);
    const result = await fetcher.fetchReferendum(api, 1886, false);

    expect(result).toBeDefined();
    expect(result?.status).toBe('approved');
    expect(result?.proposal.type).toBe('Lookup');
    expect(result?.proposal.hash?.toLowerCase()).toMatch(/^0xab[0-9a-f]+cd$/);
    expect(result?.proposal.len).toBe(42);
    // Latest block read for diagnostic logging
    expect(api.query.Scheduler.Agenda.getValue).toHaveBeenCalledWith(99999);
  });

  it('returns a stub if Scheduler.Lookup.getValue throws and no agenda entry carries the task id', async () => {
    const logger = createSilentLogger();
    const api = createMockApi();
    api.query.Referenda.ReferendumInfoFor.getValue.mockResolvedValue({
      type: 'Approved',
      value: [12345, undefined, undefined],
    });
    api.query.Scheduler.Lookup.getValue.mockRejectedValue(new Error('decode error'));

    const fetcher = new ReferendaFetcher(logger);
    const result = await fetcher.fetchReferendum(api, 1886, false);

    expect(result).toBeDefined();
    expect(result?.proposal.hash).toBe('unknown');
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Scheduler.Lookup unavailable for referendum #1886')
    );
    expect(api.query.Scheduler.Agenda.getEntries).toHaveBeenCalledTimes(1);
  });

  it('returns a stub if the Lookup points to an empty agenda slot and no agenda entry carries the task id', async () => {
    const logger = createSilentLogger();
    const api = createMockApi();
    api.query.Referenda.ReferendumInfoFor.getValue.mockResolvedValue({
      type: 'Approved',
      value: [12345, undefined, undefined],
    });
    api.query.Scheduler.Lookup.getValue.mockResolvedValue([99999, 0]);
    api.query.Scheduler.Agenda.getValue.mockResolvedValue([]);

    const fetcher = new ReferendaFetcher(logger);
    const result = await fetcher.fetchReferendum(api, 1886, false);

    expect(result?.proposal.hash).toBe('unknown');
    expect(api.query.Scheduler.Agenda.getEntries).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('scheduled enactment has already executed')
    );
  });

  it('finds the enactment by scanning Scheduler.Agenda for its task id when Scheduler.Lookup cannot be decoded', async () => {
    const logger = createSilentLogger();
    const api = createMockApi();
    api.query.Referenda.ReferendumInfoFor.getValue.mockResolvedValue({
      type: 'Approved',
      value: [12345, undefined, undefined],
    });
    api.query.Scheduler.Lookup.getValue.mockRejectedValue(new Error('Incompatible runtime entry'));

    const proposalHash = new Uint8Array(32);
    proposalHash[0] = 0xab;
    proposalHash[31] = 0xcd;
    // Block 88888 holds an unrelated task first, then this referendum's enactment
    api.query.Scheduler.Agenda.getEntries.mockResolvedValue([
      {
        keyArgs: [88888],
        value: [
          {
            maybeId: new Uint8Array(32).fill(1),
            call: { type: 'Inline', value: new Uint8Array([0x00]) },
          },
          {
            maybeId: getEnactmentTaskName(1886),
            call: { type: 'Lookup', value: { hash: proposalHash, len: 42 } },
          },
        ],
      },
    ]);

    const fetcher = new ReferendaFetcher(logger);
    const result = await fetcher.fetchReferendum(api, 1886, false);

    expect(result?.proposal.type).toBe('Lookup');
    expect(result?.proposal.hash?.toLowerCase()).toMatch(/^0xab[0-9a-f]+cd$/);
    expect(result?.proposal.len).toBe(42);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('scheduled enactment at block 88888')
    );
  });

  it('returns a stub if scanning Scheduler.Agenda fails', async () => {
    const logger = createSilentLogger();
    const api = createMockApi();
    api.query.Referenda.ReferendumInfoFor.getValue.mockResolvedValue({
      type: 'Approved',
      value: [12345, undefined, undefined],
    });
    api.query.Scheduler.Lookup.getValue.mockResolvedValue(undefined);
    api.query.Scheduler.Agenda.getEntries.mockRejectedValue(new Error('rpc error'));

    const fetcher = new ReferendaFetcher(logger);
    const result = await fetcher.fetchReferendum(api, 1886, false);

    expect(result?.proposal.hash).toBe('unknown');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to scan Scheduler.Agenda for referendum #1886')
    );
  });

  it('handles Inline-call enactments by returning the inline hex as proposal hash', async () => {
    const logger = createSilentLogger();
    const api = createMockApi();
    api.query.Referenda.ReferendumInfoFor.getValue.mockResolvedValue({
      type: 'Approved',
      value: [12345, undefined, undefined],
    });
    api.query.Scheduler.Lookup.getValue.mockResolvedValue([99999, 0]);

    const inlineBytes = new Uint8Array([0x00, 0x07, 0x10, 0xde, 0xad, 0xbe, 0xef]);
    api.query.Scheduler.Agenda.getValue.mockResolvedValue([
      {
        call: { type: 'Inline', value: inlineBytes },
        maybeId: undefined,
        origin: undefined,
      },
    ]);

    const fetcher = new ReferendaFetcher(logger);
    const result = await fetcher.fetchReferendum(api, 1886, false);

    expect(result?.proposal.type).toBe('Inline');
    expect(result?.proposal.hash).toBe('0x000710deadbeef');
  });
});
