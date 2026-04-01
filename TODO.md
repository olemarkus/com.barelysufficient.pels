# TODO

Open backlog plus a temporary release-verification section. Remove the checked section again after
this release if it stops being useful.

## Release verification: completed in this cycle

### Dual-control stepped device intent model: implementation

- [x] `currentOn` override. Preserve raw `onoff=false` for stepped devices instead of deriving
      from step state. `resolveSteppedLoadCurrentState` checks `currentOn === false` before
      step-based inference.
- [x] Shedding order: step down all stepped devices before any turn-off. Preemptive step-down
      candidates sort before binary turn-off candidates regardless of priority.
      Files: `planShedding.ts`.
- [x] Expected power for `shed(turn_off)` stepped devices uses the lowest non-zero step at zero
      planning power instead of falling through to `powerKw ?? 1`.
- [x] Expected power for `shed(set_temperature)` stepped devices uses the same lowest non-zero
      step restore model for conservative planning.
      Files: `planRestoreSwap.ts`.
- [x] `keep` intent requires `onoff=true` for stepped devices. The executor reconciles stepped
      devices back on when they have `keep` intent and `currentState === 'off'`.
      Files: `planExecutor.ts`.
- [x] `shed(turn_off)` sets `onoff=false` in addition to off-step for stepped devices.
      Files: `planExecutor.ts`.
- [x] External drift reconciliation for `onoff` on stepped devices checks both
      `selectedStepId` and `currentState`, so binary drift triggers reconciliation just like
      step drift does.
      Files: `planReconcileState.ts`.
- [x] `shed_action = set_step` no longer increases commanded load. It now targets the lowest
      non-zero step, returns no-op when the device is already off, degrades safely when no
      non-zero step exists, and no longer exposes step selection in settings.
      Files: `lib/plan/planSteppedLoad.ts`, `lib/plan/planShedding.ts`.

### Dual-control stepped device intent model: tests and scenarios

- [x] Preemptive stepped device sorts before higher-priority binary device.
- [x] Stepped device above lowest-active steps down before one at lowest-active transitions to
      off.
- [x] Two stepped devices plus one binary device with multi-cycle overshoot keeps binary turn-off
      deferred until both stepped devices reach their lowest active step.
- [x] `currentOn=false` on a stepped device at a non-off step is treated as off by planning.
- [x] Stepped device at off-step with `turn_off` intent uses the lowest non-zero step for
      restore headroom, not 0 or fallback 1.
- [x] Stepped device with `set_temperature` shed behavior uses the lowest non-zero step for
      expected power planning.
- [x] Stepped device with `keep` intent and `onoff=false` reconciles back on.
- [x] Stepped device with `keep` intent and `step=0` reconciles back to a non-zero step.
- [x] Stepped device with both `onoff=false` and `step=0` with `keep` intent fixes both.
- [x] Stepped device at lowest active step with `turn_off` ends up at off-step and `onoff=false`.
- [x] Intent `keep`, external actor sets `onoff=false`: PELS turns it back on.
- [x] Intent `keep`, external actor sets `step=0`: PELS restores a non-zero step.
- [x] Intent `shed(set_step)`, external actor raises step: PELS re-issues the shed step.
- [x] Shed drift with binary off plus retained higher step is detected and driven to the lowest
      step even if `onoff=false` and `measured=0`.
- [x] Restore headroom for shed device with stale retained step uses the `off -> low` path,
      not a path derived from the stale step.
- [x] Positive restore-feasibility: headroom enough for `low` but not `medium/max`; restore is
      allowed.
- [x] Negative restore-feasibility: headroom not enough for `low`; restore is blocked with the
      correct reason.
- [x] First restore target after shed is always the lowest non-zero step (`low`).
- [x] Drift correction and restore planning use the same "lowest step" model.
- [x] UI/state derivation consistency: shed devices are presented as `off` and restore state uses
      the correct baseline.
- [x] End-to-end scenario: shed -> binary off + retained step -> drift correction -> restore
      feasibility -> restore to `low`.

### State integrity progress completed

