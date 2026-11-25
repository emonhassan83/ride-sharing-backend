# Load Testing Strategy: Split Ride Backend

Status: analysis and plan only. No production code was changed to produce this document.
Date: 2026-11-24. Scope: `server/` (Express + Socket.io + cron + BullMQ producer) and `worker/`.

Each finding below has a file reference and a tag:

- **[V]**: verified by reading the code, and by local measurement where noted.
- **[S]**: a suspicion that a test needs to confirm.

---

## 0. Ground rules (read first)

1. **Never load test the shared dev/prod environment.**
   - Why: `.agents/SUMMARY.md` records that dev and prod share one MongoDB.
   - Do instead: run every test against a fully isolated stack (own MongoDB, own Redis, own server and worker) built from `docker-compose.yml` with a separate `MONGODB_URL`.
2. **Stub or limit paid third parties.**
   - Why: the current code calls these services for real.

   | Dependency | Risk | How to handle it in tests |
   |---|---|---|
   | Google Maps (Distance Matrix + Directions) | Cost per call; there is no host override. | Unset `GOOGLE_MAPS_API_KEY` for volume runs, which uses the straight-line fallback in `utils/maps.utils.ts`. Run one short, capped *cost probe* with a real key and count `📍 Google Maps` log lines. |
   | Stripe | Test mode allows about 25 req/s. There are 5 separate `new Stripe()` clients and no host override. | Volume runs use **wallet-funded riders**, so no card authorization is needed. Money-correctness runs use Stripe **test mode at low request rates**, because those tests need concurrency, not volume. |
   | Twilio SMS | Cost per SMS. | Use `NODE_ENV=development` on the isolated stack only (SMS is mocked there), or Twilio test credentials. |
   | FCM | Real pushes. | Seed users with fake FCM tokens. Calls fail fast but still exercise the code path. |
   | `date.nager.at` holidays | No timeout and failures are not cached (`fareCalculator.ts:108-118`). | Leave it reachable. Run one chaos test with it blackholed. |
3. **Seed realistic data volumes before measuring.** Most of the read-path problems below scale with *history*, not with concurrent load, so an empty database hides them. See §5.

---

## 1. Executive summary: top risks

Ranked by likelihood × impact at realistic scale:

| # | Risk | Type | Evidence |
|---|---|---|---|
| 1 | Concurrent cancels or confirms refund the same money twice | Race, money | `rideCancelAfterAccept.handler.ts:174-302` (read → `refundToWallet` → unconditional status update); `driverCancelRide.handler.ts:67-87`; `payment.service.ts:550-744` (a lost write conflict refunds a paid intent). [V] |
| 2 | An email-regex ReDoS freezes the event loop from an unauthenticated endpoint | DoS | `user.model.ts:21`. A 33-character address took **7.9 s** locally. Reachable via `POST /auth/register`. [V, measured] |
| 3 | Every driver location ping on a started ride calls Google Maps, and the ETA cache never hits | Cost, latency | `driverLocationUpdate.handler.ts:130` → `liveEta.utils.ts` → `maps.utils.ts:28`. The cache key uses the driver's live coordinates to 6 decimals. [V] |
| 4 | Dispatch checks *every* online user one at a time, riders included | Scalability | `notifyDrivers.utils.ts:402-414` unions GEO results with all of `users:online`, which riders also join (`socket.init.ts:108`). It then makes 2–3 sequential Redis round trips per member. Used by ride dispatch and by the no-driver cron. [V] |
| 5 | Unauthenticated, unlimited, in-memory file upload | DoS, OOM | `upload.routes.ts`: `memoryStorage()`, no `limits`, no `auth`, up to 100 files. [V] |
| 6 | No rate limiting anywhere; SMS endpoints and OTP verify are open | Cost, brute force | `express-rate-limit` is never imported. `/otp/verify` has no attempt counter. [V] |
| 7 | Hot collections have no indexes: `Notification`, `Message`, `Payment`, `Refund`, `Review` | Query scans | Model files define no secondary indexes. The chat list does 2N scans; notifications add an N+1. [V] |
| 8 | Split-ride accept can resurrect a cancelled ride and overwrite a cancelled passenger | Race | `driverAcceptRide.handler.ts:620-631` (no status filter), `:706` `passenger.save()`. [V code / S timing] |
| 9 | Any unhandled rejection kills the process. Redis runs with `maxRetriesPerRequest: null` | Availability | `server.ts:70-85`, `redis.config.ts`. A Redis blip makes commands hang forever, then a rejection exits the process. [V] |
| 10 | Cron work grows with history and online drivers. Jobs scan unindexed predicates every 30–60 s | Scalability | See §3.4. [V/S] |

