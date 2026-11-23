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
- Pre-existing, not changed: `confirmPayment` auto-refunds the Stripe intent on any other error; `PATCH /payments/refund-payment` and `POST /payments/confirm-payment` have no auth middleware.

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
