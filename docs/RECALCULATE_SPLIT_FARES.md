# recalculateSplitFares Documentation

## Overview
`recalculateSplitFares` automatically adjusts passenger fares for split rides when:
- A new passenger joins (`passenger_joined`)
- A passenger cancels (`passenger_cancelled`)
- A passenger is rejected (`passenger_rejected`)

This is critical for maintaining fair pricing — split ride costs are shared among all passengers, so any change in passenger count affects everyone's fare.

---

## Location
`server/src/app/utils/splitFare.utils.ts` — lines 226–348

---

## Step-by-Step Flow

### 1. Acquire Distributed Lock
```ts
let locked = false;
for (let i = 0; i < 3; i++) {
  locked = await acquireRecalculateLock(rideId);
  if (locked) break;
  await new Promise((r) => setTimeout(r, 600));
}
```
- Uses Redis key `ride:recalculate:lock:<rideId>` with 15-second TTL.
- Retries 3 times (600ms apart) to handle concurrent recalculations.
- If lock cannot be acquired, the function logs a warning and exits. **This prevents double-charging or incorrect refunds when multiple events fire simultaneously for the same ride.**

### 2. Fetch Active Passengers
```ts
const activePassengers = await Passenger.find({
  rideId,
  status: {
    $in: [
      PASSENGER_STATUS.pending,
      PASSENGER_STATUS.confirmed,
      PASSENGER_STATUS.in_progress,
      PASSENGER_STATUS.driver_arrived,
    ],
  },
}).lean();
```
- Only passengers in **active** states are considered.
- Passengers with status `cancelled`, `rejected`, or `pending` (waiting for driver acceptance) are **excluded** because their seats are not yet committed.

### 3. Calculate Total Booked Seats
```ts
const totalSeats = activePassengers.reduce(
  (s, p) => s + (p.requestedSeats || 1),
  0
);
```
- `requestedSeats` defaults to `1` if undefined.
- `totalSeats` is the denominator for fare splitting.

### 4. Determine Applicable Surcharge Rate
```ts
const { percent: newSurchargePercent } = getSurchargeMultiplier(totalSeats);
```
- `getSurchargeMultiplier` sets tiered surcharges based on total seats:
  - **5– seats**: 0% surcharge, multiplier `1.0`
  - **5 seats**: 20% surcharge, multiplier `1.2`
  - **6+ seats**: 40% surcharge, multiplier `1.4`
- These rules encourage smaller groups and offset higher coordination costs.

### 5. Recalculate Each Passenger's Fare
For every active passenger:

#### a. Compute New Fare
```ts
const newFare = await calcSplitPassengerFare(
  passenger.estimatedDistanceKm || 0,
  passenger.requestedSeats || 1,
  totalSeats,
  passenger.luggageCounts || 0,
  (ride as any).departureTime,
  depDate
);
```
`calcSplitPassengerFare` factors in:
- **Base fare** (initial charge + per-km rate), split equally across `totalSeats`.
- **Night/holiday multipliers** applied before splitting.
- **Luggage charge** split equally.
- **Surcharge** (step 4) applied on top of the per-passenger base.
- **Result**: Each passenger pays the same *base* per ride, but surcharge scales with group size.

#### b. Compare Old vs. New Fare
```ts
const oldFare = passenger.estimatedFare || 0;
const diff = Math.round((newFare.estimatedFare - oldFare) * 100) / 100;

if (Math.abs(diff) < 0.01) continue; // ignore rounding noise
```
- `diff < 0`: Fare decreased → refund to passenger.
- `diff > 0`: Fare increased → charge passenger.
- If the change is less than 1 penny, skip to avoid unnecessary payments.

#### c. Refund (Fare Decreased)
```ts
await refundToWallet(passenger.userId.toString(), Math.abs(diff), `fare_recalculate_${reason}`, io);
```
- Refund is **always to wallet** (never to original card) per Case 26.
- Sends a push notification to the user.

#### d. Charge (Fare Increased)
```ts
const result = await chargeUser(passenger.userId.toString(), diff, rideId, `fare_recalculate_${reason}`, io);
```
- Wallet-first, card-fallback logic:
  - If wallet balance covers the amount → deduct from wallet.
  - If partially covered → deduct wallet portion + charge rest to user's default card via Stripe.
  - If wallet is empty + no card → emit `ride:payment-failed` event and set `paymentStatus = 'pending_recovery'` for manual intervention.
- Idempotency is guaranteed by a Redis key `payment:charged:<rideId>:<userId>:<amount>` valid for 24 hours.

#### e. Update Passenger Fare in DB
```ts
await Passenger.findByIdAndUpdate(passenger._id, {
  estimatedFare: newFare.estimatedFare,
  surchargePercent: newFare.surchargePercent,
  surchargeAmount: newFare.surchargeAmount,
  totalKmCharge: newFare.totalKmCharge,
  luggageCharge: newFare.luggageCharge,
  holidayTripCharge: newFare.holidayTripCharge,
});
```
All fare components are persisted so the passenger document holds the exact final amount.

#### f. Notify Passenger
```ts
io.to(`user:${passenger.userId}`).emit('ride:fare-adjusted', {
  rideId,
  oldFare,
  newFare: newFare.estimatedFare,
  diff,
  surchargePercent: newFare.surchargePercent,
  reason,
  message: diff > 0
    ? `Your fare increased by £${diff.toFixed(2)}.`
    : `You saved £${Math.abs(diff).toFixed(2)}!`,
});
```
Real-time notification explains the price change and the reason.

### 6. Update Ride Surcharge Record
```ts
await Ride.findByIdAndUpdate(rideId, {
  currentSurchargePercent: newSurchargePercent,
});
```
The ride document stores the latest surcharge for reporting/dashboard purposes.

### 7. Release Lock
```ts
finally {
  await releaseRecalculateLock(rideId);
}
```
Always releases the lock, even if an exception occurred.

---

## Event Sequence in `driverAcceptRide.handler.ts`

When a driver accepts a split ride:
1. Passenger status → `PASSENGER_STATUS.confirmed`
2. `recalculateSplitFares(rideId, 'passenger_joined', io)` is called asynchronously.
3. The same function is triggered during:
   - `rideCancelAfterAccept.handler.ts` → `'passenger_cancelled'`
   - `splitRideRequest.handler.ts` (rejection path) → `'passenger_rejected'`

---

## Key Guarantees & Edge Cases

| Concern | Handling |
|---------|----------|
| **Double recalculation** | Distributed Redis lock (15 s) prevents concurrent execution. |
| **Clock skew / minor fare diff** | `Math.abs(diff) < 0.01` skips charging for a single penny or less. |
| **Payment idempotency** | Redis key blocks charging the same ride/user/amount twice within 24 h. |
| **Payment failure recovery** | Sets `paymentStatus = 'pending_recovery'` for ops staff. |
| **Wallet-rollback** | If card charge fails, wallet deduction is reversed (Case 11). |
| **Refund path** | Always wallet — consistent policy for split-ride adjustments. |

---

## Data Model Changes

- `Passenger.estimatedFare` — updated on every recalculation.
- `Passenger.surchargePercent`, `surchargeAmount`, `totalKmCharge`, `luggageCharge`, `holidayTripCharge` — refreshed.
- `Ride.currentSurchargePercent` — refreshed.

---

## Future Notes / TODOs

- [ ] Add webhook / audit log for fare changes.
- [ ] Extend with promocode or subscription discounts.
- [ ] Consider per-seat dynamic pricing during peak hours.