Single-instance only: there is no Socket.io Redis adapter, `onlineUsers` is a process-local map, and cron guards and the chat-presence check are in-process. Horizontal scaling **will break correctness** (duplicate cron refunds, missed socket events). This is acceptable today because docker-compose runs one `server`, but it is a hard ceiling. See §3.8.

---

## 2. Traffic model

There are no production metrics in the repo. **Replace these assumptions with real numbers** (peak concurrent sockets, rides per hour, app ping interval) before running.

| Tier | Online drivers | Connected riders | Ride requests | Location ping interval | Purpose |
|---|---|---|---|---|---|
| T1 baseline | 300 | 1,000 | 30 / min | 4 s | Today plus headroom; SLO verification |
| T2 growth | 1,000 | 5,000 | 150 / min | 4 s | 12-month target |
| T3 stress | 3,000 | 15,000 | 500 / min | 3 s | Find the knee and the failure mode |
| Spike | T1 → 5× T1 in 60 s | | | | Friday night, event end, app push campaign |

Derived load at T2:

- **Location pings:** 1,000 / 4 s = **250 events/s**.
- **Redis per ping:** about 8 round trips (`SISMEMBER`, `SET`, `GEOADD`, `HSET`, `SET` again, `SADD`, `GET activeRide`, plus more on a ride). That is roughly 2,000 Redis ops/s from pings alone.
- **Mongo per ping:** one fire-and-forget `User.findByIdAndUpdate` on a 2dsphere-indexed collection (`geo.utils.ts:42`), so **250 writes/s**. Pings with no `activeRide` key also run `Ride.findOne({driverId, status})`.
- **Maps calls on started rides:** with about 30% of drivers on a started ride, that is about 75 pings/s × one call per distinct rider target. This is roughly **75+ calls/s**, about 6.5 M/day if sustained.

User-journey mix for virtual users:

| Journey | Share | Steps |
|---|---|---|
| Rider browse | 40% | login → `/user/me` → `/setting/generals` → socket connect → `ride:get-nearby-drivers` ×3 → idle-poll `/notification` every 15 s |
| Rider book (private) | 15% | browse → `ride:fare-breakdown` → `ride:request` → payment (wallet) → wait for accept → live updates → complete → `ride:submit-rating` |
| Rider book (split) | 10% | `ride:find-nearby-split-ride` → `ride:join-split-ride` or split request → match → pickup OTP → complete |
| Rider history and chat | 15% | `/ride/rider-rides`, `/chats/my-chat-list`, `/message/my-messages/:id`, send message |
| Driver online | 100% of drivers | socket connect → `driver:go-online` → ping every N s → accept or reject requests → arrive → OTP → pickup → drop off → complete |
| Driver dashboard | 20% of drivers | `/user/me` (heavy for drivers), `/ride/driver-rides`, `/withdraw/my` |
| Cancellations | 8% of bookings | before accept, after accept, and driver cancel |

---

## 3. Critical flows, bottlenecks and risks

### 3.1 Driver location ping: `driver:location-update` (highest volume)

