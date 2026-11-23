# App integration: backend changes from QA round 4 (23 Nov 2026)

For the rider and driver app developers. Everything below is merged into the backend `main`
branch. **It is only live on a server after that server is redeployed from `main`.** Before
testing, check that `PATCH /api/v1/auth/fcm-token` with an empty body returns `400`; a `404`
means the server is still running an older build (see section 8).
Nothing is removed: old events and fields still work, so each item can ship on its own.
The order is by impact.

---

## 1. Register the FCM token (fixes missing/late pushes, B-09)

The backend stores **one FCM token per user**. Until now it was only saved at login, so a
token that Firebase rotated, or a reinstall without logging in again, silently stopped all pushes.

```
PATCH /api/v1/auth/fcm-token
Authorization: Bearer <accessToken>
Content-Type: application/json

{ "fcmToken": "<token from FirebaseMessaging.getToken()>" }
```

Call it:
- on every app start, once the user is logged in;
- in `onTokenRefresh` / `onNewToken`;
- after logging in on a new device (the same token is removed from any other account).

The body is strict: any extra field returns `400`. The token must be 10 to 4096 characters.

---

## 2. Show the real cancellation fee (B-04)

Do **not** hard-code "20% fee". Ask the backend right before showing the confirm dialog.

Socket (preferred):
```js
socket.emit('ride:cancel-quote', { rideId, passengerId /* optional */ }, (res) => { ... })
```
REST: `GET /api/v1/ride/:rideId/cancellation-quote`

`res.data`:

| Field | Meaning |
|---|---|
| `cancelEvent` | Event to emit to cancel: `ride:cancel-before-accept` or `ride:cancel-after-accept` |
| `paidAmount` | Captured money (EUR) |
| `heldAmount` | Card hold that will be released (EUR); nothing is charged |
| `feeAmount`, `feePercent` | Fee that will be kept |
| `refundAmount` | Amount credited back |
| `refundDestination` | `wallet`, `card_release` or `null` |
| `freeCancellationUntil` | ISO UTC time; free to cancel before this. `null` = not free now |
| `lateFeeFrom`, `earlyFeePercent`, `lateFeePercent` | Policy, to explain it in the UI |
| `departureAt` | ISO UTC pickup time |

The cancel acks return the same numbers as `data.feeAmount`, `data.feePercent`, `data.refundAmount`
and `data.refundDestination`, so the result screen can use them. The same four fields are also in
the `ride:cancelled` event sent to the cancelling rider (both `ride:cancel-before-accept` and
`ride:cancel-after-accept`). That event arrives **before** the ack, because the ack is sent only after
every driver/co-rider notification. The fee percentages are admin settings and can change at any
time, which is why they must not be hard-coded.

---

## 3. Handle the two new socket events

### `ride:request-updated` (driver app, B-07)
Sent when a rider joins or leaves a split ride the driver was notified about or accepted.
`reason` is `passenger_joined`, `passenger_left` (a rider cancelled or was rejected) or
`passenger_paid`. `totalSeats` is the seat count of **this driver's** vehicle until a driver
accepts, then the accepted vehicle's seats. Update the existing request card **in place**:

```json
{
  "rideId": "…", "reason": "passenger_joined",
  "bookedSeats": 2, "totalSeats": 4, "riders": 2,
  "surchargePercent": 30, "totalFare": 40,
  "passengers": [{ "passengerId": "…", "requestedSeats": 1, "estimatedFare": 20 }]
}
```

A driver may also get a **new** `ride:new-request` for the same ride when another rider joins.
Treat it as an update of the same card (key it by `rideId`).

### `ride:driver-en-route` (rider app, B-20)
Sent when the driver taps "Start" and is heading to the pickup. The rider is **not** on board yet.

```json
{ "rideId": "…", "passengerId": "…", "driverId": "…", "startTime": "…",
  "phase": "driver_en_route", "title": "Driver On The Way", "message": "…" }
```

The old `ride:trip-started` is still sent with the same payload (with `phase`), so older builds
keep working. New builds should listen to `ride:driver-en-route` and show "Trip started" only on
the pickup event.

---

## 4. Route notification taps by `type` / `screen` (B-14)

Every push (`data`) and every row of `GET /notification` (`type` and `data`) now carries:

