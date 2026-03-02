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
    const resultRecord = result as Record<string, unknown>;

    if ('success' in resultRecord && typeof resultRecord.success === 'boolean') {
      return {
        outcome: resultRecord.success ? 'success' : 'failure',
        message: resultRecord.success
          ? undefined
          : formatDispatchError(resultRecord.value ?? resultRecord.error ?? resultRecord.err),
      };
    }

    if ('isOk' in resultRecord && typeof resultRecord.isOk === 'boolean') {
      if (resultRecord.isOk) {
        return { outcome: 'success' };
      }
      const errVal =
        typeof resultRecord.asErr === 'function'
          ? (resultRecord.asErr as () => unknown)()
          : resultRecord.asErr;
      return { outcome: 'failure', message: formatDispatchError(errVal) };
    }

    if ('ok' in resultRecord && typeof resultRecord.ok === 'boolean') {
      return {
        outcome: resultRecord.ok ? 'success' : 'failure',
        message: resultRecord.ok ? undefined : formatDispatchError(resultRecord.err),
      };
    }

    if ('Ok' in resultRecord && resultRecord.Ok !== undefined) {
      return { outcome: 'success' };
    }

    if ('Err' in resultRecord) {
      return { outcome: 'failure', message: formatDispatchError(resultRecord.Err) };
    }

    // Extract the enum variant tag used by various polkadot-api result formats
    const resultTypeTag = (
      resultRecord.type ||
      resultRecord.__kind ||
      resultRecord.kind ||
      ''
    ).toString();
    if (resultTypeTag) {
      const loweredTag = resultTypeTag.toLowerCase();
      if (loweredTag === 'ok' || loweredTag === 'success') {
        return { outcome: 'success' };
      }
      if (['err', 'error', 'fail', 'failure'].includes(loweredTag)) {
        return {
          outcome: 'failure',
          message: formatDispatchError(
            resultRecord.value ?? resultRecord.error ?? resultRecord.err
          ),
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

    const errorRecord = error as Record<string, unknown>;

    if ('type' in errorRecord && typeof errorRecord.type === 'string') {
      const payload = errorRecord.value ?? errorRecord.error ?? errorRecord.err ?? errorRecord.data;
      if (payload !== undefined) {
        return `${errorRecord.type}: ${stringify(payload)}`;
      }
      return errorRecord.type;
    }

    if ('Module' in errorRecord) {
      return `Module error: ${stringify(errorRecord.Module)}`;
    }

    if ('module' in errorRecord) {
      return `Module error: ${stringify(errorRecord.module)}`;
    }

    if ('token' in errorRecord) {
      return `Token error: ${stringify(errorRecord.token)}`;
    }

    if ('value' in errorRecord) {
      return stringify(errorRecord.value);
    }

    return stringify(error);
  }

  return String(error);
}
