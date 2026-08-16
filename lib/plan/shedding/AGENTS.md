# Shedding Planner Boundary

Shedding selection belongs in `lib/plan/shedding`; `planDevices.ts` materializes decisions and must not select new shed devices.

Keep this module as the single place that chooses devices for capacity, daily-budget, or hourly-budget shedding. Plan materialization may copy `shedSet` and `shedReasons`, but it should not independently set a device to `plannedState: 'shed'` as a new selection decision.

The shedding planner decides what to shed, not how to actuate it. Keep step and temperature target projection outside this module; those are materialization or executor concerns for devices already present in `shedSet`.

## Module layout

- `candidates.ts` — the collect loop and the candidate ranking. Nothing else.
- `candidateBuilders.ts` — binary + temperature builders, and the two eligibility predicates.
- `steppedCandidates.ts` — every stepped builder, plus the ladder descent that picks WHICH rung a shed aims at.
- `candidateSkipLog.ts` — why a controlled device did not become a candidate.
- `selection.ts` — the greedy pick over the ranked candidates.

## A device may only be selected when limiting it releases power

Every selection site here already enforces it — `buildBinaryCandidate`, `buildTemperatureCandidate`, `buildSteppedCandidate` and `buildPreparedSteppedBinaryOffCandidate` all reject a candidate whose `effectivePower <= 0`, and `buildSwapCandidates` skips `pwr <= 0` the same way. Keep it that way.

Shedding a device already drawing nothing frees nothing, but it still costs a write and then makes the device fight back through restore cooldown and backoff. The one lane that ignored this (`pauseHold.ts`, deleted) turned off ten zero-draw devices in production on 2026-07-31 while 2.48 kW sat available. Needing a device to stay off *pre-emptively* is not a shed decision — express it as an admission term instead (`lib/plan/admission/headroomReserve.ts`).

## …but ask the whole ladder, not just the next rung

The rule above is about the ANSWER, not about how hard you looked for it. For a stepped device the two got conflated: `getSteppedLoadShedTargetStep` returns one rung down, and pricing only that rung made "this rung frees nothing" read as "this device frees nothing".

`resolveSteppedLoadImmediateReliefKw` caps *both* sides of the step delta by the current measurement, so the moment measured draw sits at or below the next rung's admission estimate the delta is exactly zero — for any from-step. A device pinned at `max` and one idling at `low` price identically. Prod 2026-08-05 (`inc_26449fb9`): a water heater's `measure_power` lagged its step-up by ~5 minutes, `max → medium` priced at 0, the heater was never a candidate, and the house sat 526 W over the hard cap for 4.5 minutes while the meter showed it drawing 2.9 kW.

`resolveSteppedShedRung` (`steppedCandidates.ts`) walks the ladder and returns the **gentlest rung that actually releases power**. It cannot invent relief — every rung is priced by the same `resolveSteppedCandidatePower`, so the answer stays bounded by the meter. Two constraints on the descent:

- **Credited relief must not exceed delivered relief, so only `turn_off` descends.** The planner does not get to name the step the executor commands: materialization recomputes it from the device alone (`resolveSteppedLoadDirectShedStepId`, reached from `planDevicesBase`), and the candidate's `toStepId` never crosses over — only `shedSet` membership does. For `turn_off` that resolver answers the off step, so any credited rung under-states what the executor actually frees. For `set_step` it answers the ADJACENT rung, so crediting a deeper one would decrement the deficit by a step-down that is never commanded, mark the breach covered, and skip the device that could have helped — strictly worse than offering no candidate. Lift this only if materialization starts honouring the planner's chosen target.
- **Gentlest, not deepest.** Stop at the first rung with positive relief. Taking the largest would over-shed every device whose adjacent rung already works.

Related: `preemptiveStepDown` reads the chosen TARGET, not just the from-step. A descent that lands on the off step is a full turn-off, and `sortCandidates` is explicit that those follow normal priority ordering — marking one preemptive would sort it ahead of every other candidate and then stop the selection loop (`shouldStopAfterCandidate`) with the deficit still open.

## A skip must be reviewable

Candidate gathering has a dozen exits that drop a device. Each one records a reason through `candidateSkipLog.ts`, rolled up into one `plan_shed_candidates_skipped` event per cycle and counted onto `OvershootStats`. Do not add a bare `continue` / `return null` to the collect loop or the builders without a reason code.

This exists because the counters in `hard_cap_shortfall_detected` cannot answer the question: `blockedByCooldownDevices`, `blockedByPenaltyDevices` and `blockedByInvariantDevices` are all RESTORE-side holds (`lib/planContract/planDecisionSemantics.ts`). All three read zero through the incident above, which made "nothing was blocking" look like a finding when the truth was "the one device that mattered was never a candidate". Devices that are not controllable at all are out of scope rather than skipped, and are deliberately not recorded — matching `controlledDevices` in the capacity summary.

## An unchanged reading is not new evidence

Whole-home power lags the switch: the meter aggregate (and the 10 s `homey_energy` poll behind it) can repeat the pre-shed watts for a poll or two after a device is confirmed off. A repeat is a re-delivery of the reading the last shed was already decided on, so `resolveSameMeasurementSheddingDecision` refuses to deepen on it for a short hold (`UNCHANGED_READING_SHED_HOLD_MS`, `overshoot.ts`) — otherwise the planner cuts into devices the user ranked higher for a deficit the previous shed already covered. Equality is exact so that any real movement, in either direction, is still acted on at full speed, and the hold releases early if the deficit itself grows (a tightened soft limit is a new question, not a re-delivered answer). Do not remove the hold to make shedding "more responsive": the deficit it protects against is imaginary.

A held cycle re-asserts the shed this module itself decided (`lastShedPlanShedIds`) and adds nothing. It must never re-derive that set from the FINAL plan's shed set (`lastPlannedShedIds`), which carries holds merged in after this module ran; handing one of those a capacity shed reason mislabels it and clamps unrelated stepped loads. Its window is anchored on `lastShedPlanAtMs`, not the overshoot mitigation clock, because `PlanBuilder` runs shedding *before* `OvershootTracker.updateOvershootState` nulls that clock on overshoot entry.

## Declining to shed is not deciding there is no overshoot

`buildSheddingPlan` takes both halves of the soft-overshoot decision (`SheddingOvershootInput`). `shedActionable` gates SELECTION — may this cycle choose devices. `actionable` gates the shedding-active LATCH through `updateGuardState`. Never collapse them back into one flag.

The whole restore side stands down while headroom is negative, on the assumption that this module has already said what stays limited: `resolveOffDeviceReason` returns the caller's own reason on `activeOvershoot`, `resolveCapacityRestoreBlockReason` returns `null`, and `applyRestorePlan` reaches its stay-off marking through `sheddingActive`. So a cycle that both selects nothing *and* leaves the latch off has nothing at all holding a device that is already off — it materializes as `keep`, and the executor turns it on. That is the 2026-08-16 restore-all: the shed grace (`resolveShedGraceMs`) deferred a shed, the latch went with it, and five thermostats came back on into a hard-cap crossing. Regression cover: `test/integration/planShedGraceHoldsExistingShed.test.ts`.

The general form: an empty `shedSet` this cycle means "nothing NEW to limit", never "release what is limited". Any future reason to withhold selection has to keep saying the overshoot is real.
