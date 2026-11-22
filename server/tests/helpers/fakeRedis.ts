/**
 * In-memory stand-in for the subset of `ioredis` commands this codebase uses.
 *
 * Why not `vi.fn()` per command? Business rules here rely on Redis *semantics*
 * (SET NX locks, TTL expiry, hash/zset/geo state, idempotency keys, MULTI pipelines).
 * A behavioural fake lets tests assert on real state ("lock key exists", "key expired
 * after 15s") instead of asserting on call order, which makes tests resilient to
 * refactors and far more meaningful.
 *
 * TTL handling uses `Date.now()` so `vi.useFakeTimers()` / `vi.setSystemTime()` /
 * `vi.advanceTimersByTime()` expire keys deterministically.
 *
 * Only commands present in `src/` are implemented. Unknown commands throw loudly so
 * a missing command is noticed immediately rather than silently returning undefined.
 */

type Kind = 'string' | 'hash' | 'set' | 'zset' | 'list' | 'geo';

interface Entry {
  kind: Kind;
  value: any;
  expiresAt?: number;
}

const WRONGTYPE =
  'WRONGTYPE Operation against a key holding the wrong kind of value';

const toStr = (v: unknown): string => String(v);

const UNIT_TO_METERS: Record<string, number> = {
  m: 1,
  km: 1000,
  mi: 1609.344,
  ft: 0.3048,
};

const haversineMeters = (
  lng1: number,
  lat1: number,
  lng2: number,
  lat2: number,
): number => {
  const R = 6372797.560856; // radius Redis uses for GEO commands
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
};

const globToRegExp = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
};

export class FakeRedis {
  status: 'wait' | 'ready' | 'end' = 'ready';
  private store = new Map<string, Entry>();

  // ---------------------------------------------------------------- plumbing
  /** Wipes all keys (called before every test by tests/setup/global.setup.ts). */
  reset(): void {
    this.store.clear();
    this.status = 'ready';
  }

  /** Test helper: synchronous snapshot of a string key. */
  peek(key: string): string | null {
    const e = this.live(key);
    return e && e.kind === 'string' ? e.value : null;
  }

  /** Test helper: all live keys. */
  allKeys(): string[] {
    return [...this.store.keys()].filter((k) => this.live(k));
  }

  private live(key: string): Entry | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== undefined && e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  private typed(key: string, kind: Kind, create = false): Entry | undefined {
    const existing = this.live(key);
    if (existing) {
      // geo keys are sorted sets in real Redis
      const compatible =
        existing.kind === kind ||
        (kind === 'zset' && existing.kind === 'geo') ||
        (kind === 'geo' && existing.kind === 'zset');
      if (!compatible) throw new Error(WRONGTYPE);
      return existing;
    }
    if (!create) return undefined;
    const initial =
      kind === 'string'
        ? ''
        : kind === 'hash'
          ? new Map<string, string>()
          : kind === 'set'
            ? new Set<string>()
            : kind === 'list'
              ? ([] as string[])
              : new Map<string, any>(); // zset & geo
    const entry: Entry = { kind, value: initial };
    this.store.set(key, entry);
    return entry;
  }

  // ---------------------------------------------------------------- connection
  on(): this {
    return this;
  }
  async connect(): Promise<void> {
    this.status = 'ready';
  }
  async quit(): Promise<'OK'> {
    this.status = 'end';
    return 'OK';
  }
  async ping(): Promise<'PONG'> {
    return 'PONG';
  }
  async flushall(): Promise<'OK'> {
    this.store.clear();
    return 'OK';
  }

  // ---------------------------------------------------------------- strings / keys
  async get(key: string): Promise<string | null> {
    const e = this.typed(key, 'string');
    return e ? e.value : null;
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    const flat = keys.flat();
    return Promise.all(flat.map((k) => this.get(k)));
  }

