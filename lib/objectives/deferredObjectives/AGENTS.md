# Deferred Objectives

All three Smart-task kinds schedule native price intervals, with explicit start/end bounds. The lifecycle clock solves at most one task per 30-second tick. New tasks start in priority order; queued edits retain their position, and unsuccessful attempts retry behind other waiting tasks. The hourly `:58` settle opens a queue generation that drains past `:00`; bootstrap and explicit changes also queue a turn. Meter-driven decoration never allocates: it serves compatible saved plans. A new task leaves normal device control in place until its first plan; an invalidated saved plan relinquishes its reservation until replanned. Existing draw remains subject to live limits while the task grants no start, increase, target update or rescue permission. A higher committed revision invalidates lower plans until their turn, using stable revision identity rather than live shrinking draw windows; `frozenHorizonPlan.ts` serves the saved interval containing `nowMs` between settles. The next normal meter-driven rebuild follows a quarter boundary; do not add a quarter-hour allocator or control timer. Admission can make per-cycle release decisions without rerunning allocation. Capacity-period settings are independent of scheduling resolution. The design record is `notes/deferred-load-objectives/README.md`; execution details are in `notes/deferred-load-objectives/execution-adaptation.md`.

## Booking is decided by price, not by forecast room

The allocator books an interval when it carries energy, when it is meaningfully cheaper than the dearest interval carrying energy, or when the task falls short (`resolveBookedBucketIds`). A booked interval the forecast left no room for carries 0 kWh. The saved plan's legacy-named `hours` array holds explicit intervals; readers of scheduled operation use `hoursWithPlannedEnergy`, and only intervals with energy are commitment floors. Compare schedules by time coverage. On a source-grid change, distribute floors over overlapping spans by duration and retain elapsed history. Public `planned_hours` is the union duration of positive-energy bookings in hours, including fractions; equal-duration changes stay quiet. `currentHourClaim.ts` resolves `claimed` or `released` once; a 0 kWh booking is claimed but carries no escalation permission (boost, startup reservation), so it runs only on capacity that is actually free. The frozen read replays the settled bookings and `floorShortfallCause` rather than recomputing them from live drift.

Daily-budget learning remains hourly. `policyHorizon.ts` prorates each hour's background and managed allowance over native intervals; never apply a whole hourly allowance to every quarter. Higher-priority energy and power claims retain their actual overlap. Planning prices include the configured solar/export adjustment; preview cost estimates and metered money use import prices. Active plans use v2 and history v7, with legacy hourly bookings migrated to explicit 60-minute spans and archived costs retained.

## During an active smart task, the task decides whether the device runs

EV charging continuity is an opt-in scheduling preference, owned after ordinary
fresh allocation by `evChargingSessionSmoothing.ts`. It moves energy rather than
adding it, within one original-plan 5% money and planning-value allowance. Never
rewrite committed energy to smooth a gap. `keepCharging` records the chosen run
independently of price facts; both fresh and frozen claims consult the current
preference. Capacity protection, completion and short-task free-capacity claims
retain precedence. See the continuity section of the design record.

A `released` interval stands the task's device down even when Power-limit control is on. With standing command authority, `admission.ts` holds that device off; a temperature-only device with no off command keeps its configured setback. With borrowed authority, it keeps its configured release posture. Both are deferred holds, not capacity pressure, and must not clamp unrelated stepped devices. `claimed` intervals continue through normal planning. Do not infer the release rule from task status text or stored start policy; use the resolved active claim and authority.

A device on a solar-surplus posture (`surplusOnly`, `surplusTracking`) is the exception in a `released` interval (owner ruling 2026-11-17, `followsSurplusWhileWaiting` in `admission.ts`): the task neither holds nor pauses it and it leaves the surplus precedence set, so its posture holds it off and runs it on measured export, never on grid import. What it draws counts toward the task like any other draw. A `claimed` interval is the task's as before, grid import included (owner ruling 2026-09-25).

A continuous priced window starting now can be allocated before prices reach the deadline. The remaining work determines the latest start on available power using the slowest useful step and the ordinary deadline reserve. Save this fallback with the revision so it survives a restart or the end of the priced window. It carries no commitment floor, priority reservation, or rescue permission. Newly published coverage queues a planning turn, and a transient shorter read keeps the compatible saved revision.

The task governs until its deadline, also once satisfied (owner ruling 2026-10-17). Satisfaction strips the rescue permissions; it does not hand the device back to normal running, and it has no lifecycle fallback of its own. A temperature task's setpoint rides every decision as `deadlineFloorTargetC`, so neither satisfaction nor a mode change writes a mode target below the task's mid-task (a more demanding one still wins, as the floor has always worked); a released interval's shed posture carries its own limit.

## The step-ladder gap is the producer's answer

`steppedLadderMissing` is resolved by the producer. `resolveObjectiveSteps` reads that fact for frozen serving; diagnostics derive planning speed from those same resolved rungs. Do not re-derive the gap from profile presence or a missing power value.

## Smart-task requests are decided here

The request lanes own their smart-task write decisions: `smartTaskCreateLane.ts` (settings UI create, refuses an open task), `smartTaskEditLane.ts` (edit and clear, requires an open task, keeps unmentioned permissions and a left-on permission's mode) and `smartTaskWidgetCreateLane.ts` (widget create, may replace an open task, grants selected permissions outright). `smartTaskRequests.ts` assembles preview sessions and owns their final create, replace, clear and rescue operations. Rescue uses the fresh-create write so a newly opened task cannot be replaced. `smartTaskWriteValidation.ts` is their final check before persistence. `smartTaskCommands.ts` owns the Flow and scheduled deadline upserts and permission changes: a deadline replaces the goal and preserves standing permissions; each enabled schedule permission acts like its rescue card with `always`, while permissions left off stay unchanged. Missing recorders reject requests as retryable `unavailable`; preview still requires initialized services, since a missing budget owner is not an off budget. Request adapters bind ports and forward; change a rule here, not in an adapter.

## Testing and review

For a cross-cycle reproduction, drive the real bridge, recorder, allocator, and admission through the Homey SDK boundary: device temperature/SoC, prices, and clock. Do not mock internal milestones or fresh/frozen dispatch. `test/e2e/deferredObjectiveColdStartSdkE2E.test.ts` is the reference harness. A mid-hour cold-start finding must account for the committed milestone and price-deferral backstop before being treated as a regression.
