# Shedding Planner Boundary

Shedding selection belongs in `lib/plan/shedding`; `planDevices.ts` materializes decisions and must not select new shed devices.

Keep this module as the single place that chooses devices for capacity, daily-budget, or hourly-budget shedding. Plan materialization may copy `shedSet`, `shedReasons`, `steppedDesiredStepByDeviceId`, and `temperatureShedTargets`, but it should not independently calculate new shed targets or set a device to `plannedState: 'shed'` as a new selection decision.
