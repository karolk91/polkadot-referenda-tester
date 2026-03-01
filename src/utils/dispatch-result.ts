import { stringify } from './json';

/**
 * Interpret a dispatch result from Scheduler.Dispatched events.
 * Handles multiple polkadot-api result formats (Ok/Err, success/failure, boolean, etc.)
 */
export function interpretDispatchResult(result: any): {
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

  if (typeof result === 'object') {
    if ('success' in result && typeof result.success === 'boolean') {
      return {
        outcome: result.success ? 'success' : 'failure',
        message: result.success
          ? undefined
          : formatDispatchError(result.value ?? result.error ?? result.err),
      };
    }

    if ('isOk' in result && typeof (result as any).isOk === 'boolean') {
      const isOk = (result as any).isOk;
      if (isOk) {
        return { outcome: 'success' };
      }
      const errVal =
        typeof (result as any).asErr === 'function'
          ? (result as any).asErr()
          : (result as any).asErr;
      return { outcome: 'failure', message: formatDispatchError(errVal) };
    }

    if ('ok' in result && typeof (result as any).ok === 'boolean') {
      return {
        outcome: (result as any).ok ? 'success' : 'failure',
        message: (result as any).ok ? undefined : formatDispatchError((result as any).err),
      };
    }

    if ('Ok' in result && result.Ok !== undefined) {
      return { outcome: 'success' };
    }

    if ('Err' in result) {
      return { outcome: 'failure', message: formatDispatchError(result.Err) };
    }

    const type = (result.type || result.__kind || result.kind || '').toString();
    if (type) {
      const loweredType = type.toLowerCase();
      if (loweredType === 'ok' || loweredType === 'success') {
        return { outcome: 'success' };
      }
      if (['err', 'error', 'fail', 'failure'].includes(loweredType)) {
        return {
          outcome: 'failure',
          message: formatDispatchError(result.value ?? result.error ?? result.err),
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
export function formatDispatchError(error: any): string {
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
      return error.map((entry) => formatDispatchError(entry)).join(', ');
    }

    if ('type' in error && typeof (error as any).type === 'string') {
      const payload =
        (error as any).value ?? (error as any).error ?? (error as any).err ?? (error as any).data;
      if (payload !== undefined) {
        return `${(error as any).type}: ${stringify(payload)}`;
      }
      return (error as any).type;
    }

    if ('Module' in error) {
      return `Module error: ${stringify(error.Module)}`;
    }

    if ('module' in error) {
      return `Module error: ${stringify(error.module)}`;
    }

    if ('token' in error) {
      return `Token error: ${JSON.stringify(error.token)}`;
    }

    if ('value' in error) {
      return stringify(error.value);
    }

    return stringify(error);
  }

  return String(error);
}
