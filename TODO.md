# TODO

## Backlog

- [ ] Architecture tightening: remove remaining `lib/utils/** -> lib/{core,plan}` imports by moving those helpers to a better-owned module (current checks warn, not fail).
- [ ] Dead-code tightening: expand the dead-code export check to include `packages/contracts/**` and `packages/shared-domain/**` so temporary allowlisted runtime exports can be removed.
- [ ] Perf lint tightening: change `unicorn/no-array-reduce` in hot-path runtime code from `allowSimpleOperations: true` to `false` after remaining reducers are migrated.
- [ ] Perf lint tightening: expand hot-path iteration rules (`no-array-for-each`, `no-array-reduce`, loop allocation bans) from `lib/{core,plan,dailyBudget}` to the rest of runtime (`app.ts`, `flowCards/**`, `drivers/**`) once violations are cleaned.
- [ ] Perf lint tightening: re-enable `functional/immutable-data` for hot-path overrides once intentional mutable fast-paths are isolated behind explicit, well-scoped exceptions.
- [ ] Perf lint tightening: enable targeted `no-await-in-loop` in safe non-actuation loops after documenting approved sequential-actuation patterns.
- [ ] Gate `logNextDayPlanDebug` behind debug flag early: the call at `dailyBudgetManager.ts:183` runs a full `buildPlan` for tomorrow on every plan rebuild; ensure `shouldLog` is reliably false in production so the extra plan build is skipped.
- [ ] Reduce `getZonedParts` calls in plan rebuild: `resolveRemainingCaps`, `resolveRemainingFloors`, and `buildControlledMinFloors` each call `getZonedParts` per bucket (~72 calls total); pre-compute a `bucketHour[]` map once and share it.
- [ ] Extract `setBinaryControl` boilerplate into a private `PlanExecutor` helper. The dependency
  bag (`state`, `deviceManager`, `updateLocalSnapshot`, `log`, `logDebug`, `error`) is duplicated
  across `applySteppedLoadShedOff`, `applySteppedLoadRestore`, `applyRestorePower`,
  `applyUncontrolledRestore`, and `turnOffDevice`.
  Files: `planExecutor.ts`.

## Dual-control stepped device intent model

Devices like the Connected 300 have both binary power state (`onoff`) and a stepped power mode
(`step`, where one step may represent 0 W). PELS must own device intent and distinguish between
observed state, desired state, and expected power.

### Core principle

During a shed event, the first action is always to step down stepped devices (following priority
order). Turning off any device should only happen when all stepped devices are at their lowest
non-zero step.

### Implementation gaps

- [x] **`currentOn` override.**
  `appDeviceControlHelpers.ts` decorator preserves raw `onoff=false` for stepped devices instead
  of deriving from step state. `resolveSteppedLoadCurrentState` checks `currentOn === false`
  before step-based inference.

- [x] **Shedding order: step down ALL stepped devices before ANY turn-off.**
  Preemptive step-down candidates sort before binary turn-off candidates regardless of priority.
  Files: `planShedding.ts` (`sortCandidates`).

- [x] **Expected power for `shed(turn_off)` stepped devices.**
  `estimateRestorePower` now uses the lowest non-zero step for stepped devices at zero planning
  power, instead of falling through to `powerKw ?? 1`. `computeBaseRestoreNeed` simplified to
  `computeRestoreNeeded`.

- [x] **Expected power for `shed(set_temperature)` stepped devices.**
  Covered by the same `estimateRestorePower` change — stepped devices at zero planning power
  use the lowest non-zero step for conservative planning.
  Files: `planRestoreSwap.ts` (`estimateRestorePower`).

- [x] **`keep` intent requires `onoff=true` for stepped devices.**
  `applySteppedLoadRestore` in the executor reconciles stepped devices back to on when they have
  `keep` intent and `currentState === 'off'`, using the standard `setBinaryControl` path.
  Files: `planExecutor.ts` (`applySteppedLoadRestore`).

- [x] **`shed(turn_off)` should set `onoff=false` in addition to off-step.**
  `applySteppedLoadShedOff` in `planExecutor.ts` sets `onoff=false` via `setBinaryControl` when
  a stepped device is at the off-step during a shed. Covers the dual-control case where the step
  command alone leaves the binary power state on.
  Files: `planExecutor.ts`.

- [ ] **External drift reconciliation for `onoff` on stepped devices.**
  `planReconcileState.ts` detects step drift but not `onoff` drift. If an external actor turns
  off a stepped device that should be `keep`, or raises the step on a `shed(set_step)` device,
  the `onoff` state is not corrected.
  Files: `planReconcileState.ts`, `planExecutor.ts`.

### Missing tests

- [x] Preemptive stepped device sorts before higher-priority binary device.
- [x] Stepped device above lowest-active steps down before one at lowest-active transitions to off.
- [ ] Two stepped devices at different priorities + one binary device, overshoot requires multiple
  cycles. Verify both stepped devices reach lowest active step before the binary device turns off.
