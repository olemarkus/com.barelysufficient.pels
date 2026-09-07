# Structured Logging Notes

> Status note: this document is still the logging policy reference, but the event inventory below
> is now a representative high-value slice rather than an exhaustive list. The codebase currently
> emits additional structured events beyond the ones enumerated here.

This note is for contributors changing runtime logging.

## Policy

- Runtime and operational logs are structured.
- Human-readable strings belong in UI/status text, not runtime logs.
- Debug-topic flags gate whether debug-level logging is emitted, not whether logs are structured.

## Legacy logging is banned

You cannot tell from a logging call site whether the line reaches the owner. Three receivers spell
`.debug(...)` identically and behave differently:

| Receiver | What actually happens |
|---|---|
| A pino module logger — `getLogger(module)` / `getStructuredLogger(component)` | **Dark.** The root is created at `info` and these children inherit it, so the line is never written. |
| The injected SDK `Logger` (`lib/utils/types.ts`), wired to `ctx.logDebug('devices', …)` | Emits, as topic-gated **prose** with no `event` field to filter, count or alert on. |
| A hand-rolled `.child({component}, {level:'debug'})` | Emits correctly — it is `getDebugEmitter` rewritten by hand, free to drift from it. |

So all three are refused in runtime code (`app.ts`, `api.ts`, `lib/**`, `setup/**`, `flowCards/**`,
`drivers/**`) by `npm run logging:no-legacy`, which runs in `ci:checks`. The ban is not the claim
that every `.debug()` is invisible — it is that the reader cannot tell which kind they are looking
at, and one kind is invisible.

| Also banned | Why | Use instead |
|---|---|---|
| `logDebug(topic, '…')`, `this.log('…')` | Prose through the Homey SDK: no `event` field. | `getLogger(module).info({ event, … })` |
| `logger[level](…)` with a computed level | The call site does not say whether the line is visible, and one live instance resolves to a dark `debug`. | spell the level out |
| `console.*` | Bypasses the Homey destination, so it never reaches the app log at all. | any of the above |

The dark case is not hypothetical. Four events listed under "Current Structured Events" below —
`target_command_skipped`, `restore_command_skipped`, `binary_command_skipped`,
`stepped_load_command_skipped` — are emitted through a pino module logger and appear **zero** times
in a production log carrying tens of thousands of debug lines. They are the executor's "why was this
device not commanded?" events, which is the first thing anyone reaches for when a device will not
respond. Converting a working topic-gated emit onto that path DELETES the line, and that has
shipped: PR #2252 moved `fetchZoneTree` and silently lost `zone_tree_fetch_failed` /
`zone_tree_fetched`. `lib/device/transport/managerZones.ts` keeps the injected devices-topic logger
for exactly this reason, and says so in its own comment.

`scripts/logging-legacy-allowlist.txt` carries the files that predate the ban, each with a budget
that may only shrink. `api.ts`'s pre-logger boot `console.error` is exempted by name in the guard
rather than budgeted, so the list can reach zero and be deleted.

## Current Model

- Root logger is created in `app.ts` with `createRootLogger(createHomeyDestination(...))` and
  registered process-wide with `setRootLogger(...)`.
- Modules obtain a scoped child via `getLogger('<module-name>')` from `lib/logging/logger.ts`.
  The child inherits the root's ALS mixin (so `rebuildId` and other `runWithContext` values
  land on every line) and adds a stable `module` binding for filtering.
- Prefer `getLogger(module)` over receiving a logger through deps. Treat logging as an
  ambient capability — the ALS context is the Node-side equivalent of Go's
  `context.Context` for request-scoped values. This eliminates the deps-propagation
  problem where every layer redeclares `structuredLog?` / `debugStructured?`.
- **`getLogger(module).debug(...)` emits nothing in production.** The root runs at `info`, so a
  child that inherits its level drops every debug line. Converting a topic-gated debug event onto
  the module logger therefore deletes it: PR #2252 did this to `fetchZoneTree` and silently lost
  `zone_tree_fetch_failed` / `zone_tree_fetched`. Reserve `getLogger` for `info`/`warn`/`error`.