  /**
   * SET key value [EX s | PX ms | EXAT | PXAT | KEEPTTL] [NX | XX] [GET]
   * Returns 'OK', or null when NX/XX precondition fails.
   */
  async set(
    key: string,
    value: string | number | Buffer,
    ...args: Array<string | number>
  ): Promise<'OK' | string | null> {
    let ttlMs: number | undefined;
    let nx = false;
    let xx = false;
    let keepTtl = false;
    let returnOld = false;

    for (let i = 0; i < args.length; i++) {
      const opt = toStr(args[i]).toUpperCase();
      if (opt === 'EX') ttlMs = Number(args[++i]) * 1000;
      else if (opt === 'PX') ttlMs = Number(args[++i]);
      else if (opt === 'EXAT') ttlMs = Number(args[++i]) * 1000 - Date.now();
      else if (opt === 'PXAT') ttlMs = Number(args[++i]) - Date.now();
      else if (opt === 'NX') nx = true;
      else if (opt === 'XX') xx = true;
      else if (opt === 'KEEPTTL') keepTtl = true;
      else if (opt === 'GET') returnOld = true;
      else throw new Error(`FakeRedis.set: unsupported option ${opt}`);
    }

    const existing = this.live(key);
    const old = existing && existing.kind === 'string' ? existing.value : null;
    if ((nx && existing) || (xx && !existing)) {
      return returnOld ? old : null;
    }

    const entry: Entry = { kind: 'string', value: toStr(value) };
    if (ttlMs !== undefined) entry.expiresAt = Date.now() + ttlMs;
    else if (keepTtl && existing?.expiresAt !== undefined) {
      entry.expiresAt = existing.expiresAt;
    }
    this.store.set(key, entry);
    return returnOld ? old : 'OK';
  }

  async setex(key: string, seconds: number, value: string | number) {
    return this.set(key, value, 'EX', seconds);
  }

  async setnx(key: string, value: string | number): Promise<0 | 1> {
    return (await this.set(key, value, 'NX')) === 'OK' ? 1 : 0;
  }

  async del(...keys: Array<string | string[]>): Promise<number> {
    let n = 0;
    for (const k of keys.flat()) {
      if (this.live(k)) {
        this.store.delete(k);
        n++;
      }
    }
    return n;
  }

  async unlink(...keys: Array<string | string[]>): Promise<number> {
    return this.del(...keys);
  }

  async exists(...keys: Array<string | string[]>): Promise<number> {
    return keys.flat().filter((k) => this.live(k)).length;
  }

