# Client bug fixing report #3

**Issues covered:** backend issues from the third client QA document (32 entries)
**Date:** 2026-11-23 · **Component:** backend (`server/`)

## 1. Summary

| | Before this work | After |
|---|---|---|
| Unit tests | 1078 passed | **1126 passed, 0 failed** (48 new) |
| Integration tests (real MongoDB + Redis) | 37 passed | **56 passed, 0 failed** (19 new) |
| Production type check (`npx tsc --noEmit`) | clean | **clean** |
| Test type check (`npm run test:types`) | clean | **clean** |

Every entry in the document was checked against the code:

| Group | Issues |
|---|---|
| Already fixed in reports #1 and #2 | 7 (old 42), 10 (old 52), 12 (old 61), 13 (old 63), 15, 16, 19 |
| **Backend, fixed in this round** | **14, 23, 24, 27, 28, 29, 30**, and the backend part of **5** |
| Backend works, the app needs a change | 6, 18, 25 (see section 5) |
| App only, no backend change needed | 1, 2, 3 (both entries), 4, 8, 9, 17, 20, 21, 22, 26, 31, 32 |

The 19 new integration scenarios were also run against the code from before this round:
**15 of the 19 fail on the old code.** The other 4 are control checks, which must pass on both.
All 19 pass on the new code.

## 2. Issues, causes and fixes

### Issue 14: split ride. The second rider was refunded, then the ride went ahead and showed "PAID"

| Cause | Fix |
|---|---|
| When a driver accepted a rider, the server did **not check** whether that rider's booking had been cancelled or refunded. A refunded rider could be accepted, picked up and completed. The rider kept the wallet refund and rode for free. | Accept now refuses a rider whose booking is cancelled, rejected or completed, or whose payment is refunded or released. Message: "Booking has been cancelled or refunded and cannot be accepted." |
| A repeated payment confirmation could turn a **refunded** payment back into "paid". The rider kept the refund too. | Refunded or released payments and cancelled bookings can no longer be confirmed, checked out or paid with the wallet. A refunded payment record is never reused. |
| While testing this, we found a second problem: when such a confirmation was refused, the server **refunded the card**. The rider had already been refunded to the wallet, so this would have paid them twice. | This refusal no longer refunds anything on Stripe. |
| Completing a trip wrote "amount paid = fare" even on a refunded booking. | Refunded or released bookings are left unchanged. |
| The admin "Recent Transactions" list was sorted by **booking** time. A payment captured at pickup appeared to replace a refunded row from an older test booking, so it looked like the same row flipped from REFUNDED to PAID. | The list is sorted by the time the payment was last paid or refunded. The response also includes `updatedAt`. |

About "why did user Aakib get Paid?": the Customer column is the rider who **paid**. "PAID" means Aakib's
card was charged. Aakib did not receive money.

**Also found and fixed while checking issue 14:** a rider who paid from the **wallet** and then cancelled
before any driver accepted **did not get the money back**. Cancelling only released card holds. The
wallet is now refunded exactly once, even if the rider taps cancel twice. The booking is closed and a
refund record is created.

### Issue 30: "Cannot delete profile while having an active ride", but there is no active ride

