# Server test suite

Unit tests for the Split Ride API (`server/`). Runner: **Vitest 3.2** (`vitest.config.mts`).

```bash
# from server/
npm test                      # run everything once
npm run test:watch            # watch mode
npm run test:coverage         # + v8 coverage -> coverage/ (html, lcov, text)
npm run test:types            # type-check src + tests (tests/tsconfig.json)
npx vitest run tests/unit/utils/fareMath.utils.test.ts      # one file
npx vitest run -t "pending -> completed"                    # by test name
npx tsc --noEmit              # production type gate (tests are NOT part of it)
```

> **Why Vitest 3.2 and not the newest 5.x?** 5.1.1 loads itself twice (setup file vs. worker)
> when the shell's cwd has a lower-case drive letter (`c:\...`, which Git Bash and some VS Code
> terminals produce), failing every suite with *"Vitest failed to find the runner"*. 3.2.4 is not
> affected.

## Layout

```
server/tests/
  unit/                     mirrors src/app/ :  unit/<same path as src/app>/<file>.test.ts
  helpers/                  shared fakes (see cookbook)
  setup/global.setup.ts     global mocks + per-test reset (redis/logger/firebase)
  stubs/dotenv.ts           no-op dotenv (the real .env is NEVER read by tests)
  tsconfig.json             type-checks tests with the @src / @tests aliases
```

Tests live outside `src/` on purpose: `tsconfig.json`/Docker only compile `src/`, so nothing
test-related reaches `dist/` or the image.

Import aliases (tests only): `@src/app/utils/x` = `server/src/app/utils/x`, `@tests/helpers/x`.

## Hermeticity guarantees

* `dotenv` is stubbed; every env var is defined in `vitest.config.mts` (`test.env`). Time zone is
  pinned to `Europe/Nicosia` (production zone).
* Redis is an in-memory fake (`helpers/fakeRedis.ts`) installed globally and wiped before each test.
  TTLs use `Date.now()` so fake timers expire keys.
* `logger.config` (creates log files at import) and `firebase.config` (initialises at import) are
  mocked globally.
* No network, no database, no real Stripe/Twilio/S3/SMTP/FCM. Everything external is mocked per file.
* `mockReset + restoreMocks + clearMocks + unstubEnvs + unstubGlobals` are on: no mock state, queued
  `...Once` value, spy or env stub leaks between tests; fake timers are reset after each test.

## Mocking cookbook

### DB models (every service/handler/job)

```ts
vi.mock('@src/app/modules/ride/ride.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Ride: createModelMock() };
});
import { Ride } from '@src/app/modules/ride/ride.model';
import { mockQuery, mockDoc, oidStr } from '@tests/helpers/mongoose';

vi.mocked(Ride.findById).mockReturnValue(mockQuery(mockDoc({ status: 'pending' })) as any);
```

* `createModelMock()` = constructor-capable fake with *safe defaults* (finders -> `null`/`[]`).
* `mockQuery(result, { error?, total?, filter? })` is chainable (`.select().sort().lean()...`) **and**
  awaitable. Every chain method is a `vi.fn` you can assert on. `mockQueryError(err)` rejects.
* `mockDoc(fields)` = document with `save()` (resolves to itself), `populate()`, `toObject()`.
* Multiple calls in one flow: `mockReturnValueOnce(...)` in call order.
* Mock **every** model module the file under test (transitively) touches, otherwise the real
  Mongoose model loads (harmless to import, but any query would hang waiting for a connection).

### Transactions

```ts
import mongoose from 'mongoose';
const session = mockSession();
vi.spyOn(mongoose, 'startSession').mockResolvedValue(session as any);
// ... expect(session.commitTransaction / abortTransaction / endSession)
```

### Redis

Use the real behaviour of the global fake: `fakeRedis.hset/hgetall/sadd/smembers/ttl/exists/...`.
Failure injection: `vi.spyOn(fakeRedis, 'get').mockRejectedValueOnce(new Error('redis down'))`.

### Time