  async expire(key: string, seconds: number): Promise<0 | 1> {
    const e = this.live(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async pexpire(key: string, ms: number): Promise<0 | 1> {
    const e = this.live(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + ms;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const e = this.live(key);
    if (!e) return -2;
    if (e.expiresAt === undefined) return -1;
    return Math.ceil((e.expiresAt - Date.now()) / 1000);
  }

  async pttl(key: string): Promise<number> {
    const e = this.live(key);
    if (!e) return -2;
    if (e.expiresAt === undefined) return -1;
    return e.expiresAt - Date.now();
  }

  async incrby(key: string, by: number): Promise<number> {
    const e = this.typed(key, 'string');
    const cur = e ? e.value : '0';
    if (!/^-?\d+$/.test(cur)) {
      throw new Error('ERR value is not an integer or out of range');
    }
    const next = Number(cur) + Number(by);
    const entry: Entry = { kind: 'string', value: String(next) };
    if (e?.expiresAt !== undefined) entry.expiresAt = e.expiresAt;
    this.store.set(key, entry);
    return next;
  }
  async incr(key: string) {
    return this.incrby(key, 1);
  }
  async decrby(key: string, by: number) {
    return this.incrby(key, -Number(by));
  }
  async decr(key: string) {
    return this.incrby(key, -1);
  }

  async keys(pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern);
    return this.allKeys().filter((k) => re.test(k));
  }

  /** SCAN cursor [MATCH p] [COUNT n] — single-page implementation (always cursor '0'). */
  async scan(
    _cursor: string | number,
    ...args: Array<string | number>
  ): Promise<[string, string[]]> {
    let match = '*';
    for (let i = 0; i < args.length; i++) {
      if (toStr(args[i]).toUpperCase() === 'MATCH') match = toStr(args[++i]);
    }
    return ['0', await this.keys(match)];
  }

  // ---------------------------------------------------------------- hashes
  async hset(
    key: string,
    ...args: any[]
  ): Promise<number> {
    const e = this.typed(key, 'hash', true)!;
    const h = e.value as Map<string, string>;
    let added = 0;
    const pairs: Array<[string, string]> = [];
    if (args.length === 1 && args[0] && typeof args[0] === 'object') {
      const src =
        args[0] instanceof Map ? [...args[0].entries()] : Object.entries(args[0]);
      for (const [f, v] of src) pairs.push([f, toStr(v)]);
    } else {
      for (let i = 0; i < args.length; i += 2) {
        pairs.push([toStr(args[i]), toStr(args[i + 1])]);
      }
    }
    for (const [f, v] of pairs) {
      if (!h.has(f)) added++;
      h.set(f, v);
    }
    return added;
  }

  async hmset(key: string, ...args: any[]): Promise<'OK'> {
    await this.hset(key, ...args);
    return 'OK';
  }

  async hget(key: string, field: string): Promise<string | null> {
    const e = this.typed(key, 'hash');
    return e ? ((e.value as Map<string, string>).get(field) ?? null) : null;
  }

  async hmget(key: string, ...fields: Array<string | string[]>) {
    return Promise.all(fields.flat().map((f) => this.hget(key, f)));
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const e = this.typed(key, 'hash');
    return e ? Object.fromEntries(e.value as Map<string, string>) : {};
  }

  async hdel(key: string, ...fields: Array<string | string[]>): Promise<number> {
    const e = this.typed(key, 'hash');
    if (!e) return 0;
    const h = e.value as Map<string, string>;
    let n = 0;
    for (const f of fields.flat()) if (h.delete(f)) n++;
    if (h.size === 0) this.store.delete(key);
    return n;
  }

  async hexists(key: string, field: string): Promise<0 | 1> {
    return (await this.hget(key, field)) === null ? 0 : 1;
  }

  async hkeys(key: string): Promise<string[]> {
    return Object.keys(await this.hgetall(key));
  }

  async hvals(key: string): Promise<string[]> {
    return Object.values(await this.hgetall(key));
  }

  async hlen(key: string): Promise<number> {
    return Object.keys(await this.hgetall(key)).length;
  }

  async hincrby(key: string, field: string, by: number): Promise<number> {
    const e = this.typed(key, 'hash', true)!;
    const h = e.value as Map<string, string>;
    const cur = h.get(field) ?? '0';
    if (!/^-?\d+$/.test(cur)) {
      throw new Error('ERR hash value is not an integer');
    }
    const next = Number(cur) + Number(by);
    h.set(field, String(next));
    return next;
  }

  // ---------------------------------------------------------------- sets
  async sadd(key: string, ...members: Array<string | string[]>): Promise<number> {
    const e = this.typed(key, 'set', true)!;
    const s = e.value as Set<string>;
    let n = 0;
    for (const m of members.flat().map(toStr)) {
      if (!s.has(m)) {
        s.add(m);
        n++;
      }
    }
    return n;
  }

  async srem(key: string, ...members: Array<string | string[]>): Promise<number> {
    const e = this.typed(key, 'set');
    if (!e) return 0;
    const s = e.value as Set<string>;
    let n = 0;
    for (const m of members.flat().map(toStr)) if (s.delete(m)) n++;
    if (s.size === 0) this.store.delete(key);
    return n;
  }

  async smembers(key: string): Promise<string[]> {
    const e = this.typed(key, 'set');
    return e ? [...(e.value as Set<string>)] : [];
  }

  async sismember(key: string, member: string): Promise<0 | 1> {
    const e = this.typed(key, 'set');
    return e && (e.value as Set<string>).has(toStr(member)) ? 1 : 0;
  }

  async scard(key: string): Promise<number> {
    const e = this.typed(key, 'set');
    return e ? (e.value as Set<string>).size : 0;
  }

  // ---------------------------------------------------------------- sorted sets
  async zadd(key: string, ...args: Array<string | number>): Promise<number> {
    const e = this.typed(key, 'zset', true)!;
    const z = e.value as Map<string, number | { score: number }>;
    let added = 0;
    for (let i = 0; i < args.length; i += 2) {
      const score = Number(args[i]);
      const member = toStr(args[i + 1]);
      if (!z.has(member)) added++;
      const prev = z.get(member);
      z.set(
        member,
        prev && typeof prev === 'object' ? { ...prev, score } : score,
      );
    }
    return added;
  }

  private zscoreOf(v: number | { score: number }): number {
    return typeof v === 'object' ? v.score : v;
  }

  async zrem(key: string, ...members: Array<string | string[]>): Promise<number> {
    const e = this.typed(key, 'zset');
    if (!e) return 0;
    const z = e.value as Map<string, any>;
    let n = 0;
    for (const m of members.flat().map(toStr)) if (z.delete(m)) n++;
    if (z.size === 0) this.store.delete(key);
    return n;
  }

  async zscore(key: string, member: string): Promise<string | null> {
    const e = this.typed(key, 'zset');
    const v = e ? (e.value as Map<string, any>).get(toStr(member)) : undefined;
    return v === undefined ? null : String(this.zscoreOf(v));
  }

  async zcard(key: string): Promise<number> {
    const e = this.typed(key, 'zset');
    return e ? (e.value as Map<string, any>).size : 0;
  }

  async zrange(
    key: string,
    start: number,
    stop: number,
    withScores?: string,
  ): Promise<string[]> {
    const e = this.typed(key, 'zset');
    if (!e) return [];
    const sorted = [...(e.value as Map<string, any>).entries()].sort(
      (a, b) => this.zscoreOf(a[1]) - this.zscoreOf(b[1]) || a[0].localeCompare(b[0]),
    );
    const len = sorted.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const t = stop < 0 ? len + stop : stop;
    const slice = sorted.slice(s, t + 1);
    return withScores?.toUpperCase() === 'WITHSCORES'
      ? slice.flatMap(([m, v]) => [m, String(this.zscoreOf(v))])
      : slice.map(([m]) => m);
  }

  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<string[]> {
    const e = this.typed(key, 'zset');
    if (!e) return [];
    const lo = min === '-inf' ? -Infinity : Number(min);
    const hi = max === '+inf' || max === 'inf' ? Infinity : Number(max);
    return [...(e.value as Map<string, any>).entries()]
      .filter(([, v]) => this.zscoreOf(v) >= lo && this.zscoreOf(v) <= hi)
      .sort((a, b) => this.zscoreOf(a[1]) - this.zscoreOf(b[1]))
      .map(([m]) => m);
  }

  // ---------------------------------------------------------------- lists
  async rpush(key: string, ...values: Array<string | number>): Promise<number> {
    const e = this.typed(key, 'list', true)!;
    (e.value as string[]).push(...values.map(toStr));
    return (e.value as string[]).length;
  }

  async lpush(key: string, ...values: Array<string | number>): Promise<number> {
    const e = this.typed(key, 'list', true)!;
    for (const v of values) (e.value as string[]).unshift(toStr(v));
    return (e.value as string[]).length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const e = this.typed(key, 'list');
    if (!e) return [];
    const list = e.value as string[];
    const len = list.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const t = stop < 0 ? len + stop : stop;
    return list.slice(s, t + 1);
  }

  async llen(key: string): Promise<number> {
    const e = this.typed(key, 'list');
    return e ? (e.value as string[]).length : 0;
  }

  async lpop(key: string): Promise<string | null> {
    const e = this.typed(key, 'list');
    return e ? ((e.value as string[]).shift() ?? null) : null;
  }

  async rpop(key: string): Promise<string | null> {
    const e = this.typed(key, 'list');
    return e ? ((e.value as string[]).pop() ?? null) : null;
  }

  async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    const e = this.typed(key, 'list');
    if (e) e.value = await this.lrange(key, start, stop);
    return 'OK';
  }

  // ---------------------------------------------------------------- geo
  async geoadd(key: string, ...args: Array<string | number>): Promise<number> {
    const e = this.typed(key, 'geo', true)!;
    e.kind = 'geo';
    const z = e.value as Map<string, { score: number; lng: number; lat: number }>;
    let added = 0;
    for (let i = 0; i < args.length; i += 3) {
      const lng = Number(args[i]);
      const lat = Number(args[i + 1]);
      const member = toStr(args[i + 2]);
      if (!z.has(member)) added++;
      z.set(member, { score: 0, lng, lat });
    }
    return added;
  }

  async geopos(
    key: string,
    ...members: string[]
  ): Promise<Array<[string, string] | null>> {
    const e = this.typed(key, 'geo');
    const z = e?.value as Map<string, { lng: number; lat: number }> | undefined;
    return members.map((m) => {
      const p = z?.get(toStr(m));
      return p ? [String(p.lng), String(p.lat)] : null;
    });
  }

  async geodist(
    key: string,
    a: string,
    b: string,
    unit = 'm',
  ): Promise<string | null> {
    const [pa, pb] = await this.geopos(key, a, b);
    if (!pa || !pb) return null;
    const meters = haversineMeters(+pa[0], +pa[1], +pb[0], +pb[1]);
    return (meters / UNIT_TO_METERS[unit.toLowerCase()]).toFixed(4);
  }

  /**
   * GEORADIUS key lng lat radius unit [WITHDIST] [WITHCOORD] [COUNT n] [ASC|DESC]
   * Without WITH* flags returns `string[]`; with them returns nested arrays like ioredis.
   */
  async georadius(
    key: string,
    lng: number,
    lat: number,
    radius: number,
    unit: string,
    ...opts: Array<string | number>
  ): Promise<any[]> {
    const e = this.typed(key, 'geo');
    if (!e) return [];
    const factor = UNIT_TO_METERS[unit.toLowerCase()];
    if (!factor) throw new Error('ERR unsupported unit provided. please use M, KM, FT, MI');

    let withDist = false;
    let withCoord = false;
    let count: number | undefined;
    let desc = false;
    for (let i = 0; i < opts.length; i++) {
      const o = toStr(opts[i]).toUpperCase();
      if (o === 'WITHDIST') withDist = true;
      else if (o === 'WITHCOORD') withCoord = true;
      else if (o === 'COUNT') count = Number(opts[++i]);
      else if (o === 'DESC') desc = true;
      else if (o === 'ASC' || o === 'WITHHASH') continue;
      else throw new Error(`FakeRedis.georadius: unsupported option ${o}`);
    }

    const hits = [...(e.value as Map<string, { lng: number; lat: number }>).entries()]
      .map(([member, p]) => ({
        member,
        p,
        dist: haversineMeters(lng, lat, p.lng, p.lat) / factor,
      }))
      .filter((h) => h.dist <= radius)
      .sort((a, b) => (desc ? b.dist - a.dist : a.dist - b.dist));

    const limited = count !== undefined ? hits.slice(0, count) : hits;
    if (!withDist && !withCoord) return limited.map((h) => h.member);
    return limited.map((h) => {
      const row: any[] = [h.member];
      if (withDist) row.push(h.dist.toFixed(4));
      if (withCoord) row.push([String(h.p.lng), String(h.p.lat)]);
      return row;
    });
  }

  // ---------------------------------------------------------------- pipelines
  /** MULTI / pipeline: queues commands, `exec()` resolves `[[err, result], ...]`. */
  multi(): any {
    const self = this;
    const queue: Array<[string, any[]]> = [];
    const pipeline: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'exec') {
            return async () => {
              const results: Array<[Error | null, unknown]> = [];
              for (const [cmd, args] of queue) {
                try {
                  results.push([null, await (self as any)[cmd](...args)]);
                } catch (err) {
                  results.push([err as Error, undefined]);
                }
              }
              return results;
            };
          }
          if (prop === 'then') return undefined; // not thenable
          return (...args: any[]) => {
            if (typeof (self as any)[prop] !== 'function') {
              throw new Error(`FakeRedis.multi: unsupported command "${prop}"`);
            }
            queue.push([prop, args]);
            return pipeline;
          };
        },
      },
    );
    return pipeline;
  }

  pipeline(): any {
    return this.multi();
  }
}

/** Process-wide singleton returned by the mocked `getRedisClient()`. */
export const fakeRedis = new FakeRedis();