| Cause | Fix |
|---|---|
| Any ride in "accepted" status blocked deletion. A ride the driver accepted but never started stays "accepted" **forever** (see report #2, issue 13), so one old test ride blocked account deletion permanently. | A ride counts as active only while it is under way, or while it has not passed the window used for Upcoming (departure time + 2 hours). A real upcoming ride, or a ride in progress, still blocks deletion. |

### Issue 23: driver KYC. "VAT number" is asked again and again

| Cause | Fix |
|---|---|
| A driver whose documents were **rejected** had no way to submit them again. Every attempt returned "User already sent KYC verification!". Retrying a submission that was already received failed the same way. | Submitting again now updates the existing documents and sends them back to the admin for review (status "pending", rejection reason cleared). Approved documents still can't be overwritten. |

The "Enter VAT number" message in the screenshot comes from the app's own form check, which fails even
though a number was entered. The app team needs to fix that check too.

### Issues 24, 27, 28, 29: invalid profile and vehicle data accepted

| Issue | Was accepted | Now |
|---|---|---|
| 24 | Name "." (shown as "Ask . for the 6-digit code", "Hello, .") | A name needs at least 2 letters. Checked at sign-up and on profile update. |
| 29 | Address "." | An address needs at least 3 characters, including letters or digits. |
| 27 | Date of birth 20-11-1900 | The date must be real, in the past, and no more than 100 years ago. **Drivers must be 18 or older.** |
| 28 | Car from 1900 | A car can be at most **30 years old**. Please confirm this limit. It is one setting and can be changed. |

New messages: "Please enter a valid name (at least 2 letters).", "Please enter a valid address.",
"Please enter a valid date of birth.", "Drivers must be at least 18 years old.", "Vehicle is too old.
Please add a newer vehicle." They are translated in all 5 languages.

### Issue 5: some text still in English after changing language

3 server messages were missing translations, and they are now added. All other server messages already
existed in all 5 languages. The remaining English text on the screens comes from the app.

## 3. How it was tested

### 3.1 Unit tests (`cd server && npm test`)

| Test file | New tests | Issues |
|---|---:|---|
| `utils/profileValidation.utils.test.ts` | 35 | 24, 27, 28, 29 |
| `utils/acceptGuard.utils.test.ts` | 11 | 14 |
| `socket/handlers/ride/rideCancelBeforeAccept.handler.test.ts` | 2 (and 2 existing tests updated) | 14 (wallet) |

### 3.2 Integration tests against real services (`cd server && npm run test:integration`)

Real: MongoDB (single-node replica set, because account deletion and KYC use transactions), Redis, the
API, Socket.io with login-token checks, all handlers. Faked: Firebase, Google Maps and Stripe.

| # | Scenario | Issue | Old code | New code |
|---|---|---|---|---|
| 1 | Driver accepts a split rider whose booking was refunded: refused, nothing changes | 14 | FAIL | PASS |
| 2 | Booking refunded by a background job, rider still "pending": refused | 14 | FAIL | PASS |
| 3 | Repeated payment confirm on a refunded payment: refused, stays refunded, no Stripe refund | 14 | FAIL | PASS |
| 4 | Checkout for a cancelled booking: refused, no new Stripe payment | 14 | FAIL | PASS |
| 5 | Admin recent transactions: most recently paid/refunded first | 14 | FAIL | PASS |
| 6 | Wallet payment and double-tap cancel before accept: wallet refunded once, booking closed, 1 refund record | 14 | FAIL | PASS |
| 7 | Old accepted ride never started: account can be deleted | 30 | FAIL | PASS |
| 8 | Accepted ride tomorrow: deletion still blocked | 30 | PASS (control) | PASS |
| 9 | Ride in progress, past departure: deletion still blocked | 30 | PASS (control) | PASS |
| 10 | Rejected driver submits KYC again: accepted, back to "pending" | 23 | FAIL | PASS |
| 11 | Pending KYC submitted again: accepted, still one record | 23 | FAIL | PASS |
| 12 | Approved KYC can't be overwritten | 23 | PASS (control) | PASS |
| 13 | Sign-up with name "." refused | 24 | FAIL | PASS |
| 14 | Profile name "." refused | 24 | FAIL | PASS |
| 15 | Address "." refused | 29 | FAIL | PASS |
| 16 | Date of birth 20-11-1900 refused | 27 | FAIL | PASS |
| 17 | Driver born 2015 refused | 27 | FAIL | PASS |
| 18 | Valid name, address and date of birth still accepted | 24, 27, 29 | PASS (control) | PASS |
| 19 | Car older than 30 years refused, 2020 car accepted | 28 | FAIL | PASS |

**Old code: 15 failed, 4 passed (the 4 controls). New code: 19 passed.** The 37 scenarios from reports #1
and #2 still pass.

## 4. Not tested here

- Real phones, real Stripe and the deployed test server. QA should re-test issues 14, 23 and 30 on a build with this change.
- Existing data is not changed. Old test bookings keep their current status.

## 5. Needed from the mobile app

1. **Issue 25 (€10 or €20):** the server sends €20 everywhere (`waitTimeNotice.feeAmount`). The "Wait Time Notice" popup shows
   a hardcoded €10. Show the amount from the server instead.
2. **Issue 23:** the "Enter VAT number" check fails although a number is entered. Also show the server's message when a submission fails.
3. **Issues 24, 27, 28, 29:** show the server's validation message. The app can also add the same checks to its forms.
4. **Issue 6 (block notification):** the server sends the push and saves the notification (QA saw it in the list). While the
   app is open, phones do not display a push automatically (report #2, section 5). Handle the `user:status-changed`
   socket event, for example by showing a message and logging out.
5. **Issue 18 (driver not in admin):** a driver appears in the admin KYC list only after the business information is submitted.
   A driver stuck on issue 23 never got there. Please check which list the admin panel shows for drivers.

## 6. Open decisions

- **Maximum vehicle age** is set to 30 years. **Minimum driver age** is set to 18. Please confirm both.
- Report #2 question still open: should accepted rides that were never started be cancelled and refunded automatically?

Found while checking, already like this before and **not changed** in this round:

- `confirmPayment` still refunds the Stripe payment on any other error.
- `PATCH /payments/refund-payment` and `POST /payments/confirm-payment` have no login check.

Both deserve a separate review.

## 7. Files changed

Backend:
- New: `utils/acceptGuard.utils.ts`, `utils/profileValidation.utils.ts`.
- Changed: `socket/handlers/ride/{driverAcceptRide,driverCompleteTrip,rideCancelBeforeAccept}.handler.ts`,
  `modules/payment/payment.service.ts`, `modules/meta/meta.service.ts`, `modules/user/{user.service,user.validation}.ts`,
  `modules/provider/provider.service.ts`, `modules/vehicle/vehicle.validation.ts`.
- 5 translation files (9 new texts).

Tests:
- New: `tests/integration/round3Issues.int.test.ts`, 2 new unit test files.
- Updated: `rideCancelBeforeAccept.handler.test.ts`.
- `vitest.integration.config.mts`: the test MongoDB now runs as a single-node replica set.
