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

- [x] **External drift reconciliation for `onoff` on stepped devices.**
  `hasRelevantBinaryExecutionDrift` in `planReconcileState.ts` now checks both `selectedStepId`
  and `currentState` for stepped devices, so binary (onoff) drift triggers reconciliation just
  like step drift does. The executor's `applySteppedLoadRestore` already handles the correction
  when reconciliation fires.
  Files: `planReconcileState.ts`.

### Missing tests

- [x] Preemptive stepped device sorts before higher-priority binary device.
- [x] Stepped device above lowest-active steps down before one at lowest-active transitions to off.
- [x] Two stepped devices + one binary device, overshoot requires multiple cycles. Verify both
  stepped devices reach lowest active step before the binary device turns off. Test uses distinct
  stepped priorities to exercise priority ordering among preemptive candidates.
- [x] `currentOn=false` on a stepped device at a non-off step: plan sees device as off, not
  consuming power.
  Covered by `appDeviceControlHelpers.test.ts` (`decorateSnapshotWithDeviceControl`).
- [x] Stepped device at off-step with `turn_off` intent. Verify restore headroom uses lowest
  non-zero step power, not 0 or fallback 1.
  Covered by `planRestoreSwap.test.ts` (`estimateRestorePower`).
- [x] Stepped device with `set_temperature` shed behavior. Verify expected power uses lowest
  non-zero step for planning.
  Covered by `planRestoreSwap.test.ts` (`estimateRestorePower`).
- [x] Stepped device with `keep` intent and `onoff=false`. Verify reconciliation turns it on.
- [x] Stepped device with `keep` intent and `step=0`. Verify reconciliation sets non-zero step.
- [x] Both `onoff=false` and `step=0` with `keep` intent. Verify both are fixed.
- [x] Stepped device at lowest active step with `turn_off`. Verify device ends up at off-step
  AND `onoff=false`.
- [x] Intent `keep`, external actor sets `onoff=false`. Verify PELS turns it back on.
- [x] Intent `keep`, external actor sets `step=0`. Verify PELS sets a non-zero step.
- [x] Intent `shed(set_step)`, external actor raises step. Verify PELS re-issues the shed step.

## Plan UI: restore-cooldown badge inconsistency

- [ ] `buildPlanStateLine()` shows "Shed (restore cooldown)" for restore-cooldown shed devices that
  are currently off/unknown, but `resolvePlanBadgeState()` / `buildPlanStateBadge()` still resolves
  to `restoring` in the same scenario. Introduce a dedicated badge state/label for restore cooldown
  or otherwise align the badge label with the state text.
  Files: `packages/settings-ui/src/ui/plan.ts`.

- [ ] Test `renders restore cooldown as restoring when the device is currently off` has a description
  that no longer matches its assertion ("Shed (restore cooldown)"). Rename to match current semantics.
  Files: `packages/settings-ui/test/plan-ui.test.ts`.

## State integrity: intent vs observation vs planning

Production logs show recurring problems where PELS internal state, planner intent, and
observed device state are not clearly separated. The root causes fall into four areas
with targeted fixes for each.

### 1. `binaryCommandPending` flag for restore lifecycle

**Problem:** After a restore write, `updateLocalSnapshot` optimistically sets `currentOn=true`.
The UI shows "Active" or "Restoring" before fresh telemetry confirms the device is actually on.
Intent is presented as confirmed reality.

**Fix:** Add a `binaryCommandPending` flag mirroring the existing `stepCommandPending` pattern.
After a restore or shed binary write, set the flag. Clear it when fresh telemetry confirms the
expected state, or expire it after a timeout (similar to `BINARY_COMMAND_PENDING_MS`). Stop
setting `currentOn=true` optimistically — let the pending flag carry the "requested but
unconfirmed" state instead.

**Solves:** intent shown as reality, restore lifecycle ambiguity, overloaded state labels.

- [ ] Add `binaryCommandPending` and `binaryCommandStatus` fields to snapshot/plan device types,
  mirroring `stepCommandPending` / `stepCommandStatus`.
  Files: `planTypes.ts`, snapshot types.
- [ ] Stop `updateLocalSnapshot` from setting `currentOn=true` optimistically on restore writes.
  Instead, set `binaryCommandPending=true` with a `restoreRequestedMs` timestamp.
  Files: `planBinaryControl.ts`, `planExecutor.ts`.
