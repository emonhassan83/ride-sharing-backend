Date/Session: 2026-11-24 (website/admin report: OTP bypass, chat access, busy rule at accept)

Completed Tasks:
- OTP bypass: `driver:start-trip` is "driver on the way" (B-20), so it stays without OTP. The hole was `driver:drop-off-passenger` accepting `in_progress`: start-trip → drop-off → complete charged a trip with no OTP. Drop-off now needs `picked_up` (set only by `driver:pickup-ride`, which enforces the OTP). A not-yet-picked-up rider gets `code: PICKUP_REQUIRED, requiresOtp: true`. The split `remainingPassengers` now also counts confirmed/driver_arrived riders. Test: `driverDropOffPassenger.otp.test.ts`.
- Messages module: `GET /message/my-messages/:chatId` had no auth. It is now participants plus admin. GET/PUT/DELETE `/message/:id`: participant read, sender-only edit (text only) and delete. `DELETE /message/chat/:chatId` and `PATCH /seen/:chatId`: participants only. `POST /send-messages` takes the sender from the token (it was `req.body.sender`), and sending to yourself → 400. `seen` emitted both chat lists with `io.emit` (to every socket); it now goes only to the two user rooms. Test: `tests/unit/modules/messages/message.access.test.ts`.
- `driver:accept-ride`: the ±60 min busy rule (`hasDriverRideAtDateTime`, new optional `excludeRideId`) on first accept → `code: DRIVER_BUSY`. Not unit-tested in the accept handler.
- `rideCancelAfterAccept`: creator cancels + transfer fails → `cancelRemainingPassengers` (riders left on a cancelled ride were not refunded).
- 4 new messages in all 5 locales.
- `GET /user/:userId`: other users (not admin, not self) now get a public profile only: name, photo, role, type, gender, language, rating, isOnline, createdAt; for drivers also vehicles (no carPapers), completedRides, isKycVerified. `phone`/`countryCode` only when the two share a ride (`sharesRide`). It used to return the full user + provider docs (email, wallet, Stripe ids, FCM token, IBAN, ID/licence images, earnings). Test: `user.publicProfile.test.ts`. The DRIVER_BUSY accept path is now tested too. 1205 unit tests pass.
- Scripts (dry run by default, `--apply` to write): `server/scripts/releaseOrphanHolds.ts` and `server/scripts/backfillSplitProviderEarning.ts`. Dry runs against the dev DB (read-only, Stripe test key):
  - SR-6707273707: its hold was already released by the no-driver job (Stripe `canceled`); only Passenger.paymentStatus still says authorized.
  - 6 bookings cancelled by the old auto-cancel bug. 4 are `canceled` in Stripe (DB stale). **2 were CAPTURED (Stripe `succeeded`) while DB says authorized: SR-6833591637 €20 and SR-6802214855 €20.** The script never touches captured ones; they need a refund decision.
  - Backfill: 25 completed split rides whose payments still show €0.

Next Steps:
- Run both scripts with `--apply` (user approval needed; dev and prod share the DB).
- Decide on refunds for SR-6833591637 / SR-6802214855, and why the DB never recorded the capture.
- Chat message list order (page 1 = oldest): waiting for the app developer.
- Before vs after accept split rules differ (after accept, 1 remaining rider → ride cancelled): product call.
- Infra: dev and prod share one MongoDB; servers run with NODE_ENV=development (stack traces); prod is old. Backfill providerEarning for split payments completed before B-06.

---

Date/Session: 2026-11-24 (admin dashboard list: sort, role filter, admin rides, KYC reject, meta)