`freezeTime('2026-03-20T00:00:00Z')` (fakes `Date` only; promises keep working). To advance:
`vi.setSystemTime(...)`. Use `useRideTimeZone('Asia/Dhaka')` to test zone switching. Never rely on
the machine's current time or zone.

### Socket.io

```ts
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));
const io = createMockIo();          vi.mocked(getIO).mockReturnValue(io as any);   // in beforeEach!
const socket = createMockSocket({ userId, role: 'provider' });
await handler.call(socket as any, data, ack);
io.payloadTo(`user:${id}`, 'ride:cancelled');  io.emittedTo(room, event);  socket.emit.mock.calls
```

Handlers are wrapped by `eventHandler`; errors thrown inside become `ack({success:false,message})`
plus `socket.emit('socketError', {...})`, assert on those.

### Express

`mockReq()/mockRes()/mockNext()` from `helpers/express.ts` (`res.body`, `res.statusCode` captured).

### Stripe / external SDKs

* Stripe: `helpers/stripeMock.ts` (see its header).
* `axios`: `vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }))`
* `twilio`: `vi.mock('twilio', () => ({ default: vi.fn(() => ({ messages: { create: vi.fn() } })) }))`
* `bullmq`: `vi.mock('bullmq', () => ({ Queue: vi.fn(function () { return { add: vi.fn(), close: vi.fn(), on: vi.fn() }; }), Worker: vi.fn(function () { return { on: vi.fn(), close: vi.fn() }; }) }))`
* push notifications / emails: mock `@src/app/utils/sentPushNotification`, `notifyUser.utils`, `queues/*`.

## Vitest-3 gotchas specific to this repo

* `mockReset: true` restores `vi.fn(impl)` to `impl`, but **wipes** `vi.fn().mockReturnValue(x)`
  made at module/factory level. Put per-test behaviour in the test or in `beforeEach`.
  A mock that must work for the whole file = `vi.fn(() => value)` (kept) or set in `beforeEach`.
* `vi.mock()` is hoisted above imports. Use async factories + dynamic `import()` for helpers, or
  `vi.hoisted()` for shared variables.
* A constructor mock must use `function`/`class` (not an arrow fn): `vi.fn(function () { return inst; })`.
* Mongoose models are mocked, so schema-level behaviour (validators, defaults, hooks, indexes) is
  **not** exercised; test that logic by importing the real model/schema where it matters
  (`Schema.validateSync`, `Model.schema.path(...)`), no DB needed.

## Conventions

* One `describe` per exported function/handler; `it('does X when Y')`; arrange-act-assert.
* Assert **outcomes and state** (return value, thrown `ApiError {code,message}`, Redis keys, emitted
  events, DB calls with arguments, wallet/refund amounts), not just "mock was called".
* Always test: happy path, each guard/branch, boundaries (0, 1, N, N+1, exact thresholds), invalid
  input (null/undefined/NaN/empty/wrong type), duplicate/idempotent calls, downstream failure
  (what is rolled back / not done), and that error paths cause **no** side effects.
* Money: assert exact cents; test rounding boundaries.
* Deterministic: no real timers/network/randomness (mock `Math.random`/crypto where used).
* No snapshot tests of large objects. No `expect(true)`. No assertions-free tests.

## Known-bug convention

When a test shows the production code is wrong, do **not** change the code and do **not** delete the
scenario. Write the test asserting the *correct* behaviour as `it.fails(...)` inside
`describe('KNOWN BUGS ...')`, with a comment block:

```ts
// BUG-REPORT <ID> | <severity> | <file>:<line>
// <what is wrong, why it matters, suggested fix in one line>
it.fails('BUG <ID>: <correct behaviour in plain words>', async () => { ... });
```

`it.fails` passes while the bug exists and turns red as soon as it is fixed, which tells the fixer
to delete the `.fails` marker. Use `CHARACTERIZATION:` / `LIMITATION:` name prefixes for tests that
merely pin down surprising-but-maybe-intended behaviour (no claim that it is wrong).
Find all open bugs with: `grep -rn "it.fails" tests/`.
