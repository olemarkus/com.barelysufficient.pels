# Auto-Adjust Daily Budget From Past Exemptions

This note captures a planned budget-policy feature.
It does not describe current behavior.

## Purpose

Allow PELS to increase tomorrow's effective daily budget based on recent eligible exempted
energy, so repeated starvation-driven exemptions do not make the planner chase weather and
thermal demand too aggressively.

This is a budget-policy feature.

It must not:

- change hourly capacity logic
- bypass hourly protection
- use raw starved minutes as the correction source
- recursively compound from yesterday's already-adjusted budget
- silently include every exemption type without source filtering

## Core Formula

Tomorrow's effective daily budget must be:

```text
effectiveBudgetTomorrow = baseBudget + autoBudgetCorrection
```

Not:

```text
effectiveBudgetTomorrow = yesterdayEffectiveBudget + correction
```

Always apply the correction relative to the configured base budget.

## Correction Source

Use eligible exempted kWh from recent completed local days.

Do not use:

- starved duration
- starved device count
- arbitrary percentage bumps

Duration is not energy. The correction should come from measured exempted energy.

## Eligible Exemption Energy

In v1, only include explicitly allowed exemption sources.

Suggested default:

- `starvation_policy`

Excluded by default:

- manual exemptions
- flow-driven exemptions
- ad hoc / debug exemptions

This implies exemption episodes need source tagging.

## Data Model

### Daily budget values

Keep these separate:

- `baseDailyBudgetKwh`
- `autoBudgetCorrectionKwh`
- `effectiveDailyBudgetKwh`

### Per-day accounting

For each completed local day, store at least:

- `dateLocal`
- `eligibleExemptedKwh`
- `totalExemptedKwh`
- `eligibleExemptionEpisodeCount`

Optional but useful:

- per-device breakdown
- per-source breakdown

### Exemption episode metadata

Each exemption episode should record:

- `source`
- `countsForAutoBudget`
- `deviceId`
- `startedAt`
- `endedAt`
- `exemptedKwh`

## Calculation Modes

Supported shapes:

- yesterday only
- rolling average
- weighted rolling average

Recommended default:

- weighted rolling average

Example 3-day weights:

- yesterday: `0.5`
- two days ago: `0.3`
- three days ago: `0.2`

## Recommended Algorithm

Inputs:

- `baseBudget`
- `lookbackDays`
- `mode`
- `maxCorrectionKwh`

Computation:

1. Collect the last `N` completed local days.
2. Read `eligibleExemptedKwh` for each day.
3. Compute correction using the selected mode.
4. Clamp correction to `0..maxCorrectionKwh`.
5. Compute `effectiveBudgetTomorrow = baseBudget + correction`.

Important rule:

- ignore the current incomplete day in v1
- compute tomorrow's correction at day rollover from finalized daily values only

## Interaction With Controlled vs Uncontrolled Load

Because exempted usage is handled as uncontrolled in the daily-budget model, the correction must
be based on measured exempted energy, not on a hypothetical controlled-load estimate.

Use:

- actual exempted kWh that occurred

Do not use:

- what PELS wished it had controlled

## Settings Direction

Expose this in the Budget UI, not only via flows.

Suggested settings:

- auto-adjust daily budget: off/on
- source: eligible exempted kWh only
- lookback mode: yesterday only / rolling average / weighted rolling average
- lookback days: `1`, `2`, `3`, `5`
- maximum correction: fixed kWh cap
- minimum history required before the feature becomes active

Recommended defaults:

- lookback mode: weighted rolling average
- lookback days: `3`
- minimum history: `1` for yesterday-only, `2` for rolling modes

## UI / Explainability

If the feature changes the budget, the UI must show why.

Budget view:

- Base budget
- Auto-budget correction
- Effective budget

Example:

- Base: `70.0 kWh`
- Auto-adjust: `+3.2 kWh`
- Effective: `73.2 kWh`

Detailed diagnostics should show:

- contributing days
- eligible exempted kWh per day
- selected mode
- raw correction
- clamped correction

Example:

- Day -1: `2.8 kWh`
- Day -2: `4.1 kWh`
- Day -3: `1.9 kWh`
- Weighted correction: `+3.1 kWh`

## Logging

Log at rollover:

- base budget
- selected mode
- lookback days used
- eligible exempted kWh per contributing day
- raw correction
- clamped correction
- effective budget for next day

## Acceptance Criteria

Functional:

- tomorrow's effective daily budget is computed as `base + correction`
- correction uses only completed local days
- correction uses only eligible exempted kWh
- correction is capped
- disabling the feature restores current behavior

Behavioral:

- hourly capacity protection is unaffected
- exempted energy still behaves as uncontrolled in the daily-budget split
- reporting still shows actual usage

Explainability:

- UI shows base, correction, and effective budget
- diagnostics and logs show exactly how correction was derived

## Open Decisions

Still to settle:

- which exemption sources count beyond built-in starvation policy
- exact default correction cap
- retention period for daily accounting
- whether any manual exemptions should ever count

Current recommendation:

- only built-in starvation-policy exemptions count in v1
- use a fixed kWh cap first
- keep at least 30 days of historical daily accounting
- do not include manual exemptions in v1
