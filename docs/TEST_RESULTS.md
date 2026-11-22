# Test Results

Snapshot of the unit test run. Every number below comes from an actual `vitest run --coverage` execution. Re-run the commands to refresh it.

```bash
cd server && npx vitest run --coverage --coverage.reportOnFailure
cd worker && npx vitest run --coverage --coverage.reportOnFailure
```

## Summary

| Package | Test files | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|---|
| server | 24 | 927 | 927 | 0 | 0 |
| worker | 12 | 125 | 125 | 0 | 0 |

`it.fails` tests are known-bug tests. They count as passed while the bug exists and turn red once it is fixed.

## Coverage

| Package | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| server (`src/**`) | 21.63% (5474/25298) | 80.62% | 55.72% | 21.63% |
| worker (`src/**`) | 93.84% (442/471) | 97.36% | 88.88% | 93.84% |

Server coverage is low because most of the ~287 source files have no tests yet.

## Modules tested

**Server**

| Area | Test file(s) | Tests |
|---|---|---|
| Split fare | `splitFare.utils.test.ts` | 89 |
| Split matching | `splitMatching.utils.test.ts` | 94 |
| Fare calculation | `fareCalculator.test.ts` | 41 |
| Fare math | `fareMath.utils.test.ts` | 123 |
| Waiting charge | `waitingCharge.utils.test.ts` | 32 |
| Luggage limits | `luggage.utils.test.ts` | 55 |
| Rider price view | `riderPriceResponse.utils.test.ts` | 14 |
| Stored fare breakdown | `fareBreakdownResponse.utils.test.ts` | 20 |
| Ride schedule / time zones | `rideSchedule.utils.test.ts` | 73 |
| Time helpers | `time.utils.test.ts` | 11 |
| Geo | `geo.utils.test.ts` | 76 |
| Maps | `maps.utils.test.ts` | 22 |
| Numbers / transaction IDs / callbacks | `number.utils`, `generateTransctionId`, `callbackFn` tests | 29 |
| Driver cancel ride | `driverCancelRide.handler.test.ts` | 29 |
| Ride cancel after accept | `rideCancelAfterAccept.handler.test.ts` | 33 |
| Ride cancel before accept | `rideCancelBeforeAccept.handler.test.ts` | 26 |
| Driver reject ride | `driverRejectRide.handler.test.ts` | 24 |
| No-driver-found job | `noDriverFound.job.test.ts` | 27 |
| No-show passengers job | `noShowPassengers.job.test.ts` | 24 |
| Withdraw service | `withdraw.service.test.ts` | 65 |
| Queues | `email.queues`, `notification.queues` tests | 20 |

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
- Time zones: DST spring-forward gap, DST fall-back ambiguity, day/night rate boundaries.
- Invalid input: NaN and negative distances, impossible dates, malformed `departureTime`, unparseable pickup dates, empty or corrupted stored values.
- Thresholds: zero-value settings falling back to defaults, waiting-charge grace-period boundaries, luggage limits per vehicle type.
- Wallet and payment: partial wallet with no card, negative wallet balance diverted to card, failed card charge after wallet debit.
- Cancellation: refund side effects (wallet credit, status update, provider debit, Refund document), non-driver reject attempts, split-ride seat release.

## Bugs found

Bugs are recorded as `it.fails` tests. Production code has not been changed.

