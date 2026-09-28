# Planner

`lib/plan/` turns resolved power, device, price, and budget facts into a `DevicePlan`. `lib/executor/` converges observed state onto that decision. `planService.ts` owns rebuild orchestration; `planBuilder.ts` assembles the decision; `shedding/`, `restore/`, `admission/`, and `swap/` own their respective choices. Read `shedding/AGENTS.md` when changing selection there.

## Input and ownership

- The planner consumes `PlanInputDevice` facts from `lib/planInput/`, without reading Homey or reinterpreting source evidence. It must not import objectives, executor, or thermostat modules. The allowed device producer seams and architecture guards are in `.dependency-cruiser.cjs` and `npm run arch:grep`.
- Only metered devices carry `currentDrawKw`. A temperature device without a per-device reading still receives temperature planning, but does not participate in power sums, shedding, restore admission, swaps, reserves, or surplus decisions. Do not fabricate zero draw. Use `isMeteredPlanDevice` and `isPlannableDevice` for their distinct questions.
- Temperature direction and setpoint arithmetic belong to `lib/thermostat/`. The planner uses resolved `TemperatureSetpoints` and compares setpoints only for equality.
- Do not add an EV-specific plan-device cluster. Boost is a kind-free `boostActive` decision. `PlanInputDevice.stateOfCharge` remains available to deferred-objective progress; changing that input requires tracing its actual consumer.
- Capacity control uses the selected tariff period (`CapacitySettings.periodMinutes`, 15 or 60). Daily budgets, price, usage history, and smart-task allocation remain hourly. A partial first/reset quarter is not favourable capacity evidence. See `notes/capacity-periods.md`.

## Decisions and rebuilds

- A whole-home meter reading normally triggers a rebuild. A device observation changes input and may clear a throttle, but does not trigger a rebuild or reapply a committed plan. `PLAN_REBUILD_TRIGGERS` in `planRebuildTrigger.ts` is the trigger record. An executor action follows a newly decided plan, not an apply-without-decide path.
- `lib/power/` resolves meter trust. The ordinary builder receives measured power, never a stale label or sentinel value. `SilentMeterPlanBuilder` takes an explicit fail-closed directive and sheds candidates to their floor once when the power owner escalates. `planBuildGate` blocks later rebuilds until a new reading. Display freshness stays outside planner context.
- Shedding selects devices only in `shedding/`. Plan materialization copies decisions; it does not invent new selection. Shed cooldown is at least 60 seconds; restore cooldown is 60–300 seconds.
- Deferred-objective decoration can change numeric admission inputs but cannot select other devices or produce actuation intent. `forceShedSet` is the narrow contract for a smart task to hold its own device off during a deferred hour. A reserve may prevent another device's restore, and its release needs evidence from its holder rather than an unattributable whole-home sum. See `notes/deferred-load-objectives/preemptive-power-reservation.md`.

## Terminology: the safe-pace family

`notes/safe-pace-two-constraints.md` defines canonical pace, limit, and exempt quantities. Read it when naming or comparing them. Capacity pace and budget pace use different power axes and require an explicit exempt-load rebase. The build alone stamps period fields through `PlanBuilder.stampCapacityPace`; other readers use the side-effect-free `computeDynamicSoftLimit`.
