/**
 * Unit tests: `callbackFn` (socket ack helper).
 *
 * Every chat socket handler answers through `callbackFn(callback, payload)`. Socket.io clients
 * routinely emit WITHOUT an ack function, so the helper must be a safe no-op for anything that
 * is not a function, and must never throw into the handler.
 */
import { describe, expect, it, vi } from 'vitest';
import { callbackFn } from '@src/app/utils/callbackFn';

describe('callbackFn', () => {
  it('invokes the callback exactly once with the payload object itself (no copy, no extra args)', () => {
    const cb = vi.fn();
    const payload = { success: true, message: 'ok' };

    callbackFn(cb, payload);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]).toEqual([payload]);
    expect(cb.mock.calls[0][0]).toBe(payload);
  });

  it('returns undefined whatever the callback returns', () => {
    const cb = vi.fn(() => 'ignored');
    expect(callbackFn(cb, { a: 1 })).toBeUndefined();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'ack'],
    ['a number', 42],
    ['an object', { call: () => 'nope' }],
    ['an array', [() => 'nope']],
  ])('is a silent no-op when the ack is %s', (_label, notAFunction) => {
    expect(() => callbackFn(notAFunction, { success: true })).not.toThrow();
    expect(callbackFn(notAFunction, { success: true })).toBeUndefined();
  });

  it('forwards falsy payloads untouched (undefined / null / 0 / empty string)', () => {
    const cb = vi.fn();
    callbackFn(cb, undefined);
    callbackFn(cb, null);
    callbackFn(cb, 0);
    callbackFn(cb, '');
    expect(cb.mock.calls).toEqual([[undefined], [null], [0], ['']]);
  });

  it('LIMITATION: an exception thrown by the callback is NOT swallowed (the socket handler sees it)', () => {
    const cb = vi.fn(() => {
      throw new Error('client ack blew up');
    });
    expect(() => callbackFn(cb, {})).toThrow('client ack blew up');
  });
});