- [x] Added `binaryCommandPending` to `DevicePlanDevice`, populated it from
      `state.pendingBinaryCommands`, and exposed it to the UI via `PlanDeviceSnapshot`.
      Files: `planTypes.ts`, `planDevices.ts`.
- [x] Stopped binary restore writes from flipping local observed `currentOn` to `true`.
      Binary turn-on now stays pending until telemetry confirms it; only turn-off keeps the
      optimistic local preservation path.
      Files: `deviceManager.ts`.
- [x] Updated the UI to show "Restore requested" when `binaryCommandPending=true` and the device
      is off, instead of presenting it as confirmed "Restoring".
      Files: `packages/settings-ui/src/ui/plan.ts`.
- [x] Kept `binaryCommandPending` until confirmed telemetry or timeout only, and added explicit
      waiting/debug logs for contradictory pending observations. EV pending confirmation now
      follows `evChargingState` instead of generic `currentOn`.
      Files: `planBinaryControl.ts`.
- [x] Added device-level freshness tracking and stale-refresh merge rules. `lastLocalWriteMs`
      and `lastFreshDataMs` now flow through snapshots, stale fetches preserve fresher local
      writes and `device.update` observations, and power-only realtime updates no longer get
      silently overwritten by an older snapshot refresh.
      Files: `deviceManager.ts`, `deviceManagerRuntime.ts`.
- [x] Added per-device communication-model timing for slow devices. Binary pending windows,
      stepped pending windows, and realtime reconcile suppression now stay conservative for
      cloud/laggy devices instead of reissuing or drifting early.
      Files: `planBinaryControl.ts`, `appDeviceControlHelpers.ts`, `planReconcileState.ts`.
- [x] Made pending binary restores visible to shedding as provisional live load, so a requested
      but unconfirmed restore is not invisible during overshoot protection.
      Files: `planShedding.ts`.
- [x] Tightened stale-observation handling and post-actuation refresh coverage. Planning and
      reconciliation now treat stale observations as uncertain instead of restoring/reconciling
      from them, stale-off devices stay conservatively shed-eligible, and direct shedding uses the
      same targeted post-actuation refresh path as rebuild/reconcile.
      Files: `planObservationPolicy.ts`, `planDevices.ts`, `planRestoreDevices.ts`,
      `planReconcileState.ts`, `planShedding.ts`, `planService.ts`, `app.ts`.
- [x] Stopped recent local writes from masking old live observations in stale detection. Fresh
      telemetry timestamps now take precedence over local intent timestamps when deciding whether
      a device observation has gone stale.
      Files: `planObservationPolicy.ts`.
- [x] Stopped stale recently shed devices from blocking unrelated stepped restores through the
      pending-recovery path, and aligned stepped live-plan state resolution with the same
      off-step classification used during initial planning.
      Files: `planRestoreHelpers.ts`, `planReconcileState.ts`.
- [x] Audited `measuredPowerKw` source handling so it stays tied to trusted power telemetry
      (`measure_power`, meter deltas, and live-power telemetry) rather than configured load,
      Homey energy expected-power estimates, or step-derived nominal power.
      Files: `powerEstimate.ts`, `deviceManager.ts`.
- [x] Stopped overwriting `expectedPowerKw` with `planningPowerKw` in runtime and settings UI
      decoration. `planningPowerKw` and `expectedPowerKw` now stay independent, and
      `'step-planning'` was removed from `expectedPowerSource`.
      Files: `appDeviceControlHelpers.ts`, `deviceControlProfiles.ts`, `planTypes.ts`,
      `packages/contracts/src/types.ts`.

### Duplicate logic already removed

- [x] Extracted shared `setBinaryControl` boilerplate into a private `PlanExecutor` helper so the
      dependency bag is no longer duplicated across the executor call sites.
      Files: `planExecutor.ts`.
- [x] Merged `setEvBinaryControl` and `setStandardBinaryControl` into a single
      `setBinaryControl` implementation with EV-specific logging where needed.
      Files: `planBinaryControl.ts`.

