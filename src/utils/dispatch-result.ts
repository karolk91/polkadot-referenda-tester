import { stringify } from './json';

/**
 * Interpret a dispatch result from Scheduler.Dispatched events.
 * Handles multiple polkadot-api result formats (Ok/Err, success/failure, boolean, etc.)
 */
export function interpretDispatchResult(result: unknown): {
  outcome: 'success' | 'failure' | 'unknown';
  message?: string;
} {
  if (result === null || result === undefined) {
    return { outcome: 'unknown' };
  }

  if (typeof result === 'boolean') {
    return { outcome: result ? 'success' : 'failure' };
  }

  if (typeof result === 'string') {
    const lowered = result.toLowerCase();
    if (lowered === 'ok' || lowered === 'success') {
      return { outcome: 'success' };
    }
    if (['err', 'error', 'fail', 'failure'].includes(lowered)) {
      return { outcome: 'failure', message: 'Scheduler dispatch returned error' };
    }
  }

  if (typeof result === 'object' && result !== null) {
    const r = result as Record<string, unknown>;

    if ('success' in r && typeof r.success === 'boolean') {
      return {
        outcome: r.success ? 'success' : 'failure',
        message: r.success ? undefined : formatDispatchError(r.value ?? r.error ?? r.err),
      };
    }

    if ('isOk' in r && typeof r.isOk === 'boolean') {
      if (r.isOk) {
        return { outcome: 'success' };
      }
      const errVal = typeof r.asErr === 'function' ? (r.asErr as () => unknown)() : r.asErr;
      return { outcome: 'failure', message: formatDispatchError(errVal) };
    }

    if ('ok' in r && typeof r.ok === 'boolean') {
      return {
        outcome: r.ok ? 'success' : 'failure',
        message: r.ok ? undefined : formatDispatchError(r.err),
      };
    }

    if ('Ok' in r && r.Ok !== undefined) {
      return { outcome: 'success' };
    }

    if ('Err' in r) {
      return { outcome: 'failure', message: formatDispatchError(r.Err) };
    }

    const type = (r.type || r.__kind || r.kind || '').toString();
    if (type) {
      const loweredType = type.toLowerCase();
      if (loweredType === 'ok' || loweredType === 'success') {
        return { outcome: 'success' };
      }
      if (['err', 'error', 'fail', 'failure'].includes(loweredType)) {
        return {
          outcome: 'failure',
          message: formatDispatchError(r.value ?? r.error ?? r.err),
        };
      }
    }
  }

  return { outcome: 'unknown' };
}

/**
 * Format a dispatch error into a human-readable string.
 * Handles nested error structures from polkadot-api (Module errors, Token errors, etc.)
 */
export function formatDispatchError(error: unknown): string {
  if (error === null || error === undefined) {
    return 'Unknown dispatch error';
  }

  if (typeof error === 'string') {
    return error;
  }

  if (typeof error === 'boolean') {
    return error ? 'true' : 'false';
  }

  if (typeof error === 'object') {
    if (Array.isArray(error)) {
      return error.map((entry: unknown) => formatDispatchError(entry)).join(', ');
    }

    const e = error as Record<string, unknown>;

    if ('type' in e && typeof e.type === 'string') {
      const payload = e.value ?? e.error ?? e.err ?? e.data;
      if (payload !== undefined) {
        return `${e.type}: ${stringify(payload)}`;
      }
      return e.type;
    }

    if ('Module' in e) {
      return `Module error: ${stringify(e.Module)}`;
    }

    if ('module' in e) {
      return `Module error: ${stringify(e.module)}`;
    }

    if ('token' in e) {
      return `Token error: ${JSON.stringify(e.token)}`;
    }

    if ('value' in e) {
      return stringify(e.value);
    }

    return stringify(error);
  }

  return String(error);
}
