# Deferred Objectives — review & test rules

This module has a **two-clock** design: the allocator runs only at the `:58` settle / bootstrap
(`activePlanSchedule.ts`, `settleWindow.ts`); between settles a **frozen read** serves the committed
plan (`frozenHorizonPlan.ts`). Several per-cycle release decisions are layered on top at admission
time (`admission.ts` → `isReleasedCurrentHour`): `priceDeferralEligible` (WI-2) and
`coldStartReleaseEligible` (WI-4). Get the interaction between these wrong and you will "find" bugs
that are not there.

## E2E must drive the real stack from the Homey SDK boundary

When testing or reproducing deferred-objective behaviour across cycles, simulate **only** the Homey
SDK boundary — **device temperature / SoC, prices, and the clock** — and drive the real
`buildDeferredObjectiveDiagnostics` + `DeferredObjectiveActivePlanRecorder` +
`applyDeferredObjectiveAdmission`. Loop: read `recorder.getActivePlansSnapshot()` → bridge →
`recorder.observe()` → admission → apply the decision to a thermal/SoC model → advance the clock.
See `test/deferredObjectiveColdStartSdkE2E.test.ts` for the canonical harness.

**Never mock PELS internals** — `aheadOfHourMilestone`, the fresh/frozen dispatch, the allocator,
the milestone stamping. Mocking any of them makes the test confirm your *assumptions* instead of the
*system's behaviour*. A reproduction that pins `aheadOfHourMilestone = false` severs the
price-deferral backstop and manufactures a cold-start "catastrophe" that does not happen in
production.

## Cold-start ⇄ price-deferral: the standing misread

`frozenHorizonPlan.ts` hardcodes `coldStartReleaseEligible: false` on the mid-hour read; cold-start
is recomputed only on the fresh path. This is **not** a mid-hour regression. WI-2 price-deferral is
the backstop: the cold-start hour's `plannedUnitMilestone` is seeded low at the cold measured value
when first committed (frozen thereafter), so once the device delivers its floor booking and crosses
that milestone, `priceDeferralEligible`
idles it for the rest of the hour. Residual peak draw = the floor bookings spilled onto the
expensive hours (marginal), not the full element run. Before escalating any "cold-start is defeated
mid-hour" finding to P0/P1, reproduce it through the SDK-boundary harness above — unmocked. Full
write-up: `notes/deferred-load-objectives/execution-adaptation.md` → "Interaction with the per-cycle
frozen read".
