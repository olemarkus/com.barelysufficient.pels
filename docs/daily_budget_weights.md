# Daily Budget Weighting Math (Advanced)

This document explains the exact math behind:

- **Controlled usage weight** (Advanced tab)
- **Price flex share** (Advanced tab)
- **Confidence** (how quickly learned behavior influences the plan)

The formulas here match the current implementation in `lib/dailyBudget`.

## 1) Inputs used by the planner

For each local hour `h` (0-23), PELS works with:

- `D[h]`: default profile weight (baseline day shape), normalized to sum to 1
- `U[h]`: learned **uncontrolled** weight, normalized to sum to 1
- `C[h]`: learned **controlled** weight, normalized to sum to 1
- `s`: learned controlled share of total energy (`0..1`)
- `w`: **Controlled usage weight** setting (`0..1`, default `0.30`)
- `p`: **Price flex share** setting (`0..1`, default `0.35`)
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

## 4) Confidence math

Confidence ramps learned influence in over time:

```text
confidenceFromCount(n) = clamp(n / 14, 0, 1)
```

PELS tracks:

- `profileSampleCount`: days with usable total data
- `profileSplitSampleCount`: days with usable split (controlled/uncontrolled) data

Planner confidence used for profile blending:

```text
plannerConfidence = confidenceFromCount(profileSampleCount)
```

Final confidence shown in UI:

```text
baseConfidence  = confidenceFromCount(profileSampleCount)
splitConfidence = confidenceFromCount(profileSplitSampleCount)
uiConfidence    = min(baseConfidence, splitConfidence)
```

Profile blending applied by the planner:

```text
effectiveUncontrolled[h] = D[h] * (1 - plannerConfidence) + learnedUncontrolled[h] * plannerConfidence
effectiveControlled[h]   = learnedControlled[h] * plannerConfidence
combined[h]              = normalize(effectiveUncontrolled[h] + effectiveControlled[h])
```

Implications:

- Early days: plan stays close to default profile
- As planner confidence grows: learned behavior gradually takes over
- Controlled contribution ramps with planner confidence
- If split data lags total data, UI confidence can be lower than planner confidence

### Example B: confidence ramp

- After `3` valid days: planner confidence is `3/14 = 0.214`
- After `10` valid days: planner confidence is `10/14 = 0.714`
- After `14+` valid days: planner confidence saturates at `1.0`

If split data only exists for 4 days but total data exists for 12 days:

- `baseConfidence = 12/14 = 0.857`
- `splitConfidence = 4/14 = 0.286`
- `uiConfidence = 0.286` (the limiting factor for displayed confidence)
- `plannerConfidence = 0.857` (used for profile blending)

## 5) Price flex share (`p`) math

Price shaping applies only when:

- price optimization is enabled
- daily price shaping is enabled
- complete remaining price data is available

For each bucket, controlled base weight is blended with a price-adjusted version:

```text
priceAdjusted = base * f
composite     = base * (1 - p) + priceAdjusted * p
              = base * ((1 - p) + f * p)
```

Behavior:

- `p = 0`: no price shaping
- `p = 1`: full price-factor shaping
- default `p = 0.35`: partial shaping

When split profiles are available, only controlled portion is price-shaped; uncontrolled stays on profile shape.

### Example C: price flex effect

Assume bucket controlled base weight `base = 0.10`, `p = 0.35`.

Cheap bucket with `f = 1.3`:

```text
composite = 0.10 * (0.65 + 1.3 * 0.35)
          = 0.10 * 1.105
          = 0.1105
```

Expensive bucket with `f = 0.7`:

```text
composite = 0.10 * (0.65 + 0.7 * 0.35)
          = 0.10 * 0.895
          = 0.0895
```

So with default settings, shaping is meaningful but not extreme.

## 6) Practical tuning guidance

- Keep defaults unless you have stable data and a clear tuning goal.
- Change one setting at a time and observe at least one full day.
- If controlled devices are getting too much influence, lower **Controlled usage weight**.
- If plan movement by price is too aggressive, lower **Price flex share**.
- If confidence stays low, verify regular power reporting and controlled/uncontrolled split data.

## 7) Debug fields to inspect

With debug logging enabled for daily budget, these fields are useful:

- `profileSampleCount`
- `profileSplitSampleCount`
- `profileConfidence`
- `profileControlledShare`
- `profileLearnedWeights`
- `profileEffectiveWeights`
- `priceFactor` array

These values let you verify whether behavior is caused by profile learning, confidence ramping, or price shaping.