- [ ] `currentOn=false` on a stepped device at a non-off step: plan sees device as off, not
  consuming power.
- [ ] Stepped device at off-step with `turn_off` intent. Verify restore headroom uses lowest
  non-zero step power, not 0 or fallback 1.
- [ ] Stepped device with `set_temperature` shed behavior. Verify expected power uses lowest
  non-zero step for planning.
- [x] Stepped device with `keep` intent and `onoff=false`. Verify reconciliation turns it on.
- [ ] Stepped device with `keep` intent and `step=0`. Verify reconciliation sets non-zero step.
- [ ] Both `onoff=false` and `step=0` with `keep` intent. Verify both are fixed.
- [x] Stepped device at lowest active step with `turn_off`. Verify device ends up at off-step
  AND `onoff=false`.
- [ ] Intent `keep`, external actor sets `onoff=false`. Verify PELS turns it back on.
- [ ] Intent `keep`, external actor sets `step=0`. Verify PELS sets a non-zero step.
- [ ] Intent `shed(set_step)`, external actor raises step. Verify PELS re-issues the shed step.

## Plan UI: restore-cooldown badge inconsistency

- [ ] `buildPlanStateLine()` shows "Shed (restore cooldown)" for restore-cooldown shed devices that
  are currently off/unknown, but `resolvePlanBadgeState()` / `buildPlanStateBadge()` still resolves
  to `restoring` in the same scenario. Introduce a dedicated badge state/label for restore cooldown
  or otherwise align the badge label with the state text.
  Files: `packages/settings-ui/src/ui/plan.ts`.

- [ ] Test `renders restore cooldown as restoring when the device is currently off` has a description
  that no longer matches its assertion ("Shed (restore cooldown)"). Rename to match current semantics.
  Files: `packages/settings-ui/test/plan-ui.test.ts`.

## Confirmation, freshness, and drift handling for dual-control stepped devices

Two integrity problems observed in production logs: (1) optimistic restore state is
treated as confirmed active state, and (2) stale PELS state outranks fresher observed
state from Homey/device telemetry.

### Phase 1: provisional restore state

- [ ] Stop `updateLocalSnapshot` from setting `currentOn=true` optimistically on restore writes.
  Use a pending/confirmation model similar to `stepCommandPending` for binary control. After a
  restore write, PELS should show "restore requested" / "pending confirmation" until fresh
  telemetry confirms the device is actually on.
  Files: `planBinaryControl.ts`, `planExecutor.ts`, `appDeviceControlHelpers.ts`.

### Phase 2: fresher observed state wins

- [ ] Ensure `decorateSnapshotWithDeviceControl` respects fresh Homey-reported state over stale
  PELS-internal optimistic state. If Homey reports `onoff=false` / `measure_power=0` with a
  newer timestamp than the PELS optimistic write, the fresher observed state must win.
  Files: `appDeviceControlHelpers.ts`, snapshot pipeline.

### Phase 3: separate drift logging

- [ ] Log step drift and binary drift separately for stepped devices. Required log patterns:
  `step drift: desired X, observed Y` and `binary drift: desired onoff=X, observed onoff=Y`.
  Files: `planReconcileState.ts`, `planExecutor.ts`.

### Phase 4: observed vs expected power separation

- [ ] Keep `observedPower` (real telemetry only) and `expectedPower` (planning) as distinct fields.
  Measured power must never be inferred from configured load, expected load, or step-derived
  nominal load. Only `observedPower` may answer "what is the device drawing now?"
  Files: snapshot types, `appDeviceControlHelpers.ts`, UI display code.

### Phase 5: full freshness tracking and confirmation state machine

- [ ] Add per-field freshness awareness (`onoff` age, measured power age, step age). PELS must not
  let an older internal/local state outrank a fresher observed device state.
- [ ] Introduce confirmation state vocabulary: `none`, `restore_requested`, `step_change_requested`,
  `pending_confirmation`, `confirmed`, `contradicted`.
- [ ] UI: show `On (pending confirmation)` or `Restore requested` instead of `Active` when restore
  is unconfirmed. Show `On, idle` or `On (0 W)` when confirmed on but measured power is 0.

## Deferred: restore-pending follow-up tests

- [ ] Per-device scoping: one temperature device is stuck at shed temperature, another is healthy; verify the healthy device can still restore while the stuck one stays pending.
- [ ] Retry window expiry: verify no repeated restore writes within `RESTORE_CONFIRM_RETRY_MS`, then exactly one new restore attempt is allowed after the window expires.
- [ ] Confirmation clears pending: when reported target moves from shed temperature to planned temperature, `restore pending` state disappears immediately.
- [ ] No false pending: device at shed temperature without a recent restore attempt (`lastDeviceRestoreMs` missing or stale) should not be marked `restore pending`.
- [ ] On/off restore path unaffected: ensure `restore pending` logic does not interfere with normal `onoff` restoration.
- [ ] Status classification: devices in `restore pending` should not count as limit-driven shedding in `pels_status.limitReason`.
