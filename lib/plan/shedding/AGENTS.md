# Shedding Planner Boundary

Shedding selection belongs in `lib/plan/shedding`; `planDevices.ts` materializes decisions and must not select new shed devices.

Keep this module as the single place that chooses devices for capacity, daily-budget, or hourly-budget shedding. Plan materialization may copy `shedSet` and `shedReasons`, but it should not independently set a device to `plannedState: 'shed'` as a new selection decision.

The shedding planner decides what to shed, not how to actuate it. Keep step and temperature target projection outside this module; those are materialization or executor concerns for devices already present in `shedSet`.

## A device may only be selected when limiting it releases power

Every selection site here already enforces it — `buildBinaryCandidate`, `buildTemperatureCandidate`, `buildSteppedCandidate` and `buildPreparedSteppedBinaryOffCandidate` all reject a candidate whose `effectivePower <= 0`, and `buildSwapCandidates` skips `pwr <= 0` the same way. Keep it that way.

Shedding a device already drawing nothing frees nothing, but it still costs a write and then makes the device fight back through restore cooldown and backoff. The one lane that ignored this (`pauseHold.ts`, deleted) turned off ten zero-draw devices in production on 2026-07-31 while 2.48 kW sat available. Needing a device to stay off *pre-emptively* is not a shed decision — express it as an admission term instead (`lib/plan/admission/headroomReserve.ts`).

## An unchanged reading is not new evidence

Whole-home power lags the switch: the meter aggregate (and the 10 s `homey_energy` poll behind it) can repeat the pre-shed watts for a poll or two after a device is confirmed off. A repeat is a re-delivery of the reading the last shed was already decided on, so `resolveSameMeasurementSheddingDecision` refuses to deepen on it for a short hold (`UNCHANGED_READING_SHED_HOLD_MS`, `overshoot.ts`) — otherwise the planner cuts into devices the user ranked higher for a deficit the previous shed already covered. Equality is exact so that any real movement, in either direction, is still acted on at full speed, and the hold releases early if the deficit itself grows (a tightened soft limit is a new question, not a re-delivered answer). Do not remove the hold to make shedding "more responsive": the deficit it protects against is imaginary.

A held cycle re-asserts the shed this module itself decided (`lastShedPlanShedIds`) and adds nothing. It must never re-derive that set from the FINAL plan's shed set (`lastPlannedShedIds`), which carries holds merged in after this module ran; handing one of those a capacity shed reason mislabels it and clamps unrelated stepped loads. Its window is anchored on `lastShedPlanAtMs`, not the overshoot mitigation clock, because `PlanBuilder` runs shedding *before* `OvershootTracker.updateOvershootState` nulls that clock on overshoot entry.
