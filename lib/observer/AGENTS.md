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

- **Smart-task temperature planning** (`lib/objectives/deferredObjectives/diagnosticProgress.ts`) credits the last-seen temperature for any device that has produced at least one trusted observation. It deliberately does not consult `observationStale`, because that flag is age-derived today (`setup/appInit/toPlanDevice.ts` calls `isDeviceObservationStale`), and consulting it would re-introduce the miscategorisation. EV SoC stays strictly fresh because charger session validity genuinely requires per-session telemetry.
- **Profile learning** (`lib/objectives/samples.ts`) keeps the 30-minute observation-age gate, because rate learning legitimately needs recent value-changed samples.
- **Snapshot refresh, idle classification, shed/restore lanes** stay on the existing `observationStale` flag for their own reasons; this rule is scoped to "consuming the current value for planning," not all observation trust.

Related invariant: Homey reports capabilities only on CHANGE, so stale-off = trusted-off — do not re-derive trust from staleness.
