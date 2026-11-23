# Client bug fixing report #2

**Issues covered:** 4, 8, 9, 13 (both entries numbered 13) from the second client QA document
**Date:** 2026-11-23 · **Component:** backend (`server/`)

## 1. Summary

| | Before this work | After |
|---|---|---|
| Unit tests | 1033 passed | **1078 passed, 0 failed** (45 new) |
| Integration tests (real MongoDB + Redis) | 21 passed | **37 passed, 0 failed** (16 new) |
| Production type check (`npx tsc --noEmit`) | clean | **clean** |
| Test type check (`npm run test:types`) | clean | **clean** |

All four issues had real backend causes, and all are fixed. The 16 new integration scenarios drive
one real private ride from accept to completion over sockets, as QA does. They were also run against
the code from before this round: **11 of the 16 fail on the old code** and all pass on the new code.

## 2. Issues, causes and fixes

### Issue 8: driver accepted the ride, but the rider got no notification, or got it late

| Cause | Fix |
|---|---|
| The ride was assigned to the driver **before** the card payment was captured. If the capture failed, the rider got nothing, but the ride stayed "accepted" by that driver, so it was no longer being offered to anyone. A later retry by the driver then produced a very late "accepted" notification. | If the capture fails and **no money was taken**, the ride goes back to searching and the rider gets "Payment Needs Attention". If money *was* taken (or we can't tell), the driver keeps the ride and a retry finishes safely without charging twice. Other drivers are told "already taken" only after a successful capture. |
| The rider's live "driver accepted" screen update was sent only **after** the push notification had gone through Firebase. | The live update is sent first, then the push. |
| A single failed Firebase delivery was never retried, and blocked later attempts for 6 hours. | Up to 3 attempts. Dead device tokens (app uninstalled or token rotated) are removed. |

### Issue 4: late notifications

| Cause | Fix |
|---|---|
| Notifications had **no expiry**. A phone that was offline or in battery-saving mode received every ride update in a burst, hours later (Firebase keeps them up to 4 weeks). | Live ride updates (accepted, arrived, trip started and so on) expire after **10 minutes**. Everything else expires after 24 hours. |
| Old and new notifications for the same ride stacked up. | A newer notification for the same ride and event **replaces** the older one on the phone. |
| Drivers were notified strictly one at a time (DB checks plus a Firebase round trip each), so later drivers, and the rider's "drivers notified" message, waited for everyone before them. | Up to 5 drivers are notified in parallel. Tested: 12 drivers that each take 100 ms finish in under 0.8 s instead of over 1.4 s. |
| iOS priority was not set explicitly, and there was no Android notification channel. | iOS priority is set to high. The Android channel can be set with `FCM_ANDROID_CHANNEL_ID` once the app creates that channel (see section 5). |

### Issue 9: the same notification arrives several times

| Duplicate | Fix |
|---|---|
| "Drivers Notified – 3 nearby drivers…" followed about a minute later by "Still Searching – 3 nearby drivers…" | The follow-up is pushed only when **more** drivers have been reached. The live screen update still happens. |
| Start trip sent "Trip Started" and pickup sent "Trip Started!" | Start trip now says **"Driver On The Way"**. "Trip Started!" is sent once, at pickup. |
| The rider received the "trip started" live event twice | One event instead of two. |
| Driver double-tapping start, drop-off or complete ran the step twice and notified twice | These steps now run once (protected status change). Each notification also has a duplicate guard. |
| Private ride: "You have been dropped off" plus "Trip Completed!" (same fare) | One "trip finished" notification per rider. |
| Every pickup attempt or "resend code" created a **new** start code with a new push, SMS and email | The current code is re-used while it is valid. The same code is sent at most once a minute. |

### Issue 13 (first entry): driver has arrived, but the app still shows "Driver Arriving in 1 min"

| Cause | Fix |
|---|---|
| After the driver arrived, every location update still sent the rider an ETA. The ETA could never go below 1 minute, so a driver standing at the pickup was always "1 min" away. | Each rider gets their own update with a `phase`: `to_pickup`, `arrived` or `to_destination`. Once the driver has arrived, the rider gets **`phase: "arrived"`, `eta: 0`**. |
| On a started ride, the ETA was measured to the ride's **destination** instead of the rider's pickup. | The ETA is measured to **this rider's own** pickup, and to their own drop-off once on board. |
| The "driver arrived" event did not state the new status, and was always labelled "auto-detected", even when the driver tapped it. | The event now includes `phase: "arrived"`, `eta: 0` and `passengerStatus: "driver_arrived"`, and `autoDetected` is correct. |

### Issue 13 (second entry): yesterday's ride shows in "Upcoming"

| Cause | Fix |
|---|---|
| An accepted ride that the driver never started stays "accepted" forever. The Upcoming filter compared only the **date** (not the time), and only for some request values: `?status=accepted,started` had no filter at all. | An accepted ride leaves Upcoming once its departure **date and time** plus **2 hours** has passed. This applies to every request that asks for accepted rides, for riders and drivers. A ride that is actually under way is never hidden. |

Timezone note: rides are scheduled in the server's timezone (Europe/Nicosia). A tester in Bangladesh
(4 hours ahead) will see times shifted by that amount. This is by design.

## 3. How it was tested

### 3.1 Unit tests (`cd server && npm test`)

| Test file | New tests | Issues |
|---|---:|---|
| `utils/pushDelivery.test.ts` | 9 | 4, 8 |
| `socket/handlers/ride/acceptAndTripNotifications.test.ts` | 6 | 8, 9 |
| `utils/notifyDrivers.utils.test.ts` | 5 | 4, 9 |
| `utils/liveEta.utils.test.ts` | 10 | 13 |
| `modules/ride/upcomingWindow.test.ts` | 11 | 13 |
| `utils/rideStartOtp.utils.test.ts` | 4 | 9 |

### 3.2 Integration tests against real services (`cd server && npm run test:integration`)

Real: MongoDB, Redis, the API on an HTTP port, Socket.io with login-token checks, all ride handlers.
Faked: Firebase delivery (every push the server sends is recorded and checked) and Google Maps.

| # | Scenario | Issue | Old code | New code |
|---|---|---|---|---|
| 1 | Capture fails at accept: ride back to searching, rider gets "Payment Needs Attention", no "accepted" event | 8 | FAIL | PASS |
| 2 | Accept: rider gets the live event and **one** push that expires in 10 min and replaces older ones | 8, 4 | FAIL | PASS |
| 3 | Driver double-taps start: one "Driver On The Way" push, one live event | 9 | FAIL | PASS |
| 4 | Driver arrives: event says `phase: arrived`, `eta: 0`, tapped manually | 13 | FAIL | PASS |
| 5 | Next location ping: rider gets `eta: 0` / `arrived` (was "1 min"), exactly one update | 13 | FAIL | PASS |
| 6 | Two pickup attempts without the code: same code, pushed once | 9 | FAIL | PASS |
| 7 | Pickup with the code: one "Trip Started!" push | 9 | FAIL | PASS |
| 8 | Drop-off then complete: one "trip finished" push | 9 | FAIL | PASS |
| 9 | Setup: accepted ride from yesterday (never started) and one for tomorrow | 13 | PASS | PASS |
| 10–11 | Rider Upcoming with `?status=upcoming` / `accepted`: yesterday hidden | 13 | PASS* | PASS |
| 12 | Rider list with `?status=accepted,started`: yesterday hidden | 13 | FAIL | PASS |
| 13–14 | Driver Upcoming with `?status=upcoming` / `accepted`: yesterday hidden | 13 | PASS* | PASS |
| 15 | Driver list with `?status=accepted,started`: yesterday hidden | 13 | FAIL | PASS |
| 16 | "Drivers Notified" then a re-match with the same count: one push only | 9 | FAIL | PASS |

\* The old date-only rule already hid yesterday's rides for these two request values. It failed for the others,
and for rides earlier the same day.

**Old code: 11 failed, 5 passed. New code: 16 passed.** The 21 scenarios from report #1 still pass.

## 4. Not tested here

- Real phones, real Firebase delivery, Stripe and the deployed test server. QA should re-test on a build with this change.
- Delivery timing in Doze or battery-saving mode can only be confirmed on real devices.

## 5. Needed from the mobile app

1. **Live updates (issue 13):** `ride:live-update` now includes `phase` (`to_pickup` / `arrived` / `to_destination`)
   and `passengerId`. Show "Driver arriving in N min" only for `to_pickup`. On `ride:driver-arrived` or
   `phase: "arrived"`, show "Driver has arrived" and stop showing the ETA until pickup.
2. **Duplicates (issue 9):** if the app shows its own local notification for socket events (e.g. `ride:driver-accepted`,
   `ride:trip-started`) **and** displays the push, every event appears twice. Show only one of them: push when
   the app is in the background, in-app UI when it is in the foreground.
3. **Foreground (issue 8):** while the app is open, Android and iOS do not show push notifications automatically.
   The app must show the live event, or display the push itself.
4. **Android channel (issue 4):** create a high-importance notification channel. Tell us its id and we will set
   `FCM_ANDROID_CHANNEL_ID`, so ride notifications show as banners with sound.
5. **New push types:** `PAYMENT_ACTION_REQUIRED` ("Payment Needs Attention"), `PASSENGER_PICKED_UP`, `TRIP_COMPLETED`.
   The start-trip push title is now "Driver On The Way".
6. **Upcoming tab:** please confirm which `status` value the app sends. All values are handled now, but `upcoming` is
   the intended one.

## 6. Open product decisions (not changed)

- **Accepted rides the driver never starts** are now hidden from Upcoming, but remain "accepted" in the database.
  Should the system auto-cancel them after departure and refund the rider? That moves money, so it needs your decision.
- **Automatic arrival** within 100 m of the pickup exists in the code but has never been active. Turning it on would
  also start the waiting-time and no-show rules. We left it off; the driver taps "arrived" as before.
- The refund on a cancellation sends its own separate "refund" notification next to the cancellation notification.
  This is a different message, so it was not merged.

## 7. Files changed

Backend: `utils/sentPushNotification.ts`, `utils/notifyUser.utils.ts`, `utils/notifyDrivers.utils.ts`,
`utils/liveEta.utils.ts` (new), `utils/rideStartOtp.utils.ts`, `modules/payment/payment.service.ts`,
`modules/ride/ride.service.ts`, `socket/utils/triggerArrival.ts`,
`socket/handlers/ride/{driverAcceptRide,driverStartTrip,pickUpRideClean,driverDropOffPassenger,driverCompleteTrip,driverArrivedClean,driverLocationUpdate}.handler.ts`,
5 translation files (new texts in all languages).

Tests: 5 new unit test files, 1 extended; `tests/integration/notificationIssues.int.test.ts` (new) and
`tests/integration/helpers.ts` (new, shared by both integration files).

New optional setting: `FCM_ANDROID_CHANNEL_ID`.
