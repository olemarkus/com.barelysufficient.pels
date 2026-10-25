# Capacity-period boundary mode (sustainable-rate drain)

Contributor-facing design-of-record for the boundary behaviour of the capacity
safe pace. The configured period is either a clock hour or an aligned
15-minute quarter. Code: `lib/plan/planBudget.ts` (`computeDynamicSoftLimit`).
User-facing description: `docs/technical.md` (“Capacity-period enforcement”).

## What problem it solves

PELS protects an average-power tariff interval: an hour for traditional capacity
tariffs, or an aligned quarter-hour for quarter-hour peak tariffs. The thing to protect is the
selected period boundary: draw that carries across it inflates the new period’s
average from its first instant.

Within an hour the planner lets you **burst** — spend the remaining period
budget at whatever instantaneous rate fits the time left
(`burstRate = remainingKWh / remainingHours`). Left unchecked, that invites a
boundary burst: devices ramp up near the end to use leftover budget, then carry
that high draw into the next period.

## A quarter does not burst

In 15-minute mode the capacity safe pace is `min(burstRate, sustainable)`: it
never rises above the sustainable rate, so there is no boundary burst to drain
and the drain below applies to hourly control only. A drain scaled to a
quarter would last about a minute, shorter than the shed and restore cooldowns,
and in a live run it ended every quarter in a batch shed in the final seconds.
The safety margin is the quarter's buffer. See `notes/capacity-periods.md`
§ "Control rule" (owner ruling 2026-09-19).

## The mechanism: a ten-minute drain to the sustainable rate (hourly)

The goal is that the next hour starts at its target: the house enters `:00` at
or below the sustainable rate, so the new hour does not open over its limit.
Over the last `EOH_DRAIN_WINDOW_MIN` (10) minutes the capacity safe pace
(`allowedKw`, the capacity `softLimit`) falls from what the house drew when the
window opened to that rate at `:00` (owner, 2026-10-25):

```text
sustainable = limitKw - marginKw                               // the next hour's average target
start       = draw and minute of the first measured build at or after :50  // CapacityDrainStart
share(m)    = 1 - expm1((10 - m) / TAU) / expm1(10 / TAU)      // 1 at :50, 0 at :00
ceiling(m)  = sustainable + max(0, start.draw - sustainable) * share(m) / share(start.m)
allowedKw   = m > 10 ? burstRate : min(burstRate, ceiling(m))
```

- **Before `:50`** the budget-driven `burstRate` governs, as it does all hour.
- **At `:50`** the ceiling is the house's own draw, so nothing is limited when
  the window opens. Starting from a fixed level instead would limit every device
  above it at once, which is the cliff this replaced.
- **Through the window** the ceiling falls, cutting least at first and most in
  the final minutes (`TAU = EOH_DRAIN_TAU_MIN = 4`). Devices above it are limited
  one at a time in priority order by the normal shedding lane
  (`lib/plan/shedding`). A house drawing less than the sustainable rate at `:50`
  keeps a flat ceiling at that rate.
- **At `:00`** the ceiling is the sustainable rate.
- **After a restart inside the window**, or with a meter that first reports
  after `:50`, the drain starts at the first measured build's draw and minute
  and falls from there, so it also opens at the house's draw.

| minutes left | 10 | 5 | 2 | 1 | 0 |
|---:|---:|---:|---:|---:|---:|
| share of the starting excess | 1.00 | 0.78 | 0.43 | 0.24 | 0 |
| ceiling, 7.8 kW at `:50`, 4.8 kW target | 7.8 | 7.1 | 6.1 | 5.5 | 4.8 |

Hourly `burstRate` uses the actual time left, without a minimum-time floor. At
exactly `:00`, `getCurrentHourContext` selects the new hour with 60 minutes
remaining, so the hourly divisor never reaches zero. The former ten-minute
divisor floor made a busy hour taper from `:50` below even the sustainable rate
(0.55 kWh left at `:59` became 3.3 kW against a 4.8 kW rate); the drain never
goes below the sustainable rate unless the remaining energy does.

### Nothing new comes on in the drain unless the next hour can hold it

