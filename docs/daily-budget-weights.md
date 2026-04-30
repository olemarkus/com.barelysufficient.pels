---
title: Daily Budget Weighting Math
description: Exact formulas for unmanaged reserve, managed-device price flexibility, confidence, and observed hourly caps in the daily-budget planner.
---

# Daily Budget Weighting Math (Advanced)

This document explains the exact math behind:

- **Unmanaged usage reserve** (Advanced tab)
- **Managed device flexibility** (Advanced tab)
- **Observed hourly peak caps** (split-budget safety)
- **Confidence** (backtested forecast-skill score shown in the UI)
- **Profile blend confidence** (how quickly learned behavior influences the plan internally)

The formulas here match the current implementation in `lib/dailyBudget`.

## 1) Inputs used by the planner

For each local hour `h` (0-23), PELS works with:

- `D[h]`: default profile weight (baseline day shape), normalized to sum to 1
- `U[h]`: learned **uncontrolled** weight, normalized to sum to 1
- `C[h]`: learned **controlled** weight, normalized to sum to 1
- `s`: learned controlled share of total energy (`0..1`)
- `r`: unmanaged reserve mode (`0 = balanced`, `1 = conservative`)
- `w`: internal managed-load floor/profile weight (current implementation: `0.30`)
- `p`: managed device price flexibility (`0.30 = low`, `0.60 = medium`, `0.85 = high`)
- `Umax[h]`: robust upper observed uncontrolled kWh envelope for local hour `h` (hourly quantile)
- `Cmax[h]`: robust upper observed controlled kWh envelope for local hour `h` (hourly quantile)
- `Umin[h]`: robust lower positive observed uncontrolled kWh envelope for local hour `h` (`0` means no minimum data)
- `Cmin[h]`: robust lower positive observed controlled kWh envelope for local hour `h` (`0` means no minimum data)
- `m`: observed-peak margin ratio (current implementation: `0.20`)
- `W`: observed-peak rolling window in days (current implementation: `30`)
- `qMax`: upper quantile for observed caps (current implementation: `0.90`)
- `qMin`: lower quantile for observed minimums (current implementation: `0.25`)
- `Nq`: minimum samples per hour before quantiles are used (current implementation: `5`)
- `price[b]`: combined price for each plan bucket
- `pricePosition[b]`: normalized position within the remaining price range
  (`0 = cheapest`, `1 = most expensive`)

## 2) How daily learning updates profiles

At day rollover, PELS splits each bucket into uncontrolled and controlled kWh (if controlled split data exists), then builds daily hour weights:

- `dayU[h] = hourlyUncontrolled[h] / totalUncontrolled`
- `dayC[h] = hourlyControlled[h] / totalControlled`

Each profile is a running average:

```text
nextWeight[h] = (prevWeight[h] * sampleCount + dayWeight[h]) / (sampleCount + 1)
```

Controlled share is also a running average:

```text
dayShare = totalControlled / (totalControlled + totalUncontrolled)
nextShare = (prevShare * sampleCount + dayShare) / (sampleCount + 1)
```

Observed hourly peaks are updated at rollover too:

```text
nextUmax[h] = quantile(hourlyUncontrolled[h], qMax) over buckets in last W days
nextCmax[h] = quantile(hourlyControlled[h], qMax) over buckets in last W days
```

Observed hourly minimums are updated from the same rolling window:

```text
nextUmin[h] = quantile(hourlyUncontrolled[h] where > 0, qMin) over buckets in last W days
nextCmin[h] = quantile(hourlyControlled[h] where > 0, qMin) over buckets in last W days
```

For low sample counts (`count < Nq`), PELS falls back to raw extrema for that hour:

```text
nextUmax[h] = max(...)
nextCmax[h] = max(...)
nextUmin[h] = min(... where > 0)
nextCmin[h] = min(... where > 0)
```

## 3) Managed-load profile weight (`w`) math

`w` is no longer exposed as a normal user setting. The Advanced tab exposes **Unmanaged usage reserve** instead; that mode affects unmanaged reserve floors, not the learned controlled/uncontrolled profile split.

Internally, `w` is fixed at the default value and scales the contribution of the controlled profile relative to uncontrolled, using learned controlled share `s`.

```text
denom = (1 - s) + s * w
uncontrolledScale = (1 - s) / denom
controlledScale = (s * w) / denom

learnedUncontrolled[h] = U[h] * uncontrolledScale
learnedControlled[h]   = C[h] * controlledScale
learnedCombined[h]     = normalize(learnedUncontrolled[h] + learnedControlled[h])
```

Internal behavior:

- lower `w`: less controlled history influences the learned shape
- higher `w`: controlled contribution follows more of measured share `s`
- current implementation: fixed default, so changing **Unmanaged usage reserve** does not reshape controlled history

### Example A: managed-load profile weighting

Assume:

- `s = 0.40` (40% controlled energy historically)
- `w = 0.30` (default)

Then:

```text
denom = 0.60 + 0.40 * 0.30 = 0.72
uncontrolledScale = 0.60 / 0.72 = 0.8333
controlledScale   = 0.12 / 0.72 = 0.1667
```

So even though controlled energy share is 40%, the learned shape uses about 16.7% controlled influence internally.

## 4) Confidence

PELS has two distinct confidence concepts:

### 4a) Profile blend confidence (internal)

Profile blend confidence controls how quickly learned profiles replace the default profile in the planner. It is **not** shown in the UI.

```text
profileBlendConfidence = clamp(profileSampleCount / 14, 0, 1)
```

Profile blending applied by the planner:

```text
effectiveUncontrolled[h] = D[h] * (1 - profileBlendConfidence) + learnedUncontrolled[h] * profileBlendConfidence
effectiveControlled[h]   = learnedControlled[h] * profileBlendConfidence
combined[h]              = normalize(effectiveUncontrolled[h] + effectiveControlled[h])
```

Implications:

- Early days: plan stays close to default profile
- As profile blend confidence grows: learned behavior gradually takes over
- Controlled contribution ramps with profile blend confidence

### 4b) Budget confidence (UI-facing)

Budget confidence is a backtested forecast-skill score computed from the last 30 complete local days (excluding today and days overlapping unreliable periods). This is the value shown in the Budget tab.

It has two components:

#### Regularity score

Measures how consistent the home's daily usage shape is across history.

```text
For each valid day i:
  looCentroid   = mean of all other days' normalized actual profiles
  dayScore[i]   = clamp(1 - L1(actualProfile[i], looCentroid) / 2, 0, 1)

regularityScore = mean(dayScores) * clamp(validActualDays / 14, 0, 1)
```

#### Adaptability score

Measures how well the home follows shifted budget plans when controlled load exists. Only uses days with near-complete plan data (≥90% of hourly buckets).

```text
For each valid planned day:
  planFitScore    = clamp(1 - L1(actualProfile, plannedProfile) / 2, 0, 1)
  controlledShare = controlledDayKWh / totalDayKWh
  shiftDemand     = max(0.20, L1(plannedProfile, centroid) / 2)
  scoreWeight     = controlledShare * shiftDemand

adaptabilityScore = weightedMean(planFitScores, scoreWeights) * clamp(validPlannedDays / 14, 0, 1)
```

`validPlannedDays` counts only planned days with positive `scoreWeight`, so low-evidence histories ramp slowly.

#### Combined confidence

```text
weightedControlledShare = weightedMean(controlledShare, weights = shiftDemand)
adaptabilityInfluence   = clamp(weightedControlledShare * 1.2, 0, 0.85)

confidence = regularityScore * (1 - adaptabilityInfluence)
           + adaptabilityScore * adaptabilityInfluence
```

If there is no valid planned-day data or total day weight is zero, confidence falls back to regularity score alone.

This makes adaptability dominate only when the home historically has meaningful controlled share; otherwise confidence is mostly whole-home regularity.

A bootstrap confidence interval (5th/95th percentile, 500 iterations) is computed for debug/validation but is not shown in the UI.

### Example B: profile blend confidence ramp

- After `3` valid days: profile blend confidence is `3/14 = 0.214`
- After `10` valid days: profile blend confidence is `10/14 = 0.714`
- After `14+` valid days: profile blend confidence saturates at `1.0`

## 5) Observed hourly peak caps (split-budget safety)

This adds an hour-aware cap based on a robust upper observed split envelope for each local hour, plus margin.
Observed bounds are recomputed from a rolling window, so old seasonal peaks eventually age out.

Per local hour:

```text
Ucap[h] = Umax[h] * (1 + m)
Ccap[h] = Cmax[h] * (1 + m)
```

PELS then combines the split caps into a total plausible-load cap:

```text
observedCap[h] = Ucap[h] + Ccap[h]
```

Notes:

- If one side has no usable observed max, the other side still contributes.
- If neither side has usable observed max, this cap is effectively disabled for that hour.

Final bucket cap is the minimum of:

- capacity per-hour cap (if configured), and
- total observed-peak cap above.

`w` does not affect the cap. Controlled usage is still available as flexible headroom above the
floor even when `w = 0`.

## 5b) Observed hourly minimum floors (split-budget safety)

Observed minima create an hour-aware floor that prevents planning below typical
historical usage for each side. Floors use robust lower positive envelopes and
the same margin ratio `m`, but apply
in the opposite direction:

```text
Ufloor[h] = max(0, Umin[h] * (1 - m))
Cfloor[h] = max(0, Cmin[h] * (1 - m))
```

The floor always includes the uncontrolled minimum. The **Unmanaged usage reserve** mode controls how defensively this unmanaged floor is reserved. Controlled minimums are added with the fixed internal managed-load floor weight `w`:

```text
floor[h] = Ufloor[h] + w * Cfloor[h]
```

Important behavior:

- Floors are enforced only while budget remains; if floors exceed remaining budget,
  all floors are scaled down proportionally to fit the budget.
- Balanced unmanaged reserve keeps the unmanaged floor closer to the learned minimum.
- Conservative unmanaged reserve raises the unmanaged floor toward the robust reserve envelope.
- Controlled service-floor influence stays fixed when changing unmanaged reserve mode.
- Controlled load between the floor and cap remains flexible budget headroom.

## 6) Managed device flexibility (`p`) math

Price shaping applies only when:

- price optimization is enabled
- daily price shaping is enabled
- complete remaining price data is available

Price range is computed from remaining buckets:

```text
minPrice = min(remainingPrices)
maxPrice = max(remainingPrices)
priceRange = maxPrice - minPrice
```

If `priceRange` is zero or within the planner's near-flat deadband, price shaping is effectively
disabled for that plan.
Otherwise the selected managed-device flexibility maps to `p`, which is used directly as the effective shaping strength:

```text
pEff = p
```

The planner first builds a neutral allocation from profile/history weights, floors, and caps.
It then builds a full-flex price target between the same effective bounds:

```text
pricePosition[b] = (price[b] - minPrice) / priceRange
priceTarget[b]   = cap[b] - pricePosition[b] * (cap[b] - floor[b])
```

`priceTarget[b] - floor[b]` becomes the preferred redistribution weight after floors are reserved.
That means the cheapest bucket targets its cap, the most expensive bucket targets its floor, and
intermediate buckets land between those extremes according to price.

The final plan blends neutral allocation and full-flex allocation:

```text
planned[b] = neutralAllocation[b] * (1 - pEff)
           + fullFlexAllocation[b] * pEff
```

Behavior:

- Low (`p = 0.30`): modest price shaping
- Medium (`p = 0.60`): default price shaping
- High (`p = 0.85`): stronger movement toward cheaper feasible hours
- Internally, `p = 1`: cheapest remaining bucket is allowed up to cap, most expensive remaining bucket is held
  to floor when the remaining budget permits it
- Values between 0 and 1 smoothly blend profile-driven pacing and full price-driven pacing

### Example C: price flex effect

Assume three remaining buckets:

```text
prices = [10, 20, 30]
caps   = [4, 4, 4]
floors = [0, 0, 0]
```

```text
pricePosition = [0, 0.5, 1]
priceTarget   = [4, 2, 0]
```

With a `6 kWh` remaining budget and `p = 1`, the full-flex allocation is:

```text
[4, 2, 0]
```

With the same setup and `p = 0.5`, the result is halfway between neutral allocation and this
full-flex allocation.

## 7) Practical tuning guidance

- Keep defaults unless you have stable data and a clear tuning goal.
- Change one setting at a time and observe at least one full day.
- If unmanaged household load regularly causes budget misses, use **Conservative** unmanaged reserve.
- If too much budget is held back from managed devices, use **Balanced** unmanaged reserve.
- If plan movement by price is too aggressive, lower **Managed device flexibility**.
- If the budget cannot be fully allocated under capacity and historical caps, the Budget UI shows
  an allocation warning; lower the daily budget or raise the relevant capacity/load assumptions.
- If confidence stays low, verify regular power reporting and controlled/uncontrolled split data.

## 8) Debug fields to inspect

With debug logging enabled for daily budget, these fields are useful:

### Profile & planner fields

- `profileSampleCount`
- `profileSplitSampleCount`
- `profileControlledShare`
- `profileLearnedWeights`
- `profileEffectiveWeights`
- `priceFactor` array (debug-only legacy price multiplier view)
- `profileObservedMaxUncontrolledKWh`
- `profileObservedMaxControlledKWh`
- `priceSpreadFactor`
- `effectivePriceShapingFlexShare`
- `state.allocationPressure` — requested vs planned budget and whether caps prevent full allocation

### Budget confidence fields (in `state.confidenceDebug`)

- `confidenceRegularity` — regularity score (0..1)
- `confidenceAdaptability` — adaptability score (0..1)
- `confidenceAdaptabilityInfluence` — weight of adaptability in combined score (0..0.85)
- `confidenceWeightedControlledShare` — controlled share weighted by shift-demand
- `confidenceValidActualDays` — number of valid days used for regularity
- `confidenceValidPlannedDays` — number of valid planned days used for adaptability
- `confidenceBootstrapLow` — 5th percentile bootstrap interval (debug only)
- `confidenceBootstrapHigh` — 95th percentile bootstrap interval (debug only)
- `profileBlendConfidence` — internal profile blend confidence (sample-count ramp)

These values let you verify whether behavior is caused by profile learning, observed-peak caps, budget confidence scoring, or price shaping.