## P0 Correctness: stale data, confirmation, and observation integrity

These items are highest priority because they can make PELS act on state that is no longer true,
or present requested state as confirmed reality.

- [x] Remove the dead `preserveFresherRealtimeCapabilityObservations` path and its unused
      supporting freshness helpers (`realtimeCapabilities`,
      `shouldKeepFetchedTargetAfterNewerLocalWrite`, and related debug plumbing). The code
      suggests per-capability freshness exists, but nothing writes those observations.
      Files: `deviceManager.ts`, `appDebugHelpers.ts`, `appDebugHelpers.test.ts`.
- [x] Add `lastLocalWriteMs` and `lastFreshDataMs` per device. Use them to compare local writes,
      full snapshot refreshes, and `device.update` events so fresher observations win.
      Files: `deviceManager.ts`, `planState.ts` or equivalent runtime state.
- [x] In snapshot refresh, preserve locally written control values when Homey data is older than
      the last local write instead of replacing the snapshot wholesale.
      Files: `deviceManager.ts`, `appDeviceControlHelpers.ts`.
- [x] Stop binary restore writes from setting local observed `currentOn=true` optimistically.
      Keep restore intent in pending state until telemetry confirms it.
      Files: `deviceManager.ts`.
- [x] Clear or expire `binaryCommandPending` from confirmed telemetry or timeout only, matching
      the step-command pending model. Record contradictory live observations while pending so
      unexpected behavior is visible in debug logs, and confirm EV pending state from
      `evChargingState`.
      Files: `planBinaryControl.ts`.
- [x] Trigger targeted post-actuation refreshes or realtime measured-power updates after
      restore/shed writes so `measuredPowerKw` does not stay stale until the next half-hour
      snapshot.
      Files: `planService.ts`, `app.ts`, snapshot refresh pipeline.
- [x] Treat devices with stale observations as uncertain during planning and reconciliation
      instead of acting on outdated state. Start with a simple threshold such as "no fresh
      snapshot/update/write within 5 minutes".
      Files: `planObservationPolicy.ts`, `planDevices.ts`, `planRestoreDevices.ts`,
      `planReconcileState.ts`, `planShedding.ts`.
- [x] Add `communicationModel: 'local' | 'cloud'` to device config / plan input and use it to
      scale confirmation windows, drift detection, and reconciliation aggressiveness.
      Anchor scenario: a Connected 300 may take about 60s from command send to confirmative
      telemetry. During that full window, PELS should stay in pending/awaiting-confirmation
      state without treating the device as confirmed on, reissuing the command, or declaring
      drift prematurely. That includes avoiding restore retry loops caused by a pending timeout
      that expires before a slow device has any chance to report confirmed state. The same
      principle also applies to slow stepped-load confirmations where a step change takes
      similar time to show up in trusted telemetry.
      Files: `planTypes.ts`, device config, `planBinaryControl.ts`,
      `appDeviceControlHelpers.ts`, `planReconcileState.ts`.
- [x] Make downward stepped-load changes conservative end-to-end. A pending step-down may update
      desired state, but planning and overshoot protection must keep using the last confirmed /
      effective step and power until telemetry confirms the lower step. Do not count unconfirmed
      freed capacity early, and make repeated downward requests collapse cleanly without treating
      desired step as confirmed actual state.
      Files: `appDeviceControlHelpers.ts`, `planSteppedLoad.ts`, `planShedding.ts`,
      `planDevices.ts`, `planExecutor.ts`.
- [x] Enforce one shared restore cooldown gate for every capacity-driven restore path. Normal
      restore, swap restore, stepped restore, rebuild-triggered restore, and feedback-triggered
      restore should all consult the same cooldown state and emit a clear "blocked by cooldown"
      reason when headroom exists but restore is still intentionally delayed.
      Files: `planRestore.ts`, `planRestoreDevices.ts`, `planBuilder.ts`, `planReasons.ts`.
