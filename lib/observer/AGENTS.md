# Observer Layer — Orientation and Quiescence Rules

`lib/observer` owns timeless observed-state projection and observation trust: what telemetry says, how fresh it is, and what an idle device means. It supplies current state; it never decides desired state (planner) or issues commands (executor).

## Map

- `observedState.ts` / `observedDeviceStateProjection.ts` / `observedStateEvents.ts` — observed-state model and projections.
- `idleClassifier.ts` / `idleDetector.ts` — `near_target_idle` / `unresponsive` / `capped_idle` classification (see `notes/idle-classification.md`).
- `pendingBinaryCommands.ts` + `pendingBinaryCommandTypes.ts` — pending semantic binary commands and telemetry confirmation; capability routing stays in transport.
- `controlCommandConfirmation.ts` — per-communication-model confirmation windows, shared by every control axis.
- `steppedReportedStep.ts` — store of the last flow-reported rung per device.
- `steppedSettleSnapshot.ts` — projection of devices onto the stepped axis's settle evidence.
- `observedHomePower.ts` / `observedPower.ts` — whole-home and per-device power views.
- `generationFreshness.ts` — freshness policy for the held generation reading on the flow source.
- `externalOffHold.ts` — the "Leave off until turned on again" hold state and its persistence.

## One deliberate exception to "timeless observed state"

`externalOffHold.ts` is the layer's only *persisted* store, and a hold is a policy
posture rather than an observation. It lives here anyway because it is the one
thing `lib/device`, `lib/plan`, `lib/executor`, and `setup` all need to read, and
observer is the only leaf all four may depend on (`no-observer-to-peer`). Keep the
module a pure leaf — it must never import a peer, and it must not grow logic that
decides *whether* a hold applies. That decision (the provenance question, "was this
OFF ours?") belongs to `setup/externalOffHoldDetection.ts`, and the resolved
`externalOffHoldActive` fact reaches the planner only through `toPlanDevice`.

The full device-state invariants digest lives in `lib/device/AGENTS.md`; read it before changing anything that feeds reconcile/merge.

## A device observation never times out

Homey drivers push a capability update only on value CHANGE, so a healthy device
steady at setpoint legitimately falls silent for hours. **Silence therefore means
"unchanged", never "unknown"** — and PELS has no timeout, anywhere, that turns a
quiet device into an untrusted one. There is no `stale` device state to read, no
age threshold to compare against, and nothing that re-fetches a device because it
has been quiet.

This is not a tuning choice; a per-device age threshold cannot be right at any
value. The only honest distinctions are:

- **never observed** — `lastFreshDataMs` absent. Re-reading cannot change it, so
  a consumer that needs a reading suppresses (see `diagnosticProgress.ts`), and
  the device's `currentState` is `unknown`.
- **gone** — `available === false`, which the Homey SDK states outright. This is
  the one signal that grays a device card.

What was removed (2026-08-29) and must not come back: a 40-minute
`STALE_DEVICE_OBSERVATION_MS` window with a 60 s loop that re-fetched every
device past it. It recovered a device once in 18 days of production while
re-polling the whole managed set every minute, because a snapshot fetch returns
the same per-capability `lastUpdated` Homey already served. It also grayed
working thermostats in the UI, blocked idle/unresponsive classification on the
quiet devices that classification exists to catch, and stopped counting
starvation for a device held below target — which is precisely the device that
goes quiet. Every consumer now reads the last trusted value directly.

Ages that DO stay, because their feed is not change-driven:

- **Profile learning** (`lib/objectives/samples.ts`) keeps its 30-minute
  observation-age gate: rate learning needs recent value-CHANGED samples.
- **EV SoC** (`getTrustedStateOfCharge`) keeps its `status === 'fresh'` gate:
  charger session validity genuinely requires per-session telemetry.
- **The whole-home meter** (`generationFreshness.ts`, `POWER_SAMPLE_STALE_THRESHOLD_MS`)
  pushes on a fixed cadence, so its silence IS a fault.

Related invariant: because Homey reports only on CHANGE, a long-silent `off` is a
trusted `off` and a long-silent `on` a trusted `on`. **Shed/restore lanes** read
the producer-resolved `currentOn` (narrow via `isBinaryPlanDevice`) — a strict
boolean latched at the last observed value, with no age gate. The retired
`isObservedOff`/`isObservedOn` (which collapsed silence to "neither") no longer
exist, and neither does the plan-kind `observationStale` field.
