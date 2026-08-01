# Shedding Planner Boundary

Shedding selection belongs in `lib/plan/shedding`; `planDevices.ts` materializes decisions and must not select new shed devices.

Keep this module as the single place that chooses devices for capacity, daily-budget, or hourly-budget shedding. Plan materialization may copy `shedSet` and `shedReasons`, but it should not independently set a device to `plannedState: 'shed'` as a new selection decision.

The shedding planner decides what to shed, not how to actuate it. Keep step and temperature target projection outside this module; those are materialization or executor concerns for devices already present in `shedSet`.

## A device may only be selected when limiting it releases power

Every selection site here already enforces it — `buildBinaryCandidate`, `buildTemperatureCandidate`, `buildSteppedCandidate` and `buildPreparedSteppedBinaryOffCandidate` all reject a candidate whose `effectivePower <= 0`, and `buildSwapCandidates` skips `pwr <= 0` the same way. Keep it that way.

Shedding a device already drawing nothing frees nothing, but it still costs a write and then makes the device fight back through restore cooldown and backoff. The one lane that ignored this (`pauseHold.ts`, deleted) turned off ten zero-draw devices in production on 2026-07-31 while 2.48 kW sat available. Needing a device to stay off *pre-emptively* is not a shed decision — express it as an admission term instead (`lib/plan/admission/headroomReserve.ts`).