- [x] Preserve enough provisional post-command state for laggy/cloud devices that a requested but
      unconfirmed restore is not invisible to overshoot control. Today a device can remain
      `currentOn=false` until telemetry arrives even if it has already started drawing power,
      which can exclude it from shedding candidates and weaken hard-cap protection.
      Files: planning/reconciliation state model, `planShedding.ts`, `planDevices.ts`,
      `planReconcileState.ts`.
- [x] Make binary drift/reconcile state internally consistent. Realtime updates should refresh
      observed state before drift evaluation, drift reapply should always target plan state, and
      logs should separate observed transition from corrective command direction instead of
      implying that PELS is intentionally applying the drifted state.
      Files: `deviceManagerRealtimeHandlers.ts`, `appRealtimeDeviceReconcile.ts`,
      `appRealtimeDeviceReconcileRuntime.ts`, `planReconcileState.ts`, `planExecutor.ts`.
- [x] Audit `measuredPowerKw` assignment so it only comes from trusted power telemetry
      (`measure_power`, meter deltas, or live-power telemetry), never configured load, expected
      load, or step-derived nominal power.
      Files: `powerEstimate.ts`, `deviceManager.ts`, snapshot decoration pipeline.
- [ ] If the simpler freshness model is still insufficient for cloud devices, add
      per-capability realtime subscriptions for control capabilities (`onoff`,
      `evcharger_charging`, `target_temperature`) on managed devices.
      Files: `deviceManager.ts`.
- [ ] Fix `flushRealtimeDeviceReconcileQueue` attempt recording so when
      `shouldRecordAttempt` reports that no devices still drift after reconcile, PELS does not
      fall back to logging/recording all eligible devices or open the circuit breaker early.
      Files: `lib/app/appRealtimeDeviceReconcile.ts`, realtime reconcile tests.
- [x] Back off repeated target-temperature retries for persistently unreachable devices and surface
      a temporary-unavailable state in logs/status instead of re-sending the same doomed command
      every cycle.
      Files: `lib/plan/planTargetControl.ts`, diagnostics/logging, tests.
- [ ] Audit target confirmation semantics for temperature devices so
      "Target still waiting for confirmation" compares against the confirmed target/setpoint
      capability rather than observed room temperature.
      Files: `lib/plan/planTargetControl.ts`, target confirmation tests.
- [ ] Reduce restore ping-pong / shedding churn when a just-restored device is followed by a
      predictable stepped-load or EV ramp. PELS should not restore into headroom that will vanish
      inside the same convergence window and immediately force a re-shed.
      Follow-up direction: reserve provisional restore load until the device confirms the requested
      binary/step transition, and anchor restore cooldown from confirmation time rather than command
      send time. This should prevent double-spending headroom during pending restore convergence
      without relying on laggy per-device power telemetry.
      Files: restore/headroom/shedding logic, mixed restore/shedding tests.

## P1 Correctness, inefficiency, and cleanup follow-ups

These are important follow-ups, but they are a mix of correctness bugs, avoidable inefficiencies,
and code-cleanup work. Keep them separated so the behavioral fixes do not get buried under larger
refactors.

### P1 Bugs: conflicting models and wrong answers

- [ ] Document the intended fallback order per consumer and align power resolution across
      `resolveCandidatePower`, `estimateRestorePower`, `resolveUsageKw`, and stepped-load power
      resolution to that model.
      Files: `planCandidatePower.ts`, `planRestoreSwap.ts`, `planUsage.ts`,
      `planSteppedLoad.ts`.
- [ ] Align `currentOn` vs `currentState` checks across shedding, restore, reconciliation, and
      executor logic so the same device does not look "off" in one stage and "on" in another.
      Files: `planShedding.ts`, `planRestoreDevices.ts`, `planReconcileState.ts`,
      `planExecutor.ts`.
- [ ] Standardize restore eligibility checks across normal restore, stepped restore, and swap
      restore so "can this device restore?" has one consistent answer.
      Files: `planRestoreDevices.ts`, `planRestoreSwap.ts`.
- [ ] Pick one source of truth for the controlled vs uncontrolled power split. Today the plan
      builder and `PowerTracker` compute it independently and can drift.
      Files: `powerTracker.ts`, `planBuilder.ts`, `planUsage.ts`.
