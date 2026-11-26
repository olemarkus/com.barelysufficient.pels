# Planner

`lib/plan/` turns resolved power, device, price, and budget facts into a `DevicePlan`. `lib/executor/` converges observed state onto that decision. `planService.ts` owns rebuild orchestration; `planBuilder.ts` assembles the decision; `shedding/`, `restore/`, `admission/`, and `swap/` own their respective choices. Read `shedding/AGENTS.md` when changing selection there.

## Input and ownership

- The planner consumes `PlanInputDevice` facts from `lib/planInput/`, without reading Homey or reinterpreting source evidence. It must not import objectives, executor, or thermostat modules. The allowed device producer seams and architecture guards are in `.dependency-cruiser.cjs` and `npm run arch:grep`.
- Only metered devices carry `currentDrawKw`. A temperature device without a per-device reading still receives temperature planning, but does not participate in power sums, shedding, restore admission, swaps, reserves, or surplus decisions. Do not fabricate zero draw. Use `isMeteredPlanDevice` and `isPlannableDevice` for their distinct questions.
- A managed binary device awaiting its first power information remains visible as Manual, with its setup requirement. Without a power reading it produces no executable binary command, including an uncontrolled resume. Explicit last-resort relay control admits a trusted OFF under the shared external-off policy. The first eligible relay in Modes order holds ordinary restores while it waits to clear the full configured maximum and restore buffer. A relay whose buffered maximum is above the highest rate admission can ever offer (`resolveAdmissionPowerCeiling`: the grid import target, and the sustainable rate only in 15-minute periods) fits only while export makes room, so it gets no priority turn, starts only when measured room covers it without a swap, and otherwise carries `lastResortAboveLimit`. This maximum is a reservation and never contributes to per-device consumption or relief. After a device power reading appears, the last-resort path only finishes undoing a confirmed PELS OFF on the current binding.
- Temperature direction and setpoint arithmetic belong to `lib/thermostat/`. The planner uses resolved `TemperatureSetpoints` and compares setpoints only for equality.
- Do not add an EV-specific plan-device cluster. Boost is a kind-free `boostActive` decision. `PlanInputDevice.stateOfCharge` remains available to deferred-objective progress; changing that input requires tracing its actual consumer.
- Capacity control uses the selected tariff period (`CapacitySettings.periodMinutes`, 15 or 60). Daily budgets, price, usage history, and smart-task allocation remain hourly. A partial first/reset quarter is not favourable capacity evidence. See `notes/capacity-periods.md`.

## Decisions and rebuilds

- Emit executable decisions through `planExecutionProjection.ts` into `ExecutionPlan`. Keep selection here and command lifecycle in execution. Read execution facts through readonly ports; apply execution feedback through `PlanExecutionFeedback`, without exposing mutable planner state. The named historical step baseline must stay separate from desired commands and live observations.

- A whole-home meter reading normally triggers a rebuild. A device observation changes input and may clear a throttle, but does not trigger a rebuild or reapply a committed plan. `PLAN_REBUILD_TRIGGERS` in `planRebuildTrigger.ts` is the trigger record. An executor action follows a newly decided plan, not an apply-without-decide path.
- The published plan is what a build decided. Between builds it may gain pending-target decoration (`pendingTargetCommand`), never device inputs; its binary and step pending flags stay as of the build. The raw `PlanInputDevice` predates admission, so merging it onto a plan pairs the plan's decisions with a posture they were not made under (a smart task's command authority is the case that broke). A reader that needs a current reading asks the observer or executor at read time, as `settingsOverviewReadModel.ts` does.
- `lib/power/` resolves meter trust. The ordinary builder receives measured power, never a stale label or sentinel value. `SilentMeterPlanBuilder` takes an explicit fail-closed directive and sheds candidates to their floor once when the power owner escalates. `planBuildGate` blocks later rebuilds until a new reading. Display freshness stays outside planner context.
- A driveable Main-home battery with Managed and Power-limit control on follows PELS's setpoint policy throughout normal operation. Without a current price plan, it charges from measured solar allocated at its priority and otherwise idles. A battery is a ranked limiting candidate: max charge → 0 W → max discharge, so devices ranked below it are limited first. It is never in `shedSet`. Selection carries `storageSetpoints` into a limit hold. The restore lane resumes managed operation in priority order using available power after withholdings. Restore and admission cannot spend battery discharge or room already allocated to charging. In the surplus pool, measured battery charge that PELS can free is available to devices ranked above it. The battery reserves its allocation at its own priority and its discharge never supplies the solar pool. Managed off, Power-limit control off, and safety releases end the claim. The battery owner recovers compatible persisted claims on restart without a routine hand-back.
- Shedding selects devices only in `shedding/`. Plan materialization copies decisions; it does not invent new selection. Shed cooldown is at least 60 seconds; restore cooldown is 300–600 seconds, and the ordinary 300-second wait can end early once every restored device has started drawing from idle, or a running stepped device's draw has risen after its step-up, and a whole-home value measured after that draw is in (`restore/timing.ts`).
- Deferred-objective decoration can change numeric admission inputs but cannot select other devices or produce actuation intent. `forceShedSet` is the narrow contract for a smart task to hold its own device off during a deferred hour. A reserve may prevent another device's restore, and its release needs evidence from its holder rather than an unattributable whole-home sum. See `notes/deferred-load-objectives/preemptive-power-reservation.md`.

## Pressure persistence

`PacingGrace` owns discretionary waiting and its per-period expenditure. It
allocates half the configured period margin and requires the observed
trajectory to retain the other half as response reserve. A new pressure episode
never refills the allowance; the first partial period after restart cannot
open one. Grid pressure, projected actual-cap pressure, exhausted allowance,
and period-end control bypass waiting. Activation attribution remains a
restore-penalty input, not a permission to ignore background-driven transients.
See `notes/slow-response-control.md` for sampling assumptions and regressions.

## Terminology: the safe-pace family

`notes/safe-pace-two-constraints.md` defines canonical pace, limit, and exempt quantities. Read it when naming or comparing them. Capacity pace and budget pace use different power axes and require an explicit exempt-load rebase. The build alone stamps period fields through `PlanBuilder.stampCapacityPace`; other readers use the side-effect-free `PlanBuilder.computeCapacityPace` (the capacity axis) or `PlanBuilder.computePhysicalPowerLimit` (the lower of the capacity pace and the grid import target).
