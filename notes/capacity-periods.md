# Capacity periods — hourly and Belgian quarter-hour control

**Status:** design of record. Owner ruling 2026-09-17.

The hard cap is an average-power ceiling over a tariff measurement period. PELS
supports two periods per home:

- `60` minutes, the existing default for hourly capacity tariffs;
- `15` minutes, for Belgian quarter-hour peak tariffs.

The setting is home-scoped. Existing installs and homes without a saved value
resolve to 60 minutes, so the change is backward compatible.

## Control rule

The hard-cap and safe-pace energy allowances scale with the period. A 5 kW cap
is 5 kWh in an hour and 1.25 kWh in a quarter. Power samples continue to accrue
into hourly history. Separately, the tracker holds only the active aligned UTC
quarter and the current local month's completed-quarter maximum; the planner
reads the active quarter when 15-minute control is selected. The daily budget,
smart-task schedule, Usage charts, and price planning stay hourly.

A quarter is eligible for control and reporting only after the tracker has
covered it from its boundary. Startup, reset, and meter gaps therefore never
turn a partial quarter into a favourable complete reading: control begins
conservatively, and monthly reporting waits for the next fully tracked quarter.

The end-of-period drain uses the same shape as the hourly controller, scaled to
the shorter window. A period boundary starts a new allowance. Prices are a
separate timeline: a Homey price may change every quarter regardless of which
capacity period is selected.

## Reporting rule

For a 15-minute home, Limits & safety reports the highest completed quarter's
average kW in the current Homey-local month. The in-progress and partially
tracked quarters are omitted. This is tracked operational evidence, not a bill
estimate: grid-operator minimums and rolling multi-month billing formulas are
deliberately out of scope.