Completed Tasks:
- `QueryBuilder.sort()`: appends an `_id` tie-breaker (same direction as the first field), so paging stops repeating or skipping rows that share a createdAt. Dashboard recent transactions too.
- `GET /user?role=`: `filter()` drops `role`, so the filter was ignored on `main` (dev's older QueryBuilder still applied it). Now handled in `getAllUsersFromDB`: `user`/`provider` (aliases `rider`/`driver`), `all`, anything else → 400. Provider rows also get `lifetimeEarnings` (= `totalEarning`, rounded).
- KYC (`PATCH /provider/:id`): reject/pending now set `User.isKycVerified=false` (and active → pending; blocked stays). Before, a rejected driver stayed verified and kept receiving ride requests, and `status: pending` was saved as rejected. Test: `tests/unit/modules/provider/provider.updateStatus.test.ts`.
- Admin `GET /ride`: `status=cancelled` fell through to the default filter (which excludes cancelled), so the list was empty. Now: cancelled, rejected, pending, accepted, started, completed, ongoing, all, overdue; unknown → 400. `scheduled`/`upcoming` hides accepted rides past pickup + 120 min (`isPastUpcomingWindow`), and `overdue` lists them. Product decision pending: nothing auto-closes them. Rows add `rideShortId`, `bookingShortIds`, and `bookingShortId` (private rides).
- `GET /user/:userId`: vehicles include `carPapers`, but only for the admin or the driver.
- `GET /meta`: `cancelledBookings`, `completedBookings`, `cancellationRate` (real bookings only: paymentStatus not pending/failed), `totalRefunded`, `totalRefundCount`. `salesReport.refunded` came from `Payment.refundAmount`, a field Payment does not have (always 0). It now sums confirmed `Refund` docs for the selected year.

Next Steps:
- SECURITY (not changed): `GET /user/:userId` is open to any logged-in user and returns a driver's `providerData` (IBAN, ID and license image URLs) and earnings. Check what the rider app needs, then restrict.
- Decide whether stale accepted rides should be auto-closed by a job (and the refund rule for that).
- `/upload/signed` does not exist. Check whether upload URLs expire (storage config).

---

Date/Session: 2026-11-24 (app team 24 Nov list: other-booking auto-cancel, list sort, rate passenger, slow acks)

Completed Tasks:
- `driver:accept-ride`: removed `cancelOtherPendingRequests`. Accepting one booking cancelled the rider's other pending bookings (`accepted_another_ride`) and changed only the Passenger status: the hold stayed authorized, the Ride stayed pending, and the rider got no message. In History, the ride did not match `status=cancelled`, so the row showed `rideId`/`rideType` null. This was SR-6707273707 (bookingId 6b054855c795e0b4dcac249a). Its hold still needs a manual release.
- `QueryBuilder`: `1`/`-1` counted as field-sort shorthand, so `?page=1` sorted by a nonexistent `page` field (lists came back unordered). Only on `main`. Shorthand is now words only (`asc`/`desc`), and pagination/special params are never sort fields. `?rating=1` is no longer dropped as a filter. Test: `tests/unit/builder/QueryBuilder.sort.test.ts`.
- `resolveRideStatusesFromQuery` (rider-rides/driver-rides): unknown status → 400 `Invalid ride status filter`. New aliases: `requested`, `confirmed`, `driver_arrived`, `picked_up`.
- Slow acks: `notifyUserPushInBackground` (fire-and-forget). It's used in `driverCancelRide`, `rideCancelAfterAccept`, and `rideCancelBeforeAccept`, where an awaited push with FCM retries (3 × 700 ms) delayed the ack. In `driverCompleteTrip`, the location-history save now runs after the ack (pushes there were already non-blocking).
- `driver:pickup-ride`: every failure ack has a `code` (MISSING_FIELDS, RIDE_NOT_FOUND, NOT_ASSIGNED_DRIVER, INVALID_RIDE_STATUS, TRIP_START_TOO_EARLY, NO_ACTIVE_PASSENGER, INVALID_OTP, OTP_REQUIRED).
- New `driver:rate-passenger` {rideId, passengerId?, rating 1-5, comment?}: the ride's driver only, the passenger must be dropped_off/completed, one rating per ride. It updates the rider's `avgRating`/`totalRating`. `ratePassenger.handler.ts`.
- 6 new messages in all 5 locales. Fixed 2 stale withdraw tests (they still expected the pre-B-06 totalEarnings). All 1190 unit tests pass.

Next Steps:
- Release the authorized hold for booking 6b054855c795e0b4dcac249a (Stripe), and check for other passengers with `cancellationReason: accepted_another_ride` and an authorized payment.
- No unit tests yet for `driver:rate-passenger`.
- Open product calls: list unpaid bookings? Refund after accept to card or wallet?
- Redeploy dev/prod from `main`.

---

Date/Session: 2026-11-23 (app team final list: busy rule, re-match, auto-cancel, timeouts, hold, KYC/earnings push, notification data)

Completed Tasks:
- Verified against the dev DB (local `.env` → Atlas `splitride`, Stripe test key), read-only: Melisa's hold `pi_3UetuwAiyUfiOQaF0yAvmO6p` was cancelled at 10:00:31Z. Today's busy case: SR-5767649458 (split 18:00) was booked while SR-1162540362 (private 17:30) was still accepted (60-min window in `hasDriverRideAtDateTime`). The 17:30 ride completed at 11:01Z, but the 18:00 ride had already used its single early re-notify, so nothing would run until 1h before pickup.
- `noDriverFound.job`: between the first re-notify and the final window it now sweeps every `waitingReminderIntervals` (5 on dev) for drivers never notified. The rider is told only when `notified > 0`.
- `GET /notification` returned `data: {}`: `toObject()` keeps the Mongoose Map as a JS Map. Now `toObject({ flattenMaps: true })`. The stored data was always correct.
- KYC push: was `ACCOUNT_STATUS` (modelType User), only with an FCM token, sent inside the transaction (an FCM error rolled back the approval). Now `notifyUserPush` after the commit, `type: KYC_STATUS`, `screen: home`, `kycStatus`. Withdraw push (the only `screen: earnings`) gets the same treatment, plus `withdrawId`/`withdrawStatus`/`amount`.
- Dev server facts: it runs ts-node-dev (dev mode, stack traces in responses). The B-14 build arrived about 09:00Z, but not `da5c980` (at 10:00Z it still cancelled SR-0552185702 "Only one passenger remaining").
- Docs: `docs/APP_INTEGRATION_ROUND4.md` "Final list (fourth message)" plus section 4. Tests: `tests/integration/appTeamRound5.int.test.ts` (6 of 8 fail on the old code). Updated the unit tests for the job and withdraw.

Next Steps:
- `noDriverFound.job` falls back to `matchingLastNotifyHours ?? 24` when the setting is missing, while the settings default is 1. Dev has it set; align it when the job tests are reworked.
- Timeouts: need server logs (endpoint + timestamp). Move dev off ts-node-dev and use `docker-compose.prod.yml` for prod.
- Redeploy dev/prod from `main`.

---

Date/Session: 2026-11-23 (app team: split cancel cascade, one card per ride, totalSeats 0)

Completed Tasks:
- `rideCancelBeforeAccept`: a split ride was cancelled whenever one rider or fewer remained, so a 2-rider ride lost the other rider's booking too (SR-0552185702). Now it's cancelled only when nobody is left. The creator leaving transfers ownership even to a single rider. The remaining riders are recalculated (`passenger_cancelled`). `remainingSeats` is `null` while `totalSeats` is 0 (it was negative). Removed `cancelAndNotifyRemaining`.
- `recalculateSplitFares` → `ride:request-updated`: `reason` maps cancelled/rejected to `passenger_left`. `totalSeats` falls back per driver to `driver:<id>:details.seats` (default 4) while the ride's is 0.
- Product decision (user): one card per ride, one Accept takes the whole ride. `driver:accept-ride` without `passengerId` on a split ride accepts every pending rider within the cap. Blocked riders go to `skippedPassengers`. The per-rider body moved into `acceptSplitPassenger`, and the in-memory `ride.driverId` is synced so "already taken" is sent once. `driver:reject-ride` without `passengerId` on a split ride = decline for this driver only (like private). `GET /passenger/ride-requests` is grouped per ride (old fields from the first rider plus `riders`/`bookedSeats`/`totalSeats`/`totalFare`/`passengers`).
- 4 new messages in all 5 locales. Docs: `docs/APP_INTEGRATION_ROUND4.md` section 3 and "Split rides (third message)". Tests: `tests/integration/splitOneCard.int.test.ts`, plus updated unit tests (cancel-before-accept, splitFare, reject).

Next Steps:
- `rideCancelAfterAccept` has the same "one rider or fewer remaining → cancel everyone" rule after a driver accepted. Not changed, but probably the same bug: needs a product call.
- Split `driver:reject-ride` WITH `passengerId` still marks that rider `rejected` on the ride for all drivers (and cancels the ride without releasing holds when none are pending). The app should stop using it from the card.
- Redeploy dev/prod from `main`.

---

Date/Session: 2026-11-23 (app team follow-up: cancel ack, boarding state, refresh, chat push)

Completed Tasks:
- Cancel: both cancel handlers already ack, but the ack comes last (after all pushes). The cancelling rider's `ride:cancelled` now carries `feeAmount`/`feePercent`/`refundAmount`/`refundDestination`; after-accept previously sent the canceller no `ride:cancelled` at all.
- `GET /ride/driver-rides`: added `pickedUpCount`, `canDriverCancel`, `passengerDetails`. Shared constant `DRIVER_CANCEL_BLOCKING_PASSENGER_STATUSES` (also used by `driverCancelRide`).
- `POST /auth/refresh-auth` was broken: verified with the access secret, cookie only, user by email, 500 on bad token. Now body `{ refreshToken }` (cookie fallback), refresh secret, user by id, 401. Removed a bogus cookie in `loginWithPhone`.
- Chat push: `screen: 'chat'` set explicitly.
- Docs: `docs/APP_INTEGRATION_ROUND4.md` section 2, 5 and the section 8 follow-up. Test: `tests/integration/appTeamFollowUp.int.test.ts`.

Next Steps:
- Redeploy dev and prod from `main` (unchanged from the entry below).

---

Date/Session: 2026-11-23 (app team: "nothing is deployed" + questions)

Completed Tasks:
- App team found none of round 4 on dev (`72.244.153.29:8080`) or prod. Cause: the code is only on `main`; `origin/development` is 76 commits behind and has none of QA rounds 1 to 4. Servers need a redeploy from `main`.
- Answered the app team's questions in `docs/APP_INTEGRATION_ROUND4.md` section 8 (REST OTP `resend`, who sees the OTP, chat by id, logout/FCM, wait fee keys, B-19 30-minute rule) and replaced "Everything below is live" with a deploy check.
- Security fix: `/chats/:id` (GET/PUT/DELETE) and `/chats/booking/:bookingId` had no participant check (any user could read the other side's email/phone, edit, or delete a chat; PUT could rewrite `participants`). Now scoped to participants (404 otherwise), PUT only sets `name`/`status`, POST `/chats` requires the caller to be a participant. Test: `tests/integration/chatSecurity.int.test.ts` (4/6 fail on the old code).

Next Steps:
- Merge `main` into `development` and redeploy both servers. `development` has one commit not on `main` (`5ada35d`, `minimumFareApplied`/`minimumFareAdjustment` compared against `actualFare` in `fareMath.utils.ts`); keep it on purpose or drop it on purpose.

---

Date/Session: 2026-11-23 (app doc checklist)

Completed Tasks:
- Added section 7, a test checklist for the app team, to `docs/APP_INTEGRATION_ROUND4.md`.

---

Date/Session: 2026-11-23 (app integration doc check)

Completed Tasks:
- Checked `docs/APP_INTEGRATION_ROUND4.md` against the code. Fixed: socket error shape (`details`/`data`, `status` not always present, missing codes), FCM token length, B-15 wording (earnings rows do not carry short ids), split-search contact masking, B-19 text, 400 for malformed ids.

---

Date/Session: 2026-11-23 (coverage check of round 4)

Completed Tasks:
- Mapped every B-01..B-24 to tests; added missing ones: B-02 (NODE_ENV gate, 7 cases), B-19 (scheduled accept text; helper now exported), B-07 (ride:request-updated reaches only notified drivers), B-17/B-21 (settings exposed in GET generals).
- Still no automated test: B-03 (TLS/infra), B-05 (policy, wallet refund by design), B-22 beyond existing socket error tests.
- tsc clean; unit 1176, integration 96 passing.

---

Date/Session: 2026-11-23 (verification follow-ups)

Completed Tasks:
- Rider split search now masks the unassigned driver's phone and hides the email (`findNearBySplitRide.handler.ts`).
- `globalErrorHandler` maps Mongoose ObjectId CastError to 400 "Invalid ID format" (new string in all 5 locales); was 500 on every route.
- tsc clean; unit 1166, integration 94 passing.

---

Date/Session: 2026-11-23 (independent verification of QA round 4 fixes)

Completed Tasks:
- Re-ran everything independently, added `tests/integration/round4Verification.int.test.ts` (7 adversarial probes: wallet boundaries/ownership/invalid input, quote auth + malformed id, settings validation, split-search PII).
- Found and fixed 2 defects the earlier round missed: (1) `ride:find-nearby-split-ride` returned other riders' full phone numbers (B-18 class) because `passengers[].userId` was populated with `phone`; phone removed. (2) `GET /ride/:id/cancellation-quote` with a malformed id returned 500 (CastError); now 404.
- tsc clean; unit 1166 passing; integration 92 passing.

Pending/Next Steps:
- Confirm with the app team whether `driverEmail`/`driverPhone` in the same search result are needed before a rider joins (still returned; contact of an unassigned driver).
- Malformed ObjectIds still give 500 on most other routes (no global CastError mapping); consider mapping CastError to 400/404 in globalErrorHandler.
- B-01 root cause not reproduced: the original `payWithWallet` already debited the wallet; the fix is hardening (atomic conditional debit), not a proven root-cause fix.

---

Date/Session: 2026-11-23 (QA round 4: last two open items)

Completed Tasks:
- Driver wallet going negative: cancel/refund paths debited `payment.providerEarning`, but since 4a0e2ba the driver is only credited at trip completion. New `utils/driverEarning.utils.ts` `revertDriverEarningIfCredited` debits only when `ride.driverEarningCredited` is true; used in driverCancelRide, rideCancelAfterAccept (x2), rideCancelBeforeAccept, noDriverFound job. CLAUDE.md rule updated.
- Refund status push: empty title made `Notification.create` fail ("Message is required") inside the refund transaction, so admin approval returned 500 and the wallet credit rolled back for any rider with an FCM token (reproduced in an integration test before the fix). `refund.utils.ts` now has real titles/bodies per status (6 strings in all 5 locales), correct `modelType` key + `REFUND_ISSUED` routing data; the push is sent after commit and cannot fail the refund. Dead `refundAddNotifyToVendor` removed.
- Refund status endpoint (`PATCH /refunds/status/:id`): ApiErrors keep their status (404/400), "already processed" is a fixed translated 409 (was a 403 with an interpolated, untranslatable message, then wrapped into 500), a concurrent double approval's write conflict maps to 409, unknown errors return a generic 500 without internal text. 2 strings in all 5 locales.
- Unit 1166, integration 85 passing; tsc clean.

---

Date/Session: 2026-11-23 (QA round 4 follow-up: open items: product settings, release hardening, app guide)

Completed Tasks:
- Product decisions turned into admin settings (defaults = previous behaviour): `cancellationFeePercent` (0), `lateCancellationFeePercent` (100), `splitRideMinimumFare` (0 = baseFare).
- Release: OTP mock mode fail-closed, production compose with Caddy HTTPS/WSS, `TRUST_PROXY`.
- Docs for the other teams: `docs/APP_INTEGRATION_ROUND4.md` (app), `docs/PRODUCT_SETTINGS_ROUND4.md` (product, incl. suggested T&C refund wording), `docs/DEPLOYMENT.md` §5 (ops).
- Unit 1159 passing (5 new); integration 81 passing (1 new: admin fee → quote). `tsc` + `test:types` clean. Compose file and Caddyfile validated with `docker compose config` / `caddy validate`.

Key Changes:
- `rideSchedule.utils.getCancellationFeePercents` (0 allowed, clamped 0..100) used by `calculateCancellationRefund`; refund = paid − fee. Quote adds `lateFeeFrom`, `earlyFeePercent`, `lateFeePercent`; `freeCancellationUntil` is null when an early fee is set.
- `fareMath.resolveSplitMinimumFare` + `splitMinimumFare` input, applied to MATCHED split riders only; passed from `fareCalculator`, `splitFare.calcSplitPassengerFare`, `fareBreakdownResponse`.
- `config.exposeDevSecrets` (true only for NODE_ENV development/test) replaces `!== 'production'` in auth/otp services and `rideStartOtp.utils`; startup warning in `server.ts`.
- New: `docker-compose.prod.yml`, `deploy/Caddyfile`.

Next Steps:
- Product: pick fee % / split minimum and set them in admin; legal review of the T&C wording.
- App team: implement `docs/APP_INTEGRATION_ROUND4.md`. Ops: DNS + `docker-compose.prod.yml`, switch app URLs to https.
- Still open from round 4: driver wallet debit on cancel before completion credit (needs decision); empty push titles in `refund.utils.ts`. `cancellationFreeWindowHours` / `cancellationPercentage50Hours` settings are unused.

---

Date/Session: 2026-11-23 (QA round 4: SplitRide_Backend_Issues_2026-11-23, B-01..B-24)

Completed Tasks:
- Verified all 24 items. Fixed: B-01, 04 (quote + fee in acks; policy unchanged), 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 18, 19, 20, 21, 22, 23, 24. No code (by design / infra / app-side): B-02, 03, 05, 16, 17 (values now exposed in /setting/generals).
- Unit 1154 passing (28 new or updated); integration 80 passing (11 new in `round4Issues.int.test.ts`, lifecycle test updated). `tsc` + `test:types` clean.

Key Changes:
- Money: `payWithWallet` conditional atomic debit, returns `bookingShortId` + `walletBalance`; private accept sets exact `bookedSeats` (wallet bookings showed 0). `recalculateSplitFares` keeps surcharge/commission in sync when the fare is unchanged (€20 minimum hid the matched state); split completion writes the ride payout pro rata to payments; Ride stores `driverGrossAmount/driverPlatformFeeAmount/driverVatAmount`; invoice totals are an explicit breakdown (old `vatAmount` was a residual).
- Cancel: `utils/cancellationQuote.utils.ts` (`GET /ride/:id/cancellation-quote`, socket `ride:cancel-quote`), fee fields in cancel acks; cancel-before-accept notifies the rider; `notifyRiderDriversNotified` skips riders no longer waiting; no-driver job reports refund/release, sorts by departure, expires pending riders on accepted rides; driver cancel refused once anyone boarded (`CANNOT_CANCEL_AFTER_PICKUP`).
- Realtime: split notify dedupes per passenger (Redis `ride:notified:<ride>:passenger:<p>`) and re-sends to previously notified drivers; `ride:request-updated` to drivers after recalculation; push dedupe per passenger.
- OTP: issued on arrival, reused until expiry (extended, never replaced), `resend` flag, deliveries in parallel/background, 5-attempt lock, no split fallback key. `PATCH /auth/fcm-token`.
- Notifications: `type` + `data` persisted; `buildNotificationRoutingData` adds type/screen everywhere. `ride:driver-en-route` + `DRIVER_EN_ROUTE`; scheduled-ride accept text. Socket errors carry `code`, no internal text.
- Privacy: `utils/contactPrivacy.utils.ts` on `/passenger/ride/:id`, `/passenger/:id`, `/ride/:id` (access check + masking until accepted). Start window `tripStartEarlyWindowMinutes` (default 30). `POST /setting/generals` now admin-only (was unauthenticated).

Pending/Next Steps:
- Product: cancellation-fee policy (app says 20% within 24h; backend refunds 100% outside 1h private / 24h split and 0% inside); split minimum fare per rider; refunds-to-wallet wording in terms.
- Pre-existing, not fixed: cancel paths debit `providerEarning` from the driver wallet although it is only credited at completion (driver wallet can go negative). `refund.utils.ts` sends empty titles.
- Release: `NODE_ENV=production` (OTP leaves responses), TLS/wss. App: call `PATCH /auth/fcm-token`, `ride:cancel-quote`, handle `ride:request-updated`, `ride:driver-en-route`, error `code`.

---

Date/Session: 2026-11-23 (client QA doc #3: backend issues 14, 23, 24, 27, 28, 29, 30, 5)

Completed Tasks:
- Triaged all 32 entries (7 already fixed in rounds 1-2, ~14 app-only). Fixed the backend ones. Report: `docs/CLIENT_BUG_FIXING_REPORT_3.md`.
- Unit 1126 passing (48 new); integration 56 passing (19 new in `round3Issues.int.test.ts`; old code fails 15, the other 4 are controls). `tsc` + `test:types` clean.

Key Changes:
- Issue 14: `utils/acceptGuard.utils.ts`. `driverAcceptRide` (both branches) refuses cancelled/rejected/completed passengers or bookings and refunded/released payments. `confirmPayment` / `createPaymentIntent` / `payWithWallet` refuse closed bookings; refunded/released payments are never reused; the closed-booking error skips the confirm auto-refund (would refund the card on top of the wallet). `driverCompleteTrip` does not overwrite refunded bookings. Admin recent transactions sorted by `updatedAt`.
- Wallet pay + cancel before accept: `rideCancelBeforeAccept` now refunds the wallet (atomic payment claim, Refund doc), closes the booking, and claims the passenger atomically (double tap).
- Issue 30: `deleteUserProfile` uses `hasBlockingActiveRide` / `isRideStillActive` (stale accepted/pending rides past `isPastUpcomingWindow` no longer block).
- Issue 23: `POST /provider` resubmits for rejected/pending KYC (status back to pending); verified still 409.
- Issues 24/27/28/29: `utils/profileValidation.utils.ts` used by user + vehicle Zod schemas; drivers 18+ in `updateUserProfile`; vehicles max 30 years (`MAX_VEHICLE_AGE_YEARS`, product to confirm).
- 9 strings added to all 5 locales. Integration Mongo is now a single-node replica set (transactions); see `vitest.integration.config.mts`.

Pending/Next Steps:
- Client: confirm max vehicle age (30 used) and driver minimum age (18).
- Mobile: wait-notice amount from `waitTimeNotice.feeAmount` (EUR 20), not a hardcoded EUR 10; show server validation messages.
- Follow-up done (report #3 section 8): payment endpoint auth. `confirm-payment` needs auth + owner, intent `metadata.paymentId` must match, auto-refund only for verified captured money not yet committed (`refundOnFailure`/`committed`), ApiError codes kept; `refund-payment` admin-only + validation + only paid payments; `GET /payments/:id` and `/booking/:id` restricted to rider/driver/admin. `paymentSecurity.int.test.ts` (11; old code fails 10). Integration now 67. Mobile must send the token on `confirm-payment`.

---

Date/Session: 2026-11-23 (client QA doc #2: issues 4, 8, 9, 13)

Completed Tasks:
- Fixed late / missing / duplicate notifications and the two issue-13 bugs. Report: `docs/CLIENT_BUG_FIXING_REPORT_2.md`.
- Unit 1078 passing (45 new); integration 37 passing (16 new; old code fails 11 of them). `tsc` + `test:types` clean.

Key Changes:
- `sentPushNotification`: `buildPushDeliveryOptions` (ride-state TTL 10 min / default 24 h, collapse key = type:passenger|ride|chat, apns priority/expiry/collapse-id, optional `FCM_ANDROID_CHANNEL_ID`).
- `notifyUserPush`: up to 3 FCM attempts; dead tokens cleared.
- `driverAcceptRide`: capture failure with no money moved (`PaymentService.getBookingCaptureState`) releases the claim + "Payment Needs Attention" push; "already taken" only after capture; socket event before push.
- `notifyNearbyDrivers*`: `runWithConcurrency` (5). `notifyRiderDriversNotified`: re-match push only when count grows (`drivers-notified:pushed-count:<rideId>`).
- Start/drop-off/complete: atomic status transitions + dedupe keys; start push "Driver On The Way"; drop-off & complete share `trip-finished:<pid>`; start OTP re-used while >60 s valid, push/SMS/email once per 60 s.
- `driverLocationUpdate`: per-rider `ride:live-update` with `phase`/`eta`/`passengerId` (`utils/liveEta.utils.ts`), ride room `.except(riderRooms)`; `ride:driver-arrived` has `phase/eta/passengerStatus`, correct `autoDetected`.
- `ride.service`: `isPastUpcomingWindow` (date+time + 120 min grace) applied to accepted rides whenever accepted (not history) is requested.

Pending/Next Steps:
- Product: auto-cancel + refund accepted rides never started? Enable 100 m auto-arrival? (both left off).
- Mobile: use `phase` in live updates; avoid local+push duplicates; foreground display; create Android channel and share its id.

---

Date/Session: 2026-11-23 (client QA issues 15, 42, 52, 58, 61, 63, 67, 68)

Completed Tasks:
- Fixed the server-side causes of QA issues 15, 42, 52, 58, 61, 63, 67/60; 68 is app-side (text not sent by the server). Full report: `docs/CLIENT_BUG_FIXING_REPORT_1.md`.
- Unit: 1033 passing (106 new). Integration (real Mongo + Redis in Docker, `npm run test:integration`): 21 passing; the old code fails 14 of them. `tsc` and `test:types` clean.
- Follow-ups also done: logout revokes tokens (`user.tokensValidAfter`, `iatMs` in `createToken`, checked in `auth` middleware, `socketAuth`, refresh); `driver:location-update` no longer re-adds offline drivers (`isDriverMarkedOnline`); `messages` module uses `getIO()` instead of importing `server.ts` (that import booted the whole server in tests); fixed 2 pre-existing test type errors.

Key Changes:
- `socket.init.ts`: `registerSocketEvents` runs before any await (early `driver:go-online` was dropped); drivers get `driver:status` + `ride:pending-requests` on connect and go-online (`socket/utils/driverSync.ts`).
- `utils/driverAvailability.utils.ts`: one "available now" rule (fresh ping OR connected socket + `users:online`) used by dispatch (`notifyDrivers.utils`) and the rider map (`fetchDriversWithinRadius`, new optional `io` param).
- `driverAcceptRide`: offline drivers are refused ("You are offline. Go online to accept rides.") instead of silently switched online.
- `chatPush.queue`: presence TTL 24h -> 120s, value = socket id (dead socket ignored), `refreshUserActiveInChat` on send/typing/seen; atomic buffer read; separate job id when a batch job is active.
- `logoutUser`: disconnects all user sockets (`io.in(uid).disconnectSockets(true)`) and clears chat presence.
- `splitRidePendingMatch.job`: lone-split Solo fallback timed from the rider's createdAt (exported `isSoloFallbackDue`, `hoursSinceSearchStarted`); clearer split-search message.
- `config/zod.config.ts` (imported first in `app.ts`): global readable Zod messages + 13 `validation_*` i18n patterns in all 5 locales.

Pending/Next Steps:
- Mobile app: change "Driver has picked you up. Safe journey." text (issue 68); handle `driver:status`, `ride:pending-requests`, offline-accept error, 401 "Your session has ended"; `leave-chat` on background / `join-chat` heartbeat; `deleteToken()` on logout.
- Verify on a deployed build with real devices, Firebase and Stripe; check deployed `splitRideMinBookingHours`.
- "Connected" check reads the local Socket.io adapter; needs a shared adapter if the server is ever scaled out.
- Three docs (`docs/P0_*`, `P1_*`, `P2_*`) show as deleted in the working tree; not done in this session.

---

Date/Session: 2026-11-22 (bug-fix pass)

Completed Tasks:
- Fixed all 32 bugs that were recorded as `it.fails` unit tests (25 server, 7 worker). Each test is now a normal regression test in a `FIXED BUGS (regression tests)` group. Full list with fixes: `docs/TEST_RESULTS.md`.

Key Changes:
- Refund paths (`driverCancelRide`, `rideCancelAfterAccept`, `noDriverFound.job`): the rider's wallet is credited BEFORE the booking/passenger is finalised, so a failed credit stays retryable and is never paid twice.
- `rideCancelAfterAccept`: no refund of the estimated fare when nothing was captured; the remaining rider(s) of a split ride cancelled for too few riders are now cancelled, refunded in full and notified (`cancelRemainingPassengers`).
- `rideCancelBeforeAccept`: releases the card hold; rejected passengers no longer count as remaining.
- `driverRejectRide`: only the `provider` role may reject.
- `noShowPassengers.job` / `noDriverFound.job`: per-item try/catch; hold released before marking no-show; a failed Stripe cancel no longer marks the hold released.
- `splitFare.utils`: `recalculateSplitFares` now returns `boolean` (false = lock not acquired) and `lockSplitRideFare` does not lock in that case; recalculation keeps the platform commission; a Redis failure after a card charge no longer rolls the charge back.
- Worker: SMTP and push failures now fail the job (BullMQ retries); notifications POST to `/notification`; FCM data values are stringified; `.env.example` lists `TIME_ZONE` and `SERVER_URL`.

Pending/Next Steps:
- `POST /api/v1/notification` has no auth middleware (the worker relies on it).
- `payment.service` `cancelAuthorizedBookingPayment` still marks a hold released when the Stripe cancel fails; untested, so left unchanged.
- Fixes are verified with mocked models/Stripe/Redis only; not yet run against real services.

---

Date/Session: 2026-11-22

Completed Tasks:
- Fixed lone/unmatched split rides never converting to Solo when booked less than ~1h10m before pickup (Solo window was only `[created+1h, departure]`, 10 minutes or empty).

Key Changes:
- `server/src/app/job/splitRidePendingMatch.job.ts`: new `isSoloFallbackDue()` used by both `releaseLoneSplitRidesToSolo` and the backlog loop. Due when pickup is within `matchingLastNotifyHours` and (full search done OR pickup <= 15 min away). Backlog passengers still unmatched at pickup are now cancelled at pickup (was 15 min after), so they can't keep matching after departure.

Pending/Next Steps:
- Rides store wall-clock `departureTime` without a timezone; the server interprets it in `RIDE_TIME_ZONE`/`TIME_ZONE` from `.env`. Testers in another zone than the server's `.env` see rides "past due" that the server still considers hours away.
- Timezone is now `.env`-only: removed hardcoded `TZ/TIME_ZONE/RIDE_TIME_ZONE=Europe/Nicosia` and `/etc/localtime` symlinks from docker-compose and all four Dockerfiles (the image's `RIDE_TIME_ZONE` used to beat `.env` `TIME_ZONE`). `user.model` timeZone default now uses `config.timeZone`; worker logger uses resolved `env.timeZone`. Only remaining literal is the single `DEFAULT_TIME_ZONE` fallback (server `env.config.ts`, worker `env.ts`) when `.env` has none. Tests stay pinned to Nicosia in `vitest.config.mts` on purpose.

---

Date/Session: 2026-07-01

Completed Tasks:
- Fixed Docker compose build issues by resolving npm dependency conflicts (TypeScript 6 -> 5.8.3, ESLint 10 -> 9.25.0, dotenv 17 -> 16.5.0, uuid 14 -> 11.1.0, etc.) in both server and worker `package.json` files and deleting stale package-lock.json files.
- Resolved node-cron missed execution warnings at server startup by rescheduling `startBackgroundJobs()` to only execute inside the `server.listen()` callback once connection tasks (Mongoose, Redis) have completed.
- Implemented and synchronized the passenger payment refund logic for ride cancellations. Specifically, when a ride is cancelled by a driver (`driverCancelRideHandler`) or by the system (`noDriverFound.job`), passengers who have already checked out and paid are fully refunded to their wallets, their booking payment status is updated to `refunded`, their associated Stripe/wallet `Payment` records are marked as `refunded`, and driver's wallets are debited by any `providerEarning` they had received.
- Integrated `Refund` document creation into `rideCancelAfterAccept.handler.ts` (when passenger/rider cancels ride after acceptance) and `noDriverFound.job.ts` (when system cancels ride because no driver is found).

Key Changes:
- Modified [server/package.json](file:///d:/bd-calling/task/ride-sharing-backend/server/package.json) and [worker/package.json](file:///d:/bd-calling/task/ride-sharing-backend/worker/package.json) to correct package versions.
- Modified [server/src/server.ts](file:///d:/bd-calling/task/ride-sharing-backend/server/src/server.ts) to move `startBackgroundJobs()` inside `server.listen()` callback.
- Modified [driverCancelRide.handler.ts](file:///d:/bd-calling/task/ride-sharing-backend/server/src/app/socket/handlers/ride/driverCancelRide.handler.ts) to handle user refunding, driver wallet debiting, payment record updates, and Refund doc creation on driver cancellation.
- Modified [rideCancelAfterAccept.handler.ts](file:///d:/bd-calling/task/ride-sharing-backend/server/src/app/socket/handlers/ride/rideCancelAfterAccept.handler.ts) to handle driver wallet debiting, payment record updates, and Refund doc creation on passenger cancellation after acceptance.
- Modified [noDriverFound.job.ts](file:///d:/bd-calling/task/ride-sharing-backend/server/src/app/job/noDriverFound.job.ts) to query bookings under system-cancelled rides, refund paid bookings to user wallets, set payment status to refunded, and revert driver earnings.

Pending/Next Steps:
- None.

---

Date/Session: 2026-06-29

Completed Tasks:
- Updated outdated server and worker dependencies to their latest versions (including `bullmq`, `convert-csv-to-json`, `eslint`, `i18next`, `mongoose` in server; and `prisma`, `firebase-admin`, `bullmq`, `eslint`, `typescript`, `uuid`, etc. in worker).
- Added typescript compiler override options (`ignoreDeprecations: "6.0"`) and resolved firebase-admin v14 messaging import breaking changes in worker to ensure clean compiles post-upgrade.
- Checked and verified that typescript compilation is clean on both server and worker.

Key Changes:
- Modified [package.json](file:///c:/bdcalling/explore/ride-sharing-backend/server/package.json) dependencies.
- Modified [package.json](file:///c:/bdcalling/explore/ride-sharing-backend/worker/package.json) dependencies.
- Modified [tsconfig.json](file:///c:/bdcalling/explore/ride-sharing-backend/worker/tsconfig.json) options.
- Modified [push-notification.service.ts](file:///c:/bdcalling/explore/ride-sharing-backend/worker/src/app/utils/push-notification.service.ts) to use modular imports.
- Modified [notification.workers.ts](file:///c:/bdcalling/explore/ride-sharing-backend/worker/src/app/workers/notification.workers.ts) to remove unused variables.

Pending/Next Steps:
- None.

---

Date/Session: 2026-06-29

Completed Tasks:
- Updated `PROJECT_OVERVIEW.md` to provide a complete overview of the project, adding detailed information about project goals, monorepo components (REST routes, Socket.io communication in server, BullMQ offloading in worker), recent enhancements (FCM tokens, driver ride queries), and links to new documentation files.

Key Changes:
- Modified [PROJECT_OVERVIEW.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/PROJECT_OVERVIEW.md) content.

Pending/Next Steps:
- None.

---

Date/Session: 2026-06-29

Completed Tasks:
- Generated comprehensive system architecture, API guidelines, coding rules, deployment infrastructure, and AI system prompt documentation.

Key Changes:
- Created files inside the `docs/` directory: [ARCHITECTURE.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/ARCHITECTURE.md), [API_GUIDELINES.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/API_GUIDELINES.md), [AUTHENTICATION.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/AUTHENTICATION.md), [CODING_RULES.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/CODING_RULES.md), [DATABASE_SEEDING.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/DATABASE_SEEDING.md), [DEPLOYMENT.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/DEPLOYMENT.md), [FOLDER_STRUCTURE.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/FOLDER_STRUCTURE.md), [TESTING_WORKFLOW.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/TESTING_WORKFLOW.md), and [AI_SYSTEM_PROMPT.md](file:///c:/bdcalling/explore/ride-sharing-backend/docs/AI_SYSTEM_PROMPT.md).

Pending/Next Steps:
- None.

---

Date/Session: 2026-06-29

Completed Tasks:
- Filtered driver rides returned by `getDriverRides` based on active passenger count and passenger payment status.
- Added FCM token support during user registration (sign-up) and login validations.

Key Changes:
- Modified `getDriverRides` in [ride.service.ts](file:///c:/bdcalling/explore/ride-sharing-backend/server/src/app/modules/ride/ride.service.ts) to filter rides using active passenger count and paid statuses.
- Added `fcmToken: z.string().optional()` to `createUserValidationSchema` in [user.validation.ts](file:///c:/bdcalling/explore/ride-sharing-backend/server/src/app/modules/user/user.validation.ts).
- Added `fcmToken: z.string().optional()` to `loginValidationSchema` and `loginWithPhoneValidationSchema` in [auth.validations.ts](file:///c:/bdcalling/explore/ride-sharing-backend/server/src/app/modules/auth/auth.validations.ts).
- Updated `createUser` in [auth.service.ts](file:///c:/bdcalling/explore/ride-sharing-backend/server/src/app/modules/auth/auth.service.ts) to destructure and save `fcmToken`.

Pending/Next Steps:
- None.
