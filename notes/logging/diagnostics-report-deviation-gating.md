# Deviation-Gated Logging for the Diagnostics Report

Status: partially implemented (idle de-flood + `emitGated` helper + EV clamp shipped).
Companion to `notes/logging/README.md`.

## Problem

A Homey diagnostics report is a ring buffer of only ~100 log lines, captured by a
non-technical user with **no debug topics enabled**. Only ungated info/warn/error
structured lines reach it (`getStructuredLogger(component)` is ungated, `app.ts`;
`getStructuredDebugEmitter` is topic-gated; `logDebug` prose is topic-gated). Every
routine info line evicts an older line that might be the actual evidence.

The goal: make a default (no-debug) report self-diagnosing for common runtime issues —
the EV stepped-load clamp, starvation, capacity overshoot, command-vs-report mismatch —
without a round-trip to enable debug topics and reproduce.

## Measured baseline

Measured from `/tmp/pels/start.main.0a4464c3.stdout.log`, ~86 h, 14-device install,
counting only **default-visible** lines (structured, no `debugTopic`; all high-volume
prose is `logDebug`/`logger.debug`, gated):

- **~1.9 default-visible lines/min → ~100-line buffer survives ~50 min** on this install
  (install-dependent; more EV/thermostat churn pushes it down).
- Top default-visible emitters:

  | lines (86 h) | event | note |
  |---:|---|---|
  | 4335 | `plan_rebuild_completed` | already gated to actioned/failed/slow/startup (`getPlanRebuildLogLevel`). The command record — keep. |
  | 1798 | `device_near_target_idle_started`/`_cleared` | the dominant non-command flood; thermostat flap. **Demoted to debug — see below.** |
  | 1248 | `stale_device_observation_refresh` | already backoff-throttled. |
  | 636 | `device_became_stale`/`_fresh` | per-device transitions. |
  | 148 ×3 | `periodic_status` / `_device_health_summary` / `daily_budget_periodic_status` | twice-hourly (`:25`/`:55`); negligible. |

  Notes that corrected the original intuition: `periodic_status` is **not** a 10 s
  flooder (decoupled from the power poll, twice-hourly); the EV command side is **not**
  missing — `stepped_load_command_requested` (default-visible info) already carries
  `previousStepId`/`desiredStepId`/`plannedDesiredStepId`/`planningPowerW`. What was
  missing is the **join** from command to the inbound report value.

## The pattern: a third emission tier — *deviation-gated*

Two tiers existed: **always-info** (anomalies, commands, transitions) and
**topic-gated debug** (per-cycle detail). Structured payloads let us add a middle tier:

> **Normally debug; auto-promoted to info/warn when a structured field is out of its
> expected band.**

The line stays invisible in steady state but surfaces *the one cycle where the numbers
looked wrong*. It removes routine lines while adding the anomaly lines that were missing,
in one mechanism.

**Core discipline:** always carry the expected value next to the observed value in the
payload, so "surprise" is a pure predicate over the line's own fields and the promoted
line is **self-contained** — it survives the buffer in isolation.

### Helper

`lib/logging/deviationGate.ts` — `emitGated({ logger, debugEmitter, event, fields,
surprise, dedupe? })`. When `surprise` is set, emits on the ungated `logger` at the given
level with `reasonCode`; an optional `dedupe` (reusing `shouldEmitOnChange`) collapses a
persistent anomaly to one line + heartbeat keyed on the surprise signature, with
suppressed cycles still recorded on the debug tier. When `surprise` is null, routes to the
topic-gated `debugEmitter`. The caller computes `surprise` at the producer (no cross-layer
state). Dedupe maps prune via `shouldEmitOnChange` (160 MB RSS ceiling).

## Shipped instances

1. **Idle de-flood** (`lib/observer/idleClassifier.ts`). The classifier was already
   transition-gated; the flood was genuine thermostat flap. `near_target_idle` is the
   **benign** duty-cycle classification (at setpoint, drawing ~0), so its started/cleared
   transitions are demoted to the debug tier (`debugStructured`, wired from
   `planService`). `unresponsive` (commanded on but not reacting) and `capped_idle` (held
   below target by the cap) stay on the info sink with a `reasonCode`. This removes the
   dominant non-command flood from the default report without dropping the signals.

2. **EV / stepped-load clamp** (`flowCards/registerFlowCards.ts`,
   `stepped_load_report_clamp_detected`). `report_stepped_load_*` was never a flooder
   (~80 lines/86 h), so the routine accepted/unchanged report stays at info; this **adds**
   one self-contained `warn` joining the **commanded** step (`desiredStepId` /
   `targetStepId` off the decorated snapshot) to the **reported** power when the device
   reports materially below its commanded step — a downward shortfall beyond the existing
   `getSteppedLoadPowerCeilingMarginW` margin. Per-device dedupe + 10-min heartbeat so a
   stuck clamp emits once, not per report. (Required tightening `getFlowSnapshot` /
   `FlowCardDeps.getSnapshot` to `DecoratedDeviceSnapshot[]`, which the runtime already
   returns.)

## Cautions

- **Only deviation-gate the gray lines.** Unambiguous anomalies (`*_rejected`,
  `*_command_failed`, crashes) stay always-on. A miscalibrated predicate silently *eats
  evidence*; that risk is acceptable for per-cycle wobble, never for hard failures.
- **Prefer relational/static predicates over learned baselines** — "A should equal B",
  "expected vs observed delta" — they cannot drift quiet.
- **No heartbeat-spam.** Pair the gate with `shouldEmitOnChange` on the surprise signature.
- **Keep the predicate at the emit site.** Expected-vs-observed is local (snapshot holds
  the command; the report arrives at the flow card). If a predicate needs cross-layer
  state, push the resolved expected value down into the payload at the producer.

## Follow-up candidates (not yet done)

- `stepped_load_command_requested`: promote only when `desiredStepId !==
  plannedDesiredStepId` or transport fell back; route the matching majority to debug.
- `periodic_device_health_summary`: value-gate (quiet when all-healthy; info on transition
  into `unavailableDevices > 0 || temperatureUnknownDevices > 0`).
- `plan_rebuild_completed`: add `commandRequestCount > appliedActions` and `headroom < 0`
  as explicit surprise reasons.