| Key | Example |
|---|---|
| `type` | `RIDE_ACCEPTED`, `NEW_RIDE_REQUEST`, `CHAT_MESSAGE`, `REFUND_ISSUED`, `DRIVER_EN_ROUTE`, … |
| `screen` | `ride_details`, `ride_request`, `chat`, `wallet`, `earnings`, `home` |
| ids | `rideId`, `bookingId`, `passengerId`, `chatId`, `withdrawId` where relevant |

KYC decision: `type: KYC_STATUS`, `screen: home`, `kycStatus: verified | rejected`. Payout request
completed or cancelled by an admin: `type: WITHDRAW_STATUS`, `screen: earnings`, `withdrawId`,
`withdrawStatus`, `amount`. These are the only two pushes with `home` / `earnings`.

Routing rule: open `screen` with the ids; if `screen` is unknown to the app, fall back to `type`,
then to the notification list. All values in `data` are strings (an FCM requirement).

---

## 5. Map socket errors by `code` (B-22)

Failed acks and the `socketError` event carry a `code`:

```json
{ "success": false, "status": 400, "code": "BAD_REQUEST", "message": "…translated…", "details": { … } }
```

Errors raised by the server (`status`, `code`, `message`, optional `details`) always have a `code`.
A few handlers answer with their own ack, e.g. `{ "success": false, "code": "TRIP_START_TOO_EARLY",
"message": "…", "data": { "earliestStartAt": "…" } }`. Those have `code` and `message` but may have
no `status`, and extra values are in `data` instead of `details`. A few older checks still return only
`{ success: false, message }`. If `code` is missing, show `message`.

Decide behaviour from `code`, never from `message` (messages are translated).

| `code` | App behaviour |
|---|---|
| `TRIP_START_TOO_EARLY` | "You can start from HH:MM". `data.earliestStartAt` is ISO UTC (default window 30 min, see `tripStartEarlyWindowMinutes` in generals) |
| `CANNOT_CANCEL_AFTER_PICKUP` | Hide/disable driver Cancel once anyone is on board (use `canDriverCancel` from `GET /ride/driver-rides`) |
| `UNAUTHORIZED`, `INVALID_TOKEN`, `TOKEN_EXPIRED` | Refresh the token with `POST /auth/refresh-auth` (section 8); if that answers `401`, log in again |
| `FORBIDDEN`, `NOT_FOUND`, `BAD_REQUEST`, `CONFLICT`, `VALIDATION_ERROR`, `INVALID_VALUE`, `DUPLICATE_KEY`, `TOO_MANY_REQUESTS` | Show `message` |
| `INTERNAL_ERROR`, `UPSTREAM_ERROR`, `ERROR` | Generic "Something went wrong", offer retry |

---

## 6. Smaller items

- **Start-trip OTP, Resend button (B-10):** send `resend: true` **only** when the user taps Resend:
  `socket.emit('driver:send-start-otp', { rideId, passengerId, resend: true }, cb)`.
  Without it the backend reuses the current code and does not re-send, so screen reloads no longer
  invalidate the code the rider has. The OTP is now also sent automatically when the driver arrives.
- **Wait fee text (B-17):** read `waitNoticeFeeAmount` and `waitNoticeMaxMinutes` from
  `GET /api/v1/setting/generals` (currently €20 / 5 min) instead of the hard-coded €10.
- **References (B-15):** show `bookingShortId` (the rider's booking, `SR-…`) to riders and `rideShortId`
  (the trip) to drivers. The rider ride list returns both. The driver ride list returns `rideShortId`,
  `bookingShortIds` (all bookings on the ride) and, for private rides, `bookingShortId`. Ride details and
  the payment responses also include them.
- **Wallet booking (B-01):** the `payWithWallet` response now includes `bookingShortId` and the new
  `walletBalance`. Show that value; don't add refunds up on the device.
- **Dates (B-24):** ride responses include `departureAt` (ISO UTC). Use it for countdowns; the local
  `departureDate`/`departureTime` strings are unchanged.
- **Contact details (B-18):** before a driver accepts, phone numbers come back masked
  (`+357••••3456`), email is `null`, and `contactMasked: true`. Hide the Call button when
  `contactMasked` is true.
  - `ride:find-nearby-split-ride` (rider app): other riders' phone numbers are no longer returned
    at all, and the driver's `driverPhone` is masked and `driverEmail` is `null` (no `contactMasked`
    flag there). Do not show a Call button on that screen; real contact is available after acceptance.