- [ ] Make planner and guard use the same soft-limit model. The dynamic plan budget limit and the
      guard's static margin should not produce different headroom answers at the same time.
      Files: `planBudget.ts`, `capacityGuard.ts`, `planContext.ts`.
- [ ] Add hysteresis to shedding active state so power oscillation near the limit does not flip
      shed/restore state every few seconds.
      Files: `capacityGuard.ts`, `planSheddingGuard.ts`.

### P1 Structured logging: runtime coverage and correlation

- [ ] Expand structured events for the highest-value runtime failure/control paths that still only
      emit prose/debug logs, starting with command actuation, executor outcomes, periodic/status
      output, and the remaining startup/background-task paths.
      Files: `planExecutor.ts`, runtime helpers in `app.ts`, startup helpers, tests.
- [ ] Add bounded `reasonCode` values for important failures, fallback paths, and degraded-state
      decisions instead of relying on free-form prose or exception text alone.
      Files: `lib/logging/`, price/device/startup/runtime failure paths, tests.
- [ ] Expand ALS correlation helpers beyond rebuilds. Add shared helpers for flow-scoped IDs such
      as `incidentId`, `snapshotId`, and `priceRefreshId`, generated with `crypto.randomUUID()`
      and propagated automatically across async boundaries.
      Files: `lib/logging/alsContext.ts`, `lib/logging/logger.ts`, overshoot/snapshot/price flows,
      logging tests.
- [ ] Add the next high-value structured events:
      `capacity_action_selected`, `price_source_fallback_used`, `device_state_unknown_entered`,
      `ui_snapshot_written`, and degraded-mode boundary events.
      Files: capacity handling, price services, device manager/UI snapshot writers, tests.
- [ ] Emit compact summary snapshot events only at key boundaries such as startup completion,
      device snapshot refresh completion, plan rebuild completion, UI snapshot writes, and
      degraded-mode enter/exit. Keep payloads bounded and machine-friendly.
      Files: startup, device manager, plan service, UI snapshot write paths, tests.
- [ ] Extend logging tests to cover end-to-end correlation and boundary behavior, including
      overshoot incidents grouped by `incidentId`, rebuild flows grouped by `rebuildId`, nested
      ALS contexts, and Homey forwarding for correlated structured events.
      Files: `test/logging/`, flow-specific runtime tests.

### P2 Structured logging: schema and cleanup polish

- [ ] Add typed structured-log event/reason-code definitions and migrate the current stringly
      typed event names / reason codes to them so payloads do not drift across services.
      Files: `lib/logging/`, structured-log call sites, logging tests.
- [ ] Replace ad hoc `Date.now() + Math.random()` correlation IDs such as `incidentId` and
      `rebuildId` with `crypto.randomUUID()` so generated IDs are uniform and do not encode
      accidental timestamp semantics.
      Files: `capacityGuard.ts`, `planService.ts`, logging tests.
- [ ] Finish the structured logging policy migration so runtime logging no longer depends on prose
      `this.log()` / `this.logDebug()` messages. Spell out the target end-state, how debug-topic
      filtering applies to structured debug events, and which legacy prose log sites remain to be
      removed.
      Files: `AGENTS.md`, `notes/`, logging helpers, remaining runtime log call sites.
- [x] Add a contributor-facing structured logging note covering current event inventory,
      ALS context (`rebuildId`), incident correlation, transport constraints, and test guidance
      for new event emitters / destinations.
      Files: `notes/README.md`, `notes/logging/README.md`, logging tests.

### P1 Inefficiencies: unnecessary work or repeated lookups

- [ ] Cache snapshot lookup by device ID in `applyPlanActions` instead of repeating
      `latestTargetSnapshot.find(...)` across action paths.
      Files: `planExecutor.ts`.

### P1 Cleanup: reduce duplicate logic and state-model sprawl

- [ ] Remove duplicate stepped-state derivation in `resolveSteppedLoadCurrentState` and rely on
      the already decorated snapshot state instead of deriving the same intent twice.
      Files: `planSteppedLoad.ts`, `planDevices.ts`.
