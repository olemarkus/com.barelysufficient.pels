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
Battery-driven export is excluded.

`lib/planInput/continuousBatteryHorizon.ts` projects published import/export price
periods, selected solar forecasts, battery observations, house limits and existing
smart-task commitments. It splits partial periods and uses actual UTC durations.
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

The configured wear allowance is bound to its electricity price unit. Switching
units cannot silently reinterpret its value. The form starts an unbound wear
allowance at zero and explains that zero ignores wear.

## Execution

Continuous planning is opt-in for one drivable main-home battery. Managed,
Power-limit control, membership, observation trust, simulation, manual takeover
and nonresponse protections still apply. The storage lane retains a continuous
claim at zero power between charging windows. Disabling the plan releases that
claim; existing limit and solar-sharing decisions continue to use their own
policy.

Economic charging is capped by measured available power and the priority solar
offer. Extra capacity relief is selected in the existing priority walk. The
configured reserve also bounds capacity discharge. Economic discharge is bounded
by the house's measured demand and is withheld from admission, so it never creates
room for unrelated restores. A capacity hold returns directly to continuous
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
