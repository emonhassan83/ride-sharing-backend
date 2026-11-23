# Test Results

Snapshot of the unit test run on 2026-11-22. Every number below comes from an actual `vitest run --coverage` execution. Re-run the commands to refresh it.

```bash
cd server && npx vitest run --coverage --coverage.reportOnFailure
cd worker && npx vitest run --coverage --coverage.reportOnFailure
```

> Status: **all tests pass, no known-bug tests remain.** The 32 bugs that were recorded as `it.fails` tests have been fixed in the source code, and each one is now a normal regression test. `npx tsc --noEmit` passes in both packages.

## Summary

| Package | Test files | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|---|
| server | 24 | 927 | 927 | 0 | 0 |
| worker | 12 | 124 | 124 | 0 | 0 |

The worker has one test fewer than before (125 to 124): a characterization test that pinned the WRK-1 `ReferenceError` was removed when that bug was fixed.

## Coverage

| Package | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| server (`src/**`) | 22.02% | 80.84% | 56.11% | 22.02% |
| worker (`src/**`) | 96.82% | 97.52% | 88.88% | 96.82% |

Server coverage is low because most of the ~287 source files have no tests yet.

## Modules tested

**Server**

| Area | Test file(s) | Tests |
|---|---|---|
| Fare calculation | `fareCalculator.test.ts` | 41 |
| Fare math | `fareMath.utils.test.ts` | 123 |
| Split fare (pricing, charging, recalculation, fare lock) | `splitFare.utils.test.ts` | 89 |
| Split matching | `splitMatching.utils.test.ts` | 94 |
| Waiting charge | `waitingCharge.utils.test.ts` | 32 |
| Luggage limits | `luggage.utils.test.ts` | 55 |
| Rider price view | `riderPriceResponse.utils.test.ts` | 14 |
| Stored fare breakdown | `fareBreakdownResponse.utils.test.ts` | 20 |
| Ride schedule / time zones | `rideSchedule.utils.test.ts` | 73 |
| Time helpers | `time.utils.test.ts` | 11 |
| Geo | `geo.utils.test.ts` | 76 |
| Maps | `maps.utils.test.ts` | 22 |
| Numbers / transaction IDs / callbacks | `number.utils`, `generateTransctionId`, `callbackFn` tests | 29 |
| Withdraw service | `withdraw.service.test.ts` | 65 |
| Queues | `email.queues`, `notification.queues` tests | 20 |
| Driver reject ride | `driverRejectRide.handler.test.ts` | 24 |
| Driver cancel ride | `driverCancelRide.handler.test.ts` | 29 |
| Rider cancel after accept | `rideCancelAfterAccept.handler.test.ts` | 33 |
| Rider cancel before accept | `rideCancelBeforeAccept.handler.test.ts` | 26 |
| No-driver-found job | `noDriverFound.job.test.ts` | 27 |
| No-show passengers job | `noShowPassengers.job.test.ts` | 24 |

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
| Socket notification stub | `socket-notification.service.test.ts` | 1 |
| Request context | `requestContext.system.utils.test.ts` | 5 |

## Edge cases covered (examples)

- Money: exact-cent results, half-cent float behaviour, rounding at boundaries.
- Time zones: DST spring-forward gap (03:30 shifts to 04:30), DST fall-back ambiguity (resolves to the later instant), day/night rate boundaries.
- Invalid input: NaN and negative distances, impossible dates, malformed `departureTime`, unparseable pickup dates, empty or corrupted stored values.
- Thresholds: zero-value settings falling back to defaults, waiting-charge grace-period boundaries, luggage limits per vehicle type.
- Wallet and payment: partial wallet with no card, negative wallet balance diverted to card, failed wallet credits, failed Stripe cancels, retries after a failure.
- Socket: non-driver reject attempts, cancellation flows, the last remaining rider of a cancelled split ride.

## Bugs fixed

All 32 bugs below were first recorded as `it.fails` tests and are now fixed in production code. The test for each one is kept as a regression test in the `FIXED BUGS (regression tests)` group of its test file.

**Fares and schedule (server)**

