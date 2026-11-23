# Client bug fixing report #1

**Issues covered:** 15, 42, 52, 58, 61, 63, 67 (and 60), 68 from the client QA document
**Date:** 2026-11-23 · **Component:** backend (`server/`)

## 1. Summary

| | Before this work | After |
|---|---|---|
| Unit tests | 927 passed (24 files) | **1033 passed, 0 failed (35 files)** |
| Integration tests (real MongoDB + Redis) | none | **21 passed, 0 failed** |
| Production type check (`npx tsc --noEmit`) | clean | **clean** |
| Test type check (`npm run test:types`) | 2 errors | **clean** |

Every backend cause found for these issues is fixed. Each fix is covered by tests, and the main
fixes are also tested end to end against a real database, real Redis and real sockets.
The same integration suite was run against the **old code: 14 of the 21 scenarios fail there**,
so the tests reproduce the reported problems and prove the fix.

Issue 68 is not a backend problem: that notification text comes from the mobile app.

## 2. Issues, causes and fixes

### Issue 58: split ride request not received; reopening the app put the driver offline; ride accepted while offline

| Cause | Fix |
|---|---|
| When the app connected, the server first ran database lookups and only then started listening for events. A "go online" sent right after connecting was **lost**, and the app showed the driver as offline. | The server listens for events immediately on connect. |
| The server never told the app whether the driver was online, so the app and server could disagree. | On connect and on "go online" the server sends `driver:status { isOnline }`. |
| Accepting a ride while offline quietly switched the driver online. | An offline driver is refused: "You are offline. Go online to accept rides." |
| A driver who went offline but whose app kept sending location was put back into the available-drivers list, so they kept getting requests. | Location updates no longer make an offline driver available. |

### Issues 61 and 63: driver in range does not get the private ride request; sometimes it appears only after restarting the app

| Cause | Fix |
|---|---|
| A request only went to drivers who had sent a GPS position in the last 45 minutes. A driver **parked with the app open** sends no positions, so they were skipped. The rider's map still showed them as available. | A driver is "available now" if they sent a recent position **or** their app is connected and online. Ride dispatch and the rider's map use the same rule. |
| A request missed while the app was disconnected was never sent again. | On reconnect and on "go online" the server re-sends all unanswered requests (`ride:pending-requests`). |

### Issue 42: "23 / 28 drivers notified" when only 1-2 drivers are in the area

| Cause | Fix |
|---|---|
| Until 19 Nov the server chose drivers by their saved profile location, however old. That counted every old or test account in the city. | Only drivers who pass the "available now" rule are notified and counted. Old accounts are excluded (tested with 20 stale accounts near the pickup: none counted). |

Note: requests go to drivers within 10 km of pickup. The rider's map shows drivers within 5 km first and widens
to 10 km only if none are found. The count can therefore be higher than the map shows. This is a product setting
and was not changed.

### Issue 52: messaged the driver during the ride, no notification

| Cause | Fix |
|---|---|
| Opening a chat marked the user as "viewing this chat" for **24 hours**. Nothing cleared it when the user went back to another screen, so every later message skipped the notification. | "Viewing" now lasts 2 minutes and is extended while the user is active in the chat (typing, sending, reading). |
| The "viewing" mark survived a reconnect (new connection after a network drop). | The mark belongs to the connection that set it and is ignored once that connection is gone. |
| A message that arrived while the previous chat notification was being sent could be lost. | Fixed: every message gets a notification job. |

### Issue 15: notification received after logout; split ride converted to Solo after 25 minutes instead of 1 hour

| Cause | Fix |
|---|---|
| Logout cleared the push token, but the live app connection stayed open and still received messages and counts. | Logout disconnects all of the user's connections. |
| Login tokens were valid for 30 days and were **not revoked** by logout. | Logout ends the session on the server. Old tokens are rejected by the API, the socket connection and the token refresh: "Your session has ended. Please log in again." Logging in again works immediately. |
| A rider left alone on an older split ride (for example, their partner cancelled) was timed from when the **ride** was created, not from their own request, so they were converted almost at once. | The search time is measured from the rider's own request. |
| The message "until the 1h Solo fallback" was unclear. | New message: "…we will keep looking for a ride partner until 1 hour before pickup. If no partner is found by then, your ride continues as a Solo ride." (all 5 languages) |