A device turned on or stepped up in the window keeps running into the next hour.
So restore and step-up admission spend only the room under the lower of the
pace and the sustainable rate there (`resolveCapacityAdmissionHeadroomKw`,
applied to the restore ledger's capacity axis), while shedding keeps reading the
falling ceiling. Without this,
a house that dropped below the ceiling (a thermostat resting, a household load
ending) would turn devices on only to limit them again before `:00`: the
restore lab on 2026-10-25 turned two heaters on at −9.7 and −4.7 minutes,
limited them at −1.0 and −0.0, and turned them on again at +0.1.

The rule starts at `:50`, not earlier (owner, 2026-10-25: holding back
increases from `:45` wastes too much of the hour). A device turned on just
before `:50` whose draw only lands after it can still be limited in the window
when the house is then above the falling ceiling.

### Large on/off devices

An on/off device cannot run at part power, and shedding keeps its priority
order. When the next device in that order is a large one, it is limited as soon
as the ceiling has fallen below the house's draw by more than the shedding
deadband, early in the window rather than in its final minutes (owner,
2026-10-25). A single device that alone keeps the house above the sustainable
rate is the plain case: it goes right after `:50`. The next hour then starts
clean; the cost is the leftover allowance it could have used in those minutes. A
stepped device steps down instead, and smaller devices are limited one at a
time.

### Why not the old exponential ceiling

Until 2026-10-25 the ceiling was `sustainable * e^(minutesRemaining / 4)`:
12.2x the sustainable rate with 10 minutes left, 3.5x at 5, 1.28x at 1. In an
under-used hour it bound only in the last two or three minutes. It let devices
come on late (all four lab heaters ran at `:56`, against a 10.7 kW ceiling) and
then pinched so steeply at the end that slow devices still drew across `:00`:
the lab's 14:00 hour opened at 5.35 kW against 4.8 kW, and the house lab cut its
EV charger just after `:00`. A device that takes one to two minutes to apply a
command could not follow it.

### Why not the old cliff

Before that, `minutesRemaining <= 10 ? min(burst, sustainable) : burst` cut
everything to the sustainable rate at `:50` in one coordinated batch. Starting
the drain from the house's draw keeps that from happening.

## Invariants

- **`min(burstRate, …)` is load-bearing.** `burstRate` is the most you can draw
  and still land within *this* period’s budget; the drain may only pull the
  allowance *below* burst, never above. When `burstRate < sustainable`, the `min`
  collapses to `burstRate` and the drain is irrelevant.
- **The drain starts from the house's draw.** The first measured build inside
  the window records its draw and minute (`CapacityDrainStart`, written only by
  the plan build from its reading; the silent-meter pass records nothing). A
  read before then starts from the draw now.
- **The ceiling reaches the sustainable rate at `:00`** and never goes below it.
- **Admission in the window fits the next hour.** Restores and step-ups spend
  only the room under the lower of the pace and the sustainable rate; shedding
  reads the drain ceiling.
- **A quarter's pace never exceeds the sustainable rate.** `min(burstRate,
  sustainable)` from the first minute; the burst rate can only pull it lower.
- **Hourly pacing uses actual remaining time.** There is no hourly divisor floor.
- **The quarter keeps its ten-second divisor floor** (one meter poll), with
  its pace capped at the sustainable rate. A longer floor understates the pace
  in the final minute.

## Daily budget is exempt by design

`computeDailyUsageSoftLimit` does **not** apply the drain (`allowedKw = burstRate`).
It retains its independent ten-minute remaining-time divisor floor.
The daily budget is a soft pacing target with no per-hour grid penalty, so the
planner stays free to make the right call at `23:55`. Only the selected-period
hard-cap side needs boundary protection. See `docs/daily-budget.md`.

## Tests

`test/integration/planBudget.test.ts` covers the drain opening at the house's
draw at `:50`, the budget-driven pace before the window, the fall to the
sustainable rate at `:00` with cuts growing toward the end, a flat ceiling for a
house below the sustainable rate, a drain first seen after a restart, the start
recorded once an hour from a reading, the remaining-energy guard below the drain, a
busy hour that never goes below the sustainable rate, a fresh allowance at
exactly `:00`, a quarter never above sustainable, and the admission headroom in
and out of the window. `test/unit/endOfHourDailyBudget.test.ts` checks the
unchanged daily divisor floor and absence of a drain.
`test/integration/app.test.ts` covers the physical limit through the app
(`computePhysicalPowerLimit`) inside the window: from the draw now before a
build records the start, the remaining budget binding below it, and a house
below the target at `:59`.

`test/e2e/capacityEndOfHourDrain.e2e.test.ts` drives the full SDK-boundary stack
(energy poll → planner → executor → `api.put`) with the faked clock stepped toward
`:00`, using a feedback energy model (the reported home total reflects each
device's commanded state):

- a heterogeneous fleet (on/off + thermostat, distinct priorities) is not limited
  at `:50` and is wound down to the sustainable rate in priority order;
- a single 8 kW device runs until `:50` and is limited once the drain falls below
  it; a Flow-reported reading opens the drain at `:50` and replans the same way;
- the restore lab's 12:00 hour: limited heaters are not turned back on after the
  household load drops at `:50`, and the next hour starts at its target with
  nothing limited at the boundary.

`test/e2e/capacityQuarterPace.e2e.test.ts` is the quarter counterpart: an
under-used quarter whose load jumps above hard cap minus margin at `:08` is
limited within a minute, rather than left running on saved energy until the
burst rate runs out.