- **Scheduled rides (B-19):** the accept push for a ride more than 30 minutes away now says
  "Your ride is confirmed for <date> at <time>." instead of an ETA.
- **Invalid ids:** a malformed id in a REST path now returns `400` "Invalid ID format" (it was `500`).

---

## 7. Test checklist for the app team

Tick each item on a real device against the dev server. Check the wallet balance in every flow.

### 7.1 FCM token (B-09)
- [ ] After login, every app start calls `PATCH /auth/fcm-token`.
- [ ] A refreshed token (`onTokenRefresh`) is sent to the backend.
- [ ] Logging in to another account on the same phone stops pushes for the old account and starts them for the new one.
- [ ] A push arrives on a real device (e.g. Realme / Android 16) for: ride accepted, driver arrived, OTP, drop-off, cancel, refund.

### 7.2 Cancellation fee (B-04)
- [ ] The confirm dialog asks for a quote first and shows the API fee, not a hard-coded 20%.
- [ ] Before a driver accepts: fee 0 and the full amount is refunded.
- [ ] After an admin changes the fee setting, the app shows the new number.
- [ ] The result screen shows `feeAmount` and `refundAmount` from the cancel ack.

### 7.3 New socket events (section 3)
- [ ] A second rider joins a split ride: the driver's request card updates in place (seats and fare change, no duplicate card, matched by `rideId`).
- [ ] The driver taps Start: the rider sees "Driver On The Way", not "Trip started".
- [ ] After pickup the rider sees "Trip started".

### 7.4 Notification taps (B-14)
- [ ] Tapping a push opens the right screen for each `screen`: ride_details, ride_request, chat, wallet, earnings, home.
- [ ] An unknown `screen` falls back to `type`, then to the notification list.
- [ ] A KYC-approved push opens home.

### 7.5 Errors (B-22)
- [ ] Behaviour is decided by `code`, not `message`.
- [ ] When `code` is missing, `message` is shown.
- [ ] Starting too early shows "You can start from HH:MM" using `data.earliestStartAt`.
- [ ] The driver Cancel button is disabled once someone is on board.
- [ ] An expired token triggers a refresh or re-login.
- [ ] A malformed id (HTTP 400) does not crash the app.

### 7.6 Smaller items (section 6)
- [ ] Closing and reopening the start-OTP sheet keeps the same code working; `resend: true` is sent only when the user taps Resend.
- [ ] The wait-fee text (€20 / 5 min) comes from `GET /setting/generals`, not a hard-coded €10.
- [ ] Riders see `bookingShortId`, drivers see `rideShortId`.
- [ ] After a wallet payment, the success screen shows the `SR-…` id and `walletBalance`; the app does not add or subtract on the device.
- [ ] Countdowns use `departureAt`.
- [ ] Before accept, the phone is masked, the email is not shown, and the Call button is hidden when `contactMasked` is true. The split search screen has no Call button.

### 7.7 End-to-end flows
- [ ] Pay by wallet for a private ride, the driver accepts, then cancels: the wallet is back to the starting balance (B-01).
- [ ] Pay by card, cancel before a driver accepts: the hold is released, and the cancel and refund notifications arrive (B-11).
- [ ] Two riders join the same split ride: the driver sees both at once, and the second rider sees the ride under Pending (B-07, B-08).
- [ ] No driver accepts: the ride is auto-cancelled, a notification arrives, and it shows under History, Cancelled (B-12, B-13).

---

## 8. Questions from the app team (answered)

**Is this deployed?** Not when the app team checked: dev (`72.244.153.29:8080`) and prod
(`api.splitride.com.cy`) both returned `404` for the new endpoints. The code is on `main`;
the `development` branch is behind it and does not include QA rounds 1 to 4. Both servers need
a redeploy from `main`. Quick check after the deploy:

| Request | Old build | New build |
|---|---|---|
| `PATCH /auth/fcm-token` with `{}` | `404` | `400` (validation) |
| `GET /ride/<any id>/cancellation-quote` with a token | `404` "endpoint not found" | `404` "Ride not found" or `200` |
| `GET /setting/generals` | no `waitNoticeFeeAmount` | has `waitNoticeFeeAmount`, `waitNoticeMaxMinutes`, `tripStartEarlyWindowMinutes` |
| `GET /notification` (new rows) | no `type` | `type` and `data.screen` |

Notifications created before the deploy keep their old shape; only new ones have `type`/`screen`.

