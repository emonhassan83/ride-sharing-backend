# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

Split Ride is a ride-sharing backend (riders, drivers, and admins; private and split-fare rides). It is a monorepo with two independent Node/TypeScript packages, each with its own `package.json`, `node_modules`, and `.env`:

- `server/`: Express 5 REST API (`/api/v1`) plus a Socket.io server, cron jobs, MongoDB (Mongoose), and Redis. Almost all business logic lives here.
- `worker/`: BullMQ consumer that sends emails (Handlebars/Nodemailer) and push notifications. It uses `@/` path aliases (`tsconfig-paths` in dev, `tsc-alias` at build time). The server does not use aliases.
- `docs/`: project docs. `FARE_CALCULATION_PRIVATE_SPLIT.md`, `RECALCULATE_SPLIT_FARES.md`, and `STRIPE_CONNECT_ONBOARDING.md` explain the trickiest domain logic. Read them before touching fares or payouts.

`server/README.md` was copied from an unrelated "mechanic" project. Don't rely on it.

## Commands

Run these from inside `server/` or `worker/`. There is no root `package.json`.

```bash
# server/
npm run dev          # ts-node-dev with --poll, entry src/server.ts
npm run build        # tsc -> dist/
npm start            # node dist/server.js
npm run seeder       # seeds admin user + settings (needs MONGODB_URL, ADMIN_PASS)
npx tsc --noEmit     # primary correctness check; run it after every change

# worker/
npm run dev          # nodemon + ts-node --transpile-only
npm run build        # scripts/build.sh (tsc + tsc-alias)
npx tsc --noEmit

# whole stack (redis + server + worker; MongoDB is external, set via MONGODB_URL)
docker-compose up --build -d
docker-compose --profile tools up -d redis-ui   # Redis Commander on :8081
```

Redis from docker-compose is exposed on host port **6380** with password `myStrongRedisPassword`.

There is no test suite (`npm test` is a stub), and neither package has an ESLint config file, so the lint scripts don't work. The server's `lint:fix` script also calls a nonexistent `lint` binary. Treat `npx tsc --noEmit` as the gate. For manual verification, `docs/TESTING_WORKFLOW.md` prescribes throwaway scripts such as `server/src/test_scratch.ts`, run with `npx ts-node`, then deleted before committing.

## Server architecture

### Request path

`app.ts` mounts the middleware in this order: `i18nMiddleware` → morgan → cors/json → `/api/v1` router (`app/routes/index.ts` aggregates module routers) → `globalErrorHandler` → `notFound`.

Each feature in `app/modules/<name>/` follows the same file set: `.routes.ts` → `.controller.ts` → `.service.ts` → `.model.ts`, plus `.interface.ts`, `.validation.ts` (Zod), `.constant.ts`, and `.utils.ts`.

- Routes: `auth(...roles)` from `middlewares/auth.ts` (roles: `user` = rider, `provider` = driver, `admin`, plus `'common'` for any role), then `validateRequest(zodSchema)`.
- Controllers: wrap handlers in `catchAsync` and respond with `sendResponse`. They contain no business logic and no direct model calls.
- Services: hold all business logic and DB, Redis, Stripe, and queue access. Throw `ApiError(StatusCodes.X, 'English message')` from `http-status-codes`.
- Lists use `builder/QueryBuilder.ts` (search/filter/sort/paginate/fields/countTotal).

### i18n

Supported languages are `en`, `el`, `he`, `ru`, and `uk`. Translation keys are the literal English message strings, stored in `app/i18n/locales/<lang>/translation.json` under `messages`. Strings with `{{vars}}` go under `patterns`.

`sendResponse`, `globalErrorHandler`, and the socket `eventHandler` call `translateText()` on outgoing messages automatically. **When you add or change a user-facing message, add the identical English string to all five locale files**, or other languages will fall back to English.

Language comes from request headers or the user's stored language and is propagated through `AsyncLocalStorage` (`runWithLanguage` / `getCurrentLanguage`). Push notifications resolve the recipient's language through `resolveUserLanguage`.

### Real-time ride lifecycle (Socket.io)

Most of the ride flow happens over Socket.io, not REST:

