/**
 * Minimal Express req/res/next fakes for middleware & controller unit tests.
 */
import { vi } from 'vitest';

export interface MockRes {
  locals: Record<string, any>;
  statusCode?: number;
  headers: Record<string, string>;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  /** The JSON payload passed to `res.json(...)` (undefined if never called). */
  body: any;
  req?: any;
}

export const mockReq = (overrides: Record<string, any> = {}): any => ({
  method: 'GET',
  originalUrl: '/api/v1/test',
  headers: {},
  params: {},
  query: {},
  body: {},
  cookies: {},
  ...overrides,
});

export const mockRes = (): MockRes => {
  const res: MockRes = {
    locals: {},
    headers: {},
    body: undefined,
    status: vi.fn(),
    json: vi.fn(),
    send: vi.fn(),
    setHeader: vi.fn(),
    set: vi.fn(),
  };
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json.mockImplementation((payload: unknown) => {
    res.body = payload;
    return res;
  });
  res.send.mockImplementation((payload: unknown) => {
    res.body = payload;
    return res;
  });
  res.setHeader.mockImplementation((k: string, v: string) => {
    res.headers[k.toLowerCase()] = v;
    return res;
  });
  res.set.mockImplementation((k: string, v: string) => {
    res.headers[k.toLowerCase()] = v;
    return res;
  });
  return res;
};

export const mockNext = () => vi.fn();
