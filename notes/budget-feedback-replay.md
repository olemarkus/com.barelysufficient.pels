# Daily-budget feedback and historical replay

## Algorithm

The weather signature retains a year of usable daily temperature/usage pairs.
Its q80 headroom is the larger of annual and recent-fortnight residual q80,
so measured occupancy/load changes can widen allowance without device-denial
estimates. Proven unresolved budget shortfall selects q90 instead. The displayed
upper prediction bound also retains the wider recent q90.

Budget feedback uses observed overshoot of budget-counted usage (metered less
budget-exempt), pending heater demand attributed
to daily pace after physical recovery accounting, or priced terminal
budget-exhausted task misses. Unused allowance absorbs pending heater demand.
Capacity/cooldown holds and recovered intervals cannot raise the damage signal.
Correction grows by at most 10 kWh/day; on quiet days it leaks by 25% and credits
up to 10 kWh of unused allowance. Physical capacity, with actual local-day
length, remains the ceiling. Auto-apply permits decreases while a correction
remains. Version 3 corrections use budget-counted energy. Earlier corrections
are discarded on load: cumulative holds and whole-home overshoot cannot be
recovered onto this axis. Their cached suggestions are discarded too, then
recomputed without an apply merely on startup. Measurement history and the
last-applied audit remain intact.

See `notes/starvation/README.md` for the accounting and producer ownership.

## Replay procedure

Export `/diagnostics/budget/days` in date ranges of at most 366 calendar days,
then join its `records` into one JSON file. Supply archived structured
`weather_advisor_fit` lines from the same Homey. The script loads the actual production fit, suggestion, normalization and
feedback functions:

```sh
node scripts/replay-weather-budget.mjs history.json archived-forecasts.log replay.json Europe/Oslo 4.7
```

The last argument is sustainable capacity kW, not the hard cap. The timezone
and capacity must match the home under evaluation. For each target day:

1. Fit on records strictly before that date. Neither today's actual temperature
   nor consumption is a predictor input.
2. Use the earliest archived MET forecast from the first 15 minutes of that
   local day. Reject late catch-up and later refreshed forecasts. If no such
   forecast exists, use the production prior-week weather fallback and report
   those rows separately.
3. Compare the recommendation against recorded actual usage and the recorded
   applied budget. Fold the closed day only after producing its recommendation,
   substituting that replay's allowance when evaluating feedback.
   Compute allowances on target days excluded from signature fitting too;
   incomplete temperature coverage does not invalidate their energy balance.
   The signature-quality gate limits the reported comparison rows.
   A record exported before `kwhBudgetCounted` existed carries only whole-home
   kWh; the replay folds it as if no load was budget-exempt, which overstates
   overshoot on a home with exempt devices (stated in the report methodology).
4. Run a second conservative replay that treats every historical cumulative
   hold as unresolved budget-attributed denial. This deliberately overstates
   the new feedback evidence; historical rows cannot establish recovery/cause.

## Interpreting comparisons

A lower allowance error measures budget fit. Replay holds usage and device
holds fixed. Changing an actual budget can change delivery, temperature,
task completion, and subsequent training. Backfilled records may have become
available after their observation dates. Keep archived-forecast results and
fallback results separate, and use the conservative run to show the effect
of incomplete recovery and cause attribution.

Focused checks cover observed recovery versus commanded target, capacity
attribution, unavailable device readings, restart retention without pricing
gaps, local-day boundaries, correction migration, and auto-apply decreases.