| ID | Severity | Location | What was wrong | Fix |
|---|---|---|---|---|
| FARE-01 | medium | `utils/waitingCharge.utils.ts` | When the card part of a waiting charge could not be collected, the full amount was still reported as paid. | Reports only the amount actually collected; method is `none` when nothing was collected. |
| FARE-02 | low | `utils/riderPriceResponse.utils.ts` | A configured 0% VAT was shown as 9%. | Falls back to 9 only when the value is not a number. |
| FARE-03 | medium | `utils/rideSchedule.utils.ts` | Impossible dates (`2026-02-30`, month 13) rolled over and were accepted. | Returns 400 `Invalid departureDate or departureTime`. |
| FARE-04 | medium | `utils/rideSchedule.utils.ts` | A `departureTime` with no minutes or empty threw a plain `RangeError` (500). | Returns the same 400 `ApiError`. |
| FARE-05 | high | `utils/fareBreakdownResponse.utils.ts` | A matched split rider saw a rebuilt total (69) instead of the stored per-rider total (40). | Uses the stored `passenger.totalFare` when present. |
| SPLIT-01 | medium | `utils/splitFare.utils.ts` | A split recalculation wrote platform commission 0 and gave the driver the full fare. | Commission is computed with `computeDriverPayoutFromPassengerTotal`, as in `payment.service`. |
| SPLIT-02 | medium | `utils/splitFare.utils.ts` | The fare was locked even when the recalculation could not get its lock, so stale estimates were charged. | `recalculateSplitFares` returns whether it ran; `lockSplitRideFare` does not lock when it did not. |
| SPLIT-03 | medium | `utils/splitFare.utils.ts` | A Redis failure after a successful card charge rolled the wallet back and reported "payment failed". | Post-charge bookkeeping is best-effort and never undoes a charge. |

**Cancellation and refunds (server)**

| ID | Severity | Location | What was wrong | Fix |
|---|---|---|---|---|
| CANCEL-1 | high | `driverCancelRide.handler.ts` | A retry after a failed wallet credit created a second `Refund`. | Wallet is credited first; a booking already refunded is not paid again. |
| CANCEL-2 | high | `rideCancelAfterAccept.handler.ts` | A rider whose payment never captured money was refunded the estimated fare. | Only `booking.amountPaid` is refundable. |
| CANCEL-3 | high | `rideCancelAfterAccept.handler.ts` | If the wallet credit failed, the rider was already marked cancelled and could never retry. | Wallet is credited before the passenger and booking are finalised. |
| CANCEL-4 | high | `rideCancelAfterAccept.handler.ts` | The last remaining rider of a cancelled split ride was not cancelled, refunded or told. | Remaining riders are cancelled, their hold is released or their payment fully refunded, and they are notified. |
| CANCEL-5 | high | `rideCancelBeforeAccept.handler.ts` | Cancelling a pending ride never released the card authorisation. | The hold is released for the rider, and for riders cancelled along with the ride. |
| CANCEL-6 | medium | `rideCancelBeforeAccept.handler.ts` | A rejected passenger counted as a remaining rider, so the ride was not cancelled. | Rejected passengers are excluded, as in the other handlers. |
| CANCEL-7 | low | `rideCancelBeforeAccept.handler.ts` | A repeat cancel of a cancelled ride answered "driver already accepted". | That message is used only for accepted or started rides; otherwise `Ride already accepted or cancelled`. |
| SOCK-1 | medium | `driverRejectRide.handler.ts` | A rider (non-driver) socket could reject a ride. | Only the `provider` role is allowed; others get `You are not authorized`. |

**Jobs and queues (server)**

