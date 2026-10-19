import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../utils/logger';

function consoleOutputLines(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.join(' '));
  });
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Logger.error', () => {
  it('error reason without --verbose', () => {
    const lines = consoleOutputLines();
    new Logger(false).error(
      'Test execution failed',
      new Error('At least one referendum must be specified')
    );
    expect(lines.join('\n'), 'a failed run must state its cause without -v').toContain(
      'At least one referendum must be specified'
    );
  });

  it('error cause chain', () => {
    const lines = consoleOutputLines();
    const rootCause = new Error('connect ECONNREFUSED 127.0.0.1:9944');
    new Logger(false).error(
      'Test execution failed',
      new Error('Failed to start Chopsticks', { cause: rootCause })
    );
    const output = lines.join('\n');
    expect(output).toContain('Failed to start Chopsticks');
    expect(output, 'the root cause contains the actionable detail').toContain(
      'connect ECONNREFUSED 127.0.0.1:9944'
    );
  });

  it('stack trace only with --verbose', () => {
    const error = new Error('boom');
    const quietLines = consoleOutputLines();
    new Logger(false).error('failed', error);
    expect(quietLines.join('\n'), 'stack frames are noise without -v').not.toContain(
      'logger.test.ts'
    );
    vi.restoreAllMocks();

    const verboseLines = consoleOutputLines();
    new Logger(true).error('failed', error);
    expect(verboseLines.join('\n')).toContain('logger.test.ts');
  });
});
