# Deferred Objectives — review & test rules

This module has a **two-clock** design: the allocator runs only at the `:58` settle / bootstrap
(`activePlanSchedule.ts`, `settleWindow.ts`); between settles a **frozen read** serves the committed
plan (`frozenHorizonPlan.ts`). Several per-cycle release decisions are layered on top at admission
time (`admission.ts` → `hasNoCurrentClaim` / `canSkipUnclaimedHour`): `priceDeferralEligible`
(WI-2), `coldStartReleaseEligible` (WI-4), and the sufficiency gate below. Get the interaction
between these wrong and you will "find" bugs that are not there.

## An unbooked hour is not a stand-down

An hour booked at 0 kWh does **not** mean "idle the device". The producer resolves one flat
`currentHourClaim` (`currentHourClaim.ts`) that admission maps 1:1 — `claimed` drives the device,
`released` stands it down, `unclaimed` hands it to the planner as managed so it competes on its own
priority with no forced shed, no release intent, no deadline floor and none of the rescue claims.

`unclaimed` is reached only when the task cannot finish without the hour, which is narrower than
"the floor was short". It keys on the settled `floorShortfallCause`, mapping an unbooked hour to a
claim: `budget` → `unclaimed`, `time_capacity` → `unclaimed`, `step_power` → `released`,
`estimate` → `released`, `none` → `released`. The two that release are the ones where the task can
still finish — `step_power` means the climbed-band probe already proved the booked hours do the job
once the executor climbs (the normal state of a stepped thermal task), and `estimate` means the gap
is entirely the `k·SE` variance padding. Gating on the raw floor shortfall instead would switch
price optimisation off for most stepped tasks.

Three things that look like regressions and are not:

- A budget-bound or infeasible task never releases **on the unbooked-hour path** — there is no later
  hour to defer into. It can still release from a hour it DID book, via `priceDeferralEligible`.
- An empty horizon still releases: no schedule demands the hour.
- The frozen read replays the settle's `floorShortfallCause` rather than recomputing sufficiency
  from the live need. That is deliberate — a live comparison would put the decision back on the
  per-cycle clock, and a device idling in a released hour drifts, so the answer would cross back and
  forth mid-hour with no cooldown able to damp it (a lifecycle release never stamps
  `lastInstabilityMs`, so the 60-300 s restore back-off never engages).

Design of record: `notes/deferred-load-objectives/README.md` § "An unbooked hour is not a
stand-down"; proof: `test/integration/smartTaskUnclaimedHourLifecycle.test.ts`.

## The step-ladder gap is the producer's answer, and its two readers are mirrors

"Configured as a stepped load, but no live ladder this cycle" is resolved at `toPlanDevice` and
arrives here as the flat `steppedLadderMissing` bit. Do **not** re-derive it from `controlModel`,
profile presence, or a missing power figure — this layer cannot see both halves of the question, and
each of those proxies has already failed once in production. `resolveObjectiveSteps` (→
`liveStepsUnavailable` → frozen serve) and `resolvePlanningSpeedKw` (hero copy) are the only two
readers, and they **move together**; changing one alone makes the diagnostic and the hero disagree
about the same device in the same cycle. Background: `notes/deferred-load-objectives/execution-adaptation.md`
§ "Live step-ladder gap — the frozen read also bridges missing steps".

## E2E must drive the real stack from the Homey SDK boundary

When testing or reproducing deferred-objective behaviour across cycles, simulate **only** the Homey
SDK boundary — **device temperature / SoC, prices, and the clock** — and drive the real
`buildDeferredObjectiveDiagnostics` + `DeferredObjectiveActivePlanRecorder` +
`applyDeferredObjectiveAdmission`. Loop: read `recorder.getActivePlansSnapshot()` → bridge →
`recorder.observe()` → admission → apply the decision to a thermal/SoC model → advance the clock.
See `test/e2e/deferredObjectiveColdStartSdkE2E.test.ts` for the canonical harness.

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