- `socket/socket.init.ts` authenticates the socket (`socket.auth`) and joins it to these rooms: `<userId>`, `user:<userId>`, and `driver:<userId>` for drivers. On reconnect it restores driver online state in Redis and rejoins the active ride room.
- `socket/socket.event.ts` maps event names to handlers in `socket/handlers/{ride,chat}/`. Wrap each handler in `socket/utils/eventHandler.ts`, which sets the language context, translates `ack` messages, and routes errors to `handleSocketError`.
- **Check `socket.event.ts` before editing a handler.** Some files are dead duplicates. For example, the registered arrival and pickup handlers are `driverArrivedClean.handler.ts` and `pickUpRideClean.handler.ts`; `driverArrived.handler.ts` and `pickUpRide.handler.ts` are not registered.
- The server process exposes the `io` instance as `global.socketio` and as the `io` export of `server.ts`.

Domain model: a `Ride` (type `private` | `split`) holds one or more `Passenger` documents (one per rider). Each passenger has its own `Booking`/`Payment` with Stripe. Two status machines move in parallel:

- `RIDE_STATUS` in `modules/ride/ride.constant.ts`.
- `PASSENGER_STATUS` and `PAYMENT_STATUS` in `modules/passenger/passenger.constant.ts`.

Stripe PaymentIntents use `capture_method: 'manual'`. The card is authorized at request time and captured via `PaymentService.captureAuthorizedBookingPayment` when the driver accepts (private rides) or at pickup (split rides). Every cancellation or refund path must do all of the following:

- refund the rider's wallet
- set the booking or payment to refunded
- reverse the driver's `providerEarning` via `utils/driverEarning.utils.ts` (`revertDriverEarningIfCredited`), which debits only if the earning was actually credited. The driver wallet is credited once, at trip completion (`ride.driverEarningCredited`), so a cancellation before completion must not debit it.
- create a `Refund` document

Keep these consistent across `driverCancelRide`, `rideCancelAfterAccept`, and `job/noDriverFound.job.ts`.

Fare logic lives in `utils/` (`fareCalculator.ts`, `fareMath.utils.ts`, `splitFare.utils.ts`, `splitMatching.utils.ts`, `waitingCharge.utils.ts`, `luggage.utils.ts`). Fare and wait-time thresholds come from the `settings` module, not constants.

### Redis usage

Redis serves several purposes:

- OTPs, hashed, via `redis/helpers/otp.ts`.
- Cache keys from `redis/keys/index.ts`. Invalidate the matching key when you mutate cached data.
- Live driver state: `users:online` set, `drivers:location` GEO set, and `driver:<id>:details` hash.
- Notification dedupe: `notif:once:<userId>:<key>`, via the `dedupeKey` option of `notifyUser.utils.ts`.
- The BullMQ backend.

### Background work

- **Cron (in the server process):** `job/jobScheduler.ts` uses `node-cron`, with each job guarded by an in-process "running" flag. Jobs handle no-driver-found, no-show passengers, split fare lock, split pending match (including the 1-hour solo fallback), location history batching, and syncing driver locations from Redis to Mongo. Jobs start only inside the `server.listen()` callback, after Mongo and Redis connect. Timezone comes from `RIDE_TIME_ZONE` / `TIME_ZONE` (default `Europe/Nicosia`) via `getRideTimeZone()`. Use the `rideSchedule.utils` / `time.utils` helpers for any schedule or day/night fare math rather than raw `Date` local time.
- **BullMQ queues:**
  - `email-queue` and `notification-queue`: produced in `server/src/app/queues/`, consumed in `worker/src/app/workers/`. Queue names and job `name` values must match on both sides.
  - `chat-push-queue`: the server consumes this itself (`initChatPushWorker`).
- **Push notifications:** most ride notifications are sent **directly from the server** via `utils/notifyUser.utils.ts` → `sentPushNotification.ts` (firebase-admin `messaging.sendEach`). The `Notification` document is also persisted. The worker's socket-notification path is a stub, because the worker has no `io`.

## Conventions

- File names are camelCase with a role suffix (`ride.service.ts`). Types and interfaces are PascalCase, usually `T`-prefixed (`TRide`). Constant objects are UPPER_SNAKE_CASE with `as const` and a derived type (`TRideStatus`).
- Mongoose schemas use `{ timestamps: true }` and explicit indexes on hot query fields.
- Use `.strict()` on Zod body schemas for creation endpoints (sign-up, ride booking).
- `docs/AI_FIXING.md` asks AI agents to prepend a dated entry (completed tasks, key changes, next steps) to `.agents/SUMMARY.md` after significant tasks. The doc says `.agent/`, but the real directory is `.agents/`.