- A debug event goes through `getDebugEmitter(component, topic)` (`lib/logging/logger.ts`), the
  ambient counterpart to `getLogger`: it resolves a child at `level: 'debug'` against the same
  process-wide root and gates on the topic set the owner toggles, published by
  `setDebugTopics(...)` from `updateDebugLoggingEnabled`. Use it in place of a threaded
  `debugStructured` parameter — `getStructuredDebugEmitter` on the app is the same emitter under
  the wiring's name, so a file that drops the parameter changes nothing about what it emits.
  `component` and `topic` are separate arguments and stay that way: `devices` events are emitted
  under `devices`, `reconcile`, and `snapshot`, and Flow-card settings events are
  `component: 'flow'` on topic `settings`.
- Skipping work that exists only to build a debug payload — a signature, a JSON dump, a derived
  summary — asks `isDebugTopicEnabled(topic)`. Do not gate that on whether an emitter was passed
  in: the wiring supplies one unconditionally and the topic check lives inside it, so a presence
  gate is always open (`planDebugDedupe.ts` carried exactly that bug).
- Transport still routes by Homey SDK log level callbacks, but payloads should remain JSON
  objects with stable field names.
- AsyncLocalStorage lives in `lib/logging/alsContext.ts`. PlanService establishes
  the owning `homeId` around every queued operation, and nested
  `withRebuildContext(...)` adds `rebuildId`. Planner and executor descendants
  therefore inherit both fields without redeclaring logging dependencies.
  Global async handoffs must use `runWithoutContext(...)` when their later work
  no longer belongs to the home/rebuild that happened to schedule it.
- `incidentId` is still attached manually by `CapacityGuard`; other important flows still lack
  automatic correlation IDs.
- Debug-level structured events follow the debug-topic model above: with the topic enabled the
  emitter's child logs at `debug`, and with it disabled nothing is written, while higher-severity
  structured events still flow through `getLogger`.

## Current Structured Events

Events marked **(dark)** are emitted through the module logger and therefore do **not** appear in a
production log today. They are listed because they exist in the code and are what a reader will
grep for; the marker is there so nobody concludes the feature is silent when it is the log that is.
Draining them is the executor lane of the legacy-logging allowlist.

- `plan_rebuild_completed`
- `plan_rebuild_scheduler_intent_dropped`
- `plan_rebuild_scheduler_intent_replaced`
- `binary_command_applied`
- `binary_command_skipped` **(dark)**
- `binary_command_failed`
- `binary_command_outcome_unknown` — the write timed out, so neither `failed`
  nor `succeeded` is true. The command stays pending and telemetry settles it.
- `target_command_applied`
- `target_command_skipped` **(dark)**
- `target_command_failed`
- `stepped_load_command_requested`
- `stepped_load_command_skipped` **(dark)**
- `stepped_load_command_failed`
- `stepped_load_command_outcome_unknown` — the stepped twin of
  `binary_command_outcome_unknown`: the write was abandoned (native transport
  timeout) or the Flow trigger went unacknowledged, so the command stays pending
  and telemetry settles it. Carries `effectiveTransition`, which says which
  cooldown clock it stamped.
- `homey_request_late_response` — a request the caller abandoned was answered
  anyway. `failed_after_abandon` carries the owning app's own error body (this is
  the only place a cloud device's real failure is visible); `landed_after_abandon`
  means the write went through after PELS stopped waiting.
- `homey_request_late_failure` — the abandoned request never produced a response.
- `stepped_load_flow_trigger_unacknowledged` — emitted by the transport for the
  Flow half of the above. Deliberately a distinct name so one occurrence is not
  counted twice; the executor owns the `outcome_unknown` line.
- `restore_command_skipped` **(dark)**
- `device_snapshot_refresh_completed`
- `periodic_status`
- `daily_budget_periodic_status`
- `capacity_overshoot_escalation_blocked`
- `overshoot_entered`
- `overshoot_cleared`
- `hard_cap_shortfall_detected`
- `hard_cap_shortfall_alert_triggered`
- `hard_cap_shortfall_alert_deferred`
- `hard_cap_shortfall_alert_dropped`
- `hard_cap_shortfall_alert_failed`
- `hard_cap_shortfall_sustained_alert_triggered`
- `hard_cap_shortfall_sustained_alert_ended` (`reasonCode`: `condition_cleared` |
  `incident_cleared` | `runtime_discarded` | `max_reached` | `evidence_stale`)