| ID | Severity | Location | Finding | Status |
|---|---|---|---|---|
| FARE-05 | high | `server/src/app/utils/fareBreakdownResponse.utils.ts:97` | A stored matched 2-rider split is rebuilt as 60 + 9 = 69 and ignores the stored per-rider total of 40. | Open |
| SPLIT-01 | medium | `server/src/app/utils/splitFare.utils.ts:420-425, 490-492, 503-505` | Recalculation writes `platformCommission = 0` and `providerEarning = full fare` on paid/unpaid payments. Authorized payments are recomputed at capture, so the damage there is transient. | Open |
| SPLIT-02 | medium | `server/src/app/utils/splitFare.utils.ts:684-694` | `lockSplitRideFare` locks the ride even when recalculation silently skipped (lock contention), so the fare is locked on stale estimates. | Open |
| SPLIT-03 | medium | `server/src/app/utils/splitFare.utils.ts:285-305` | If the post-charge `redis.set` throws, the catch rolls back the wallet and reports failure although the Stripe card was already charged. | Open |
| FARE-01 | medium | `server/src/app/utils/waitingCharge.utils.ts:82` | With a partial wallet and no card, the card part is skipped silently and the full amount is returned (got 10, expected 4). No src caller found, so latent. | Open |
| FARE-03 | medium | `server/src/app/utils/rideSchedule.utils.ts:83` | Impossible dates (`2026-02-30`, `2026-13-01`) roll over and are accepted instead of returning 400. | Open |
| FARE-04 | medium | `server/src/app/utils/rideSchedule.utils.ts:84` | `departureTime` with no minutes (`09`) or empty throws a plain `RangeError` instead of a 400 `ApiError`. | Open |
| FARE-02 | low | `server/src/app/utils/riderPriceResponse.utils.ts:16` | `Number(x) \|\| 9` turns a configured 0% VAT into 9. | Open |
| SOCK-1 | medium | `server/src/app/socket/handlers/ride/driverRejectRide.handler.ts` | A rider (non-driver) socket can reject a ride. | Open (pre-existing) |
| UTIL-1 | low | `server/src/app/queues/notification.queues.ts:57` | Two jobs for one user in the same millisecond get the same jobId. | Open (pre-existing) |
| WRK-1 | low | `worker/src/app/utils/socket-notification.service.ts:16` | `getIO` is called but never imported, so every call throws `ReferenceError`. Nothing calls it yet. | Open |
| CANCEL-1 | high | `server/src/app/socket/handlers/ride/driverCancelRide.handler.ts:88-99` | Refund created and booking finalised before wallet credit; a retry after failure creates a second Refund. | Open |
| CANCEL-2 | high | `server/src/app/socket/handlers/ride/rideCancelAfterAccept.handler.ts:124` | Falls back to `passenger.estimatedFare` as "paid" when nothing was captured, so unpaid riders get refunded. | Open |
| CANCEL-3 | high | `server/src/app/socket/handlers/ride/rideCancelAfterAccept.handler.ts:137-184` | Passenger cancelled before wallet credit; a failed credit makes retry return "No active booking found", so the rider never gets the refund. | Open |
| CANCEL-4 | high | `server/src/app/socket/handlers/ride/rideCancelAfterAccept.handler.ts:316-335` | Split ride is cancelled when one rider remains, but that rider is not cancelled, refunded or notified. | Open |
| CANCEL-5 | high | `server/src/app/socket/handlers/ride/rideCancelBeforeAccept.handler.ts:97-101` | Pending-ride cancel never releases the card authorisation (created with manual capture at booking). | Open |
| CANCEL-6 | medium | `server/src/app/socket/handlers/ride/rideCancelBeforeAccept.handler.ts:188-191` | Rejected passengers counted as remaining (`$ne cancelled` instead of `$nin cancelled/rejected`). | Open |
| CANCEL-7 | low | `server/src/app/socket/handlers/ride/rideCancelBeforeAccept.handler.ts:88` | Repeat cancel of an already cancelled ride says "driver already accepted". | Open |
| JOB-1 | high | `server/src/app/job/noDriverFound.job.ts:331-333` | Booking saved as cancelled/refunded before wallet credit; a failure is never retried. | Open |
| JOB-2 | medium | `server/src/app/job/noDriverFound.job.ts:286-296` | Stripe cancel failure is swallowed and the payment is still marked `cancelled_authorization` (same pattern in `payment.service.ts:993-1002`). | Open |
| JOB-3 | high | `server/src/app/job/noDriverFound.job.ts:279-341` | No per-booking error handling; one failure stops refunds for the other riders of an already-cancelled ride. | Open |
| JOB-4 | medium | `server/src/app/job/noShowPassengers.job.ts:39-49` | Passenger marked no-show before the hold is released; a Stripe failure strands the hold and the seat. | Open |
| JOB-5 | low | `server/src/app/job/noShowPassengers.job.ts:43-170` | A single outer try/catch aborts the rest of the batch. | Open |
| JOB-6 | medium | `server/src/app/job/noShowPassengers.job.ts:109-110` | No-show does not release the driver's Redis `bookedSeats` or gender counters. | Open |

**Characterization tests** (behaviour that may be intentional, pinned so changes are visible): split rides skip suitcase limits; 4+ riders are not rejected and 5 riders are priced at €20; the five-passenger 20% setting is unused; waiting is billed with no grace period in `calculateFareBreakdown`; negative and NaN distances are accepted; a negative wallet diverts to card; a zero lead-time or distance setting falls back to the default; a single-point route never counts as near a corridor; a driver rated 0 is shown as 5.

## Remaining work

**Not yet tested**
- `rideCancelAfterAccept` and `rideCancelBeforeAccept` are tested, but `driverCompleteTrip`, `driverStartTrip`, `pickUpRide`, `driverArrived`, and most other socket ride handlers are not.
- Jobs: `splitRidePendingMatch.job.ts` and `rideMatching.job.ts`.
- `payment.service.ts` (1420 lines), `ride.service.ts`, `auth.service.ts`, `user.service.ts`, `otp.service.ts`.
- Chat and message services.

**Risks**
- Mongoose validators, defaults, hooks and indexes are mocked out in every test, so schema-level behaviour is not exercised.
- No integration tests against real MongoDB, Redis, Stripe or SMTP.
- 24 open bugs are recorded as `it.fails` tests and none are fixed. Most of them (CANCEL-*, JOB-*, SPLIT-01..03, FARE-01) touch refund, payment or wallet money paths, and several are high severity.