- [ ] Consolidate stepped-load state naming and storage across runtime state, decorated snapshot,
      and `DevicePlanDevice`. Reduce copied fields and rename confusing carry-forward state such
      as "previous desired step" data.
      Files: `appDeviceControlHelpers.ts`, `planDevices.ts`, `planTypes.ts`.
- [ ] Replace the four pending-state systems (binary, target, step, shed/restore) with a more
      consistent per-device pending-action model and shared timeout / confirmation semantics.
      Files: `planState.ts`, `planBinaryControl.ts`, `planTargetControl.ts`,
      `appDeviceControlHelpers.ts`.
- [ ] Merge temperature-target and binary-power actuation settlement, retry policy, pending vs
      observed semantics, and logging behind one shared control pipeline instead of two parallel
      implementations that drift.
      Files: `planBinaryControl.ts`, `planTargetControl.ts`, `planExecutor.ts`,
      pending/logging helpers.
- [ ] Make stepped-load logs name their source of truth explicitly. Requested/confirmed step logs
      should distinguish desired step, last confirmed step, effective planning step, and externally
      observed step so stale desired state is never presented as actual device state and
      "outside PELS" followed by a later PELS request is easy to interpret.
      Files: stepped feedback logging path, `planExecutor.ts`, `planLogging.ts`.
- [ ] Replace the 30+ field `DevicePlanDevice` bag with tighter types where shed behavior and
      control-model-specific fields are coupled instead of independent optionals.
      Files: `planTypes.ts`.

## P2 Product and test follow-ups

- [ ] Rework temperature-device starvation detection to the intended-target / suppression-only
      model described in `notes/starvation/README.md`. This is detection only: it must not change
      planner decisions. Includes pauseable accumulation, counting vs pause reasons, overview
      badge/status suffix, insights, diagnostics/logs, and once-per-episode duration-threshold
      flow triggers.
      Files: diagnostics model/service, plan snapshot/contracts/UI, flow cards, insights.
- [ ] Treat stepped-load upward transitions for already-on devices as active mode transitions, not
      restore UI. `low -> medium/max` should not show a gray `Restoring` badge/text just because
      the target step changed.
      Files: `packages/settings-ui/src/ui/plan.ts`, plan state/status derivation.
- [ ] Debounce/coalesce rapid temperature changes from the device tab so bulk edits do not flap
      the plan or spam writes/retries.
      Files: settings UI device detail, target write path, tests.
- [ ] Add a budget-exemption toggle on the device page so a device can be marked or unmarked as
      budget-exempt without leaving the device detail flow.
      Files: settings UI device detail, settings write path, tests.
- [ ] Add gray badge/state handling for unknown or disappeared devices in the overview/device list
      instead of leaving them visually ambiguous.
      Files: settings UI overview / device list.
- [ ] Expose yesterday's daily-budget deviation as variables/tags and surface it in daily-budget
      data where useful.
      Files: daily budget API, flow cards, UI/contracts.
- [ ] Add headroom threshold flow cards for crossing above/below a configured threshold. Support
      generic triggers/conditions rather than only per-device headroom checks.
      Files: `flowCards/registerFlowCards.ts`, flow-card tests.
- [ ] Add a mode-switch surface to the insights device so flows and dashboards can drive or show
      operating mode more directly.
      Files: `drivers/pels_insights/**`, related flow cards/capabilities.
- [ ] Align restore-cooldown badge/state text in the plan UI. Either add a dedicated badge state
      or make badge text match the existing state line, and audit true shed devices so they do not
      accidentally render as neutral gray.
      Files: `packages/settings-ui/src/ui/plan.ts`.
- [ ] Rename the restore-cooldown plan UI test so the description matches the actual assertion.
      Files: `packages/settings-ui/test/plan-ui.test.ts`.
- [ ] Add stepped-load coverage for profiles without an explicit off-step. Shed should converge to
      the lowest available step instead of assuming a synthetic off-step exists.
      Files: stepped-load planning / executor tests.
