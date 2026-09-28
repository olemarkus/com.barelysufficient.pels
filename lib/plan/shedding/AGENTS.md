# Shedding Planner

`lib/plan/shedding/` is the sole owner of selecting devices to limit for capacity, daily budget, and hourly budget. `planDevices.ts` materializes its `shedSet`, reasons, and step targets; it does not select additional devices. Execution and transport remain outside this module.

## Candidate and step decisions

- Select a device only when limiting it releases measured power. A zero-draw candidate offers no relief and must not receive a speculative shed command. A preemptive need to keep a device off belongs in admission, not shedding.
- For a stepped device, price every reachable lower rung with `resolveSteppedShedLadder`; rejecting the next rung because it frees nothing must not hide a deeper useful rung. `set_step` stops at the deepest non-off-classified rung; `turn_off` may include the off rung. Use `isSteppedLoadOffStep` for that classification.
- `resolveStepChangeKw` is the common price of a step transition. A descent cannot credit more than measured draw. A climb uses the smaller current estimate to avoid understating new commitment. Determine direction from profile order, with an observed-off device at position zero.
- Choose a stepped rung when the ranked candidate is spent, using the deficit still open at that turn. The chosen `shedStepTargets` rung is the delivered rung; materialization does not recompute it. Ranking may use the maximum available relief, but not a rung that has not yet been chosen. Bank relief before asking whether the deficit remains.
- The start-policy hold applies only while Power-limit control is off. Readers of the active policy use `startPolicyInForce`; the stored `startPolicy` records the owner's choice and is used to detect its withdrawal. Power limiting being turned on pauses, rather than erases, that choice.

## Evidence and reporting

- Record a reason through `candidateSkipLog.ts` when a controlled device is excluded from candidate gathering. An uncommandable device is outside candidate scope.
- A repeated whole-home reading after a confirmed shed is not fresh evidence for deeper shedding. `resolveSameMeasurementSheddingDecision` holds the previous shed set briefly; real meter movement or a larger deficit ends that hold. Use `PlanEngineState.shedPlanLatch.shedIds`, not the final plan's merged shed set, for this module's own hold.

## Declining to shed is not deciding there is no overshoot

- `shedActionable` controls whether this cycle selects new devices. `actionable` controls the shedding-active latch. When selection is deferred but overshoot remains, keep the latch active so already limited devices do not resume into the breach. An empty new `shedSet` is not a release decision.

See `notes/state-management/actuation-clocks-and-settle.md` for timing and `lib/plan/AGENTS.md` for planner-wide boundaries.