Note: with the default setting (split rides booked at least 3 hours ahead), conversion happens 1 hour before
pickup. If `splitRideMinBookingHours` was lowered in the admin settings and a ride was booked less than about
75 minutes ahead, conversion 15 minutes before pickup is expected behaviour. Please check that setting on the
test server.

### Issues 67 and 60: strange symbols in error messages

| Cause | Fix |
|---|---|
| Validation errors reached users in raw technical form, e.g. `Invalid option: expected one of "male"\|"female"` or `must match pattern /^\d{4}-\d{2}-\d{2}$/`. | Plain sentences everywhere, e.g. "Gender must be one of: male / female.", "Departure date has an invalid format.", "Departure time is required." Translated into Greek, Hebrew, Russian and Ukrainian. Messages written for a specific field still take priority. |

### Issue 68: "Driver has picked you up. Safe journey."

The backend does **not** send this text. At pickup it sends "Trip Started! / Your ride has started. Enjoy the trip!".
The text is in the **mobile app** and must be changed there. A test now guards the backend side.

### Also fixed while testing

- Two message files loaded the whole server start-up code (database connection, port, scheduled jobs) just to
  reach the socket server. They now use the socket server directly. No behaviour change for users.
- 2 type errors in an existing test file (`splitFare.utils.test.ts`).

## 3. How it was tested

### 3.1 Unit tests (`cd server && npm test`)

Fast tests with an in-memory Redis and a mocked database. 106 new tests.

| Test file | Tests | Issues |
|---|---:|---|
| `socket/socket.init.test.ts` (real Socket.io server, raw client) | 5 | 58, 63 |
| `socket/handlers/ride/driverAcceptRide.handler.test.ts` | 5 | 58 |
| `socket/handlers/ride/driverLocationUpdate.handler.test.ts` | 4 | 58 |
| `utils/driverAvailability.utils.test.ts` | 16 | 61, 63, 42 |
| `utils/notifyDrivers.utils.test.ts` | 5 | 61, 63, 42, 58 |
| `utils/geo.utils.test.ts` (5 new, 13 updated) | 81 | 61, 63 |
| `queues/chatPush.queue.test.ts` | 9 | 52 |
| `job/splitRidePendingMatch.job.test.ts` | 11 | 15 |
| `modules/auth/auth.service.logout.test.ts` | 5 | 15 |
| `modules/auth/tokenRevocation.test.ts` | 10 | 15 |
| `config/zod.config.test.ts` | 19 | 67, 60 |
| `i18n/issueMessages.test.ts` | 12 | 15, 58, 68 |

### 3.2 Integration tests against real services (`cd server && npm run test:integration`)

What is real: **MongoDB and Redis** (throwaway Docker containers), the **Express API on a real HTTP port**,
the **Socket.io server with real login-token checks**, the **BullMQ chat notification worker**, and the
**scheduled split-ride job**. What is faked: only outside services (Firebase push delivery, Google Maps).
The suite never reads `.env`, so it cannot touch the shared database.

