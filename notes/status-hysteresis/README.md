# Status Hysteresis and Confidence Margins

Extra hysteresis on smart-task status transitions and confidence-scaled deadline
margins are **deferred from v1**. The shipped runtime still computes live
diagnostic status immediately on every cycle
(`lib/objectives/deferredObjectives/statusTransitions.ts`), but that live bus is
internal lifecycle/debug state. Public Flow/UI status reads the active-plan
record's saved `latest.planStatus`, so short mid-hour flips are damped by the
active-plan recorder's settle gate before they become user-observable.

This note collects the remaining hysteresis design so the intent is not lost;
pick it up only if real telemetry shows user-observable status flapping after
the saved-active-plan gate, or if PELS deliberately exposes live status again.

## Why hysteresis was designed

Stop status from flapping `on_track` ↔ `at_risk` ↔ `on_track` between
cycles. That used to be a direct Flow-trigger risk when public status followed
the immediate status bus. Today it is mostly a risk at active-plan revision
boundaries or at the satisfied target boundary.

## What already damps the noise (without hysteresis)

1. **Saved active-plan status.** `deadline_status_changed` and
   `deadline_status_is` read settled active-plan revisions, not the immediate
   diagnostic status bus. Mid-hour diagnostic flips do not fire public Flow
   cards unless they survive to a saved revision.
2. **Same-status public suppression.** The Flow trigger suppresses same-public-status
   revisions, including raw `cannot_meet` ↔ `invalid` transitions that both map to
   `unachievable`.
3. **Plan-stability rule.** The active-plan recorder ignores trivial
   recomputations and writes replans at the settle gate unless the objective
   itself changed.

## The case dedup doesn't cover

Status flapping across the **target boundary** — thermostat reads 21.9°C
(`on_track`), next reads 22.1°C (`satisfied`), next reads 21.95°C
(`on_track`). Each transition is a different status, so same-status
suppression cannot help. The saved-active-plan gate prevents second-by-second
Flow churn, but an unlucky settle sample can still publish a boundary status
that reverses on a later revision. The same risk applies to EV SoC: a charger
reporting an integer percent that bounces 79 -> 80 -> 79 can alternate the
saved public status across revisions even though no meaningful progress changed.

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

These rules imply either a `stableStatus` field on the evaluation type or an
additional active-plan status gate before writing public revisions. Today the
latest-cycle diagnostic `status` ships internally and the active-plan
`latest.planStatus` ships publicly.

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

- Real telemetry shows user-visible `deadline_status_changed` flapping after
  the saved active-plan status gate.
- The asymmetric satisfied-gate (smaller fix) doesn't catch the observed
  case.
- Or: confidence-scaled margins become necessary because a class of plans
  reports `on_track` while genuinely under-confident.

Until any of those signals appear, this is parked.
