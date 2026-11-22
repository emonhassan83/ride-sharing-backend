/**
 * Helpers for faking Mongoose without a database.
 *
 * Services call things like:
 *   await Model.find(filter).select('a b').sort('-createdAt').limit(5).lean();
 *   const doc = await Model.findById(id).session(session);
 *
 * `mockQuery(result)` returns an object that is BOTH chainable (every query-builder
 * method returns the same object) and awaitable (resolves to `result`, or rejects when
 * `error` is given). Every builder method is a `vi.fn()` so a test can assert e.g.
 * `expect(q.sort).toHaveBeenCalledWith('-createdAt')`.
 *
 * It also supports what `builder/QueryBuilder.ts` needs: `getFilter()` and
 * `model.countDocuments()`.
 */
import { vi } from 'vitest';
import { Types } from 'mongoose';

/** Fresh ObjectId. */
export const oid = (): Types.ObjectId => new Types.ObjectId();
/** Fresh ObjectId as a 24-char hex string. */
export const oidStr = (): string => new Types.ObjectId().toString();

const CHAIN_METHODS = [
  'select',
  'lean',
  'sort',
  'limit',
  'skip',
  'populate',
  'session',
  'where',
  'collation',
  'hint',
  'allowDiskUse',
  'read',
  'maxTimeMS',
  'find',
  'projection',
  'cursor',
  'distinct',
] as const;

export interface MockQuery<T = unknown> extends PromiseLike<T> {
  [method: string]: any;
  exec: ReturnType<typeof vi.fn>;
  catch: (onRejected: (e: unknown) => unknown) => Promise<unknown>;
  finally: (cb: () => void) => Promise<unknown>;
}

export interface MockQueryOptions {
  /** When set, awaiting the query rejects with this error instead of resolving. */
  error?: unknown;
  /** What `query.getFilter()` returns (QueryBuilder.countTotal). */
  filter?: Record<string, unknown>;
  /** What `query.model.countDocuments(...)` resolves to (QueryBuilder.countTotal). */
  total?: number;
}

/**
 * Chainable + thenable fake of a Mongoose Query.
 * @param result value the awaited query resolves to
 */
export function mockQuery<T>(result: T, opts: MockQueryOptions = {}): MockQuery<T> {
  const settle = (): Promise<T> =>
    opts.error !== undefined ? Promise.reject(opts.error) : Promise.resolve(result);

  const total = opts.total ?? (Array.isArray(result) ? result.length : 0);

  const q: any = {};
  for (const m of CHAIN_METHODS) q[m] = vi.fn(() => q);
  q.exec = vi.fn(() => settle());
  q.then = (onFulfilled?: any, onRejected?: any) => settle().then(onFulfilled, onRejected);
  q.catch = (onRejected: any) => settle().catch(onRejected);
  q.finally = (cb: () => void) => settle().finally(cb);
  q.getFilter = vi.fn(() => opts.filter ?? {});
  q.getQuery = q.getFilter;
  q.model = { countDocuments: vi.fn(async () => total) };
  q.countDocuments = vi.fn(() => mockQuery(total));
  return q as MockQuery<T>;
}

/** Shorthand: query that rejects. */
export const mockQueryError = (error: unknown): MockQuery<never> =>
  mockQuery<never>(undefined as never, { error });

export interface MockSession {
  startTransaction: ReturnType<typeof vi.fn>;
  commitTransaction: ReturnType<typeof vi.fn>;
  abortTransaction: ReturnType<typeof vi.fn>;
  endSession: ReturnType<typeof vi.fn>;
  withTransaction: ReturnType<typeof vi.fn>;
  inTransaction: ReturnType<typeof vi.fn>;
}

/**
 * Fake `ClientSession`. `withTransaction(fn)` simply runs `fn(session)`.
 * Wire it with: `vi.spyOn(mongoose, 'startSession').mockResolvedValue(session as any)`.
 */
export function mockSession(): MockSession {
  const session: MockSession = {
    startTransaction: vi.fn(),
    commitTransaction: vi.fn(async () => undefined),
    abortTransaction: vi.fn(async () => undefined),
    endSession: vi.fn(),
    withTransaction: vi.fn(async (fn: (s: MockSession) => Promise<unknown>) => fn(session)),
    inTransaction: vi.fn(() => true),
  };
  return session;
}

/**
 * Fake a Mongoose *document* (what `findById(...)` returns when not `.lean()`):
 * a plain object that also has `save()`, `toObject()`, `toJSON()` and `populate()`.
 * `save()` resolves to the doc itself, mutations on the doc are visible to the test.
 */
export function mockDoc<T extends Record<string, any>>(fields: T) {
  const doc: any = {
    _id: fields._id ?? oid(),
    ...fields,
    toObject: vi.fn(() => ({ ...fields })),
    toJSON: vi.fn(() => ({ ...fields })),
    markModified: vi.fn(),
    isModified: vi.fn(() => true),
  };
  doc.save = vi.fn(async () => doc);
  doc.populate = vi.fn(async () => doc);
  // `Record<string, any>` lets tests read/write fields the code under test adds later.
  return doc as T & Record<string, any> & {
    _id: Types.ObjectId;
    save: ReturnType<typeof vi.fn>;
    toObject: ReturnType<typeof vi.fn>;
    toJSON: ReturnType<typeof vi.fn>;
    populate: ReturnType<typeof vi.fn>;
    markModified: ReturnType<typeof vi.fn>;
    isModified: ReturnType<typeof vi.fn>;
  };
}
