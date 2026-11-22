/**
 * Unit tests: number.utils (2-decimal rounding helpers used for money and metrics).
 */
import { describe, expect, it } from 'vitest';
import { roundObjectNumbers, roundTo2 } from '@src/app/utils/number.utils';

describe('roundTo2', () => {
  it('returns integers and exact 2-decimal values unchanged', () => {
    expect(roundTo2(0)).toBe(0);
    expect(roundTo2(10)).toBe(10);
    expect(roundTo2(12.5)).toBe(12.5);
    expect(roundTo2(56.43)).toBe(56.43);
  });

  it('rounds the third decimal half-up for positive values', () => {
    expect(roundTo2(1.234)).toBe(1.23);
    expect(roundTo2(1.236)).toBe(1.24);
    expect(roundTo2(1.235)).toBe(1.24);
  });

  it('rounds symmetric for negative values (refund adjustments)', () => {
    expect(roundTo2(-1.234)).toBe(-1.23);
    expect(roundTo2(-1.236)).toBe(-1.24);
  });

  it('removes binary float noise from sums such as 0.1 + 0.2', () => {
    expect(roundTo2(0.1 + 0.2)).toBe(0.3);
  });

  it('LIMITATION: half-cent values follow binary float (1.005 -> 1, not 1.01)', () => {
    expect(roundTo2(1.005)).toBe(1);
  });

  it('propagates NaN and Infinity instead of coercing them', () => {
    expect(roundTo2(NaN)).toBeNaN();
    expect(roundTo2(Infinity)).toBe(Infinity);
    expect(roundTo2(-Infinity)).toBe(-Infinity);
  });
});

describe('roundObjectNumbers', () => {
  it('rounds every numeric field to 2 decimals and returns a new object', () => {
    const input = { a: 1.236, b: 2, c: -3.333 };
    const out = roundObjectNumbers(input);

    expect(out).toEqual({ a: 1.24, b: 2, c: -3.33 });
    expect(out).not.toBe(input);
    expect(input).toEqual({ a: 1.236, b: 2, c: -3.333 });
  });

  it('leaves non-number values untouched (strings, booleans, null, undefined, nested objects)', () => {
    const nested = { x: 1.999 };
    const out = roundObjectNumbers({
      s: '1.999',
      flag: true,
      nothing: null,
      missing: undefined,
      nested,
    });

    expect(out.s).toBe('1.999');
    expect(out.flag).toBe(true);
    expect(out.nothing).toBeNull();
    expect(out.missing).toBeUndefined();
    expect(out.nested).toBe(nested);
    expect(nested.x).toBe(1.999);
  });

  it('CHARACTERIZATION: does not recurse into nested objects (nested numbers keep full precision)', () => {
    const out = roundObjectNumbers({ nested: { x: 1.999 } });
    expect(out.nested.x).toBe(1.999);
  });

  it('returns an empty object for an empty input', () => {
    expect(roundObjectNumbers({})).toEqual({});
  });

  it('passes NaN through as NaN (typeof NaN is number)', () => {
    const out = roundObjectNumbers({ bad: NaN });
    expect(out.bad).toBeNaN();
  });

  it('keeps only own enumerable keys of the input', () => {
    const out = roundObjectNumbers({ kept: 1.111 });
    expect(Object.keys(out)).toEqual(['kept']);
    expect(out.kept).toBe(1.11);
  });
});
