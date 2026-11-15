# Capacity periods — hourly and quarter-hour control

**Status:** design of record. Owner ruling 2026-09-17.

The hard cap is an average-power ceiling over a tariff measurement period. PELS
supports two periods per home:

- `60` minutes, the existing default for hourly capacity tariffs;
- `15` minutes, for quarter-hour peak tariffs (Belgium's capacity tariff, and
  15-minute peak tariffs in other markets).

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

A quarter does not burst. Its safe pace is the burst rate (energy left over
time left) capped at the sustainable rate, hard cap minus safety margin. Energy
saved early in a quarter is not spent later in it, so the margin is the buffer.
The hourly end-of-hour drain does not carry over: scaled to a quarter it would
last about a minute, shorter than the shed and restore cooldowns, and in a live
run it let the house step a heater up with 1.6 minutes left and then shed three
devices in the final 30 seconds, every quarter (owner ruling 2026-09-19). The
burst rate still binds below the cap, so a heavy start is recovered within the
quarter. A period boundary starts a new allowance. Prices are a
separate timeline: a Homey price may change every quarter regardless of which
capacity period is selected.

## Reporting rule

For a 15-minute home, Limits & safety reports the highest completed quarter's
average kW in the current Homey-local month. The in-progress and partially
tracked quarters are omitted. This is tracked operational evidence, not a bill
estimate: grid-operator minimums and rolling multi-month billing formulas are
deliberately out of scope.

A meter that reports its own month peak raises it: the month peak is the higher
of the tracked one and the meter's (`resolveCurrentMonthCapacityPeak`), so a peak
set while PELS was not running still counts, and the readout says `Reported by
your meter.` when the meter's value is the higher. Recognising the capability is
the meter integration's job (`DeviceAdapter.meterMonthlyPeak`; the HomeWizard P1
publishes `measure_power.montly_power_peak` in W). The Homey Energy poll reads
each home's meter at most once a minute into `lib/power/meterMonthlyPeak.ts`, in
memory and keyed by meter. The read runs in the background, one at a time, and
never holds the poll's samples, which use the last accepted peak until it lands.
A failed or malformed read keeps the last accepted
peak, and a value Homey last dated in an earlier local month is not this month's,
so after the 1st the meter counts again once it reports in the new month. A home
on the Flow source has no meter peak.
