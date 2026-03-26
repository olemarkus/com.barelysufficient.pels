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

- [ ] Remove the dead `preserveFresherRealtimeCapabilityObservations` path and its unused
      supporting freshness helpers (`realtimeCapabilities`,
      `shouldKeepFetchedTargetAfterNewerLocalWrite`, and related debug plumbing). The code
      suggests per-capability freshness exists, but nothing writes those observations.
      Files: `deviceManager.ts`, `appDebugHelpers.ts`, `appDebugHelpers.test.ts`.
- [ ] Add `lastLocalWriteMs` and `lastFreshDataMs` per device. Use them to compare local writes,
      full snapshot refreshes, and `device.update` events so fresher observations win.
      Files: `deviceManager.ts`, `planState.ts` or equivalent runtime state.
- [ ] In snapshot refresh, preserve locally written control values when Homey data is older than
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
- [ ] Trigger targeted post-actuation refreshes or realtime measured-power updates after
      restore/shed writes so `measuredPowerKw` does not stay stale until the next half-hour
      snapshot.
      Files: `planExecutor.ts`, snapshot refresh pipeline.
- [ ] Treat devices with stale observations as uncertain during planning and reconciliation
      instead of acting on outdated state. Start with a simple threshold such as "no fresh
      snapshot/update/write within 5 minutes".
      Files: `planService.ts`, `planReconcileState.ts`.
- [ ] Add `communicationModel: 'local' | 'cloud'` to device config / plan input and use it to
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
- [ ] Preserve enough provisional post-command state for laggy/cloud devices that a requested but
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
- [ ] Audit `measuredPowerKw` assignment so it only comes from `measure_power` telemetry, never
      configured load, expected load, or step-derived nominal power.
      Files: `appDeviceControlHelpers.ts`, snapshot decoration pipeline.
- [ ] If the simpler freshness model is still insufficient for cloud devices, add
      per-capability realtime subscriptions for control capabilities (`onoff`,
      `evcharger_charging`, `target_temperature`) on managed devices.
      Files: `deviceManager.ts`.

## P1 Consistency: reduce duplicate logic and conflicting models

These items are next because they currently let different parts of the planner answer the same
question in different ways.

- [ ] Document the intended fallback order per consumer and align power resolution across
      `resolveCandidatePower`, `estimateRestorePower`, `resolveUsageKw`, and stepped-load power
      resolution to that model.
      Files: `planCandidatePower.ts`, `planRestoreSwap.ts`, `planUsage.ts`,
      `planSteppedLoad.ts`.
- [ ] Align `currentOn` vs `currentState` checks across shedding, restore, reconciliation, and
      executor logic so the same device does not look "off" in one stage and "on" in another.
      Files: `planShedding.ts`, `planRestoreDevices.ts`, `planReconcileState.ts`,
      `planExecutor.ts`.
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
- [ ] Make stepped-load logs name their source of truth explicitly. Requested/confirmed step logs
      should distinguish desired step, last confirmed step, and effective planning step so stale
      desired state is never presented as actual device state.
      Files: stepped feedback logging path, `planExecutor.ts`, `planLogging.ts`.
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
- [ ] Cache snapshot lookup by device ID in `applyPlanActions` instead of repeating
      `latestTargetSnapshot.find(...)` across action paths.
      Files: `planExecutor.ts`.
- [ ] Replace the 30+ field `DevicePlanDevice` bag with tighter types where shed behavior and
      control-model-specific fields are coupled instead of independent optionals.
      Files: `planTypes.ts`.

## P2 Product and test follow-ups

- [ ] Align restore-cooldown badge/state text in the plan UI. Either add a dedicated badge state
      or make badge text match the existing state line.
      Files: `packages/settings-ui/src/ui/plan.ts`.
- [ ] Rename the restore-cooldown plan UI test so the description matches the actual assertion.
      Files: `packages/settings-ui/test/plan-ui.test.ts`.
- [ ] Add stepped-load coverage for profiles without an explicit off-step. Shed should converge to
      the lowest available step instead of assuming a synthetic off-step exists.
      Files: stepped-load planning / executor tests.
- [ ] Add restore-pending follow-up tests for per-device scoping, retry-window expiry,
      confirmation clearing, no-false-pending cases, unaffected on/off restore flow, and status
      classification. Include slow-device cases where confirmation arrives after ~60s and verify
      PELS neither reissues restore prematurely nor loses track of likely-live load during the
      pending window.
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
- [ ] Add binary drift consistency tests that assert observed-state update ordering, correct
      reapply target direction, and duplicate reconcile suppression while an equivalent command is
      already pending.
      Files: realtime reconcile tests, device manager realtime tests, executor/reconcile tests.

## P3 Architecture, tooling, and perf tightening

- [ ] Remove the remaining `lib/utils/** -> lib/{core,plan}` imports by moving those helpers to
      better owned modules, then make the architecture check strict instead of advisory.
      Files: runtime helpers / architecture checks.
- [ ] Expand dead-code export checks to cover the shared packages and settings UI, then remove the
      temporary allowlist exceptions that exist only because those areas are not checked yet.
      Files: `scripts/check-dead-code.mjs`, `packages/contracts/**`, `packages/shared-domain/**`,
      `packages/settings-ui/**`.
- [ ] Tighten hot-path perf linting by changing `unicorn/no-array-reduce` to
      `{ allowSimpleOperations: false }` once the remaining reducers are migrated.
      Files: `eslint.config.mjs`, remaining reducer call sites.
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
- [ ] Gate `logNextDayPlanDebug` behind the debug flag early so production plan rebuilds do not
      pay for an unnecessary "tomorrow" `buildPlan()` call.
      Files: `dailyBudgetManager.ts`.
- [ ] Precompute shared zone/hour lookup data during plan rebuild so `resolveRemainingCaps`,
      `resolveRemainingFloors`, and `buildControlledMinFloors` do not repeatedly call
      `getZonedParts`.
      Files: plan rebuild helpers.
- [ ] Investigate long-running `planRebuildApply` stalls (observed `applyMs` up to ~90s) and add
      enough timing / queue instrumentation to distinguish slow Homey writes, delayed refreshes,
      and local sequencing bottlenecks before they distort cooldown and control timing.
      Files: apply path instrumentation, perf logging, executor / plan service timing.

## P4 Future extensibility

- [ ] Introduce a pluggable pricing strategy interface so non-Norwegian price schemes can swap in
      their own calculators without touching control logic.
      Files: pricing domain / aggregation pipeline.
