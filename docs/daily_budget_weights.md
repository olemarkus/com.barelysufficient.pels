# Daily Budget Weighting Math (Advanced)

This document explains the exact math behind:

- **Controlled usage weight** (Advanced tab)
- **Price flex share** (Advanced tab)
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
- `w`: **Controlled usage weight** setting (`0..1`, default `0.30`)
- `p`: **Price flex share** setting (`0..1`, default `0.35`)
- `Umax[h]`: robust upper observed uncontrolled kWh envelope for local hour `h` (hourly quantile)
- `Cmax[h]`: robust upper observed controlled kWh envelope for local hour `h` (hourly quantile)
- `Umin[h]`: robust lower positive observed uncontrolled kWh envelope for local hour `h` (`0` means no minimum data)
- `Cmin[h]`: robust lower positive observed controlled kWh envelope for local hour `h` (`0` means no minimum data)
- `m`: observed-peak margin ratio (current implementation: `0.20`)
- `W`: observed-peak rolling window in days (current implementation: `30`)
- `qMax`: upper quantile for observed caps (current implementation: `0.90`)
- `qMin`: lower quantile for observed minimums (current implementation: `0.25`)
- `Nq`: minimum samples per hour before quantiles are used (current implementation: `5`)
- `f[b]`: price factor per plan bucket (typically `0.7..1.3`), where:
  - `f > 1` means cheaper-than-median bucket
  - `f < 1` means more expensive-than-median bucket

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

## 3) Controlled usage weight (`w`) math

`w` does not directly replace profile values. It scales the contribution of the controlled profile relative to uncontrolled, using learned controlled share `s`.

```text
denom = (1 - s) + s * w
uncontrolledScale = (1 - s) / denom
controlledScale = (s * w) / denom

learnedUncontrolled[h] = U[h] * uncontrolledScale
learnedControlled[h]   = C[h] * controlledScale
learnedCombined[h]     = normalize(learnedUncontrolled[h] + learnedControlled[h])
```

Behavior:

- `w = 0`: controlled contribution becomes 0 (ignored in learned shape)
- `w = 1`: controlled contribution follows measured share `s`
- `0 < w < 1`: controlled contribution is partially down-weighted

### Example A: controlled weighting

Assume:

- `s = 0.40` (40% controlled energy historically)
- `w = 0.30` (default)

Then:

```text
denom = 0.60 + 0.40 * 0.30 = 0.72
uncontrolledScale = 0.60 / 0.72 = 0.8333
controlledScale   = 0.12 / 0.72 = 0.1667
```

So even though controlled energy share is 40%, the learned shape uses about 16.7% controlled influence at this stage.

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
  dayWeight       = controlledShare * shiftDemand

adaptabilityScore = weightedMean(planFitScores, dayWeights) * clamp(validPlannedDays / 14, 0, 1)
```

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

Then PELS blends the split caps by `w`:

```text
blendedCap[h] = blend(Ucap[h], Ccap[h], w)
```

Notes:

- If one side has no usable observed max, blending is normalized over available sides.
- If neither side has usable observed max, this cap is effectively disabled for that hour.

The plan uses split shares per bucket:

```text
uShare[b] = plannedUncontrolledWeight[b] / (plannedUncontrolledWeight[b] + plannedControlledWeight[b])
cShare[b] = 1 - uShare[b]
weightedShare[b] = (1 - w) * uShare[b] + w * cShare[b]
```

The blended split cap is converted to a bucket total cap:

```text
totalCapFromBlend[b] = blendedCap[h(b)] / weightedShare[b]
```

Final bucket cap is the minimum of:

- capacity per-hour cap (if configured), and
- blended observed-peak cap above.

This gives endpoint behavior:

- `w = 0`: uncontrolled side drives the cap
- `w = 1`: controlled side drives the cap
- `0 < w < 1`: smooth blend

## 5b) Observed hourly minimum floors (split-budget safety)

Observed minima create an hour-aware floor that prevents planning below typical
historical usage for each side. Floors use robust lower positive envelopes and
the same margin ratio `m`, but apply
in the opposite direction:

```text
Ufloor[h] = max(0, Umin[h] * (1 - m))
Cfloor[h] = max(0, Cmin[h] * (1 - m))
```

The blended floor follows the same weighted-share math as caps:

```text
blendedFloor[h] = blend(Ufloor[h], Cfloor[h], w)
totalFloorFromBlend[b] = blendedFloor[h(b)] / weightedShare[b]
```

Important behavior:

- Floors are enforced only while budget remains; if floors exceed remaining budget,
  all floors are scaled down proportionally to fit the budget.
- Controlled minimums are applied post‑split so they are respected even when
  `w = 0` (as long as the total bucket plan can accommodate them).

## 6) Price flex share (`p`) math

Price shaping applies only when:

- price optimization is enabled
- daily price shaping is enabled
- complete remaining price data is available

Price spread is computed from remaining buckets:

```text
median = p50(remainingPrices)
spread = p90(remainingPrices) - p10(remainingPrices)
spreadFactor = clamp(spread / max(1, abs(median)), 0, 1)
pEff = p * spreadFactor
```

`pEff` is the effective shaping strength used by the planner.

For each bucket, controlled base weight is blended with a price-adjusted version using `pEff`:

```text
priceAdjusted = base * f
composite     = base * (1 - pEff) + priceAdjusted * pEff
              = base * ((1 - pEff) + f * pEff)
```

Behavior:

- `p = 0`: no price shaping
- large spread + high `p`: strongest shaping
- small spread: shaping is automatically softened

When split profiles are available, only controlled portion is price-shaped; uncontrolled stays on profile shape.

### Example C: price flex effect

Assume bucket controlled base weight `base = 0.10`, user `p = 0.35`, and `spreadFactor = 0.8`:

```text
pEff = 0.35 * 0.8 = 0.28
```

Cheap bucket with `f = 1.3`:

```text
composite = 0.10 * (0.72 + 1.3 * 0.28)
          = 0.10 * 1.084
          = 0.1084
```

Expensive bucket with `f = 0.7`:

```text
composite = 0.10 * (0.72 + 0.7 * 0.28)
          = 0.10 * 0.916
          = 0.0916
```

So shaping remains meaningful, and naturally scales with day volatility.

## 7) Practical tuning guidance

- Keep defaults unless you have stable data and a clear tuning goal.
- Change one setting at a time and observe at least one full day.
- If split caps feel too strict, reduce **Controlled usage weight** (moves cap influence toward uncontrolled side).
- If plan movement by price is too aggressive, lower **Price flex share**.
- If confidence stays low, verify regular power reporting and controlled/uncontrolled split data.

## 8) Debug fields to inspect

With debug logging enabled for daily budget, these fields are useful:

### Profile & planner fields

- `profileSampleCount`
- `profileSplitSampleCount`
- `profileControlledShare`
- `profileLearnedWeights`
- `profileEffectiveWeights`
- `priceFactor` array
- `profileObservedMaxUncontrolledKWh`
- `profileObservedMaxControlledKWh`
- `priceSpreadFactor`
- `effectivePriceShapingFlexShare`

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
