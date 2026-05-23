# Idle classification (near_target_idle / unresponsive / capped_idle)

Surfaces a per-device state for temperature devices that are commanded on but
either drawing ~0 W (the existing two states) or cycling against the device's
own internal setpoint cap (the third state). The intent is purely UI and
diagnostics plus a producer-side bridge into the deferred-objective recorder
so a run plateaued at the device's plateau finalises as succeeded rather than
a false-missed verdict — the planner itself doesn't read the classification.

## Three states

| State | Meaning | UI | Log event | Producer effect |
|-------|---------|----|-----------|-----------------|
| `near_target_idle` | Device has stopped drawing while close to its setpoint. Normal behaviour — the device's own controller (water-heater stratification, thermostat hysteresis) decided to hold. | Neutral status line on the temperature card (`Holding near setpoint (61.5° / 65°)`). No chip. | `device_near_target_idle_started` / `..._cleared` | Promotes deferred-objective run to `met` with `metReason: 'stalled'`. |
| `unresponsive` | Device is well below setpoint and drawing nothing for an extended period. Likely a fault (tripped breaker, lost contactor, child-lock, wrong wiring). | Warning chip (`Not responding`) plus a warning status line. | `device_unresponsive_started` / `..._cleared` | None — a tripped breaker shouldn't be silently called "succeeded". |
| `capped_idle` | Device is well below the PELS-commanded target but its own internal setpoint cap has opened. Temperature parks at a stable plateau several degrees below target while power cycles around the device's own anti-cycle hysteresis (e.g. Connected 300 capped internally at ~60 °C with a 65 °C PELS target). | Neutral status line (`Device reached its own setpoint cap (58° / 65°)`). No chip — the device is doing the right thing against its own cap. | `device_capped_idle_started` / `..._cleared` | Promotes run to `met` with `metReason: 'stalled_device_capped'`. Postmortem variant `met-by-device-cap` names the device's own setpoint cap as recourse (deliberately not the PELS-canonical "hard cap" per `feedback_hard_cap_is_physical.md`). |

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

`capped_idle` is evaluated *first* because its discriminator is a cycling
pattern that resets the contiguous `idleSinceMs` streak — without an early
check the existing two-state machine would always return `active` on cycling
devices.

- A rolling sample window of the last `CAPPED_IDLE_MIN_WINDOW_MS` (20 min)
  shows:
  - at least one sample drawing power AND at least one sample idle
    (the cycling discriminator from `unresponsive`, which sees only idle
    samples), AND
  - the temperature spread across the window is
    ≤ `CAPPED_IDLE_MAX_TEMPERATURE_SPREAD_C` (1.0 °C — the "stuck"
    discriminator from `active`, which would still be climbing), AND
  - `gap > NEAR_TARGET_TEMPERATURE_DELTA_C` (5 °C — the discriminator from
    `near_target_idle`, which is already in the hysteresis band), AND
  - the device has been observed continuously for at least the full
    window (guards against a half-populated window after a restart) →
    **capped_idle**.
- Otherwise, with the device currently measured-idle:
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

### Why 5 °C / 15 min / 20 min

The Connected 300 water heater is observed to stall around 61.5 °C with a
65 °C setpoint (gap ≈ 3.5 °C). A tighter 3 °C window would mis-classify this
as `unresponsive`. The shared 5 °C threshold for both holding-entry and
unresponsive-floor avoids a gap-zone (a gap that is "neither holding nor
unresponsive") and keeps a single tuning knob.

15 min for unresponsive is conservative — fewer false alarms at the cost of
slower fault surfacing. Long enough to outlast any plausible recovery cycle
of a temperature-controlled device.

20 min for the `capped_idle` window comfortably exceeds the typical
Connected 300 thermostat duty cycle (a few minutes on / several minutes off)
so both halves of the cycle land inside the window, while staying short
enough that a real false-missed run gets re-classified before the user gives
up reading the "device unresponsive" misdiagnosis. The 1.0 °C spread bound
is wider than the sub-degree drift the Connected 300 shows at its plateau
but tight enough that a genuinely-climbing heater (rate-limited charging,
> 1 °C across 20 min) doesn't get labelled "capped".

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
