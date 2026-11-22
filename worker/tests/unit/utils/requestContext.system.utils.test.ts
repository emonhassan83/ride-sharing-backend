/**
 * Unit tests: trace-id request context + small helpers.
 */
import { describe, expect, it } from 'vitest';
import { getTraceId, requestContext } from '@/app/configs/requestContext.configs';
import { mailOption } from '@/app/utils/system.utils';

describe('requestContext / getTraceId', () => {
  it('is NO_TRACE_ID outside any context', () => {
    expect(getTraceId()).toBe('NO_TRACE_ID');
  });

  it('returns the trace id of the active context', () => {
    requestContext.run({ traceId: 't-1' }, () => {
      expect(getTraceId()).toBe('t-1');
    });
    expect(getTraceId()).toBe('NO_TRACE_ID'); // restored afterwards
  });

  it('nested contexts shadow and then restore the outer id', () => {
    requestContext.run({ traceId: 'outer' }, () => {
      requestContext.run({ traceId: 'inner' }, () => expect(getTraceId()).toBe('inner'));
      expect(getTraceId()).toBe('outer');
    });
  });

  it('survives awaits and stays isolated between concurrent flows', async () => {
    const seen: string[] = [];
    const flow = (id: string, delay: number) =>
      requestContext.run({ traceId: id }, async () => {
        await new Promise((r) => setTimeout(r, delay));
        seen.push(`${id}:${getTraceId()}`);
      });
    await Promise.all([flow('a', 15), flow('b', 1)]);
    expect(seen.sort()).toEqual(['a:a', 'b:b']);
  });
});

describe('mailOption', () => {
  it('packs recipient, subject and html', () => {
    expect(mailOption('a@b.c', 'Subject', '<b>hi</b>')).toEqual({
      to: 'a@b.c',
      subject: 'Subject',
      html: '<b>hi</b>',
    });
  });
});