| # | Scenario (runs in order, like a QA session) | Issue | Old code | New code |
|---|---|---|---|---|
| 1 | Driver connects and sends "go online" with **no delay**; driver is online in the database | 58, 63 | FAIL | PASS |
| 2 | App receives `driver:status { isOnline: true }` | 58 | FAIL | PASS |
| 3 | Driver parked 3 hours with the app open receives a new private request **live**; a 3-hour-stale old account is not notified and not counted | 61, 63, 42 | FAIL | PASS |
| 4 | Driver closes and reopens the app: still online, and the missed request is delivered again | 63, 58 | FAIL | PASS |
| 5 | Driver goes offline | 58 | PASS | PASS |
| 6 | Offline driver keeps sending location but is **not** made available again | 58 | FAIL | PASS |
| 7 | Offline driver tries to accept: refused, ride unchanged | 58 | FAIL | PASS |
| 8 | Driver opens the chat; "viewing" lasts at most 120 s (was 24 h) | 52 | FAIL | PASS |
| 9 | Rider messages while the driver is looking at the chat: no notification (correct) | 52 | PASS | PASS |
| 10 | Driver went back to the map; after the viewing time lapses, the next message **is** pushed | 52 | PASS* | PASS |
| 11 | Network drop: driver reconnects on a new connection; the next message **is** pushed | 52 | FAIL | PASS |
| 12 | Invalid booking status over HTTP: readable English message, no symbols | 67, 60 | FAIL | PASS |
| 13 | Same with Russian language header: translated | 67, 60 | FAIL | PASS |
| 14 | Rider token works before logout | 15 | PASS | PASS |
| 15 | Logout disconnects the rider's live connection and clears the push token | 15 | FAIL | PASS |
| 16 | Old token after logout: API answers 401 "Your session has ended…" (also in Greek) | 15 | FAIL | PASS |
| 17 | Old token cannot reconnect the socket | 15 | FAIL | PASS |
| 18 | Logging in again works immediately | 15 | PASS | PASS |
| 19 | Setup: split ride created 2 h ago, its only rider requested 25 min ago, pickup in 50 min | 15 | PASS | PASS |
| 20 | Scheduled job runs: ride is **not** converted after 25 min | 15 | FAIL | PASS |
| 21 | After a full hour of searching: converted to Solo | 15 | PASS | PASS |

\* Scenario 10 fast-forwards the viewing timer, so it passes on old code too. The 24-hour duration that caused
the issue is caught by scenario 8.

**Old code: 14 failed, 7 passed. New code: 21 passed.**

To run the integration tests:

```bash
docker run -d --name splitride-it-mongo -p 27099:27017 mongo:latest
docker run -d --name splitride-it-redis -p 6399:6379 redis:7-alpine
cd server && npm run test:integration
docker rm -f splitride-it-mongo splitride-it-redis
```

## 4. Not tested here

- Real phones, the deployed test server, real Firebase delivery and Stripe payments. QA should re-test these
  issues on a build that includes this change.
- The server runs as a single process. The "app is connected" check reads that process's own connections. If the
  backend is ever scaled to several instances, that check must be moved to a shared socket adapter.

## 5. Needed from the mobile app

1. **Issue 68:** change the text "Driver has picked you up. Safe journey." in the app.
2. Listen for `driver:status { isOnline }` and set the online/offline toggle from it.
3. Listen for `ride:pending-requests { count, requests }` and show the requests. These are the same items as
   `GET /api/v1/passenger/ride-requests`.
4. Handle the accept error "You are offline. Go online to accept rides." by asking the driver to go online.
   The `driver:location-update` reply now also includes `isOnline`.
5. Chat: send `leave-chat` when the chat screen closes or the app goes to the background. While the chat screen
   is open, send `join-chat` again about every 60 seconds.
6. Logout: when the API answers 401 "Your session has ended. Please log in again.", go to the login screen.
   Also call `FirebaseMessaging.deleteToken()` on logout.

## 6. Changes for deployment

- New user field `tokensValidAfter` (no migration needed; empty for existing users). Existing logins stay valid
  until the user's next logout.
- New socket events sent to the app: `driver:status`, `ride:pending-requests`.
- New npm script: `test:integration` (needs the two containers above).

### Files changed

Backend: `app.ts`, `config/zod.config.ts` (new), `i18n/i18n.ts`, 5 translation files,
`middlewares/auth.ts`, `modules/auth/{auth.service,auth.utils}.ts`, `modules/user/{user.model,user.interface}.ts`,
`modules/messages/{message.service,message.controller}.ts`, `utils/driverAvailability.utils.ts` (new),
`utils/{notifyDrivers,geo}.utils.ts`, `socket/socket.init.ts`, `socket/utils/{socket.auth,driverSync}.ts`
(`driverSync` new), `socket/handlers/ride/{driverAcceptRide,driverGoOnline,driverLocationUpdate,getNearbyDrivers,splitRideRequest}.handler.ts`,
`socket/handlers/chat/{chatPresence,sendMessage,seen,typing}.handler.ts`, `queues/chatPush.queue.ts`,
`job/splitRidePendingMatch.job.ts`.

Tests and tooling: `package.json`, `vitest.config.mts`, `vitest.integration.config.mts` (new),
`tests/integration/` (new), 12 new or updated unit test files.
