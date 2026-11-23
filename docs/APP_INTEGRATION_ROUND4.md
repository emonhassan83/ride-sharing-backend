# App integration: backend changes from QA round 4 (23 Nov 2026)

For the rider and driver app developers. Everything below is live on the backend.
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
and `data.refundDestination`, so the result screen can use them. The fee percentages are admin
settings and can change at any time, which is why they must not be hard-coded.

---

## 3. Handle the two new socket events

### `ride:request-updated` (driver app, B-07)
Sent when a rider joins or leaves a split ride the driver was notified about or accepted.
Update the existing request card **in place**:

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
| ids | `rideId`, `bookingId`, `passengerId`, `chatId` where relevant |

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
| `CANNOT_CANCEL_AFTER_PICKUP` | Hide/disable driver Cancel once anyone is on board |
| `UNAUTHORIZED`, `INVALID_TOKEN`, `TOKEN_EXPIRED` | Refresh the token / re-login |
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
