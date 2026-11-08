# Continuous battery plan prototype

The battery owns an ongoing energy plan. The device page enables it and shows its
trajectory and charge, wait, solar-storage and household-supply periods. The
existing meter-driven planner decides the executable setpoint; the existing
battery executor and actuator claim, command, verify and hand back the battery.
There is no second actuation loop and no daily battery smart task.

## Economics and inputs

`lib/battery/planning/planBatteryEnergy.ts` minimizes import cost minus export
income plus a wear allowance and the value of energy retained after the known
horizon. Its dynamic program uses 200 stored-energy intervals plus exact initial
and reserve states. It is optimal over those represented states, not a claim of
continuous or forecast-perfect optimality. Both AC conversion directions use the
square root of round-trip efficiency. Wear is charged per AC kWh supplied.
Charge power follows the taper the battery has shown: the verification ledger
(`batteryVerification.ts`) learns where a charge stopped short per 5 % band
from 80 % up (below 80 %, or without a reported level, the lesson applies at
every level). Live control caps charge by the band of the current level for 30
minutes. The plan keeps a band's lesson for a week, until it is re-taught or a
charge past it lifts it, since it charges hours ahead; the lessons are in
memory and a restart relearns them. While the plan runs, live control asks for
no more than the plan does, so a planned lesson is rarely lifted and mostly
waits to be re-taught or to expire. So the plan keeps a taper only once a
second plateau confirms it: the band taught again within the setpoint's
tolerance of the plateau before it, either way, within the week. A plateau is
judged on one fresh reading 90 s after the step, and a battery that ramps
slower than that stops short once without tapering. A plateau unlike the one
before it leaves the plan's taper as it was: a lower one waits for its own
confirmation, and a higher one, a charge past the taper, lifts it. Live control
holds the latest plateau for its 30 minutes either way, then asks for full
charge again, which lifts it or teaches it again. A lesson
where the battery took no charge at all (full, or at its own limit) is a stop,
not a taper: live control holds it, and the plan never keeps it, or a battery that
stopped at 100 % would never be charged from 95 % again that week. The
horizon carries these as stored-energy steps, and each transition's charge is
capped by the steps at or below the energy it starts from, so a battery that
slows near full starts charging earlier.
Battery-driven export is excluded unless the owner opted in to selling; see
[battery export](./battery-export-arbitrage.md#implementation).

The hidden [export economics evaluation](./battery-export-arbitrage.md#hidden-economic-evaluation)
compares a hypothetical export schedule with the household plan at equal terminal
energy for a household-only battery. It emits sampled diagnostics under the
existing `plan` debug topic; for that battery the household plan remains the only
public and executable schedule. Quote coverage,
sampling and a conservative search-work budget govern whether a comparison runs.
These estimates are independent forecast snapshots, not accumulated profit.

`lib/battery/continuousBatteryHorizon.ts` builds the horizon from published
import/export price periods, selected solar forecasts, battery observations, the
house power limits (through the shared planning-ceiling arithmetic) and existing
smart-task commitments; setup passes those owner reads in as ports. The battery owner also decides the reserve's
discharge ceiling (`continuousBatteryReserve.ts`), which planner input copies. It splits partial periods and uses actual UTC durations.
The economic energy booked by a smart task is distinct from its physical power
reservation: a final hour requiring 0.5 kWh at a 7 kW step still needs only 0.5 kWh,
while its booked power limits simultaneous battery charging.

`lib/battery/batteryDemandForecast.ts` learns non-battery background demand from
the main meter's net power, simultaneous solar, signed battery power and accepted
managed-device draw. Known managed draw is modeled separately. The prototype
keeps a bounded local-hour profile in memory, and forecasts unobserved hours from
recent measured background. It relearns after restart. Standing managed devices
use their current observed draw as a persistence forecast; smart-task devices use
their booked energy. Missing observations skip learning and retain the accepted
model. A solar home without a usable forecast waits; resolved absence of solar
means zero production.

Paused tasks outside the current Main-managed roster reserve no energy or power.
The demand and horizon owners share one solar-scope read: no Main panels means
zero Main generation, even if another meter area produces solar. If both Main
and another area have panels, the aggregate cannot resolve Main's share;
planning waits and demand learning skips those samples.

`lib/battery/batteryEfficiencyLearner.ts` measures each managed Main-home
battery's round-trip efficiency, whoever drives it. On every Main meter sample
it integrates the battery's own signed power (holding the previous reading over
the interval) and closes a cycle when the reported level re-enters the percent
the span started on, from the same direction, after travelling at least 20
percentage points. Equal level at both ends makes AC out / AC in the round trip,
independent of the configured capacity, and entering from the same side keeps
both ends on the same rounding boundary. A missing or unavailable reading, a
meter-sample gap over five minutes, a nonzero power reading older than fifteen
minutes or a span over 72 hours abandons the cycle in progress; results outside
60-100 % are rejected. The last five accepted results persist per battery in the
userdata store (built in `setup/appInit/batteryMeterLearning.ts` behind the
`lib/ports/batteryEfficiencyStore.ts` port); after three, the device page offers
their median beside the efficiency field. Use fills the field and the owner
saves it as any edit: the plan reads only the configured value.

The configured wear allowance is bound to its electricity price unit. Switching
units cannot silently reinterpret its value. The form starts an unbound wear
allowance at zero and explains that zero ignores wear.

## Several batteries

Each drivable Main-home battery opts in on its own page. The battery owner
(`ContinuousBatteryPlanService`) plans every enabled battery together, as one
memo published at once, so no battery's plan outlives the inputs of the ones
it depends on:

- `readHorizons` reads every battery at one instant. All ready horizons share
  the same periods; without a power limit the synthetic import ceiling is what
  all of them charging at once could draw.
- The batteries plan one after another in the owner's priority order
  (`orderByPriority`, highest priority first), each with its own unchanged
  dynamic program, economics, taper and export policy. A battery that waits
  (unreadable, no control) waits alone; the others plan without it.
- Each period carries what the batteries before it move (`otherStorageKWh`,
  part of net demand) and its charging room is what they left. A battery may
  not supply while they charge, or charge while they supply, so no battery
  feeds another, and a household-only battery's discharge allowance is the
  house's demand after their supply: it never supplies more than the house
  uses, so never into a sale planned before it. A seller later in the order
  may still sell while an earlier household-only battery covers the house.
- A period a battery holds or supplies may leave import above the limit for
  the batteries after it, up to their summed discharge (`laterSupplyKW`), at
  a penalty that ranks routes only: the battery covers what it can first, and
  its reported costs exclude the penalty. A charge never uses that room. The
  last battery plans against the limit alone, so a single battery plans
  exactly as before. The earlier battery leaves only what it cannot cover at
  all: the penalty makes it charge ahead for an over-limit period when it can.
  A later battery that cannot cover all it was left (its stored energy ran
  short, not just its power) plans again with the same allowance, covering
  what it can; the rest stays on the grid for power-limit control. The first
  battery alone still waits `horizon_infeasible` as before.
- A kept sale is decided again when the direction of the earlier batteries in
  any period changes (`exportEconomicsKey`). Within a direction it keeps its
  plan while their amounts move, as it does for live device draw; the storage
  lane bounds each command by measurement.
- Batteries that sell share `FleetExportTerms`: the Main-meter export
  ceiling is the lowest any selling battery's owner set, in the plan and in
  live control (the sale carries it in its `selling` decision; each owner's
  saved value is unchanged), and the export comparison's work bound
  (`MAX_EXPORT_COMPARISON_TRANSITIONS`) is shared, so several selling
  batteries cost no more comparison work than one. A battery past it keeps
  its household plan and says selling waits (`evaluation_budget_exceeded`).

The order is a heuristic, not a joint optimum: the earlier battery takes the
first opportunities, and identical batteries do not share work evenly.

## Execution

Continuous planning is opt-in for each drivable main-home battery. Managed,
Power-limit control, membership, observation trust, simulation, manual takeover
and nonresponse protections still apply. The storage lane retains a continuous
claim at zero power between charging windows. Disabling the plan releases that
claim; existing limit and solar-sharing decisions continue to use their own
policy.

Economic charging is capped by measured available power and the priority solar
offer. Extra capacity relief is selected in the existing priority walk. The
configured reserve also bounds capacity discharge. Economic discharge is bounded
by the house's measured demand and is withheld from admission, so it never creates
room for unrelated restores. A selling period (`export_energy`) may add Main
export up to the owner's ceiling and earns no settling credit.

The plan follows the solar forecast, not the meter, so a supply or hold period
can meet solar it did not expect. Each plan period carries the battery owner's
answer to whether such solar is worth storing (`storesSurplus`): its export
earns nothing (unpriced or negative), or less than the plan's value of the
energy it would store (the terminal value per usable kWh after charging loss).
When it is, live control charges the battery from the measured export its
priority offer leaves, after what the devices ranked below it take, within its
charge ceiling and the measured headroom, and under the deadband it waits
(`absorbedExportW`, `lib/plan/battery/storageContinuous.ts`). This only ever
adds charge: the house's own import is still supplied first, and a supply or
hold period never discharges into the export. Otherwise the battery waits and
the solar is exported. The stored energy shows up in the next reading of the
battery's level, from which the plan is made again.

With several batteries, a battery that delivers less than its plan asks
hands its share over through the plan, not through a second live rule. Live
control holds it to what it shows it can deliver (the lagging-reading bound
and the verification's learned delivery ceiling, `batteryVerification.ts`);
that ceiling is the horizon's `maxDischargeKW`, so the next plan gives the
rest of the house to the batteries after it, typically within a few minutes
of the plateau. A battery verification judges `not_responding` or
`sign_inverted` waits `control_unavailable`, so the others plan for the house
without it until its reprobe; one PELS cannot read waits
`battery_unavailable` the same way.

A capacity hold returns directly to continuous
planning after its ordinary resume admission, without a native-mode pulse.

Inverter curtailment waits while a newly planned battery charge has not reached
the storage owner's observation tolerance. Once the charge is observed, the
inverter controller may curtail the remaining export. Returning inverter control
or increasing available production remains executable during this wait.

The future trajectory describes the economic plan. Measured demand and the normal
control rules may reduce a current setpoint; Overview continues to report actual
observed activity. Unknown or infeasible planning inputs produce a reason on the
battery page rather than fabricated prices, production or consumption.

## Checking the planner

Run the pure planner specs:

```sh
PELS_TEST_WORKERS=1 PELS_PLAYWRIGHT_WORKERS=1 npm run test:unit -- test/unit/batteryEnergyPlan.test.ts
```

They cover the planner under deterministic fixture forecasts. Use the SDK-boundary tests for the actual PELS
command path, including zero-power ownership, reserve protection, no battery
export, permission changes and manual takeover.

The inspected 2.5.119 source has SHA-256
`b9e98fa26bef912c1818b9012d71b1d9a21a3b0e8de665d9f149cc0904cf66d6`.
The prototype comparison produces these modeled objectives, in fixture currency
units, including wear and the same credit for usable energy remaining at the end:

| Fixture | Charging-window replay | PELS |
| --- | ---: | ---: |
| Solar before morning demand | 0.7504 | 0.5566 |
| Solar after morning demand | 0.6053 | 0.3619 |
| Cloudy, uneven cheap prices | 2.0245 | 1.4907 |
| Spread below losses and wear | 2.3304 | 2.0500 |