| ID | Severity | Location | What was wrong | Fix |
|---|---|---|---|---|
| JOB-1 | high | `job/noDriverFound.job.ts` | A failed wallet credit left the booking finalised as refunded. | Wallet is credited before the booking is finalised. |
| JOB-2 | medium | `job/noDriverFound.job.ts` | A failed Stripe cancel still marked the authorisation as released. | The payment and booking are left unchanged when the cancel fails. |
| JOB-3 | high | `job/noDriverFound.job.ts` | One failing booking stopped the refunds of every other rider. | Each booking is handled in its own try/catch. |
| JOB-4 | medium | `job/noShowPassengers.job.ts` | A failed hold release left the passenger marked no-show with no retry. | The hold is released before the passenger is marked. |
| JOB-5 | low | `job/noShowPassengers.job.ts` | One failing no-show stopped the rest of the batch. | Each passenger is handled in its own try/catch. |
| JOB-6 | medium | `job/noShowPassengers.job.ts` | A no-show did not free the driver's Redis seat or the gender counters. | Decrements `malePassengers`, `femalePassengers` and the driver's Redis `bookedSeats`. |
| UTIL-1 | low | `queues/notification.queues.ts` | Two jobs for one user in the same millisecond got the same jobId. | A counter suffix is added for same-millisecond jobs. |

**Worker**

| ID | Severity | Location | What was wrong | Fix |
|---|---|---|---|---|
| WORKER-1 | high | `configs/nodemailer.config.ts` | An SMTP failure was only logged, so the mail was lost with no retry. | The error is rethrown, so BullMQ retries the job. |
| WORKER-2 | high | `workers/notification.workers.ts` | Notifications were posted to `/notifications`, a route that does not exist. | Posts to `/notification`, the server's real route. |
| WORKER-3 | medium | `workers/notification.workers.ts` | A failed push was reported as success. | The job fails, so BullMQ retries it. |
| WORKER-4 | low | `workers/notification.workers.ts` | The trace id sent by the server in `metadata.traceId` was ignored. | It is read as a fallback after `data.traceId`. |
| WORKER-5 | medium | `utils/push-notification.service.ts` | Non-string `data` values were sent to FCM, which rejects them. | Values are converted to strings (objects as JSON). |
| WORKER-6 | low | `worker/.env.example` | `TIME_ZONE` and `SERVER_URL` were required but not documented. | Both are in `.env.example`. |
| WRK-1 | low | `utils/socket-notification.service.ts` | `getIO` was called but never imported, so every call threw. | The stub returns `{ success: false }` with a warning. |

**Tests changed because they pinned the old behaviour:** 2 in `waitingCharge.utils.test.ts`, 2 in `noShowPassengers.job.test.ts`, 4 in `rideCancelBeforeAccept.handler.test.ts`, 2 in `splitFare.utils.test.ts`, and 1 each in `nodemailer.config.test.ts`, `email.workers.smtp.test.ts` and `notification.workers.test.ts`. One test in `socket-notification.service.test.ts` was removed.

**Characterization tests** (behaviour that may be intentional, pinned so changes are visible): split rides skip suitcase limits; 4+ riders are not rejected and 5 riders are priced at €20; the five-passenger 20% setting is unused; waiting is billed with no grace period in `calculateFareBreakdown`; negative and NaN distances are accepted; a negative wallet diverts to card; a zero lead-time or distance setting falls back to the default.

## Known issues

- `POST /api/v1/notification` on the server has no auth middleware. The worker depends on it (WORKER-2), but anyone who can reach the API can create notifications. Not changed here.
- `payment.service` `cancelAuthorizedBookingPayment` still marks a hold as released when the Stripe cancel fails (the same pattern as JOB-2). It has no tests yet, so it was not changed.
- A failed push is retried even when the FCM token is permanently invalid (WORKER-3 fix). The retries are bounded by the queue's 3 attempts.
- The fixes are verified by unit tests with mocked models, Stripe and Redis. They have not been run against real services.

## Remaining work

**Not yet tested**
- Job: `splitRidePendingMatch.job.ts`.
- `payment.service.ts` (1420 lines), `ride.service.ts`, `auth.service.ts`, `user.service.ts`, `otp.service.ts`.
- Most socket ride handlers.
- Chat and message services.

**Risks**
- Mongoose validators, defaults, hooks and indexes are mocked out in every test, so schema-level behaviour is not exercised.
- No integration tests against real MongoDB, Redis, Stripe or SMTP.
- The refund-consistency rules in `CLAUDE.md` (wallet credit, status update, provider debit, Refund document) are covered for `driverCancelRide`, `rideCancelAfterAccept` and `noDriverFound.job`, but not for `payment.service` or `splitRidePendingMatch.job`.