- [ ] Add remaining restore-pending follow-up tests for per-device scoping, retry-window expiry,
      confirmation clearing, no-false-pending cases, unaffected on/off restore flow, and status
      classification. Slow-device confirmation timing and provisional-live-load behavior now have
      dedicated coverage; keep this item focused on the remaining pending-state gaps.
      Files: restore / reconciliation / status test suites.
- [x] Add conservative pending-step test coverage: delayed `Max -> Low` confirmation must not
      free headroom early, overshoot during pending step-down must still shed other loads, and
      repeated downward requests must coalesce without changing effective planning power before
      confirmation.
      Files: stepped-load planning / shedding tests, mixed restore/shedding integration tests.
- [ ] Add restore-cooldown branch-coverage tests so rebuild-triggered restore, swap restore, and
      feedback-triggered restore all respect the same cooldown gate and log why restore was
      blocked.
      Files: restore planning / app integration tests.
- [ ] Add remaining binary drift consistency tests that assert observed-state update ordering and
      correct reapply target direction across realtime -> reconcile integration. Pending-command
      suppression now has dedicated coverage; keep this item focused on the missing drift path
      assertions.
      Files: realtime reconcile tests, device manager realtime tests, executor/reconcile tests.

## P3 Architecture, tooling, and perf tightening

- [ ] Remove the remaining `lib/utils/** -> lib/{core,plan}` imports by moving those helpers to
      better owned modules, then make the architecture check strict instead of advisory.
      Files: `lib/utils/settingsHandlers.ts`, `lib/utils/capacityHelpers.ts`,
      `lib/utils/appTypeGuards.ts`, architecture checks.
- [ ] Expand unused-export checks to cover the shared packages and settings UI, then remove the
      temporary allowlist exceptions that exist only because those areas are not checked yet.
      Files: `scripts/check-dead-code.mjs`, `tsconfig.runtime-unused.json`,
      `packages/contracts/**`, `packages/shared-domain/**`, `packages/settings-ui/**`.
- [ ] Tighten hot-path perf linting by changing `unicorn/no-array-reduce` to
      `{ allowSimpleOperations: false }` once the remaining reducers are migrated.
      Files: `eslint.config.mjs`, `lib/plan/planShedding.ts`,
      `lib/dailyBudget/dailyBudgetAllocation.ts`, `lib/dailyBudget/dailyBudgetConfidence.ts`,
      `lib/dailyBudget/dailyBudgetMath.ts`, `lib/dailyBudget/dailyBudgetService.ts`.
- [ ] Expand hot-path iteration rules (`no-array-for-each`, `no-array-reduce`, loop allocation
      bans) from `lib/{core,plan,dailyBudget}` to the rest of runtime after violations are
      cleaned up.
      Files: `app.ts`, `flowCards/**`, `drivers/**`, lint config.
- [ ] Re-enable `functional/immutable-data` for hot-path overrides once intentional mutable fast
      paths are isolated behind explicit, well-scoped exceptions.
      Files: `eslint.config.mjs`, hot-path runtime modules.
- [ ] Enable targeted `no-await-in-loop` in safe non-actuation loops after documenting approved
      sequential-actuation patterns.
      Files: lint config, loop call sites.
- [x] Gate `logNextDayPlanDebug` behind the debug flag early so production plan rebuilds do not
      pay for an unnecessary "tomorrow" `buildPlan()` call.
      Files: `lib/dailyBudget/dailyBudgetManager.ts`, `lib/dailyBudget/dailyBudgetNextDayDebug.ts`.
- [ ] Precompute shared zone/hour lookup data during plan rebuild so `resolveRemainingCaps`,
      `resolveRemainingFloors`, and `buildControlledMinFloors` do not repeatedly call
      `getZonedParts`.
      Files: plan rebuild helpers.
- [ ] Investigate long-running `planRebuildApply` stalls (observed `applyMs` up to ~90s) and add
      enough timing / queue instrumentation to distinguish slow Homey writes, delayed refreshes,
      and local sequencing bottlenecks before they distort cooldown and control timing.
      Files: apply path instrumentation, perf logging, executor / plan service timing.
