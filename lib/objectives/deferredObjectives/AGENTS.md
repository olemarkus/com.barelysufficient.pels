# Deferred Objectives

All three Smart-task kinds schedule native price intervals, with explicit start/end bounds. The allocator still settles hourly at `:58` or bootstrap, with the existing explicit-change paths; `frozenHorizonPlan.ts` serves the saved interval containing `nowMs` between settles. The next normal meter-driven rebuild follows a quarter boundary; do not add a quarter-hour allocator or control timer. Admission can make per-cycle release decisions without rerunning allocation. Capacity-period settings are independent of scheduling resolution. The design record is `notes/deferred-load-objectives/README.md`; execution details are in `notes/deferred-load-objectives/execution-adaptation.md`.

## Booking is decided by price, not by forecast room

The allocator books an interval when it carries energy, when it is meaningfully cheaper than the dearest interval carrying energy, or when the task falls short (`resolveBookedBucketIds`). A booked interval the forecast left no room for carries 0 kWh. The saved plan's legacy-named `hours` array holds explicit intervals; readers of scheduled operation use `hoursWithPlannedEnergy`, and only intervals with energy are commitment floors. Compare schedules by time coverage. On a source-grid change, distribute floors over overlapping spans by duration and retain elapsed history. Public `planned_hours` is the union duration of positive-energy bookings in hours, including fractions; equal-duration changes stay quiet. `currentHourClaim.ts` resolves `claimed` or `released` once; a 0 kWh booking is claimed but carries no escalation permission (boost, startup reservation), so it runs only on capacity that is actually free. The frozen read replays the settled bookings and `floorShortfallCause` rather than recomputing them from live drift.

Daily-budget learning remains hourly. `policyHorizon.ts` prorates each hour's background and managed allowance over native intervals; never apply a whole hourly allowance to every quarter. Higher-priority energy and power claims retain their actual overlap. Planning prices include the configured solar/export adjustment; preview cost estimates and metered money use import prices. Active plans use v2 and history v7, with legacy hourly bookings migrated to explicit 60-minute spans and archived costs retained.

## During an active smart task, the task decides whether the device runs

A `released` interval stands the task's device down even when Power-limit control is on. With standing command authority, `admission.ts` holds that device off; a temperature-only device with no off command keeps its configured setback. With borrowed authority, it keeps its configured release posture. Both are deferred holds, not capacity pressure, and must not clamp unrelated stepped devices. `claimed` intervals continue through normal planning. Do not infer the release rule from task status text or stored start policy; use the resolved active claim and authority.

The task governs until its deadline, also once satisfied (owner ruling 2026-10-17). Satisfaction strips the rescue permissions; it does not hand the device back to normal running, and it has no lifecycle fallback of its own. A temperature task's setpoint rides every decision as `deadlineFloorTargetC`, so neither satisfaction nor a mode change writes a mode target below the task's mid-task (a more demanding one still wins, as the floor has always worked); a released interval's shed posture carries its own limit.

## The step-ladder gap is the producer's answer, and its two readers are mirrors

`steppedLadderMissing` is resolved by the producer. `resolveObjectiveSteps` and `resolvePlanningSpeedKw` read that same fact for frozen serving and user-facing diagnostics. Change both together; do not re-derive the gap from profile presence or a missing power value.

## Smart-task requests are decided here

The request lanes own every smart-task write decision: `smartTaskCreateLane.ts` (settings UI create, refuses an open task), `smartTaskEditLane.ts` (edit and clear, requires an open task, keeps unmentioned permissions and a left-on permission's mode), `smartTaskWidgetCreateLane.ts` (widget create, may replace an open task, grants selected permissions outright) and `smartTaskRescueCreateLane.ts` (budget-exempt rescue, requires the exemption, refuses an open task). The request lanes take the app as `SmartTaskLanePorts` (`null` before it is wired answers `unavailable`). `smartTaskWrite.ts` is the app side of every write: `smartTaskWriteValidation.ts` is the final check, a write before the plan recorders are wired answers the retryable `unavailable`, and it maps the write op's refusals. The settings-UI handlers, widget routes and `setup/appSmartTaskApi.ts` bind ports and forward; change a rule here, not in a request adapter.

## Testing and review

For a cross-cycle reproduction, drive the real bridge, recorder, allocator, and admission through the Homey SDK boundary: device temperature/SoC, prices, and clock. Do not mock internal milestones or fresh/frozen dispatch. `test/e2e/deferredObjectiveColdStartSdkE2E.test.ts` is the reference harness. A mid-hour cold-start finding must account for the committed milestone and price-deferral backstop before being treated as a regression.
