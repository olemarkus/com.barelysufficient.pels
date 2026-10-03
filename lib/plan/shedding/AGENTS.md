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
- A reading that does not yet show a shed's relief is not evidence for deeper shedding. For 30 s after each device's shed was decided, `pendingRelief.ts` credits the relief that decision banked: in full while the device's own meter shows it still drawing above the decided state, and until the whole-home reading has fallen by half of it once delivered. Held devices stay at their decided rung, and only the residual is shed. A held stepped device is priced net of its undelivered relief, never from the meter alone. Each decision keeps its own stamp, so a later residual shed never extends an earlier one, and a held device chosen again is restamped only once it has delivered what it was already asked for; an older unconfirmed command banks nothing and escalates. A device that leaves the snapshot drops out of the credit. A same-sample rebuild holds decisions in their window and adds nothing. Use `PlanEngineState.shedPlanLatch`, not the final plan's merged shed set, for this module's own credit. This is bookkeeping about the planner's decisions, not settle: it reads no tolerance or timing off a device.
- The whole-home sum cannot tell a lagging meter from a new load that masks a delivered shed, and a device meter that lags its own off reads as undelivered, so in both cases a new load is under-answered until the window ends. That is accepted: under an hourly-average cap it costs a few watt-hours, while cutting the next device costs comfort or charge.

## Declining to shed is not deciding there is no overshoot

- `shedActionable` controls whether this cycle selects new devices. `actionable` controls the shedding-active latch. When selection is deferred but overshoot remains, keep the latch active so already limited devices do not resume into the breach. An empty new `shedSet` is not a release decision.

See `notes/state-management/actuation-clocks-and-settle.md` for timing and `lib/plan/AGENTS.md` for planner-wide boundaries.
