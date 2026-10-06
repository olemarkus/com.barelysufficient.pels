# Deferred Objectives

Smart tasks use two clocks: the allocator settles at `:58` or bootstrap, while `frozenHorizonPlan.ts` serves that commitment between settles. Admission can make per-cycle release decisions without rerunning allocation. The design record is `notes/deferred-load-objectives/README.md`; execution details are in `notes/deferred-load-objectives/execution-adaptation.md`.

## Booking is decided by price, not by forecast room

The allocator books an hour when it carries energy, when it is meaningfully cheaper than the dearest hour carrying energy, or when the task falls short (`resolveBookedBucketIds`). A booked hour the forecast left no room for carries 0 kWh. The saved plan's `hours` are the bookings; readers that mean "the hours the device runs" use `hoursWithPlannedEnergy`, and only hours with energy are commitment floors. `currentHourClaim.ts` resolves `claimed` or `released` once; a 0 kWh booking is claimed but carries no escalation permission (boost, startup reservation), so it runs only on capacity that is actually free. The frozen read replays the settled bookings and `floorShortfallCause` rather than recomputing them from live drift.

## During an active smart task, the task decides whether the device runs

A `released` hour stands the task's device down even when Power-limit control is on. With standing command authority, `admission.ts` holds that device off without classifying the hold as capacity pressure; a temperature-only device with no off command keeps its configured setback. `claimed` hours continue through normal planning. Do not infer the release rule from task status text or stored start policy; use the resolved active claim and authority.

## The step-ladder gap is the producer's answer, and its two readers are mirrors

`steppedLadderMissing` is resolved by the producer. `resolveObjectiveSteps` and `resolvePlanningSpeedKw` read that same fact for frozen serving and user-facing diagnostics. Change both together; do not re-derive the gap from profile presence or a missing power value.

## Testing and review

For a cross-cycle reproduction, drive the real bridge, recorder, allocator, and admission through the Homey SDK boundary: device temperature/SoC, prices, and clock. Do not mock internal milestones or fresh/frozen dispatch. `test/e2e/deferredObjectiveColdStartSdkE2E.test.ts` is the reference harness. A mid-hour cold-start finding must account for the committed milestone and price-deferral backstop before being treated as a regression.
