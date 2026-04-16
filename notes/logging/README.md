# Structured Logging Notes

> Status note: this document is still the logging policy reference, but the event inventory below
> is now a representative high-value slice rather than an exhaustive list. The codebase currently
> emits additional structured events beyond the ones enumerated here.

This note is for contributors changing runtime logging.

## Policy

- Runtime and operational logs should be structured.
- New runtime log points should use the pino logger path, not new prose `this.log()` /
  `this.logDebug()` messages.
- Human-readable strings belong in UI/status text, not runtime logs.
- Debug-topic flags should gate whether debug-level logging is emitted, not whether logs are
  structured.

## Current Model

- Root logger is created in `app.ts` with `createRootLogger(createHomeyDestination(...))`.
- Transport still routes by Homey SDK log level callbacks, but payloads should remain JSON
  objects with stable field names.
- AsyncLocalStorage already exists in `lib/logging/alsContext.ts` and currently injects
  `rebuildId` through `withRebuildContext(...)`.
- `incidentId` is still attached manually by `CapacityGuard`; other important flows still lack
  automatic correlation IDs.
- Debug-level structured events should follow the existing debug-topic model. When a topic is
  enabled, the corresponding child logger may lower its level to `debug`; otherwise debug events
  stay suppressed while higher-severity structured events still flow.

## Current Structured Events

- `plan_rebuild_started`
- `plan_rebuild_completed`
- `plan_snapshot_written`
- `plan_snapshot_write_throttled`
- `binary_command_applied`
- `binary_command_skipped`
- `binary_command_failed`
- `target_command_applied`
- `target_command_skipped`
- `target_command_failed`
- `stepped_load_command_requested`
- `stepped_load_command_skipped`
- `stepped_load_command_failed`
- `stepped_load_binary_transition_applied`
- `restore_command_skipped`
- `device_snapshot_refresh_completed`
- `target_devices_snapshot_written`
- `target_devices_snapshot_write_skipped`
- `periodic_status`
- `daily_budget_periodic_status`
- `capacity_overshoot_escalation_blocked`
- `overshoot_entered`
- `overshoot_cleared`
- `hard_cap_shortfall_detected`
- `hard_cap_shortfall_recovery_started`
- `hard_cap_shortfall_recovery_reset`
- `hard_cap_shortfall_recovered`
- `price_optimization_completed`
- `price_fetch_failed`
- `budget_recomputed`
- `app_initialized`
- `startup_step_failed`
- `startup_background_task_failed`
- `realtime_reconcile_queued`
- `realtime_reconcile_skipped_no_drift`
- `realtime_reconcile_suppressed`
- `realtime_reconcile_applied`
- `realtime_reconcile_circuit_opened`
- `realtime_reconcile_failed`

## Gaps Still Open

- Structured logging is still partial, but the highest-value executor failure/skip paths, UI
  snapshot writes, startup step/background-task failures, and the main price/overshoot boundary
  transitions are now structured.
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

## Contributor Guidance

- Prefer stable field names over embedding meaning in a formatted message string.
- When adding a new event, keep payload fields machine-friendly and consistent with existing unit
  naming such as `durationMs`, `powerW`, `kWh`, and explicit IDs.
- Capacity-state summary fields should stay semantically explicit. Do not reuse one counter name
  for planned shed selection, pending shed actuation, and currently active shed devices; log
  separate counters plus `summarySource`/`summarySourceAtMs` when the source snapshot can differ.
- Do not label hourly-budget-derived thresholds or margins as plain hard-cap headroom. If a field
  comes from remaining-hour budget math, say so explicitly in the field name or adjacent text, and
  reserve `hardCapHeadroomKw` for actual `limitKw - totalKw` semantics.
- Add or update tests when changing the transport, correlation context, or emitted event shape.
- If a code path currently uses prose logging only, either migrate it fully to structured events
  or leave a TODO entry explaining the remaining gap instead of adding more prose logs.