- `hard_cap_shortfall_sustained_alert_failed`
- `hard_cap_shortfall_recovery_started`
- `hard_cap_shortfall_recovery_reset`
- `hard_cap_shortfall_recovered`
- `price_optimization_completed`
- `price_fetch_failed`
- `budget_recomputed`
- `app_initialized`
- `startup_step_failed`
- `startup_background_task_failed`
- `device_update_processed`
- `device_snapshot_refresh_processed`
- `device_snapshot_control_state_fallback`
- `energy_live_report_received`
- `device_overview_changed`
- `device_overview_changes`
- `device_starvation_started`
- `device_starvation_paused`
- `device_starvation_resumed`
- `device_starvation_cleared`
- `device_starvation_hard_reset`

## Gaps Still Open

- The executor **skip** paths are structured but **not observable**: they emit through a pino module
  logger, so they are absent from production logs (see "Legacy logging is banned"). The executor
  *failure* paths are fine — `binary_command_failed`, `target_command_failed` and
  `stepped_load_command_failed` emit at `error`, and the two `*_outcome_unknown` at `warn`. UI
  snapshot writes, startup step/background-task failures, and the main price/overshoot boundary
  transitions are structured and do emit.
- Correlation coverage is narrow. Rebuild context exists, but there are no automatic helpers yet
  for `incidentId`, `snapshotId`, `priceRefreshId`, or broader flow-scoped correlation.
- Event payloads are still stringly typed. There is no central event schema, but the current
  high-value events in this slice now use bounded `reasonCode` values.
- We do not yet emit compact summary snapshots at important boundaries such as startup
  completion or broader degraded-mode transitions.
- Tests cover base ALS behavior, logger bindings, and Homey forwarding, but do not yet cover
  end-to-end correlation for overshoot incidents, snapshot flows, or price refresh flows.

## Migration Priorities

- Replace remaining high-value prose runtime logs with structured event logs.
- Expand automatic ALS correlation beyond rebuilds.
- Add bounded `reasonCode` fields for important failure and fallback events.
- Emit compact boundary snapshot events only at key lifecycle points, not continuously.
- Keep child logger bindings for stable component/module fields and ALS for flow-scoped IDs.
- New modules declare `const logger = getLogger('<module-name>')` at module scope for
  `info`/`warn`/`error`, and `const emitDebug = getDebugEmitter('<component>', '<topic>')` for
  debug payloads. `logger.debug(...)` is banned — it emits nothing. Do not add `structuredLog?` /
  `debugStructured?` to deps types.
- Drain `scripts/logging-legacy-allowlist.txt`, executor lane first: that lane is the only reason
  the four `*_command_skipped` events cannot be read in production.

## Contributor Guidance

- Prefer stable field names over embedding meaning in a formatted message string.
- `deviceId` is the identity field in structured logs and diagnostics. `deviceName` is only a
  display label when actually known; do not rewrite a missing name to the id.
- Any future Settings UI device-log or diagnostics surface that shows the per-device overview
  wording should reuse `packages/shared-domain/src/deviceOverview.ts` rather than rebuilding
  `powerMsg`/`stateMsg`/`usageMsg`/`statusMsg` separately in the UI.
- Overview transition logging keeps `device_overview_changed` for single-device transitions and
  emits `device_overview_changes` when one rebuild produces multiple changed device rows. The
  batched `devices` entries should keep the same per-device fields as the single-device event.
- Plan rebuild scheduler transition logs should stay structured and rate-limited by the
  intent-kind/reason tuple so repeated coalescing does not flood debug logs.
- When adding a new event, keep payload fields machine-friendly and consistent with existing unit
  naming such as `durationMs`, `powerW`, `kWh`, and explicit IDs.
- Capacity-state summary fields should stay semantically explicit. Do not reuse one counter name
  for planned shed selection, pending shed actuation, and currently active shed devices; log
  separate counters plus `summarySource`/`summarySourceAtMs` when the source snapshot can differ.
- Every home-scoped plan, executor, status, and hard-cap incident record must
  carry the stable `homeId`; use `'main'` for the Main home. Device-feed events
  remain device-scoped unless their producer has authoritative home ownership
  at the moment it emits.
- Do not label hourly-budget-derived thresholds or margins as plain hard-cap headroom. If a field
  comes from remaining-hour budget math, say so explicitly in the field name or adjacent text, and
  reserve `hardCapHeadroomKw` for actual `limitKw - totalKw` semantics.
- Add or update tests when changing the transport, correlation context, or emitted event shape.
- If a code path currently uses prose logging only, either migrate it fully to structured events
  or leave a TODO entry explaining the remaining gap instead of adding more prose logs.