- [ ] Avoid full plan rebuilds on every power sample. Sample updates should normally refresh
      headroom/status only, and rebuild the full plan only when PELS crosses a control boundary
      (over a limit, into another protection mode, or enough headroom exists to recover another
      device).
      Files: power update pipeline, rebuild scheduler, plan status/headroom path.

## P4 Future extensibility

- [ ] Introduce a pluggable pricing strategy interface so non-Norwegian price schemes can swap in
      their own calculators without touching control logic.
      Files: pricing domain / aggregation pipeline.
- [ ] Auto-adjust daily budget from past eligible exemptions using the policy in
      `notes/daily-budget-auto-adjust/README.md`. Keep base budget, correction, and effective
      budget separate, and derive correction from completed-day eligible exempted kWh rather than
      starved minutes.
      Files: daily budget state/service/UI/settings/diagnostics.
- [ ] Support configurable per-device cooldowns for restore/shedding behavior instead of a single
      global timing model.
      Files: device config, restore/shedding timing, settings UI.
- [ ] Support explicit headroom reservations within the budget model (`book X kW for X minutes`)
      so predictable near-term loads can reserve capacity/headroom.
      Files: headroom/daily budget planning, UI/flows.
- [ ] Restore more than one device at a time when headroom allows, e.g. restore a configurable
      share of headroom rather than strict one-by-one reactivation.
      Files: restore planner/executor/tests.
- [ ] Make price influence more explainable and adaptive to actual price spread, so users can see
      that price weighting is doing real work and the effect scales with volatility.
      Files: price optimization, daily budget, settings UI.
- [ ] Explore weather-aware budget context or diagnostics so current budget pressure can be
      compared with recent weather / heat demand.
      Files: daily budget analytics/UI.
- [ ] Store a small per-device action log ring buffer and expose it in the UI so users can inspect
      hysteresis, price-driven changes, sheds, restores, and other recent actions.
      Files: diagnostics/history storage, settings UI.

## P5 Product, docs, and integration backlog

- [ ] Rewrite landing-page / getting-started copy to emphasize automatic and intelligent control,
      hard-cap setup, usage-flow setup, modes/targets/priorities, and mode-switch flows; remove
      contributor-oriented copy from end-user docs and simplify over-technical early sections.
      Files: website / published docs.
- [ ] Add a Homey Energy-only how-to for users who want PELS without extra integrations.
      Files: website / published docs.
- [ ] Add a proper daily-budget how-to with a worked budget-exemption example.
      Files: website / published docs.
- [ ] Add website metadata and refresh branding assets/copy, including a non-black PELS logo.
      Files: app/site metadata, branding assets.
- [ ] Revisit daily-budget history navigation: remove the 7/14-day toggle, add week navigation,
      and consider merging hourly details plus daily history into one shared view.
      Files: settings UI daily-budget views/components.
- [ ] Replace the hourly price list with a line graph for today/tomorrow with cheap/expensive
      background bands and the existing tooltip content.
      Files: settings UI prices/daily-budget charts.
- [ ] Fix the mobile vs web color-scheme mismatch so the visual language is consistent across
      surfaces.
      Files: settings UI / website styling.
- [ ] Design a virtual thermostat driver based on the examples in `tmp`, focusing on pairing,
      settings, repair, and overall user UX before implementation.
      Files: new driver design / UX note / `tmp` review.
- [ ] Add a virtual EV charger / proxy driver that proxies official capabilities by default,
      allows optional extra capability mapping via settings or flows, hides the proxy from the
      main settings device list, uses device class `other`, and supports stepped charging /
      unsupported chargers such as Easee and Zaptec.
      Files: new driver(s), pairing/settings integration, device discovery/UI.
- [ ] Add generic proxy / flow-owned devices for unsupported integrations (for example Flexit) and
      flow-only controllable loads that are hidden by default but can participate in
      price/capacity control when configured.
      Files: new drivers, settings UI, flow cards.
