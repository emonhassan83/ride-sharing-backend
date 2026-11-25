# Load test results: before vs after optimisation

Date: 2026-11-24. Harness: `server/tests/load/`. Raw data: `server/tests/load/reports/<run>/`.
Full generated tables: `server/tests/load/reports/COMPARISON.md` (re-create with `node compare.cjs`).

Every number below was measured by these runs. Anything not run is listed under **Not tested**.

## 1. Test environment and limits (read first)

- One Windows host (i5-13400, 10 cores / 16 threads, 32 GB) runs **everything**: the server under test, MongoDB 7 and Redis 7 (Docker), and k6 (Docker). The load generator competes for CPU with the system under test, so absolute numbers are indicative, not capacity guarantees.
- The server ran from `ts-node --transpile-only` as a **single Node process** (1 instance), `NODE_ENV=development`, with request logging on.
- **Isolated stack only.** The shared Atlas database was never touched. The seeder refuses non-local URLs.
- Third parties are stubbed in `preload.cjs`: Google Maps (fixed 80 ms latency, counted), Stripe, Twilio, FCM. Maps call counts are real counts of calls the server made; real Google latency and cost are **not** measured.
- Data: 2,000 riders, 400 drivers, 50k rides / passengers / bookings, 96k notifications (REST and T1). T2 used 3,000 riders, 1,200 drivers, 75k rides, 168k notifications.
- Each scenario ran **once** per code version. Differences of a few percent are within run-to-run noise.
- "Before" `ramp` has no notification index. "Before" `*-idx` runs had that index added by hand in the test database, to isolate its effect. "After" runs get the index from the model code.

## 2. Root causes found (from measurements)

| # | Root cause | Evidence |
|---|---|---|
| 1 | **`notifications` had no index on `receiver`.** `GET /notification` ran two full collection scans (list + count) of every document per request. | Ramp: throughput stuck at 31 req/s with a 200 req/s target; p95 47.9 s. Mongo container ~1,450% CPU, 105 connections (pool full), 74 queued reads. Profiler: COLLSCAN, 96,000 docs examined, avg 4.1 s (count) / 12.1 s (find). Node CPU only ~25% of one core. |
| 2 | **Nearby-driver search awaited every candidate driver one at a time** (live check, ride-conflict query, Redis reads, one Maps call each), and made a Maps call per driver whose cache key contained the driver's exact position, so it never hit. | T1: `ride:get-nearby-drivers` p50 4.1 s at only ~2.3 searches/s while Node CPU was 25% and event-loop delay normal; 31,160 Maps calls for 487 searches (about 64 per search). T2: 2,038 of 2,064 searches timed out; 557,440 Maps calls. |
| 3 | **`io.emit('onlineUser', count)` to every socket on each driver go-online / go-offline.** Quadratic fan-out. | T1: 195,839 events delivered to clients; T2: 2,073,945. A 80-client probe showed `onlineUser` was the only repeating event. T2 location-ping p99 3.26 s, RSS 1.12 GB. |
| 4 | `Intl.DateTimeFormat` constructed on every call of the ride-schedule helpers. | CPU profile at 150 req/s: `getDepartureDateTime` 6.7% of non-idle CPU self time, the top application function. |
| 5 | Logging (console + morgan) | Same profile: self time of `writeBuffer` 6.9%, `logger.config` 3.8%, `consoleCall` 1.5%, `writev` 1.2% = about 13% of non-idle CPU. **Not changed.** |
| 6 | Single-threaded Node ceiling with no load shedding | Stress: ~200-210 req/s completed whatever the target; Node ~100-137% of a core; latency grows to 36 s with 0 server errors; RSS grew 380 MB to 1.4 GB while requests queued. Spike: 166 client `dial: i/o timeout`. |
| 7 | bcrypt cost 12 on the libuv pool (4 threads) | Login capacity ~18/s; at 30/s p50 10 s, Node ~400% CPU. **Not changed** (lowering the cost is a security decision). |

## 3. Changes made