- [ ] Add confirmation logic: clear `binaryCommandPending` when fresh telemetry confirms
  `onoff` matches the pending desired value. Add timeout expiry matching step command staleness.
  Files: `appDeviceControlHelpers.ts`, sync logic analogous to `syncPendingBinaryCommands`.
- [ ] Update UI to show "Restore requested" when `binaryCommandPending=true` and `desired=true`,
  instead of "Active" or "Restoring".
  Files: `packages/settings-ui/src/ui/plan.ts`.

### 2. Stop conflating measured, expected, and planning power

**Problem:** The decorator previously overwrote `expectedPowerKw` with `planningPowerKw` for stepped
devices (see historical implementation in `appDeviceControlHelpers.ts`), which lost the original
configured value. Downstream code that falls back to `expectedPowerKw` gets step planning power
instead. Four different
power resolution functions use different fallback orders, so the same device gets different
power estimates depending on whether PELS is shedding, restoring, or reporting usage.

**Power resolution inconsistency:**

| Function | File | Priority order |
|---|---|---|
| `resolveCandidatePower` | `planCandidatePower.ts` | measured → expected → planning → configured → 1kW |
| `estimateRestorePower` | `planRestoreSwap.ts` | planning → step-restore → expected → measured → configured → 1kW |
| `resolveUsageKw` | `planUsage.ts` | measured → expected (conditional) → planning → null |
| `resolveSteppedCandidatePower` | `planSteppedLoad.ts` | measured-relief → planning delta |

