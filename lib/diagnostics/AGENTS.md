# Diagnostics

`lib/diagnostics/` records device health, starvation, and app resource telemetry. It observes decisions and device state; diagnostics do not feed planner choices. The detailed starvation model is in `notes/starvation/README.md`.

## Temperature device starvation

- Count starvation only for managed temperature devices that PELS holds below their intended mode target. Use the producer-resolved `pelsHoldsBelowTarget` fact from `lib/plan/planDiagnostics.ts`; physical temperature alone does not establish a PELS hold. Starvation is metadata, not an automatic change to shed order or priority. A user-requested rescue is a separate action.
- Entry requires 15 minutes of continuous counting suppression. Clearing requires 10 minutes continuously commanded at the full target. Capacity control being disabled clears the episode. Track accumulated counting time, not a single start timestamp; duration Flow thresholds fire once per episode.
- PELS-imposed off periods, cooldowns, restore throttles, and reservations count. Owner-controlled or non-counting holds pause a latched episode and cannot start one. A silent device observation does not pause the clock; a gap over ten minutes in PELS's own plan samples does.
- Budget-denial learning is a separate persisted measure of unmet demand while the daily budget is below sustainable capacity. Do not gate it on the starvation latch or the planner's instantaneous block reason. See the governing note for cause and day-boundary details.

Resource telemetry and memory-reclaim tasks remain observational and must not influence planning.
