# Product decisions from QA round 4: now admin settings

Three QA items (B-04, B-16, B-05) were policy questions, not bugs. The backend now lets you
decide them from the admin panel, with no release needed. **Until you change anything, the app
behaves exactly as before.**

All of these are in **Settings → General** (`POST /api/v1/setting/generals`, admin only).

## 1. Cancellation fee (B-04)

QA expected a 20% fee; the backend had a different rule. You choose:

| Setting | Meaning | Default (current behaviour) |
|---|---|---|
| `cancellationFeePercent` | Fee kept if a rider cancels **before** the restriction window | `0` (full refund) |
| `lateCancellationFeePercent` | Fee kept if a rider cancels **inside** the window | `100` (no refund) |
| `privateRideRefundRestrictionHours` | Window for private rides (existing) | `1` hour |
| `splitRideRefundRestrictionHours` | Window for split rides (existing) | `24` hours |

Examples on a €20 private ride booked for 18:00:

| Settings | Cancel at 12:00 | Cancel at 17:30 |
|---|---|---|
| Default (0 / 100) | €20 back | €0 back |
| 20 / 100 | €16 back | €0 back |
| 0 / 50 | €20 back | €10 back |

Rules that do not change: cancelling before a driver accepts is always free; a card that was only
authorised (not charged) is always released in full; a cancellation after pickup time keeps the
full amount. The app shows the exact amount before the rider confirms.

*Note: the older settings `cancellationFreeWindowHours` and `cancellationPercentage50Hours` are
not used by any code. Changing them has no effect.*

## 2. Minimum fare for split rides (B-16)

Today every rider pays at least `baseFare` (€20), so a short split ride costs the same as a
private one.

| Setting | Meaning | Default |
|---|---|---|
| `splitRideMinimumFare` | Minimum per rider once a split ride is **matched** (2+ riders) | `0` = same as `baseFare` |

Example: a short trip where each matched rider would pay €15. With the default they pay €20;
with `splitRideMinimumFare = 12` they pay €15. Private rides and a split rider who is still alone
always keep `baseFare`. Driver earnings follow the passenger fare automatically.

## 3. Refunds go to the wallet (B-05)

By design, money refunded after a driver accepted goes to the in-app wallet, not the card (a card
hold before acceptance is simply released). If that stays the policy, please say so in the terms.
The rider terms are edited in **Settings → `userTramsAndCondition`**. Suggested text, to be
reviewed by legal:

> **Cancellations and refunds.** If you cancel before a driver accepts your ride, the
> authorisation on your card is released and you are not charged. If you cancel after a driver
> has accepted, any refund is credited to your Split Ride wallet and can be used for future rides.
> A cancellation fee may apply depending on how close to pickup you cancel; the app shows the
> exact amount before you confirm. If no driver is found, the full amount is returned the same way.