**B-19 still shows "ETA: 11 minutes".** That build is old (see above). On the new build the
"confirmed for <date> at <time>" text is used only when pickup is **more than 30 minutes** after
the accept. A ride accepted 11 minutes before pickup still correctly shows the ETA.

**Start OTP over REST.** `POST /api/v1/ride/send-start-otp` supports `resend` exactly like the
socket event: `{ "rideId": "…", "passengerId": "…", "resend": true }`. This body is **not** strict,
so the extra field never causes `400`. Without `resend` the current code is reused and not
re-sent; with `resend: true` the same code is re-sent and its lifetime extended. The code only
changes after it expires. (Only `PATCH /auth/fcm-token` has a strict body.)

**Who sees the OTP?** The driver app shows the OTP entry sheet. The rider only sees the code
(push, socket `driver:send-start-otp` on the rider's room, and email) and reads it to the driver.

**Chat push (`screen: chat`) only has `chatId`.** Fetch the chat with
`GET /api/v1/chats/:chatId` (note `chats`, plural). It returns the chat with the other participant
(`name`, `profileImage`, `email`, `phone`) and `booking`. `GET /api/v1/chats/booking/:bookingId`
also works. Only the chat's two participants can read it; anyone else gets `404`, so fall back to
the chat list in that case.

**Logout and FCM token.** `POST /api/v1/auth/logout` already clears the stored FCM token (and
revokes every token issued before it), so the old account stops getting pushes. Call it before
clearing local auth. If the app logs out without calling it (e.g. offline), the next login on
that phone moves the token to the new account anyway. Also call
`FirebaseMessaging.deleteToken()` on logout if you want to be sure.

**Wait fee: `waitNoticeFeeAmount` or `waitingTimeMinutes`?** Use `waitNoticeFeeAmount` (EUR, now 20)
and `waitNoticeMaxMinutes` (now 5) for the "be ready" text. They are different settings:
`waitingTimeMinutes` is how long a driver waits before a no-show, and `dayFareWaitingCharge`
is the waiting charge inside the fare calculation. Neither belongs in that text.

### Follow-up questions (second message)

**Cancel ack does not arrive, only `ride:cancelled`.** The backend does send an ack for both cancel
events. It is sent last, after every driver and co-rider notification, so it arrives after
`ride:cancelled`. The app only gets it if it emits with an ack callback (Flutter
`socket_io_client`: `socket.emitWithAck(...)` or `socket.emit(event, data, ack: (res) {...})`).
In any case, the fee fields are now also in the cancelling rider's `ride:cancelled` event:

```json
{ "rideId": "…", "passengerId": "…", "cancelledBy": "user",
  "feeAmount": 0, "feePercent": 0, "refundAmount": 20, "refundDestination": "wallet",
  "message": "…" }
```

Before acceptance it also has `paymentReleased`. After acceptance it also has `paidAmount` and
`refundReason`. Before this change, the rider who cancelled after acceptance got no
`ride:cancelled` at all.

**Boarding state in `GET /ride/driver-rides`.** Each ride now has:

| Field | Meaning |
|---|---|
| `pickedUpCount` | Riders on this ride who are `picked_up`, `dropped_off` or `completed` |
| `canDriverCancel` | `pickedUpCount === 0`. Exactly the rule `driver:cancel-ride` enforces |
| `passengerDetails` | `[{ passengerId, name, status, requestedSeats }]` |

`passengers` is unchanged (a list of rider **names**, not ids). Hide Cancel when
`canDriverCancel` is `false`, and still handle `CANNOT_CANCEL_AFTER_PICKUP`, because the list can be stale.

**Token refresh.** `POST /api/v1/auth/refresh-auth` existed but never worked (it checked the refresh
token with the wrong secret and only read a cookie). It is fixed:

```
POST /api/v1/auth/refresh-auth
Content-Type: application/json

{ "refreshToken": "<refreshToken from the login response>" }
```

`200` → `data.accessToken` (the refresh token stays the same). `401` (missing, invalid or expired
token, or the user logged out) → send the user to login. No `Authorization` header is needed. Retry
the failed request once with the new token. Do not loop.

**Chat push.** Confirmed: every chat push has `data.type = "CHAT_MESSAGE"`, `data.screen = "chat"`
and a non-empty `data.chatId` (no push is sent without one). It also has `bookingId` (may be `""`),
`senderId`, `senderName`, `unreadCount` and `totalUnreadCount`. All values are strings.

**Production.** Deployment is not done from this repository. Both servers still need a redeploy from
`main` (see the table at the top of this section).

### Split rides (third message)

These are backend fixes on `main`. They need the same redeploy as everything above.

**One rider cancels before acceptance: the whole ride was cancelled (ride SR-0552185702).** That
was a backend bug. When a 2-rider split ride lost one rider, the backend treated the remaining rider
as "not enough" and cancelled both the ride and that rider's booking. Fixed: a rider who leaves only
cancels their own booking. The ride is cancelled only when **no** rider is left. The rider who stays:

- keeps the booking (still `pending`). Their fare is recalculated for one rider. They get
  `ride:co-passenger-cancelled` (and a push), not `ride:cancelled`;
- stays matchable for new riders, and is converted to Solo before pickup if nobody joins, as
  for any single-rider split ride.

Notified drivers get `ride:request-updated` with `reason: "passenger_left"` (new seats, riders and
fare) and `ride:cancelled-by-rider` with `rideCancelled: false`. In that event, `remainingSeats` is
`null` before a driver accepts (the vehicle is not known yet). It used to be a negative number.

The €20 hold for Melisa (booking SR-2311425530, ride SR-0552185702): checked in Stripe and in the
dev database. The hold `pi_3UetuwAiyUfiOQaF0yAvmO6p` was **cancelled (released) at 10:00:31 UTC**,
3 seconds after the other rider left, with nothing captured. Her booking is `cancelled_authorization`
and a "Ride Cancelled" notification was saved for her at 10:00:34 UTC. With the fix, her booking is
no longer cancelled at all.

**One card or one card per rider? Does Accept take the whole ride?** One card per ride (`rideId`),
and one Accept takes the whole ride.

- `GET /api/v1/passenger/ride-requests` (and the `ride:pending-requests` replay on reconnect) now
  returns **one row per ride**. The old per-rider fields are kept, from the first rider who booked,
  so the row still renders on older builds. New fields:

  | Field | Meaning |
  |---|---|
  | `riders` | Pending riders on the ride |
  | `bookedSeats` | Their seats |
  | `totalSeats` | Seats of your vehicle (of the accepted vehicle once accepted) |
  | `totalFare` | Sum of their fares (EUR) |
  | `passengers` | `[{ passengerId, user, pickup, destination, requestedSeats, estimatedDistanceKm, estimatedFare, createdAt, luggage… }]` |
  | `rideShortId`, `rideType` | Ride reference and `private` / `split` |

- **Accept:** `socket.emit('driver:accept-ride', { rideId }, ack)`, **without** `passengerId`. Every
  pending rider on the ride is accepted. Each rider gets their own `ride:driver-accepted` and push.
  `ack.data`:

  ```json
  { "rideId": "…", "rideFullyAccepted": true, "remainingPassengers": 0,
    "acceptedPassengers": [{ "passengerId": "…", "bookingId": "…", "estimatedArrival": 3, "estimatedFare": 20 }],
    "skippedPassengers": [] }
  ```

  A rider who cannot be accepted (for example, their booking was cancelled meanwhile) is listed in
  `skippedPassengers` with a `message` and stays pending. In that case `rideFullyAccepted` is `false`.
  If nobody could be accepted, the ack is `success: false`.
- **Decline:** `socket.emit('driver:reject-ride', { rideId }, ack)`, without `passengerId`. The ride
  disappears for this driver only. The riders keep their bookings, and the ride stays open for other
  drivers. (With a `passengerId`, the old behaviour still applies: that rider is rejected from the ride.
  Don't use it from the card.)
- Sending `passengerId` to `driver:accept-ride` still accepts just that rider, so older builds keep working.

**`ride:request-updated` had `totalSeats: 0`.** Before a driver accepts, the ride has no vehicle, so
the backend stored 0 and sent it as is. It now sends each notified driver their own vehicle's seats
(4 if unknown), and the accepted vehicle's seats after acceptance. The same rule applies to
`totalSeats` in the ride-requests list.

### Final list (fourth message)

Times below are Cyprus time (ride times are always Cyprus time), UTC+2 in winter.

**When is a driver "busy"?** A driver is not offered a ride if, on the same date, they have a ride
that is not cancelled, rejected or completed, and the two departure times are less than **60 minutes**
apart (either direction). The 60 minutes is a fixed trip-length estimate. An exception: two **split**
rides are allowed if the driver's split ride still has enough free seats. Today's case: SR-5767649458
(split, 18:00) was booked at 12:50. The driver's private ride SR-1162540362 at 17:30 was still
`accepted` then, so 18:00 was inside its 17:30–18:30 window and the driver was skipped (`notifiedDrivers: 0`).
As soon as that ride is `completed` (or cancelled), the driver is free again.

**How often does re-matching run?** The job checks every minute. For each pending ride:

1. When the ride is booked: drivers are notified at once.
2. About 1 minute later: one re-notify.
3. **New:** from then until 1 hour before pickup, a sweep every `waitingReminderIntervals`
   minutes (admin setting; **5 on dev** today, 10 by default) reaches drivers who have **never**
   had this ride (a driver who became free or came online). The rider is told only if a new driver
   was reached.
4. In the last hour before pickup (`matchingLastNotifyHours`, 1): the same interval, with the
   rider kept updated.

Before step 3 existed, nothing ran between step 2 and the last hour. That is why the driver who
finished the 17:30 trip at 13:01 never got the 18:00 ride: the next run would have been at 17:00.
Now they get it within one interval (5 minutes on dev). A driver gets each ride only once; a declined ride never comes back.

**Auto-cancel (B-12 / B-13): when?** At pickup time. The job runs every minute, so it happens
within about 1 minute after the departure time: the ride (or an un-accepted rider on an accepted
split ride) is cancelled, the card hold is released or the payment refunded to the wallet, and the
rider gets `ride:no-driver-found` plus a push. **Testing it quickly on dev:** an admin lowers the
minimum booking lead time, for example `POST /api/v1/setting/generals` (admin token) with
`{ "privateRideMinBookingHours": 0.1 }` (6 minutes; `splitRideMinBookingHours` for split). Book a ride
7–8 minutes ahead and don't accept it; it is cancelled about 1 minute after its time. Set the value
back to 1 afterwards, because it applies to everyone. Lowering `waitingReminderIntervals` (5 on
dev now, for example to 2) speeds up re-match testing the same way.

**Occasional 30-second timeouts.** We can't see the server logs from here. Two facts:

- The dev server (72.244.153.29:8080) runs in development mode: `ts-node-dev --respawn --poll`
  from the TypeScript source, with stack traces in error responses. That mode is not meant for load
  and can pause or restart. Production must use `docker-compose.prod.yml` (compiled build,
  `NODE_ENV=production`).
- A 10-minute probe from Bangladesh (`GET /setting/generals`, one request every 2 s, about
  21:00 Dhaka time): 185 requests, all `200`, median 1.14 s, p95 1.17 s, slowest 2.77 s, none
  over 5 s. About 0.5 s of that is network time. The timeout did not reproduce under light
  load, so it is probably tied to a moment when the server was busy or restarting.

Please send the exact endpoint and the time (with seconds) of each timeout, so the matching server
log lines can be pulled.

**Melisa's €20 hold (SR-2311425530):** released, see "Split rides (third message)" above.

**When does production get `main`?** That's the backend team's decision, so no date is given here.
Today the dev server picked up a newer build at about 11:00 Cyprus time (notifications have `type`
from then on). It does **not** have the split fixes from the third message: at 12:00 it still
cancelled SR-0552185702 with "Only one passenger remaining". Probe for the new build: a split ride
where one of two riders cancels before acceptance stays `pending`.

**KYC push:** `type: KYC_STATUS`, `screen: home`, `kycStatus: verified | rejected`, title
"KYC Verification Approved" / "KYC Verification Rejected". Before this fix it was sent as
`ACCOUNT_STATUS`, only when the driver had an FCM token, and an FCM error could undo the admin's
approval. Now the in-app row is always saved and the approval always stands.

**Notification list had `data: {}`.** A backend bug: the routing data was stored correctly
(checked in the database: the chat row has `type`, `screen` and `chatId`), but `GET /notification`
serialised it as `{}`. Fixed: `GET /notification` and `GET /notification/:id` now return the same
`data` as the push, so a chat row opens that conversation. Rows created before about 11:00 today
have no `type` or `data` at all (older build).

**`screen: earnings`: when?** Only when an admin marks a driver's payout (withdraw) request as
**completed** or **cancelled** in the admin panel. Completing a trip credits the earning but sends
no `earnings` push, so normal ride testing doesn't produce one. To test: driver requests a payout,
admin completes or cancels it.
