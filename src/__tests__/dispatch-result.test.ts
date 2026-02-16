import { describe, it, expect } from 'vitest';
import { interpretDispatchResult, formatDispatchError } from '../utils/dispatch-result';

describe('interpretDispatchResult', () => {
  it('returns unknown for null/undefined', () => {
    expect(interpretDispatchResult(null)).toEqual({ outcome: 'unknown' });
    expect(interpretDispatchResult(undefined)).toEqual({ outcome: 'unknown' });
  });

  it('handles boolean results', () => {
    expect(interpretDispatchResult(true)).toEqual({ outcome: 'success' });
    expect(interpretDispatchResult(false)).toEqual({ outcome: 'failure' });
  });

  it('handles string results', () => {
    expect(interpretDispatchResult('Ok')).toEqual({ outcome: 'success' });
    expect(interpretDispatchResult('success')).toEqual({ outcome: 'success' });
    expect(interpretDispatchResult('Err')).toEqual({
      outcome: 'failure',
      message: 'Scheduler dispatch returned error',
    });
    expect(interpretDispatchResult('fail')).toEqual({
      outcome: 'failure',
      message: 'Scheduler dispatch returned error',
    });
  });

  it('handles { success: true/false } format', () => {
    expect(interpretDispatchResult({ success: true })).toEqual({ outcome: 'success' });
    expect(interpretDispatchResult({ success: false, value: 'SomeError' })).toEqual({
      outcome: 'failure',
      message: 'SomeError',
    });
  });

  it('handles { isOk: boolean } format', () => {
    expect(interpretDispatchResult({ isOk: true })).toEqual({ outcome: 'success' });
    expect(interpretDispatchResult({ isOk: false, asErr: 'ModuleError' })).toEqual({
      outcome: 'failure',
      message: 'ModuleError',
    });
  });

  it('handles { isOk: false, asErr: function } format', () => {
    expect(interpretDispatchResult({ isOk: false, asErr: () => 'ErrValue' })).toEqual({
      outcome: 'failure',
      message: 'ErrValue',
    });
  });

  it('handles { ok: boolean } format', () => {
    expect(interpretDispatchResult({ ok: true })).toEqual({ outcome: 'success' });
    expect(interpretDispatchResult({ ok: false, err: 'BadThing' })).toEqual({
      outcome: 'failure',
      message: 'BadThing',
    });
  });

  it('handles { Ok: ... } format', () => {
    expect(interpretDispatchResult({ Ok: null })).toEqual({ outcome: 'success' });
    expect(interpretDispatchResult({ Ok: undefined })).toEqual({ outcome: 'unknown' });
  });

  it('handles { Err: ... } format', () => {
    expect(interpretDispatchResult({ Err: 'NotFound' })).toEqual({
      outcome: 'failure',
      message: 'NotFound',
    });
  });

  it('handles type-based enum format (polkadot-api)', () => {
    expect(interpretDispatchResult({ type: 'Ok', value: null })).toEqual({ outcome: 'success' });
    expect(interpretDispatchResult({ type: 'Err', value: 'TokenError' })).toEqual({
      outcome: 'failure',
      message: 'TokenError',
    });
  });

  it('returns unknown for unrecognized format', () => {
    expect(interpretDispatchResult({ foo: 'bar' })).toEqual({ outcome: 'unknown' });
    expect(interpretDispatchResult(42)).toEqual({ outcome: 'unknown' });
  });
});

describe('formatDispatchError', () => {
  it('returns default message for null/undefined', () => {
    expect(formatDispatchError(null)).toBe('Unknown dispatch error');
    expect(formatDispatchError(undefined)).toBe('Unknown dispatch error');
  });

  it('returns string errors as-is', () => {
    expect(formatDispatchError('BadOrigin')).toBe('BadOrigin');
  });

  it('handles boolean errors', () => {
    expect(formatDispatchError(true)).toBe('true');
    expect(formatDispatchError(false)).toBe('false');
  });

  it('formats arrays recursively', () => {
    expect(formatDispatchError(['Error1', 'Error2'])).toBe('Error1, Error2');
  });

  it('formats typed errors with payload', () => {
    expect(formatDispatchError({ type: 'Module', value: { index: 5, error: 3 } })).toBe(
      'Module: {"index":5,"error":3}'
    );
  });

  it('formats typed errors without payload', () => {
    expect(formatDispatchError({ type: 'BadOrigin' })).toBe('BadOrigin');
  });

  it('formats Module errors', () => {
    expect(formatDispatchError({ Module: { index: 10, error: 2 } })).toBe(
      'Module error: {"index":10,"error":2}'
    );
  });

  it('formats module errors (lowercase)', () => {
    expect(formatDispatchError({ module: { index: 1, error: 0 } })).toBe(
      'Module error: {"index":1,"error":0}'
    );
  });

  it('formats token errors', () => {
    expect(formatDispatchError({ token: 'FundsUnavailable' })).toBe(
      'Token error: "FundsUnavailable"'
    );
  });

  it('formats value-only errors', () => {
    expect(formatDispatchError({ value: 42 })).toBe('42');
  });

  it('handles bigint in error payloads', () => {
    expect(formatDispatchError({ type: 'Arithmetic', value: 99999999999999999n })).toBe(
      'Arithmetic: "99999999999999999"'
    );
  });

  it('falls back to JSON.stringify for unknown objects', () => {
    expect(formatDispatchError({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });

  it('handles non-standard types via String()', () => {
    expect(formatDispatchError(Symbol('test'))).toBe('Symbol(test)');
  });
});
