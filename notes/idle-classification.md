# Idle classification (near_target_idle / unresponsive)

Surfaces a per-device state for temperature devices that are commanded on but
drawing ~0 W. The intent is purely UI and diagnostics — the planner already
treats `measuredPowerKw = 0` correctly via `getCurrentDrawKw`, so no plan-state
or restore-admission changes are required.

## Two states

| State | Meaning | UI | Log event |
|-------|---------|----|-----------|
| `near_target_idle` | Device has stopped drawing while close to its setpoint. Normal behaviour — the device's own controller (water-heater stratification, thermostat hysteresis) decided to hold. | Neutral status line on the temperature card (`Holding near setpoint (61.5° / 65°)`). No chip. | `device_near_target_idle_started` / `..._cleared` |
| `unresponsive` | Device is well below setpoint and drawing nothing for an extended period. Likely a fault (tripped breaker, lost contactor, child-lock, wrong wiring). | Warning chip (`Not responding`) plus a warning status line. | `device_unresponsive_started` / `..._cleared` |

## Detection criteria

All of these must hold for a device to be eligible for classification:

- Has a temperature setpoint (`currentTarget` is finite). No setpoint, no
  near-goal signal, so we cannot distinguish "satisfied hold" from "broken".
- Is **not** an EV charger (`controlCapabilityId !== 'evcharger_charging'`).
  EV pauses are modelled separately via `ev_pause`.
- Observation is fresh (`observationStale !== true`).
- Observably on (`currentState === 'on'`).
- PELS is **not** the reason it is off — `shedAction` is undefined. A device
  PELS just shed will trivially be idle near its (lowered) setpoint.
- Measured draw `≤ IDLE_MEASURED_POWER_THRESHOLD_KW` (0.05 kW).

Given those preconditions, the classifier maintains a per-device
`idleSinceMs` streak. The streak resets the moment any precondition fails or
measured draw exceeds the threshold.

### State machine

Let `gap = targetTemperature − currentTemperature`. Let `idleDurationMs =
now − idleSinceMs`.

- `idleDurationMs ≥ IDLE_HOLD_MIN_DURATION_MS` (5 min)
  - and `gap ≤ NEAR_TARGET_TEMPERATURE_DELTA_C` (5 °C) → **near_target_idle**
- `idleDurationMs ≥ IDLE_UNRESPONSIVE_MIN_DURATION_MS` (15 min)
  - and `gap > NEAR_TARGET_TEMPERATURE_DELTA_C` (5 °C) → **unresponsive**
- otherwise → **active**

### Exit hysteresis

Once a device is `near_target_idle`, the exit threshold widens to
`NEAR_TARGET_TEMPERATURE_EXIT_DELTA_C` (5.5 °C). This prevents a thermostat
hovering right at the entry boundary from flapping every cycle. Exit on
measured draw is immediate — no hysteresis on the power side.

### Why 5 °C / 15 min

The Connected 300 water heater is observed to stall around 61.5 °C with a
65 °C setpoint (gap ≈ 3.5 °C). A tighter 3 °C window would mis-classify this
as `unresponsive`. The shared 5 °C threshold for both holding-entry and
unresponsive-floor avoids a gap-zone (a gap that is "neither holding nor
unresponsive") and keeps a single tuning knob.

15 min for unresponsive is conservative — fewer false alarms at the cost of
slower fault surfacing. Long enough to outlast any plausible recovery cycle
of a temperature-controlled device.

## Plumbing

- `lib/observer/idleDetector.ts` — pure classifier and per-device state map.
- `lib/observer/idleClassifier.ts` — per-cycle service: owns state, prunes
  vanished devices, emits structured-log transitions, exposes a getter for
  the read model.
- `lib/plan/planService.ts` — ticks the classifier once per plan emission
  via `tickIdleClassifier`. Idempotent on plan reference.
- `lib/plan/settingsOverviewReadModel.ts` — reads classification through a
  deps callback and writes the result onto `SettingsUiPlanDeviceSnapshot`.
- `packages/contracts/src/settingsUiApi.ts` — adds
  `idleClassification?: 'near_target_idle' | 'unresponsive'`.
- `packages/shared-domain/src/idleClassificationCopy.ts` — the only source
  of UI status-line strings and the matching `detail` text. Used by both
  the temperature card and structured-log payloads so the two cannot drift.
- `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx` — renders the
  status line below the temperature card body and a `Not responding`
  warning chip in the header.

## Out of scope (Phase 2 candidates)

- Flow trigger cards (`device_unresponsive_started/_cleared`) — possible
  follow-up once we see the detection behave well in the wild.
- Non-temperature devices — without a near-goal signal we cannot tell
  "satisfied hold" from "broken".
- Push notifications.
- Any retry / nudge logic (toggling setpoints risks fighting the device's
  own anti-cycle controller).
