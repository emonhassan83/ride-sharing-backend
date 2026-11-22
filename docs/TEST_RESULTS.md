# Test Results

Snapshot of the unit test run. Every number below comes from an actual `vitest run --coverage` execution. Re-run the commands to refresh it.

```bash
cd server && npx vitest run --coverage --coverage.reportOnFailure
cd worker && npx vitest run --coverage --coverage.reportOnFailure
```

> Status: **in progress.** Two areas are still being written: split-fare utils and the ride cancel/no-show handlers and jobs. See "Remaining work".

## Summary

| Package | Test files | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|---|
| server | 21 | 740 | 738 | 2 | 0 |
| worker | 12 | 125 | 125 | 0 | 0 |

The 2 server failures are in `tests/unit/utils/zz_scratch_fare.test.ts`, a leftover scratch file (see "Known issues").

`it.fails` tests are known-bug tests. They count as passed while the bug exists and turn red once it is fixed.

## Coverage

| Package | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| server (`src/**`) | 15.13% (3828/25298) | 79.02% | 55.91% | 15.13% |
| worker (`src/**`) | 93.84% (442/471) | 97.36% | 88.88% | 93.84% |

Server coverage is low because most of the ~287 source files have no tests yet.

## Modules tested

**Server**

| Area | Test file(s) | Tests |
|---|---|---|
| Fare calculation | `fareCalculator.test.ts` | 41 |
| Fare math | `fareMath.utils.test.ts` | 123 |
| Waiting charge | `waitingCharge.utils.test.ts` | 32 |
| Luggage limits | `luggage.utils.test.ts` | 55 |
| Rider price view | `riderPriceResponse.utils.test.ts` | 14 |
| Stored fare breakdown | `fareBreakdownResponse.utils.test.ts` | 20 |
| Ride schedule / time zones | `rideSchedule.utils.test.ts` | 73 |
| Time helpers | `time.utils.test.ts` | 11 |
| Split matching | `splitMatching.utils.test.ts` | 94 |
| Geo | `geo.utils.test.ts` | 76 |
| Maps | `maps.utils.test.ts` | 22 |
| Numbers / transaction IDs / callbacks | `number.utils`, `generateTransctionId`, `callbackFn` tests | 29 |
| Withdraw service | `withdraw.service.test.ts` | 65 |
| Queues | `email.queues`, `notification.queues` tests | 20 |
| Driver reject ride | `driverRejectRide.handler.test.ts` | 24 |
| Driver cancel ride | `driverCancelRide.handler.test.ts` | 29 |

**Worker**

| Area | Test file(s) | Tests |
|---|---|---|
| Env validation | `env.test.ts` | 37 |
| Email worker | `email.workers.test.ts`, `email.workers.smtp.test.ts`, `email.workers.events.test.ts` | 33 |
| Notification worker | `notification.workers.test.ts` | 15 |
| Bootstrap | `index.bootstrap.test.ts` | 9 |
| Redis config | `redis.configs.test.ts` | 8 |
| Nodemailer config | `nodemailer.config.test.ts` | 4 |
| Logger config | `logger.configs.test.ts` | 5 |
| Push notifications | `push-notification.service.test.ts` | 7 |
| Socket notification stub | `socket-notification.service.test.ts` | 2 |
| Request context | `requestContext.system.utils.test.ts` | 5 |

## Edge cases covered (examples)

- Money: exact-cent results, half-cent float behaviour, rounding at boundaries.
- Time zones: DST spring-forward gap (03:30 shifts to 04:30), DST fall-back ambiguity (resolves to the later instant), day/night rate boundaries.
- Invalid input: NaN and negative distances, impossible dates, malformed `departureTime`, unparseable pickup dates, empty or corrupted stored values.
- Thresholds: zero-value settings falling back to defaults, waiting-charge grace-period boundaries, luggage limits per vehicle type.
- Wallet and payment: partial wallet with no card, negative wallet balance diverted to card.
- Socket: non-driver reject attempts, cancellation flows.

## Bugs found

Bugs are recorded as `it.fails` tests. Production code has not been changed.

| ID | Severity | Location | Finding | Status |
|---|---|---|---|---|
| FARE-05 | high | `server/src/app/utils/fareBreakdownResponse.utils.ts:97` | A stored matched 2-rider split is rebuilt as 60 + 9 = 69 and ignores the stored per-rider total of 40. | Open (agent-reported) |
| FARE-01 | medium | `server/src/app/utils/waitingCharge.utils.ts:82` | With a partial wallet and no card, the card part is skipped silently and the full amount is returned (got 10, expected 4). No src caller found, so latent. | Open (agent-reported) |
| FARE-03 | medium | `server/src/app/utils/rideSchedule.utils.ts:83` | Impossible dates (`2026-02-30`, `2026-13-01`) roll over and are accepted instead of returning 400. | Open (agent-reported) |
| FARE-04 | medium | `server/src/app/utils/rideSchedule.utils.ts:84` | `departureTime` with no minutes (`09`) or empty throws a plain `RangeError` instead of a 400 `ApiError`. | Open (agent-reported) |
| FARE-02 | low | `server/src/app/utils/riderPriceResponse.utils.ts:16` | `Number(x) \|\| 9` turns a configured 0% VAT into 9. | Open (agent-reported) |
| SOCK-1 | medium | `server/src/app/socket/handlers/ride/driverRejectRide.handler.ts` | A rider (non-driver) socket can reject a ride. | Open (pre-existing) |
| UTIL-1 | low | `server/src/app/queues/notification.queues.ts:57` | Two jobs for one user in the same millisecond get the same jobId. | Open (pre-existing) |
| WRK-1 | low | `worker/src/app/utils/socket-notification.service.ts:16` | `getIO` is called but never imported, so every call throws `ReferenceError`. Nothing calls it yet. | Open |

The FARE-* findings come from the fare agent's report. Each was checked by running its test against the current code, but the root-cause analysis has not been independently re-verified.

**Characterization tests** (behaviour that may be intentional, pinned so changes are visible): split rides skip suitcase limits; 4+ riders are not rejected and 5 riders are priced at €20; the five-passenger 20% setting is unused; waiting is billed with no grace period in `calculateFareBreakdown`; negative and NaN distances are accepted; a negative wallet diverts to card; a zero lead-time or distance setting falls back to the default.

## Known issues

- `server/tests/unit/utils/zz_scratch_fare.test.ts`: leftover scratch file. It writes to a hardcoded scratchpad path from a different machine, so 2 tests fail with `ENOENT`. Should be deleted.
- `server/tests/unit/modules/user/__probe.test.ts`: leftover probe file with no assertions. Should be deleted.
- Neither scratch file has been removed yet; the removal was denied in this session.

## Remaining work

**Not yet tested**
- Split-fare utils (`splitFare.utils.ts`).
- Cancel handlers: `rideCancelAfterAccept`, `rideCancelBeforeAccept`.
- Jobs: `noDriverFound.job.ts`, `noShowPassengers.job.ts`, `splitRidePendingMatch.job.ts`.
- `payment.service.ts` (1420 lines), `ride.service.ts`, `auth.service.ts`, `user.service.ts`, `otp.service.ts`.
- Most socket ride handlers.
- Chat and message services.

**Risks**
- Mongoose validators, defaults, hooks and indexes are mocked out in every test, so schema-level behaviour is not exercised.
- No integration tests against real MongoDB, Redis, Stripe or SMTP.
- The refund-consistency rules in `CLAUDE.md` (wallet credit, status update, provider debit, Refund document) are not yet covered for all paths.