`socket/handlers/ride/driverLocationUpdate.handler.ts`

- **[V] Maps call on every ping during a started ride.**
  - `buildRiderLiveUpdates` (line 130) calls `getRealDistanceAndETA(driverPos, target)`.
  - The Redis cache key embeds `origin.lat.toFixed(6)` (`maps.utils.ts:28`). A moving driver never repeats a key, so each ping costs a Google call, 50–500 ms of latency (5 s timeout), and money.
  - The ack waits for this call.
- **[V] Full Mongoose document loads.** `Ride.findById(activeRideId)` (line 79) is not `.lean()` and loads `routeGeometry` (the encoded route). It then runs `Passenger.find` on every ping.
- **[V] Redundant writes.**
  - `driver:<id>:current` is set twice per ping: in the handler and in `saveDriverLocation`.
  - Every ping writes the driver's location to Mongo, and the `driverLocationSync` cron writes it again every 5 min.
- **[V] Functional bug found while tracing (not performance).** The ride is only kept if `status === started` (line 80). The arrival check runs only if `status === accepted` (line 169), so steps 7–9 (auto-arrival) are unreachable.
- `ride:<id>:live` list: `RPUSH` per ping with a 2 h TTL. At a 3 s ping that is ≤2,400 entries, which is fine, but see the location-history job in §3.4.

Load test **LT-1 (P0)**: T1 → T2 → T3 driver sockets pinging, with 30% of drivers on a started ride.

- **Measure:** ack p50/p95/p99, event-loop lag, Redis ops/s and CPU, Mongo `users` write ops/s and lock/queue, and Maps calls per minute (log count).
- **Pass criteria:** ack p95 < 250 ms; event-loop lag p99 < 100 ms; Maps calls/min ≤ (active rides × 1 per minute), which is the target once a time-bucketed cache exists.

### 3.2 Ride dispatch: payment authorized → `notifyNearbyDrivers` / `notifyNearbyDriversForSplitRide`

`utils/notifyDrivers.utils.ts`

- **[V] O(all online users) sequential scan.**
  - `collectFreshDriversWithinRadius` adds every `users:online` member, which includes riders (`socket.init.ts:108`), to the candidate set.
  - It then awaits `getDriverLiveState` one candidate at a time: `GET` + `HGETALL` (+ `SISMEMBER`).
  - Example: 5,000 drivers + 15,000 riders online means about 50k sequential Redis round trips per dispatch, roughly 10 s or more.
- **[V] Private rides load the entire `Vehicle` collection** with `seats >= N` on every dispatch (`privateMatchingDriverIds`, line 249).
- **[V] Per-driver cost.** Each eligible driver gets `SISMEMBER`, `User.findById`, `hasDriverRideAtDateTime` (a `Ride.find` without a limit), a `findOneAndUpdate`, a second `User.findById` in `emitNewRideRequestToDriver`, and `notifyUserPush`. That push includes a Mongo write and an FCM round trip. Concurrency is 5.
- **[V] Split corridor check** is O(route points × candidates) of synchronous math on the event loop. With a long route this is noticeable.
- The same function backs the **no-driver cron** (50 rides per tick, `noDriverFound.job.ts:29`), so dispatch cost multiplies inside the job (§3.4).

Load test **LT-2 (P0)**: hold 1k/5k/15k connected *riders* constant and 300/1k/3k online drivers, then fire 30/150/500 ride requests per minute.

- **Measure:** time from payment authorization to `ride:new-request` received by drivers (first and last), time to the rider's `ride:drivers-notified`, and Redis command rate.
- **Pass criteria:** first driver notified p95 < 2 s, last driver notified p95 < 5 s, independent of the rider count. This test should show dispatch latency growing linearly with *riders* online, which proves the bug.

### 3.3 Ride request, accept, and the lifecycle

