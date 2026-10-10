# Client Inputs (07 Oct 2026): Implementation Status

Source: *SplitRide Client Inputs & Confirmed Production Rules: Developer Specification*.
Status as of 10 Oct 2026. Every backend item below was checked against the client's acceptance criteria.

| # | Item | Status | Where |
|---|------|--------|-------|
| 1 | Split ride matching window ±30 min | Done | Backend |
| 2 | Exact EUR 5 rounding boundary | Done (verified, hardened) | Backend |
| 3 | 6-passenger / 6-seater rule | Done (fixed) | Backend |
| 4 | Split ride fare formula (+10%) | Done (verified, enforced) | Backend |
| 5 | Luggage size wording "25 cm" | Backend OK; **UI change done** | Flutter / Admin UI |
| 6 | Waiting-time warning (EUR 20) | Done as **warning only**; fee deferred | Backend + UI text |
| 7 | PMC defaults 10% / 30% / 50% | Done (verified) | Backend |

---

## 1. Split Ride Matching Time Window

**Rule:** Two rides match when their pickup times are within 30 minutes of each other in either direction. Both boundaries count as a match.

**What was wrong:**
- The default window was `0`, so only rides with exactly the same pickup time matched.
- Rides also had to be on the same calendar date, so 23:50 and 00:10 the next day could never match.

**What changed:**
- `server/src/app/utils/splitMatching.utils.ts`:
  - The default is now 30 minutes. A stored `0` (the old seeded value) also falls back to 30.
  - The check compares real timestamps and uses `<=`, so the boundaries are inclusive.
  - It works across midnight.
- Candidate queries load the neighbouring date when the window crosses midnight (`getCandidateDepartureDates`). These are in `findNearBySplitRide.handler.ts`, `splitRideRequest.handler.ts` and `splitRidePendingMatch.job.ts`.
- The default in `settings.constant.ts` is now 30, and `settings.seeder.ts` writes 30.

**Verified:**

| Comparison | Result |
|---|---|
| 14:00 vs 13:30 | Match |
| 14:00 vs 14:30 | Match |
| 14:00 vs 13:29 | No match |
| 14:00 vs 14:31 | No match |
| 23:50 vs 00:20 next day | Match |

**Note:** When a ride already has riders, a new rider must be within 30 minutes of every one of them.

## 2. Exact EUR 5 Rounding Boundary

**Rule:** Exact multiples of EUR 5 stay unchanged. Values between two boundaries round up to the next one.

**What changed:**
- The logic was already correct.
- `roundUpToFiveBracket` in `server/src/app/utils/fareMath.utils.ts` now works in whole cents. A floating-point value such as 60.0000000001 can no longer jump to EUR 65.
- An invalid bracket setting such as `0` no longer produces NaN or Infinity.

**Verified:**

| Input | Result |
|---|---|
| 60.00 | 60 |
| 60.01 | 65 |
| 64.99 | 65 |
| 65.00 | 65 |

## 3. 6-Passenger / 6-Seater Rule

**Rule:** More than 4 passengers uses the 6-seater rate, with +40% on the entire regulated base.

**What was wrong:** The +40% was applied only when passengers were exactly 6. A 5-passenger booking got no uplift.

**What changed:**
- `server/src/app/utils/fareCalculator.ts`: the condition is now `requestedSeats > 4`. The uplift multiplies the whole regulated base (initial charge + km + waiting).
- `rideRequest.handler.ts`, `splitRideRequest.handler.ts` and `splitFare.utils.ts`: the uplift amount is now stored in `sixPassengerCharge` for both private and split riders, so saved fare breakdowns show it.

**Verified (50 km, day tariff):**

| Passengers | Regulated base | After uplift | Total |
|---|---|---|---|
| 1–4 | 51.30 | 51.30 | EUR 60 |
| 5–6 | 51.30 | 71.82 (× 1.40) | EUR 80 |

## 4. Split Ride Fare Formula (+10% initial estimate)

**Rule:** The approved worked example stays in place, and the +10% initial estimate is mandatory.

**Formula:**
1. `initialUpfront = max(ceil5(regulatedBase × 1.10), 20)`.
2. For a matched split:
   - pool = sum of every rider's initial upfront
   - average = pool ÷ riders
   - average × (1 + PMCrfSR)
   - ÷ riders
   - ceil5
   - min 20