**Fix:** Stop overwriting `expectedPowerKw` in the decorator. Keep `planningPowerKw` as a
separate field (it already is). Ensure `measuredPowerKw` is only ever populated from
`measure_power` telemetry, never from configured load or step-derived values. Document which
power field each consumer should use:
- Shedding candidate ranking: measured (what we'd actually save)
- Restore headroom estimation: planning (conservative, stable)
- Usage reporting: measured (what's actually happening)
- UI "current usage": measured only, show "unknown" if unavailable

- [x] Stop overwriting `expectedPowerKw` with `planningPowerKw` in
  `decorateSnapshotWithDeviceControl`. Keep both fields independent.
  Also removed the same override in the settings-ui `applyLocalDeviceControlProfile`.
  Removed `'step-planning'` from `expectedPowerSource` type union.
  Files: `appDeviceControlHelpers.ts`, `deviceControlProfiles.ts`, `planTypes.ts`,
  `packages/contracts/src/types.ts`.
- [ ] Audit `measuredPowerKw` assignment — ensure it only comes from `measure_power` capability
  telemetry, never from configured load, expected load, or step-derived nominal values.
  Files: `appDeviceControlHelpers.ts`, snapshot pipeline.
- [ ] Document intended fallback order per consumer and align the four power resolution functions.
  Files: `planCandidatePower.ts`, `planRestoreSwap.ts`, `planUsage.ts`, `planSteppedLoad.ts`.

### 3. Stale local writes: one `lastLocalWriteMs` per device

**Problem:** After PELS writes a command (restore, shed, step change), the local snapshot
preserves the written value. If Homey later reports contradictory state with a fresher
timestamp, the stale local write can still win because the decorator has no way to compare
freshness.

**Fix:** Track one `lastLocalWriteMs` timestamp per device, set whenever `updateLocalSnapshot`
writes any value. In the decorator, compare `lastLocalWriteMs` against the Homey snapshot's
update timestamp. If the Homey snapshot is newer, stop trusting the local write and use the
observed value instead. This is one timestamp per device, one comparison in the decorator —
not per-field freshness tracking.

- [ ] Add `lastLocalWriteMs` per device to runtime state. Set it in `updateLocalSnapshot`
  on every write.
  Files: `planState.ts` or `appDeviceControlHelpers.ts` runtime state.
- [ ] In `decorateSnapshotWithDeviceControl`, compare `lastLocalWriteMs` against the Homey
  snapshot timestamp. If Homey is newer, prefer observed values over preserved local writes.
  Files: `appDeviceControlHelpers.ts`.

### 4. `communicationModel` for device-class-aware timeouts

**Problem:** Connected 300 is cloud-to-cloud with slow, out-of-order updates. Local
thermostats update within seconds. PELS uses the same confirmation timeouts, drift detection
thresholds, and reconciliation logic for both, causing false drift detection and unnecessary
reconciliation re-issues for slow cloud devices.

**Fix:** Add a `communicationModel: 'local' | 'cloud'` field to device config (or derive it
from the driver). Use it to:
- Set longer confirmation windows before treating mismatch as drift (e.g., 60s cloud vs 10s local)
- Suppress reconciliation re-issues during the convergence window
- Log differently: "awaiting cloud confirmation" vs "drift detected"

- [ ] Add `communicationModel` field to device config / plan input types. Default to `'local'`.
  Files: `planTypes.ts`, device config.
- [ ] Use `communicationModel` to scale confirmation timeouts in pending command sync and
  drift detection. Cloud devices get longer windows before triggering reconciliation.
  Files: `planBinaryControl.ts` (`syncPendingBinaryCommands`), `appDeviceControlHelpers.ts`
  (`pruneStaleSteppedLoadCommandStates`), `planReconcileState.ts`.

## Code structure: duplication and inconsistency

Patterns found during codebase audit that make planning, shedding, restore, and reconciliation
more fragile than necessary.

### `setBinaryControl` dependency bag duplication

- [x] Extract `setBinaryControl` boilerplate into a private `PlanExecutor` helper. The dependency
  bag (`state`, `deviceManager`, `updateLocalSnapshot`, `log`, `logDebug`, `error`) is duplicated
  across `applySteppedLoadShedOff`, `applySteppedLoadRestore`, `applyRestorePower`,
  `applyUncontrolledRestore`, and `turnOffDevice` (5 call sites, 7 fields each).
  Extracted `buildBinaryControlDeps()` helper; all call sites now spread it.
  Files: `planExecutor.ts`.

### `setEvBinaryControl` / `setStandardBinaryControl` near-duplication

- [x] Merge `setEvBinaryControl` and `setStandardBinaryControl` into a single function. Both
  were ~60 lines with identical control flow, pending state management, error handling, and
  capability write. They differed only in log message construction. Inlined into `setBinaryControl`
  with EV-specific logging guarded by `controlPlan.isEv`.
  Files: `planBinaryControl.ts`.

### Repeated snapshot lookups

- [ ] Cache snapshot lookup by device ID in `applyPlanActions`. The pattern
  `this.latestTargetSnapshot.find((entry) => entry.id === dev.id)` is repeated 8+ times
  in `planExecutor.ts` — once per device per action method. Build a `Map<string, snapshot>`
  once at the start of the loop.
  Files: `planExecutor.ts`.

### `currentOn` vs `currentState` checked inconsistently

- [ ] Align on which field to check and where. Currently:
  - Shedding candidates filter on `currentOn !== false` (raw field, `planShedding.ts:213`)
  - Restore candidates filter on `currentState === 'off'` (derived, `planRestoreDevices.ts:8`)
  - Reconciliation checks `currentState` (`planReconcileState.ts:145`)
  - Executor checks `snapshot.currentOn` (`planExecutor.ts:534`)
  For stepped devices at off-step, `currentState='off'` (derived from step) while
  `currentOn=true` (raw onoff capability). Code that checks one vs the other gets different
  answers for the same device.
  Files: `planShedding.ts`, `planRestoreDevices.ts`, `planReconcileState.ts`, `planExecutor.ts`.

### `resolveSteppedLoadCurrentState` duplicates decoration logic

- [ ] `planSteppedLoad.ts:39–47` re-derives current state for stepped devices from `currentOn`
  and `selectedStepId`. The decorator in `appDeviceControlHelpers.ts` already applied this logic.
  The plan input builder calls it again via `planDevices.ts`, meaning the derivation runs twice.
  Remove the redundant derivation and use the already-decorated value.
  Files: `planSteppedLoad.ts`, `planDevices.ts`.

### Stepped load state in 3 layers

- [ ] Stepped device state is stored in runtime state (`steppedLoadDesiredByDeviceId`,
  `steppedLoadReportedByDeviceId`), decorated snapshot (`selectedStepId`, `desiredStepId`,
  `actualStepId`, `assumedStepId`), and plan device (same fields copied forward, plus
  `lastDesiredStepId` which is the *previous* desired — confusingly named). Consolidate
  naming and reduce unnecessary copying.
  Files: `appDeviceControlHelpers.ts`, `planDevices.ts`, `planTypes.ts`.

### 4 independent pending-state systems

- [ ] Binary commands (`pendingBinaryCommands` Record), target commands (`pendingTargetCommands`
  Record), step commands (`stepCommandPending` boolean on device), and shed/restore sets
  (`pendingSheds`/`pendingRestores` Sets) use different data structures and lifetime models
  for conceptually similar "request sent, awaiting confirmation" state. Consider unifying
  into a single per-device pending-action tracker with consistent timeout/confirmation semantics.
  Files: `planState.ts`, `planBinaryControl.ts`, `planTargetControl.ts`,
  `appDeviceControlHelpers.ts`.

### Restore eligibility checked 3 different ways

- [ ] Off devices for restore: `currentState === 'off' && plannedState !== 'shed'`
  (`planRestoreDevices.ts:8`). Stepped restore candidates: `selectedStepId !== highest &&
  plannedState !== 'shed'` — no `currentState` check (`planRestoreDevices.ts:17`). Swap
  candidates: `plannedState !== 'shed' && not-swapped && power > 0` (`planRestoreSwap.ts:70`).
  Different eligibility criteria for conceptually similar "is this device a candidate for
  restore" questions.
  Files: `planRestoreDevices.ts`, `planRestoreSwap.ts`.

### Controlled vs uncontrolled power split at two levels

- [ ] PowerTracker (`powerTracker.ts`) computes controlled/uncontrolled/exempt from samples.
  Plan builder (`planBuilder.ts:518`) independently computes `controlledKw = sumControlledUsageKw()`
  then derives `uncontrolledKw = total - controlledKw`. These can diverge if the device set
  changes or if exemption logic differs. Choose one source of truth.
  Files: `powerTracker.ts`, `planBuilder.ts`, `planUsage.ts`.

### Shedding hysteresis gap

- [ ] Shortfall has proper hysteresis: 0.2 kW clear margin + 60s sustained
  (`capacityGuard.ts:174–203`). Shedding active state has no hysteresis — flipped directly
  every cycle (`capacityGuard.ts:136–144`). If power oscillates near the limit, shedding
  state can flip every few seconds, causing rapid shed/restore cycling.
  Files: `capacityGuard.ts`, `planSheddingGuard.ts`.

### Soft limit computed differently in different modules

- [ ] `planBudget.ts`: dynamic soft limit based on remaining kWh / remaining time, with
  end-of-hour capping. `capacityGuard.ts`: static margin (`limitKw - softMarginKw`).
  `planContext.ts:70`: `headroomRaw = softLimit - total` — uses whichever was passed in.
  The guard and the planner can see different soft limits simultaneously.
  Files: `planBudget.ts`, `capacityGuard.ts`, `planContext.ts`.

### `DevicePlanDevice` is a 30+ field bag with implicit interdependencies

- [ ] Fields like `shedTemperature`, `shedStepId`, `shedAction` are independent optionals but
  semantically coupled — `shedTemperature` is only meaningful when `shedAction === 'set_temperature'`.
  `stepCommandPending` only applies to stepped devices but isn't gated by type. Consider
  discriminated unions for shed behavior and control model to make invalid states unrepresentable.
  Files: `planTypes.ts`.

## Deferred: restore-pending follow-up tests

- [ ] Per-device scoping: one temperature device is stuck at shed temperature, another is healthy; verify the healthy device can still restore while the stuck one stays pending.
- [ ] Retry window expiry: verify no repeated restore writes within `RESTORE_CONFIRM_RETRY_MS`, then exactly one new restore attempt is allowed after the window expires.
- [ ] Confirmation clears pending: when reported target moves from shed temperature to planned temperature, `restore pending` state disappears immediately.
- [ ] No false pending: device at shed temperature without a recent restore attempt (`lastDeviceRestoreMs` missing or stale) should not be marked `restore pending`.
- [ ] On/off restore path unaffected: ensure `restore pending` logic does not interfere with normal `onoff` restoration.
- [ ] Status classification: devices in `restore pending` should not count as limit-driven shedding in `pels_status.limitReason`.