| File | Change | Behaviour impact |
|---|---|---|
| `modules/notification/notification.model.ts` | Index `{receiver:1, createdAt:-1, _id:-1}` (matches the query's filter and sort). | None functionally. |
| `utils/geo.utils.ts` (`fetchDriversWithinRadius`) | Per-driver work runs with bounded concurrency (10) instead of strictly one by one. Result order and all filters unchanged. | None functionally. |
| `utils/maps.utils.ts` + `getNearbyDrivers.handler.ts` + `geo.utils.ts` | Opt-in `{ coarse: true }` cache key (3 decimals, about 110 m, separate `map:distance:c:` prefix) used **only** for display ETAs in the nearby-driver list. Fares, routes, accept, drop-off keep exact keys. | A listed driver's ETA/distance can come from a result computed for a point up to about 110 m away (the existing 10 min cache TTL already allowed stale values). |
| `socket/utils/onlineCountBroadcast.ts` (new) + go-online / go-offline handlers | Coalesce the `onlineUser` broadcast to one trailing emit per second, reading the count at emit time. | Clients see the count up to 1 s later. |
| `utils/rideSchedule.utils.ts` | Cache `Intl.DateTimeFormat` objects per locale + options. | None. |
| `tests/unit/utils/geo.utils.test.ts` | Two assertions updated for the new third argument. | Test only. |

Verification: `npx tsc --noEmit` clean, `npm run test:types` clean, `npm test` 1,205 / 1,205 passed. `npm run test:integration` passed 10 files / 123 tests on two reruns; **one earlier run reported "1 error" (all tests passed) and did not reproduce, so I could not diagnose it.** Server log of the last load run had no TypeError / unhandled-rejection / Mongo errors.

**Deployment note:** the new index is created by Mongoose at startup. On a large production `notifications` collection, build it first during low traffic (`createIndex` is an online build on MongoDB 4.2+, but it uses I/O and CPU).

## 4. Results

### REST read mix (rider 70% / driver 30%; 10 endpoints)

| Scenario | Run | req/s completed | p50 | p95 | p99 | Errors | Dropped | Server CPU avg/peak (% of 1 core) | RSS peak | Mongo conns |
|---|---|---|---|---|---|---|---|---|---|---|
| Ramp 10→200 | before (no index) | 31.4 | 9.18 s | 47.9 s | 54.0 s | 0% | 30,774 | 25 / 52 | 777 MB | 105 |
| | before (manual index) | 128.2 | 24 ms | 841 ms | 1.90 s | 0% | 276 | 65 / 118 | 649 MB | 105 |
| | **after** | **129.1** | **9 ms** | **41 ms** | **75 ms** | 0% | **0** | 58 / 104 | 562 MB | 43 |
| Stress to 2000 | before (manual index) | 199.9 | 5.79 s | 31.6 s | 36.3 s | 0% | 173,053 | 103 / 137 | 1,467 MB | 105 |
| | after | 207.6 | 5.67 s | 34.4 s | 35.5 s | 0% | 170,924 | 102 / 137 | 1,443 MB | 108 |
| Spike 30→800→30 | before (manual index) | 99.5 | 6.45 s | 30.6 s | 38.0 s | 0.83% (166) | 39,018 | 67 / 138 | 1,469 MB | 108 |
| | after | 116.0 | 5.54 s | 25.5 s | 34.7 s | 1.34% (294) | 37,026 | 67 / 141 | 1,430 MB | 108 |
| Login 10/s | before | 10.0 | 219 ms | 225 ms | 235 ms | 0% | 0 | 216 / 230 | 401 MB | 20 |
| | after | 10.0 | 218 ms | 224 ms | 229 ms | 0% | 0 | 212 / 227 | 381 MB | 19 |
| Login 30/s | before | 18.3 | 10.29 s | 18.7 s | 19.5 s | 0% | 344 | 399 / 424 | 397 MB | 19 |
| | after | 18.3 | 10.21 s | 18.8 s | 19.6 s | 0% | 345 | 400 / 413 | 397 MB | 19 |

Reading it honestly:

- **The index is the big win.** Against the true "before" (no index), the same ramp went from 31 to 129 req/s completed, p95 47.9 s to 41 ms, with nothing dropped. At production data sizes the gap would be larger, because the scan cost grows with the collection.
- Against "manual index only", `after` is also better on p95 (841 ms to 41 ms) and p99 (1.90 s to 75 ms), with event-loop p99 290 ms to 27 ms and Mongo connections 105 to 43. The earlier `ramp-idx` showed a stall when load stepped to 200 req/s. I **cannot attribute** that extra gain to the date-formatter cache or to anything else in particular, because I did not run the changes one at a time. Treat it as "no regression and likely better", confirm with repeat runs.
- **Stress and spike did not improve**, as expected: those changes do not touch the single-core ceiling. Spike errors went 166 to 294 (0.83% to 1.34%). All are `dial: i/o timeout` in both runs. With one run each I cannot tell whether that is noise or a real change.
- Login is unchanged (as expected; no code touched).

### Realtime (Socket.io), identical client scripts

| Tier | Run | Location ping p50 / p95 / p99 | Nearby searches completed | Nearby timeouts | Nearby p50 / p95 / p99 | Maps calls | Events received by clients | Server CPU avg/peak | RSS peak | Mongo CPU avg |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 (300 drv / 1,000 riders, ~150 searches/min) | before | 9.2 / 29 / 41 ms | 487 | 0 | 4.11 s / 5.89 s / 6.22 s | 31,160 | 195,839 | 27 / 63 | 406 MB | 18% |
| | **after** | 10.4 / 29 / 42 ms | 508 | 0 | **624 ms / 725 ms / 749 ms** | 26,072 | **20,895** | 27 / 43 | 416 MB | 19% |
| T2 (1,000 drv / 3,000 riders, ~750 searches/min) | before | 60.5 ms / 1.05 s / 3.26 s | 26 | **2,038** | 3.82 s / 9.61 s / 9.72 s | 557,440 | 2,073,945 | 97 / 121 | 1,122 MB | 89% |
| | **after** | **32 / 87 / 126 ms** | **2,138** | **0** | 2.22 s / 2.72 s / 3.12 s | 411,798 | **81,005** | 89 / 116 | 885 MB | 100% |

- T1: nearby search about 6.6x faster at p50; client-bound event traffic down 89%. Location pings unchanged (they were already healthy).
- T2: before, **98.7% of nearby searches timed out** (10 s client timeout). After, none did. Ping p99 3.26 s to 126 ms. Events down 96%. RSS down 21%.
- The T2 nearby p50 is not comparable one-to-one (before only 26 searches completed). The reliable comparison is the timeout rate and p95.
- Maps calls dropped only 16% (T1) and 26% per search (T2: about 270 to 193 per attempted search, counting the before-run's timed-out searches). The load test uses uniformly random pickups, so coarse-cell sharing is low. With real clustered pickups it may be better, **but I did not measure that.**

## 5. Remaining bottlenecks (ranked)

1. **One Node process saturates a core at about 200 req/s on this read mix** (about 5 ms CPU per request) and has no load shedding: latency grows without bound, memory climbs to about 1.4 GB, new connections time out in spikes. Fixes: run several instances (needs the Socket.io Redis adapter and a lock around cron jobs, see `docs/LOAD_TESTING_STRATEGY.md`), set server request/headers/keep-alive timeouts, and shed load (503 / `maxConnections`) before the queue explodes. Cut per-request CPU: logging (about 13% of busy CPU), Mongoose document hydration (18% of all sampled time in the 150 req/s profile, with idle at 31%; consider `.lean()` on list reads).
2. **Nearby search still costs about 51 (T1) to 193 (T2) Maps calls per search** and p50 is 2.2 s at T2 with Mongo at about 100% CPU. Suggested: rank by straight-line distance from Redis GEO and call Maps only for the nearest 5-10; drop the extra Mongo `$nearSphere` query when Redis GEO is available; avoid the per-driver `Ride.find` (`hasDriverRideAtDateTime`) by batching into one `$in` query. These change what riders see, so they need a product decision.
3. **Login throughput about 18/s** (bcrypt cost 12, 4 libuv threads). Raise `UV_THREADPOOL_SIZE` only if CPU allows, and add rate limits. Do not lower the cost without a security review.
4. Spike resilience: the accept queue overflowed (dial timeouts) in both versions.
5. Lower-priority items from the earlier audit that were not exercised here (ReDoS email regex, unauthenticated upload, no rate limits, `KEYS` usage, cron full scans).

## 6. Not tested (no results exist; do not infer any)

- Money-concurrency tests (double refund, capture races, duplicate PaymentIntents). Stripe was stubbed, so the money paths never ran.
- Ride request / accept / start / complete end-to-end, split-fare recalculation, chat, cron jobs under load.
- Soak (memory leak) test, Redis or Mongo outage, multi-instance scaling.
- The email-ReDoS and upload-DoS reproductions.
- Behaviour against real Google Maps latency and billing, or against production-sized data.
- No tests ran against production or the shared database.

## 7. Re-running

```bash
cd server/tests/load
docker compose -f docker-compose.load.yml up -d
npm install
(cd runtime && node ../../../node_modules/ts-node/dist/bin.js --transpile-only -P ../../../tsconfig.json ../seed.ts)
./run-scenario.sh ramp-after ramp        # also: stress | spike | login (-e LOGIN_RATE=30)
./run-ws.sh ws-T1-after --drivers 300 --riders 1000 --ping-ms 4000 --search-per-min-per-rider 0.15 --duration-s 180 --ramp-s 30
node analyze.cjs ramp-after 15 && node compare.cjs
```
