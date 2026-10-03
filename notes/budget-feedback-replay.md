# Daily-budget feedback and historical replay

## Algorithm

The weather signature retains a year of usable daily temperature/usage pairs.
Its q80 headroom is the larger of annual and recent-fortnight residual q80,
so measured occupancy/load changes can widen allowance without device-denial
estimates. Proven unresolved budget shortfall selects q90 instead. The displayed
upper prediction bound also retains the wider recent q90.

Budget feedback uses observed actual overshoot, pending heater demand attributed
to daily pace after physical recovery accounting, or priced terminal
budget-exhausted task misses. Unused allowance absorbs pending heater demand.
Capacity/cooldown holds and recovered intervals cannot raise the damage signal.
Correction grows by at most 10 kWh/day; on quiet days it leaks by 25% and credits
up to 10 kWh of unused allowance. Physical capacity, with actual local-day
length, remains the ceiling. Auto-apply permits decreases while a correction
remains. Old cumulative-hold corrections are discarded on upgrade, and cached
pre-upgrade advice is recomputed without an apply merely on startup.

See `notes/starvation/README.md` for the accounting and producer ownership.

## Replay procedure

Export `/diagnostics/budget/days` in date ranges of at most 366 calendar days,
then join its `records` into one JSON file. Supply archived structured
`weather_advisor_fit` lines from the same physical Homey, without mixing SHS
logs. The script loads the actual production fit, suggestion, normalization and
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
4. Run a second conservative replay that treats every historical cumulative
   hold as unresolved budget-attributed denial. This deliberately overstates
   the new feedback evidence; historical rows cannot establish recovery/cause.

## Recorded comparison, 2026-10-03

640 retained records were available. 59 days from August 2 through October 2
had sufficient earlier training, reliable actual usage, and an applied budget.
Nine had usable archived forecasts; 50 used the prior-week fallback.

| Metric | Recorded budget | Revised replay | Conservative replay |
|---|---:|---:|---:|
| Mean actual usage | 56.4 kWh/day | 56.4 | 56.4 |
| Mean budget | 67.1 kWh/day | 61.7 | 63.1 |
| Mean absolute budget-to-usage error | 12.1 kWh/day | 8.2 | 9.2 |
| Mean unused allowance | 11.4 kWh/day | 6.8 | 7.9 |
| Budget below recorded usage | 7/59 days | 12/59 | 12/59 |
| Sum of amounts below recorded usage | 41.4 kWh | 86.4 | 74.3 |

On the nine archived-forecast days, mean absolute error fell from 35.0 to
7.5 kWh/day (79%). Mean budget moved from 95.6 to 61.1 kWh/day against 60.6
actual. Even the conservative replay reduced error to 11.0 kWh/day. Revised
allowance fell below actual on two days, September 25 and October 2; recorded
budgets were above actual on all nine.

Over the four days at the 112.8 kWh ceiling, revised allowance averaged
56.9 kWh/day against 49.7 actual; mean absolute error fell from 63.1 to
11.6 kWh/day. Three of those days used archived forecasts, one the fallback.

These measure budget fit, not a change in the weather model's pseudo-R².
The revised policy covers recorded usage on approximately 80% of tested days,
consistent with ordinary q80 headroom. A lower mean error is not proof that
all device demand is served. Usage and holds remain fixed in replay: tighter
budgets could change delivery, temperature, task completion and subsequent
training. Backfilled prior records may have been available later than their
observation dates. Archived historical recovery and cause attribution are
incomplete; the conservative run exposes that uncertainty rather than treating
absence as proof of no damage. Actual archived-forecast rows are the stronger
comparison; fallback rows are a separate offline scenario.

Focused checks cover observed recovery versus commanded target, capacity
attribution, unavailable device readings, restart retention without pricing
gaps, local-day boundaries, correction migration, and auto-apply decreases.
