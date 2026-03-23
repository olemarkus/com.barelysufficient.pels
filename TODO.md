# TODO

## Backlog

- [ ] Use Homey Energy live reporting (`ManagerEnergy.getLiveReport`) as source for whole-home metering instead of relying on Flow-reported total power.
- [ ] Architecture tightening: remove remaining `lib/utils/** -> lib/{core,plan}` imports by moving those helpers to a better-owned module (current checks warn, not fail).
- [ ] Dead-code tightening: expand the dead-code export check to include `packages/contracts/**` and `packages/shared-domain/**` so temporary allowlisted runtime exports can be removed.
- [ ] Perf lint tightening: change `unicorn/no-array-reduce` in hot-path runtime code from `allowSimpleOperations: true` to `false` after remaining reducers are migrated.
- [ ] Perf lint tightening: expand hot-path iteration rules (`no-array-for-each`, `no-array-reduce`, loop allocation bans) from `lib/{core,plan,dailyBudget}` to the rest of runtime (`app.ts`, `flowCards/**`, `drivers/**`) once violations are cleaned.
- [ ] Perf lint tightening: re-enable `functional/immutable-data` for hot-path overrides once intentional mutable fast-paths are isolated behind explicit, well-scoped exceptions.
- [ ] Perf lint tightening: enable targeted `no-await-in-loop` in safe non-actuation loops after documenting approved sequential-actuation patterns.
- [ ] Investigate and reduce top-of-hour CPU/PSS spikes (observed after chart/camera-image changes): profile hour rollover work, isolate expensive render paths, and cap/schedule heavy jobs so Homey stays within practical memory/CPU limits.
- [ ] Verify resvg font caching: `renderAsync` receives `fontFiles` paths on every call — confirm resvg-js caches parsed font data internally, or pre-load font buffers once to avoid re-reading ~400 KB from disk per render.
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

- [ ] **`keep` intent requires `onoff=true` for stepped devices.**
  The executor skips binary control for stepped devices (`if (isSteppedLoadDevice(dev)) return;`
  in `applyRestorePower`). If a stepped device is `onoff=false` with `keep` intent, nothing
  reconciles it back on. Same for `step=0` (off-step) — no reconciliation to a non-zero step.
  Files: `planExecutor.ts` (`applyRestorePower`), `planReconcileState.ts`.

- [ ] **`shed(turn_off)` should set `onoff=false` in addition to off-step.**
  Currently the executor only issues step commands via flow cards for stepped devices. When a
  stepped device reaches the off-step, `onoff=false` should also be set to fully turn it off.
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
- [ ] Stepped device with `keep` intent and `onoff=false`. Verify reconciliation turns it on.
- [ ] Stepped device with `keep` intent and `step=0`. Verify reconciliation sets non-zero step.
- [ ] Both `onoff=false` and `step=0` with `keep` intent. Verify both are fixed.
- [ ] Stepped device at lowest active step with `turn_off`. Verify device ends up at off-step
  AND `onoff=false`.
- [ ] Intent `keep`, external actor sets `onoff=false`. Verify PELS turns it back on.
- [ ] Intent `keep`, external actor sets `step=0`. Verify PELS sets a non-zero step.
- [ ] Intent `shed(set_step)`, external actor raises step. Verify PELS re-issues the shed step.

## Deferred: restore-pending follow-up tests

- [ ] Per-device scoping: one temperature device is stuck at shed temperature, another is healthy; verify the healthy device can still restore while the stuck one stays pending.
- [ ] Retry window expiry: verify no repeated restore writes within `RESTORE_CONFIRM_RETRY_MS`, then exactly one new restore attempt is allowed after the window expires.
- [ ] Confirmation clears pending: when reported target moves from shed temperature to planned temperature, `restore pending` state disappears immediately.
- [ ] No false pending: device at shed temperature without a recent restore attempt (`lastDeviceRestoreMs` missing or stale) should not be marked `restore pending`.
- [ ] On/off restore path unaffected: ensure `restore pending` logic does not interfere with normal `onoff` restoration.
- [ ] Status classification: devices in `restore pending` should not count as limit-driven shedding in `pels_status.limitReason`.
