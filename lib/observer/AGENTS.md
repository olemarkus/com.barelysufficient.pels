# Observer Layer — Orientation and Quiescence Rules

`lib/observer` owns timeless observed-state projection and observation trust: what telemetry says, how fresh it is, and what an idle device means. It supplies current state; it never decides desired state (planner) or issues commands (executor).

## Map

- `observationFreshness.ts` — the freshness producer: tri-state `fresh | stale | unknown`.
- `observationTrust.ts` — which observations count as trusted evidence.
- `observedState.ts` / `observedDeviceStateProjection.ts` / `observedStateEvents.ts` — observed-state model and projections.
- `idleClassifier.ts` / `idleDetector.ts` — `near_target_idle` / `unresponsive` / `capped_idle` classification (see `notes/idle-classification.md`).
- `pendingBinaryCommands.ts` (+ types/formatting) / `binarySettle.ts` — pending binary command tracking and settle behavior.
- `observedHomePower.ts` / `observedPower.ts` — whole-home and per-device power views.

The full device-state invariants digest lives in `lib/device/AGENTS.md`; read it before changing anything that feeds reconcile/merge.

## Quiescence is a producer concern

Homey thermostat drivers only push capability updates on value change, so a healthy device steady at setpoint legitimately falls silent for hours. The producer (`observationFreshness.ts`) exposes the tri-state; consumers must not re-derive freshness from `lastFreshDataMs` age and must not collapse `stale` into "broken." In particular:

- **Smart-task temperature planning** (`lib/objectives/deferredObjectives/diagnosticProgress.ts`) credits the last-seen temperature for any device that has produced at least one trusted observation — it does not gate on staleness. (The plan device no longer carries an `observationStale` flag at all: it was removed from the plan kinds because the plan must not distrust observer-resolved state. Where a feature genuinely needs freshness it is sourced from the observer producer — see below.) EV SoC stays strictly fresh because charger session validity genuinely requires per-session telemetry (`getTrustedStateOfCharge` keeps its `status === 'fresh'` gate).
- **Profile learning** (`lib/objectives/samples.ts`) keeps the 30-minute observation-age gate, because rate learning legitimately needs recent value-changed samples.
- **Shed/restore lanes** read the producer-resolved on/off truth `currentOn` (a strict boolean latched at the last observed value, with **no** staleness gate) — narrow via `isBinaryPlanDevice`, then read `currentOn`. This is consistent with the stale-off = trusted-off invariant below: a stale-off device is trusted off (not shed — an off device cannot be commanded off), a stale-on device trusted on. The retired `isObservedOff`/`isObservedOn` (which collapsed stale to "neither") no longer exist.
- **Staleness-dependent features** — idle classification, the overview gray-state label, and the starvation freshness gate — source freshness from the **observer producer** (`isDeviceObservationStale` over `ctx.getObservedState(id)`, wired as the `getObservationStale` dep on the plan service / plan engine), never from a plan-device field. `observationStale` was removed from the plan kinds (`DevicePlanDevice` / `PlanInputDevice`): the plan trusts producer-resolved control state, and freshness reporting is the observer's concern.

Related invariant: Homey reports capabilities only on CHANGE, so stale-off = trusted-off — do not re-derive trust from staleness. The `currentOn` resolution above honours this by design.
