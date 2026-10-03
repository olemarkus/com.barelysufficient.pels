# Budget diagnostics history API

Two authenticated app API reads expose recorded evidence for daily-budget analysis:

```text
GET /diagnostics/budget/days?from=2026-09-01&to=2026-10-03
GET /diagnostics/budget/decisions?from=2026-09-01&to=2026-10-03
```

`from` and `to` are required, inclusive local calendar dates. A request may span
at most 366 dates. Invalid dates, reversed ranges, and `homeId` are rejected.
The data belongs to the weather owner's whole-home meter scope; it cannot be
relabelled as a selected sub-home. Call through Homey's authenticated app API,
with these paths relative to the app API base.

Both responses contain `meta` and `records`. Metadata includes schema version,
read time, hub timezone, requested range, retained range, and `missingDates`.
The retained range describes the first and last retained record, not guaranteed
continuous coverage. A missing date means no record exists, not zero consumption
or zero denial. Daily records retain their quality flags, temperature sample
counts, and optional values; unavailable kWh or suppression evidence remains
absent in JSON. Request ranges use calendar dates, so DST days are included once.

## Daily records

The days endpoint serves the persisted `WeatherDailyRecord` evidence from
`weather_history_days`: temperature, actual total/managed/background energy,
applied budget when recorded, quality flags, and suppression counters. It also
returns `currentBudgetPressure`, explicitly current rather than a historical
pressure value. Persistence may lag collection by the collector's debounce.

`meta.meterScopeSignature` identifies the current retained weather scope. A
meter-scope change strips old energy evidence while retaining temperature
history, so inspect quality flags before comparing those records.

Limits of interpretation:

- `appliedBudgetKwh` is the setting read at day close, when available. It is not
  a time-weighted budget and does not reconstruct manual changes within a day.
- `budgetDeniedKwh` is expected power integrated over recorded unmet-demand
  spans. It does not subtract later catch-up and is gated off when the budget
  reaches sustainable daily capacity. It is not permanently unserved energy.
- Backfilled days have no live suppression evidence. Missing evidence must not
  be classified as an undamaged day by an external analysis.
- Existing daily records alone do not establish physical temperature recovery,
  task success, or which cheaper hours actually received shifted load.

## Advice decision records

The decisions endpoint serves a new SQLite journal, `budget_advice_decisions`.
Recording begins with this version; older predictions are not reconstructed
using today's model. It retains the most recent 730 decision attempts. Multiple
attempts for one target day remain separate and ordered by insertion, so a skip
followed by a later apply does not erase the earlier prediction.

Each record carries its own meter scope and the recorded prediction, prediction
band, forecast source/temperature, computation and decision times, suggested
budget, prior budget, pressure accumulator and its through-date, pressure's
contribution after clamps, sustainable daily energy ceiling, and fit pseudo-R²
and usable-day count. A null budget or model value is unknown, not zero.
The ceiling uses the target day's actual 23/24/25-hour length.

`outcome` is one of:

- `applied`: the auto-apply succeeded. `budgetAfterKwh` is read back from the
  budget owner, preserving setting rounding; null means no readback was available.
- `would_lower_while_limiting` (historical only): the old pressure accumulator prevented lowering.
- `auto_apply_off`: advice was available but the owner opted out of auto-apply.
- `budget_disabled_or_unavailable`: the apply seam declined the write or was unavailable.

A day already successfully applied is not applied or journaled again. No entry
is manufactured when weather advice is disabled or no suggestion exists.
Decision metadata leaves the scope null because individual records can span
meter arrangements; group by each record's `meterScopeSignature` instead.
Journal failures are logged and do not stop budget application or Flow notification.

To evaluate forecast error, use the recorded `computedAtMs` and a consistent
issuance cutoff, then compare against that day's reliable actual kWh. Normal
rollup advice is computed about five minutes after the target day starts; it
is a day-start forecast, not strictly a prediction issued the previous day.
Late boot catch-up advice must be identified separately and must not be scored
as if it had existed at day start. Compare prediction accuracy, budget slack,
and demand outcomes separately; matching consumption to a tight budget does not prove
that demand was served.


Feedback version 2 adds `suppression.budgetUnservedKwh` for pending,
budget-attributed heater demand after physical recovery accounting. Older rows
lack this field; do not substitute their cumulative `budgetDeniedKwh`.
`would_lower_while_limiting` remains a readable historical journal outcome;
new decisions allow decreases and no longer emit it. Budget pressure state
carries `algorithmVersion: 2`; the old cumulative-hold accumulator is discarded.

New advice decisions carry `budgetAlgorithmVersion: 2`; older journal rows keep the field absent.
