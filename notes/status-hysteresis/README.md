# Status Hysteresis and Confidence Margins

Hysteresis on smart-task status transitions and confidence-scaled deadline
margins are **deferred from v1**. The shipped runtime transitions
immediately on status change
(`lib/objectives/deferredObjectives/statusTransitions.ts:117`) and uses a flat
deadline-reserve margin without a confidence band. This note collects the
design so the intent isn't lost; the trigger for picking it up is real
telemetry showing user-observable status flapping, not the section's
existence.

## Why hysteresis was designed

Stop status from flapping `on_track` ↔ `at_risk` ↔ `on_track` between
cycles, which would otherwise generate noisy flow-trigger fires and UI
churn.

## What already damps the noise (without hysteresis)

1. **Flow-trigger dedup.** `statusTransitions.ts` suppresses
   `deadline_status_changed` on same-status re-runs, so a flip-and-flip-back
   inside a few cycles only generates one fire.
2. **Plan-stability rule.** The active-plan recorder doesn't write a new
   revision when the hour schedule is unchanged — trivial recomputations
   don't perturb persistence.
3. **Plan-cycle frequency.** 10s polls or flow-event-driven; most
   "flapping" resolves within seconds, well below user-observable.

## The case dedup doesn't cover

Status flapping across the **target boundary** — thermostat reads 21.9°C
(`on_track`), next reads 22.1°C (`satisfied`), next reads 21.95°C
(`on_track`). Each transition is a *different* status, so dedup doesn't
apply, and a flow wired to `deadline_status_changed` fires three times for
sensor noise. The same flapping risk applies to EV SoC: a charger
reporting an integer percent that bounces 79 → 80 → 79 across consecutive
samples produces three status fires for no real progress.

The fix is an **asymmetric satisfied-gate** at the diagnostic boundary in
`lib/objectives/deferredObjectives/diagnosticsBridge.ts`:

- **Entering `satisfied`** requires `current >= target` exactly (no
  premature satisfaction). This is already shipped — `energy_already_met`
  fires when `progress.remainingUnits <= 0`.
- **Leaving `satisfied`** requires the reading to drop a non-trivial
  amount below target before returning to active tracking. Suggested
  per-kind thresholds:
  - Temperature: ~1°C (a half-degree dip from a recently satisfied 22°C
    target is sensor noise, not actual cooling)
  - EV SoC: 5 percentage points (a 1-2% dip is integer rounding or idle
    drain; 5pp signals real loss worth resuming for)

This needs a sticky-satisfied flag (the diagnostic must know whether the
objective was satisfied recently, similar to the existing sticky
`deadlineMissed` flag in `statusTransitions.ts`) so the asymmetric gate
applies only after the up-cross. Not shipped today; deferred to the same
hysteresis-implementation pass as the broader rules below.

If telemetry shows non-boundary flapping (e.g. status flipping inside the
plan-evaluation pipeline rather than at the target boundary), the full
hysteresis design below covers it.

## Hysteresis design (deferred)

Hysteresis should stabilize UI and flow triggers, but must not blind the
planner. The planner should consume the latest conservative evaluation.
Flow triggers and user-visible stable state may use rules such as
(values referenced are the shipped status ids — see §"Status enum" below):

- require two consecutive evaluations before downgrading from `on_track`
  to `at_risk`
- allow immediate transition to `cannot_meet`
- require five minutes stable before upgrading from `at_risk` to
  `on_track`

These rules imply a `stableStatus` field on the evaluation type, separate
from the latest-cycle `status`. Today only the latest-cycle `status` ships.

## Confidence-scaled deadline margin (deferred)

Rate confidence should affect deadline margins. Use conservative rate for
`likely_to_meet`; a less conservative expected rate may explain `at_risk`,
but it should not make the planner optimistic.

Initial margin model:

```ts
baseDeadlineMarginMs = 15 * 60 * 1000;
mediumConfidencePenaltyMs = 15 * 60 * 1000;
lowConfidencePenaltyMs = 45 * 60 * 1000;
```

Effective margin:

```ts
deadlineMarginMs = baseDeadlineMarginMs
  + confidencePenaltyMs
  + curveOrInstabilityPenaltyMs;
```

The shipped runtime carries `deadlineMarginMs` per objective but uses a flat
value rather than scaling from a confidence band. Bootstrap rates are
already conservative-high (EV's 1.0 kWh/% is intentionally over-booking-safe),
and learned profiles carry confidence implicitly via sample count + EMA
decay, so the confidence-scaled margin is theoretical safety on top of an
already-safe design. Pick this up if observation shows low-confidence plans
landing `likely_to_meet` when they should land `at_risk`.

## Status enum (shipped, for reference)

The shipped status values live on the diagnostic type
(`lib/objectives/deferredObjectives/diagnosticsBridge.ts`):

- `unknown` — required inputs missing, stale, invalid, or impossible to
  evaluate.
- `on_track` — conservative projected completion is before the deadline
  minus the (flat) deadline-reserve margin.
- `at_risk` — projected completion is inside the reserve, or the plan
  relies on policy-avoid hours to land.
- `cannot_meet` — even the highest allowed hard-cap-safe behavior cannot
  plausibly meet the target before the deadline.
- `satisfied` — current progress is at or above target. (Live; if a later
  reading drops below target, the next cycle returns to one of the values
  above.)

## Trigger to revisit

- Real telemetry shows user-visible `deadline_status_changed` flapping
  unrelated to true plan changes.
- The asymmetric satisfied-gate (smaller fix) doesn't catch the observed
  case.
- Or: confidence-scaled margins become necessary because a class of plans
  reports `on_track` while genuinely under-confident.

Until any of those signals appear, this is parked.
