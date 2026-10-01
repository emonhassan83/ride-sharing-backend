# Fare calculation — Private & Split (passenger pricing)

Short reference for how passenger `estimatedFare` / `totalFare` is built. Defaults below match app settings unless overridden in DB.

## Shared rates (defaults)


| Item                          | Value                                               |
| ----------------------------- | --------------------------------------------------- |
| Day window                    | 06:00–20:29                                         |
| Night window                  | 20:30–05:59                                         |
| Day start / km / wait/h       | €3.80 / €0.95 / €17                                 |
| Night start / km / wait/h     | €4.80 / €1.10 / €19                                 |
| Platform commission (PMCrfPR) | 10% (baked into price; not shown separately)        |
| Rounding                      | Round **up** to next €5                             |
| Minimum fare                  | €20                                                 |
| VAT                           | 9% **included** (display extract only)              |
| Luggage / holiday / 5-pax     | Ignored (`0`)                                       |
| 6-pax                         | +40% on regulated base (private seats)              |
| Waiting                       | Only if `waitingMinutes > 0` (estimate usually `0`) |


**Regulated base (komistra):**  
`initialCharge + (distanceKm × perKm) [+ waiting] [+ 6-pax if seats === 6]`

---



## 1. Private ride (one passenger)

Always treated as a single payer. No split matched surcharge.

### Steps

1. Pick day/night rates from departure time.
2. `regulatedBase = start + km charge`.
3. `afterPmc = regulatedBase × 1.10`.
4. `totalFare = max(ceil_to_€5(afterPmc), €20)`.
5. Display VAT = `totalFare × 9 / 109`.



### Example — day, 50 km, 1 seat


| Step          | Calc               | Result  |
| ------------- | ------------------ | ------- |
| Base          | `3.80 + 50 × 0.95` | €51.30  |
| +10% PMC      | `51.30 × 1.10`     | €56.43  |
| €5 ceil       |                    | **€60** |
| VAT (display) | `60 × 9 / 109`     | ≈ €4.95 |


**Passenger pays: €60**

---



## 2. Split ride — same pickup & destination

Each rider has an **initial upfront** (same formula as private, with `activeRiderCount = 1` for that component):

`initialUpfront = max(ceil_to_€5(regulatedBase × 1.10), €20)`

Matched surcharge (PMCrfSR):


| Active riders | Surcharge                          |
| ------------- | ---------------------------------- |
| 1 (alone)     | 0%                                 |
| 2             | +30%                               |
| 3             | +50%                               |
| 4+            | Not allowed (max 3 matched riders) |


When **2+** riders share a ride, all fares are recalculated:

1. `poolInitial` = sum of each rider’s `initialUpfront`
2. `averageInitial = poolInitial ÷ riders`
3. `sharedBasis = averageInitial × (1 + surcharge%)`
4. `perRider = sharedBasis ÷ riders`
5. `totalFare = max(ceil_to_€5(perRider), €20)`

Same route → every rider ends with the **same** per-person fare after recalc.

### Example — day, 50 km, three riders join one by one

Each rider’s solo initial upfront = **€60** (same as private example above).

#### 1st passenger (alone)


| Step              | Result  |
| ----------------- | ------- |
| Unmatched (0% SR) | **€60** |




#### 2nd passenger joins (+30%)


| Step      | Calc        | Result  |
| --------- | ----------- | ------- |
| Pool      | `60 + 60`   | €120    |
| Average   | `120 ÷ 2`   | €60     |
| +30%      | `60 × 1.30` | €78     |
| Per rider | `78 ÷ 2`    | €39     |
| €5 ceil   |             | **€40** |


- 1st: €60 → **€40** (recalculated)  
- 2nd: **€40**



#### 3rd passenger joins (+50%)


| Step      | Calc           | Result  |
| --------- | -------------- | ------- |
| Pool      | `60 + 60 + 60` | €180    |
| Average   | `180 ÷ 3`      | €60     |
| +50%      | `60 × 1.50`    | €90     |
| Per rider | `90 ÷ 3`       | €30     |
| €5 ceil   |                | **€30** |


- All three: **€30** each



### Split summary (50 km day)


| Moment          | 1st | 2nd | 3rd |
| --------------- | --- | --- | --- |
| After 1st joins | €60 | —   | —   |
| After 2nd joins | €40 | €40 | —   |
| After 3rd joins | €30 | €30 | €30 |


---

