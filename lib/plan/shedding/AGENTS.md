# Shedding Planner Boundary

Shedding selection belongs in `lib/plan/shedding`; `planDevices.ts` materializes decisions and must not select new shed devices.

Keep this module as the single place that chooses devices for capacity, daily-budget, or hourly-budget shedding. Plan materialization may copy `shedSet` and `shedReasons`, but it should not independently set a device to `plannedState: 'shed'` as a new selection decision.

The shedding planner decides what to shed, not how to actuate it. Keep step and temperature target projection outside this module; those are materialization or executor concerns for devices already present in `shedSet`.