| Flow | Hot spots |
|---|---|
| `ride:get-nearby-drivers` (called repeatedly from the rider's map) | `geo.utils.ts:271-380`: GEO search **plus** a Mongo `$nearSphere` query, then per driver sequentially `getDriverLiveState` + `hasDriverRideAtDateTime`. Then `Promise.all` over **all** drivers with one Maps call each (`getNearbyDrivers.handler.ts:81-130`), unbounded. It retries at 10 km when 5 km is empty, which doubles the cost exactly when supply is low. [V] |
| `ride:request` | One uncached Directions call (`getRouteGeometry`) per request, a Distance Matrix call, and three sequential creates (Ride, Passenger, Booking) with no transaction and no idempotency key, so a double-tap makes two rides. [V] |
| `driver:accept-ride` (private) | Atomic claim with `findOneAndUpdate({status: pending, driverId: null})`, which is good. But: (a) the busy-rule check (`hasDriverRideAtDateTime`) runs *before* the claim, so one driver accepting two overlapping rides in parallel passes both checks [V]; (b) a synchronous Stripe capture (2 calls) sits inside the ack; (c) `passenger.save()` after capture can overwrite a concurrent cancel [S]. |
| `driver:accept-ride` (split) | The ride update has **no status or type filter** (`:620-631`), so it can resurrect a cancelled ride or race the split→solo flip. `Chat.findOne` → `create` is a check-then-insert (`chat.booking` is not unique), which can create duplicate chats. `recalculateSplitFares` runs on every accept. [V] |
| `recalculateSplitFares` | Redis lock with a fixed value `'1'`, a 15 s TTL, and release by an **unconditional `DEL`** (not owner-checked). After about 1.8 s of contention it **silently skips** the recalculation, so fares go stale (`splitFare.utils.ts:176-195, 364-374`). [V] The split join lock in `splitMatching.utils.ts:191-207` has the same pattern and is held across Maps, Stripe and notify calls. |
| `driver:complete-trip` | Per passenger, sequential Stripe retrieve + capture. A capture failure is **swallowed** (`driverCompleteTrip.handler.ts:165-178`), so the passenger is completed while the payment stays `authorized`. Withdraw upsert at `:381` overwrites the amount. [V] |
| Cancellations (`rideCancelAfterAccept`, `driverCancelRide`, `cancelEntireRide`) | Read → refund (`$inc`) → unconditional status write. There is no compare-and-set and no transaction, so **double refunds and duplicate `Refund` docs** occur under concurrent or duplicate events. [V] |

### 3.4 Background cron jobs (`job/jobScheduler.ts`)

Schedules: location history every 2 min; noDriverFound every 1 min; two jobs every 30 s (no-show, split fare lock / pending match); split pending match every 1 min; driver location sync every 5 min. Overlap guards are in-process booleans only.

- **[V] noDriverFound tick time grows with online drivers.** It calls `notifyNearbyDrivers` for up to 50 rides per tick (the §3.2 cost × 50). The cancel and refund step for expired rides runs *after* the notify loop, so a slow tick delays cancellations and refunds. The overlap guard then skips ticks.
- **[V] Unindexed scans every tick:**
  - `Payment.findOne({booking})`: Payment has no index on `booking`.
  - No-show query on Passenger `{status, arriveAt}`: there is no matching index.
  - `departureDate $lte` predicates scan all historical dates.
  - `findMatchingExistingRide` has no limit and sorts in memory.
  - A booking repair query walks every historical paid booking.
- **[V] No-show job** releases the card hold *before* an unconditional passenger update, so a concurrent `pickup` can be overwritten to cancelled, or its capture fails. `remaining <= 1` cancels the ride with no refund for the last confirmed passenger, which breaks the CLAUDE.md cancellation rules.
- **[V] Split no-match cancel:** read → `refundToWallet` → unconditional update. It races a rider cancel and creates a double refund.
- **[V] Location history job:** a full-keyspace `SCAN` every 2 min, then `LRANGE 0 -1` over every key inside an unbounded `Promise.all`. It saves in-progress rides with 10 or more points and then *drops later points*, so completion reads a truncated list. `findOne` → `create` produces duplicates (no unique `rideId`).
- **[V] Driver location sync:** `SMEMBERS`, then one GET per driver (no pipeline), then one `findByIdAndUpdate` per driver at **unbounded concurrency**. 10k drivers means 10k simultaneous Mongo operations against a pool of 100.

Load test **LT-6 (P1)**:

- **Seed:** 1M historical rides, passengers, bookings and payments; 1k pending rides due within 48 h; 5k fake online drivers in Redis; 200 passengers in `driver_arrived` past the wait time; 200 unmatched split riders.
- **Measure:** each job's tick duration (wrap with timestamps in logs), how many ticks were skipped by the guard, the departure → cancellation delay, the Mongo slow log, and `COLLSCAN` counts in the profiler.
- **Pass criteria:** every tick finishes in under 50% of its interval; no `COLLSCAN` on Ride, Passenger, Booking or Payment.

### 3.5 Money correctness under concurrency (P0, cheap to run)

These tests need concurrency, not volume, so they can run in Stripe test mode. Each one is a small script: N parallel identical events, then an assertion on invariants.

| ID | Scenario | Invariant to assert |
|---|---|---|
| MC-1 | 10× parallel `ride:cancel-after-accept` for one paid passenger | Wallet delta = 1 refund; exactly 1 `Refund`; `bookedSeats` decremented once |
| MC-2 | 5× `driver:cancel-ride` + 1 rider cancel, simultaneous | Σ `Refund.amount` ≤ `amountPaid` for every booking |
| MC-3 | 5× parallel `POST /payment/confirm-payment`, same succeeded intent | 0 Stripe refunds; payment `paid` |
| MC-4 | 10× parallel `POST /payment/checkout`, same booking | 1 Payment document; 1 uncanceled PaymentIntent; 1 Stripe customer |
| MC-5 | Driver accept and rider cancel-before-accept within the same millisecond, ×50 | Every Stripe captured intent has a `paid` Payment; no `cancelled_authorization` on a captured intent |
| MC-6 | 20× parallel `POST /withdraw`, then admin approves all | ≤ 1 pending request; total paid out ≤ balance |
| MC-7 | `driver:complete-trip` racing `ride:cancel-after-accept` on a `picked_up` passenger | The driver is not credited for a refunded passenger (`revertDriverEarningIfCredited` is read-then-`$inc`) |
| MC-8 | Two drivers accept the same private ride; one driver accepts two overlapping rides | Exactly one winner; a driver never holds two rides inside ±60 min |
| MC-9 | Split accept 0–500 ms after the no-driver cron cancels the ride | A cancelled ride stays cancelled; the passenger stays cancelled |
| MC-10 | 3 riders join one split ride within 1 s | Every passenger's fare reflects the final rider count (no skipped recalculation) |
| MC-11 | 30 concurrent completions in Stripe test mode (forces 429s) | 0 `completed` passengers with an `authorized` payment |

Global invariant query to run after **every** load test, including the volume runs:

```
for each booking:  Σ Refund.amount ≤ amountPaid
for each user:     wallet ≥ 0
for each ride:     0 ≤ bookedSeats ≤ totalSeats
no passenger: status=completed AND payment.status=authorized
no ride: status=cancelled with a passenger in confirmed|picked_up
```

### 3.6 REST read paths (P1)

Hot endpoints from a real app session: login, refresh, FCM token, `GET /user/me`, `GET /setting/generals`, `GET /notification`, `GET /chats/my-chat-list`, `GET /message/my-messages/:chatId`, `PATCH /message/seen/:chatId`, `GET /ride/rider-rides`, `GET /ride/driver-rides`, `GET /ride/:id`, `GET /withdraw/my`, admin `GET /meta`.

- **[V] Per request:** `auth.ts` runs one `User.findById` per request with no cache. Morgan → winston writes to console and a file in production too.
- **[V] `/notification`:** no index on `receiver`, an extra `countDocuments`, and an N+1 `findById` per row (`withRideMeta`).
- **[V] `/chats/my-chat-list`:** all chats with no limit, then per chat `Message.findOne().sort()` + `countDocuments`, all unindexed.
- **[V] `/ride/rider-rides` and `/ride/driver-rides`:** load the user's entire history, then paginate in JavaScript (`ride.service.ts:586-640, 876-1037`).
- **[V] `/user/me` (drivers):** four uncached aggregations, two of them all-time `Payment.aggregate` with `$lookup` on an unindexed `provider`.
- **[V] `/withdraw/my`:** loads every payment, split ride and withdrawal for the driver, then filters by date in JavaScript.
- **[V] `QueryBuilder`:** no maximum `limit`; the client can choose any `sort` field; `searchTerm` goes unescaped into `$regex`; there is always a `countDocuments`.
- **[V] Settings** are read from Mongo several times per fare quote, with no cache.
- **[V] `/meta`:** about 11 uncached full-collection queries.

Load test **LT-3 (P1)**:

- **Seed:** 1M notifications, 2M messages, 200k payments; a heavy driver with 5k rides; a heavy rider with 2k bookings.
- **Load:** 1k → 5k virtual users on the journey mix in §2, with polling every 15 s.
- **Measure:** p95 per endpoint, Mongo `COLLSCAN`, docs examined/returned ratio, and pool wait time.
- **Pass criteria:** p95 < 300 ms for every read endpoint; examined/returned < 10.

### 3.7 Abuse / DoS surface

Confirm each with **one** controlled test in the isolated stack. These need fixes, not tuning.

| ID | Test | Expected today |
|---|---|---|
| AB-1 | `POST /auth/register` with an email like `a@` + 22×`a` + `.abcdefgh`, 1 req/s, while LT-1 runs | Event loop stalls for seconds; all socket acks time out |
| AB-2 | 20 concurrent `POST /upload/multiple` with 100×20 MB files, no auth | RSS explodes, then OOM kill |
| AB-3 | 50 rps `POST /otp/send-otp-via-direct-phone` (SMS mocked) | All accepted; with real SMS, unbounded cost |
| AB-4 | 200 rps wrong codes on `POST /otp/verify` | No lockout. A 6-digit code is brute-forceable within its 5 min TTL with enough parallelism |
| AB-5 | `GET /notification?limit=100000` | One request does 100k `findById` calls |
| AB-6 | Fill Redis with 1M keys, send 50 ratings/s (`deleteCachePattern` → `KEYS`) | Redis blocks; latency spikes for every ping |
| AB-7 | Unauthenticated `POST /notification` flood | Unbounded writes to an unindexed collection |

### 3.8 Resilience and multi-instance readiness (P2)

- **[V]** `unhandledRejection` → `process.exit(1)`, with no drain and no SIGTERM handler. If Mongo fails at startup, the process stays alive but never listens.
- **[V]** ioredis `maxRetriesPerRequest: null`: during an outage, commands queue in memory forever and requests hang instead of failing fast.
- **[V]** No `keepAliveTimeout`/`headersTimeout` tuning. Node's 5 s default against a 60 s load-balancer idle timeout causes sporadic 502s [S].
- **[V]** The process is single-instance only:
  - no Socket.io adapter;
  - `onlineUsers` lives in process memory and holds one socket per user, so a second device overwrites the first;
  - `isDriverSocketConnected` checks local rooms only;
  - cron jobs have no distributed lock;
  - chat-push presence is checked locally.

Tests:

- **CH-1:** under T1 load, stop Redis for 10 s. Record whether the process exits, the recovery time, and whether drivers come back online.
- **CH-2:** under T1 load, stop Mongo or step it down for 10 s. Record the same.
- **CH-3:** add 500 ms of latency to the Maps and Stripe endpoints with a proxy/toxiproxy, if traffic can be routed through it. Record accept and complete ack times.
- **CH-4 (before any scale-out):** run 2 instances behind a load balancer. Expect duplicate cron refunds (MC-style invariants fail) and missed socket events. This documents the ceiling.

### 3.9 Memory and soak (P2)

No significant leaks were found in the code review: no stray `setInterval`, cron jobs are registered once, queues are singletons. These are the growth points to watch:

- the `onlineUsers` map (entries are removed only on a disconnect that matches the stored socket);
- the ioredis offline queue during Redis trouble;
- Redis keys with **no TTL**: `ride:request:<ride>:<passenger>`, `split:matching:passenger:<id>`, some `setCache` calls, and `unread_count`;
- `email-queue` failed jobs kept forever (`removeOnFail: false`);
- unbounded `LocationHistory.locations[]` arrays.

Load test **LT-7**: run 8 h at T1 with realistic connect and disconnect churn (drivers reconnecting every 10–30 min, riders every few minutes).

- **Measure:** heap after GC (take heap snapshots at 0 h, 4 h and 8 h), RSS, `onlineUsers` size against actual sockets, Redis `used_memory` and key count by prefix, BullMQ failed-job count, and the largest LocationHistory document size.
- **Pass criteria:** heap slope ≈ 0 after warm-up; the Redis key count is stable.

---

## 4. Prioritized execution plan

| Phase | Tests | Why first | Effort |
|---|---|---|---|
| **P0-a** | MC-1 … MC-11 + invariant query | Money bugs; cheap; low concurrency; Stripe test mode is enough | 2–3 days |
| **P0-b** | AB-1, AB-2 (single confirmation each) | Either one takes the whole service down from an unauthenticated endpoint | 0.5 day |
| **P0-c** | LT-1 location pings, LT-2 dispatch | Highest-volume path and the core business flow; Maps cost exposure | 3–4 days incl. Socket.io harness |
| **P1** | LT-3 REST with seeded data, LT-6 cron at scale, AB-3…AB-7 | History-driven degradation; needs a seeding script | 3–4 days |
| **P2** | LT-7 soak, CH-1…CH-3 chaos, Spike test | Stability and recovery | 2–3 days |
| **P3** | CH-4 multi-instance | Only before planning horizontal scale | 1 day |

Re-run P0-c and LT-3 after each fix batch as the regression baseline.

---

## 5. Test harness and tooling

- **Socket.io flows:** use **Artillery** with the `socketio` engine (`artillery-engine-socketio-v3`), or a custom Node runner using `socket.io-client`. That gives full control over ack timing and per-event latency histograms and is the better choice for the multi-step ride lifecycle. k6 does not speak the Socket.io protocol natively.
- **REST:** **k6**. It is scriptable, has thresholds, and has good percentile output.
- **Concurrency/money tests (MC-*):** plain Node scripts in `server/tests/load/` (not under `src/`). Open N sockets, `Promise.all` the identical event, then run the invariant queries directly against Mongo.
- **Auth for virtual users:** seed users with known passwords and obtain JWTs through the login endpoint in a setup phase. Avoid the OTP login, which needs SMS. Seed drivers as `isKycVerified: true`, `status: active`, with a default vehicle.
- **Seeding script (needed by LT-3 and LT-6):**
  - 50k users (10% drivers);
  - 1M rides spread over 18 months with realistic status distribution (≈70% completed, 20% cancelled);
  - matching passengers, bookings and payments;
  - 1M notifications skewed to 5% heavy users;
  - 2M messages over 100k chats;
  - Redis: `users:online`, `drivers:location` and `driver:<id>:details` for the driver tier under test.
- **Observability during runs:**
  - **Node:** event-loop lag (`perf_hooks.monitorEventLoopDelay` via a sidecar, or clinic.js), heap, GC pauses, and libuv threadpool saturation. Bcrypt, fs and DNS share 4 threads, so consider `UV_THREADPOOL_SIZE` as a test variable.
  - **MongoDB:** profiler at `slowms=50`, `COLLSCAN` count, `serverStatus` opcounters, connection pool wait time.
  - **Redis:** `INFO commandstats`, `SLOWLOG`, `latency doctor`, `used_memory`, keys per prefix.
  - **App logs:** count `📍 Google Maps` (Maps calls), `📦 Cache hit`, `Could not acquire recalculate lock`, and `driver notify failed`.
  - **BullMQ:** waiting, active and failed counts per queue.

### SLOs / pass-fail thresholds (proposed)

| Metric | Target |
|---|---|
| REST read p95 / p99 | < 300 ms / < 800 ms |
| Socket ack p95: location-update | < 250 ms |
| Socket ack p95: accept / pickup / complete (includes Stripe) | < 2.5 s |
| Payment authorized → first driver notified | p95 < 2 s |
| Event-loop lag p99 | < 100 ms |
| Error rate | < 0.1% (excluding intended 4xx) |
| Cron tick duration | < 50% of its interval; 0 skipped ticks |
| Money invariants (§3.5) | **0 violations**, hard fail |
| Maps calls | ≤ 1 per active ride per minute (target after the cache fix) |

---

## 6. Fix candidates surfaced by this analysis

These are not implemented. Each one maps to a test above.

1. Make cancels and refunds compare-and-set: `findOneAndUpdate({_id, status: {$in: cancellable}}, {status: cancelled})` *before* refunding, refund only if the update matched, and add a unique index on `Refund {booking, reason}` (MC-1, MC-2, MC-9).
2. Pass Stripe idempotency keys (`booking:<id>:create-pi`, `booking:<id>:capture`, …); add a unique index on `Payment.booking`; stop the confirm-payment catch from refunding a committed intent (MC-3, MC-4, MC-5).
3. Replace the email regex with Zod's or a linear one (AB-1). Add auth and `limits` to multer, or use S3 presigned uploads (AB-2). Add `express-rate-limit` with a Redis store and an OTP attempt counter (AB-3, AB-4).
4. Maps ETA cache: round the origin to about 3 decimals (~100 m), or throttle per ride to one call every 30–60 s and interpolate in between (LT-1).
5. Dispatch: use the GEO search only. Drop the `users:online` union, or keep a drivers-only online set. Pipeline or `MGET` the per-driver Redis reads. Replace the full `Vehicle` scan with a per-driver lookup on the candidates (LT-2).
6. Indexes:
   - `Notification {receiver, createdAt}`;
   - `Message {chat, createdAt}` and `{chat, receiver, seen}`;
   - `Payment {booking}`, `{provider, status, createdAt}`, `{paymentIntentId}`;
   - `Refund {booking}`;
   - `Review {user}`;
   - `Passenger {status, arriveAt}`;
   - `Chat {booking}` (unique);
   - `LocationHistory {rideId}` (unique).
7. Replace `KEYS` with `SCAN` or explicit key sets (AB-6). Owner-token locks with a Lua compare-and-delete for the recalculation and split-join locks (MC-10). Add TTLs to the keys listed in §3.9.
8. Set `maxRetriesPerRequest` to a finite value, add graceful shutdown and SIGTERM handling, log rather than exit on unhandled rejection or exit after draining, and tune `keepAliveTimeout`.
9. DB-side pagination for rider and driver history and `/withdraw/my`. Cache settings and `/user/me` driver stats in Redis with invalidation. Cap `limit` in QueryBuilder.
10. Before scaling out: add the Socket.io Redis adapter, Redis-based presence instead of `onlineUsers`, and a distributed lock for cron (or move cron to a single worker).