**What changed:**
- The +10% was already applied.
- It is now enforced: if the setting is 0, missing or invalid, 10% is still used (`resolveInitialEstimatePercent` in `fareMath.utils.ts`).

**Verified:**

| Case | Result |
|---|---|
| 51.30 × 1.10 = 56.43 | EUR 60 (EUR 55 without the +10%) |
| Same, with the setting at 0 | EUR 60 |
| 2 riders: 120 → 60 → 78 → 39 | EUR 40 |
| 3 riders: 180 → 60 → 90 → 30 | EUR 30 |

## 5. Luggage Size Wording: UI change done

**Rule:** Replace "20(25)" with **25 cm** in all rider-facing and admin-facing wording.

**Backend status:** No "20(25)" appears in the backend. The API already returns the depth as `25`. For example, `luggage.sizeGuide.smallSuitcaseCm` for a 4-seater is `{ length: 60, width: 40, height: 25 }`, from `server/src/app/utils/luggage.utils.ts`.

**Action for the app development team:**
- Search the app and admin panel for any hard-coded "20(25)" text and replace it with "25 cm".
- Alternatively, render the depth from the API's `smallSuitcaseCm.height`.

## 6. Waiting-Time Warning / Delay Fee: warning only

**Decision:** We did not implement the automatic EUR 20 charge. Charging only the late rider in a shared ride would need:
- a separate off-session Stripe charge
- refund and dispute handling
- driver payout rules
- a restart-safe timer

That is disproportionate for a non-core feature. Per the spec, a non-charging warning is used and the real fee is deferred to a later phase.

**What changed:**
- **Warning content** (`server/src/app/utils/waitTimeNotice.utils.ts`):
  - The amount is EUR 20 (was EUR 10), and the text is the client's exact copy: "Please be ready when your driver arrives. Delays of more than 5 minutes may result in a EUR 20 waiting-time fee. This helps avoid disruption to other riders sharing the journey."
  - The flags are `mode: 'warning_only'`, `chargeApplied: false` and `affectsPrice: false`.
- **When the rider sees it:**
  - when a driver accepts (`ride:driver-accepted`)
  - when the driver arrives (`ride:driver-arrived`)
  - at the 5-minute mark (`ride:wait-time-notice`, follow-up text)
- **Timer fix:** The 5-minute reminder is skipped once the rider has been picked up, cancelled or marked as a no-show.
- **Audit data** stored on each passenger at pickup:
  - `pickupDelaySeconds`
  - `waitThresholdExceeded` (true only above 300 seconds; exactly 5:00 is not exceeded)
  - `waitFeeCharged` (always `false`)

  These are per rider, so other riders are unaffected. They give the usage data needed before turning on a real fee.

**Action for the Flutter team:** Display `waitTimeNotice.message` from those three events. No payment UI is needed.

## 7. PMC Production Defaults

**Rule:** Keep 10% (PMCrfPR), 30% (2 riders) and 50% (3 riders).

**What changed:**
- The values were already active, both in the code defaults and in the database.
- Two small gaps were closed:
  - The stored fare breakdown fell back to 0% instead of 30% for the 2-rider surcharge (`fareBreakdownResponse.utils.ts`).
  - The seeder now writes 10 / 30 / 50 explicitly (`settings.seeder.ts`).

**Verified:**
- Default values: 10 / 30 / 50.
- Tiers: 1 rider 0%, 2 riders 30%, 3 riders 50%.

**Production note:** Confirm the three values in the admin settings on the production database, or run `npm run seeder` there. The seeder also overwrites a few other client-required settings.

---

## Developer Completion Checklist

- [x] Ride matching uses an inclusive ±30-minute pickup-time window.
- [x] Exact EUR 5 boundaries stay unchanged; in-between values round up.
- [x] More than 4 passengers uses 6-seater rates with +40% on the full regulated base.
- [x] The split fare formula keeps the mandatory +10% initial estimate.
- [ ] Luggage wording updated to 25 cm (**UI**; backend already returns 25).
- [x] Waiting-time feature left as a non-charging EUR 20 warning; automatic fee deferred.
- [x] PMC defaults stay 10% / 30% / 50%.
