# Restore eagerness investigation

## 1. Observed evidence

### 1.1 Restore-then-overshoot loops

- Restored devices are followed by overshoot ~10–20s later (thermal element startup lag)
- The pattern occurs even for devices at penalty level 4, where the extra headroom requirement
  should be ~2× base power
- The loop is seen across multiple rebuild trigger paths: `max_interval` (periodic rebuild with
  no meaningful power change), `power_delta` (power sample moved meaningfully), and swap restores
  (lower-priority device shed to make room)

### 1.2 What the evidence proves / suggests / does not prove

**Clearly proven by code review:**

- `estimateRestorePower` is the sole power estimate used for restore admission. It does NOT use
  `measuredPowerKw` as the primary source — it uses `planningPowerKw`, then `expectedPowerKw`,
  then `measuredPowerKw`, then `powerKw ?? 1`. When the device is off, measured ≈ 0, so the
  admission estimate comes entirely from configuration or planning state.
- `expectedPowerKw === 0` (explicit zero) passes the `typeof x === 'number'` check in
  `estimateRestorePower` and returns 0, making `computeBaseRestoreNeed` produce `needed = 0.2kW`
  (just the minimum buffer). Any headroom admits the restore; no pending reservation is made.
- `getActivationRestoreBlockRemainingMs` returns `null` (no block) whenever `lastSetbackMs` is
  `null`, regardless of `penaltyLevel`. `lastSetbackMs` is only written in `recordActivationSetback`
  when `!stickReached`. After the 10-minute stick window, `recordActivationSetback` records
  `setback_after_stick` but does NOT update `lastSetbackMs`. The time-based block therefore
  expires and is never refreshed for sheddings that happen after stick.
- `resolveCandidatePower` (used for shedding candidate selection) prioritises `measuredPowerKw`
  first. `estimateRestorePower` (used for restore admission) prioritises planning/expected values.
  These two functions resolve power from a different priority order, so the headroom freed by
  shedding a device (based on its measured draw) can differ from the headroom claimed when
  restoring it (based on its configured expected draw).
- `applySteppedLoadRestore` in `planExecutor.ts` runs outside the planner gates entirely. It fires
  whenever a stepped device has `plannedState === 'keep'` but `currentState === 'off'` (keep-
  invariant violation). It does not check the activation setback, shed/restore cooldown, or
  headroom before issuing a binary restore command.

**Strongly suggested:**

- At penalty level 4, `applyActivationPenalty` requires ≈2× base estimated power. If
  `expectedPowerKw` is set too low (e.g. 2 kW but device actually draws 4 kW), the penalty
  requirement is 4 kW but actual draw is 4 kW, so restore is admitted whenever headroom ≥ 4 kW.
  A large burst (>4 kW startup draw) can still exceed the limit and cause overshoot. The penalty
  does not fail-safe against wrong power configuration.
- After the 10-minute setback block expires (or if it was never set due to stick-window shedding),
  the only remaining gate is the elevated headroom threshold. If the power estimate is wrong, the
  loop continues indefinitely.

**Not proven:**

- Whether the overshoot events at L4 are caused by wrong `expectedPowerKw` or by measurement lag
  in `headroomRaw` (power sample older than the element startup transient)
- Whether `applySteppedLoadRestore` is contributing to field incidents, or whether all observed
  overshoots come through `planRestoreForDevice` / `planRestoreForSteppedDevice`
- Whether any device has `expectedPowerKw === 0` or `expectedPowerKw` missing in field


---

## 2. Hypotheses

### 2.1 Hypothesis: restore admission uses overly optimistic expected power

**Why this fits:**
The element fires 10–20s after the restore command. At the time of admission, `measuredPowerKw`
for the off device is near zero. `estimateRestorePower` uses the first non-null of
`planningPowerKw`, `expectedPowerKw`, `measuredPowerKw > 0`, `powerKw`, 1 kW. If
`expectedPowerKw` is wrong or absent, the admission estimate can be far below actual draw. The
buffer is capped at 0.6 kW — small relative to the error if device draws 4 kW but configured
for 2 kW.

Additionally: `expectedPowerKw === 0` short-circuits to `needed = 0.2 kW`. The pending-restore
reservation (`computePendingRestorePowerKw`) would also reserve 0 kW for a device with
`expectedPowerKw = 0`, because it uses `estimateRestorePower` for the gap calculation. This leaves
headroom fully exposed for back-to-back restores of zeroed devices.

**What log fields would confirm this:**
- `restore_admitted.estimatedPowerKw` and `restore_admitted.powerSource` — which branch of
  `estimateRestorePower` was taken (`planning`, `expected`, `measured`, `configured`, `fallback`)
- `restore_headroom_reserved.pendingKw` (already exists) — if this is 0 for a recently restored
  device, the estimate was 0 or the gap was closed immediately

**What would refute this:**
- All `restore_admitted` events show `estimatedPowerKw` close to what the device actually drew
  (visible in subsequent power samples)
- Overshoot follows restores with accurate estimates — points to H2 instead

**Test cases:**
1. Device with `expectedPowerKw = 0.5` actually drawing 3 kW. Assert `estimateRestorePower`
   returns 0.5. Assert admission passes with headroom = 0.8 kW (> 0.5 + 0.2 buffer). Assert
   pending reserve uses 0.5 kW, not 3 kW.
2. Device with `expectedPowerKw = 0`. Assert `needed = 0.2 kW`. Assert pending reserve = 0 kW.
3. Device with `expectedPowerKw` absent, `measuredPowerKw = 0` (device off), `powerKw = 2`.
   Assert `estimateRestorePower` returns 2.

### 2.2 Hypothesis: restore safety margin is too small

**Why this fits:**
`computeRestoreBufferKw(power) = max(0.2, min(0.6, power * 0.1 + 0.1))`. At 3 kW: buffer = 0.4 kW.
At 5 kW: buffer = 0.6 kW (hard cap). A 5 kW water heater that draws a 5.5 kW startup spike with
0.6 kW buffer causes a 0.5 kW overshoot even with a perfect power estimate. The cap constrains the
buffer to ≤12% of power for devices above 5 kW.

Power measurement also has a delay: Homey Energy reports every 10 s. At the time the planner runs
on a `power_delta` rebuild, the sample can be 0–10 s old. If the element fires in the gap, the
planner sees pre-fire headroom and admits the next restore.

**What log fields would confirm this:**
- `plan_rebuild_completed.reasonCode` for the rebuild that admitted the restore — if `max_interval`
  (periodic, no meaningful power change), the measurement may be stale
- Compare `restore_admitted.availableKw` against actual draw visible in subsequent samples

**What would refute this:**
- Overshoot only occurs when `estimatedPowerKw` is clearly wrong — points to H1
- Buffer is always sufficient when estimate is correct

**Test cases:**
1. Device with accurate `expectedPowerKw = 5`. Assert buffer = 0.6 kW (capped).
   Assert admission requires headroom ≥ 5.6 kW.
2. Back-to-back restores with a perfectly accurate estimate: first restore consumes headroom,
   pending reserve covers the gap. Assert second restore is blocked during the pending window.

### 2.3 Hypothesis: restore penalty/cooldown is not applied consistently

**Why this fits:**
`getActivationRestoreBlockRemainingMs` has two conditions that return `null` (no block):
- `penaltyLevel <= 0`: expected, not an issue
- `lastSetbackMs === null`: **critical gap**. `lastSetbackMs` is only set when
  `recordActivationSetback` runs with `!stickReached`. If shedding happens after the stick window
  (>10 min since attempt started), `recordActivationSetback` records `setback_after_stick` but
  does NOT write `lastSetbackMs`. The time-based block therefore disappears.

Scenario that bypasses the block:
1. Device restored at T=0. Attempt started. Stick window = 10 min.
2. At T=11 min: device shed (overshoot or capacity). `stickReached = true`. Setback recorded as
   `setback_after_stick`. Penalty level stays unchanged. `lastSetbackMs` NOT updated.
3. At T=12 min: restore cooldown expires. `getActivationRestoreBlockRemainingMs` returns `null`
   because `lastSetbackMs` is the pre-stick value (or null). Device is admitted for restore with
   only the headroom penalty — no time-based block.
4. Overshoot again. Only the penalty headroom gate stood between admission and overshoot.

This explains why L4 devices still overshoot: if the final penalty-accumulating shed happened past
stick, no `lastSetbackMs` was written. The 10-minute block was never set for that event.

The restore cooldown (`inRestoreCooldown`) is enforced consistently in `shouldPlanRestores` for
both normal and stepped paths. But it covers only the inter-restore interval (60–300 s), not the
per-device setback block.

**What log fields would confirm this:**
- `overshoot_attributed.penaltyLevel` == 0 with `bumped == false` (setback after stick, no bump)
- Absence of `restore_blocked_setback` event (or equivalent) for the device in the period before
  the loop-breaking restore

**What would refute this:**
- All overshooting restores have a fresh `lastSetbackMs` and a block remaining > 0 at admission
  time

**Test cases:**
1. Attempt started T=0. Shed at T=11 min (past stick). Assert `recordActivationSetback` returns
   `bumped=false, transition.kind='setback_after_stick'`. Assert `lastSetbackMs` unchanged.
   Assert `getActivationRestoreBlockRemainingMs` returns `null`.
2. Same scenario, stick NOT reached (shed at T=5 min). Assert `bumped=true`,
   `lastSetbackMs = nowTs`, block enforced for 10 min.
3. Penalty L4 with `lastSetbackMs` from 10 min ago (block just expired). Assert
   `getActivationRestoreBlockRemainingMs` returns `null`, device admitted with penalty headroom.

### 2.4 Hypothesis: one or more restore paths bypass shared restore guards

**Why this fits:**
`applySteppedLoadRestore` in `planExecutor.ts` (lines ~528–623) is a keep-invariant enforcement
path that runs AFTER the planner. It triggers when a stepped device has `plannedState === 'keep'`
but `currentState === 'off'` — meaning the device appears off despite being planned on. This
handles onoff=false after a power cycle or external interference.

This path does NOT check:
- `blockRestoreForRecentActivationSetback` (activation setback / penalty time block)
- `hasOtherDevicesWithUnconfirmedRecovery` (waiting gate)
- Headroom (no headroom check at all)
- `inCooldown` / `inRestoreCooldown`

The intent is that the planner already approved `plannedState === 'keep'`, so these gates were
already checked. But the gates are checked at PLAN time, not at ACTUATE time. If overshoot
attribution runs AFTER the planner (which it does — `updateOvershootState` fires during the
same rebuild that sets `wasOvershoot`), the newly attributed setback is not yet visible to the
executor. The next rebuild would block the device, but the current executor cycle can still
issue the restore.

This is a narrow but real timing window.

**What log fields would confirm this:**
- `plan_rebuild_completed` with `appliedActions = true` + `overshoot_attributed` for the same
  device in the same rebuild cycle, with the restore coming from the executor's keep-invariant
  path (currently no structured event for this path)

**What would refute this:**
- No field incidents where `applySteppedLoadRestore` fired for a device with an active setback

**Test cases:**
1. Device with `plannedState = 'keep'`, `currentState = 'off'`, active activation setback.
   Assert `applySteppedLoadRestore` issues a restore command (current behavior — this is the gap).
2. Contrast with `planRestoreForDevice`: same device, same state. Assert it is blocked by
   `blockRestoreForRecentActivationSetback`.


---

## 3. Required test coverage

### 3.1 Regression tests from observed incidents

- Restore → overshoot → same device restore loop: device restored, overshoot attributed,
  `lastSetbackMs` written, device blocked for 10 min. Prove loop is broken.
- Restore → overshoot → stick-window shed → same device restore NOT blocked: reproduce the
  `setback_after_stick` gap (H2.3 above). Prove the block is absent.
- Swap restore → overshoot: device admitted via `attemptSwapRestore` with insufficient headroom
  after a lower-priority device is shed. Prove swap respects the same headroom gate as direct
  restore.

### 3.2 Unit tests for restore admission

- `estimateRestorePower` for each branch: planning, expected, measured, configured, fallback.
- `estimateRestorePower` with `expectedPowerKw = 0`: assert it falls through to measured/configured/fallback (not 0).
- `computeBaseRestoreNeed`: assert `needed` = power + buffer, including 0-power edge case.
- `computeRestoreBufferKw` at extremes: negative, 0, 1, 5, 10+ kW.
- `getRestoreNeed` with recent-shed multiplier active vs inactive.
- `getRestoreNeed` with penalty level 0, 1, 4.
- Power source mismatch: `resolveCandidatePower` vs `estimateRestorePower` for same device.

### 3.3 Integration tests for restore → attribution → penalty → blocked re-restore

- T+0: restore → `recordRestoreActuation` → `recordActivationAttemptStarted`.
- T+14s: overshoot → `attributeOvershootToRecentRestores` → `recordActivationSetback` →
  `lastSetbackMs` written → penalty bumped.
- T+60s: restore cooldown expires → `getActivationRestoreBlockRemainingMs` > 0 → device blocked.
- T+10min: block expires → device admitted with elevated headroom (penalty level N+1).

### 3.4 Swap-specific tests

- Swap restore with accurate headroom: assert admitted only when headroom ≥ `restoreNeed.needed`
  after swap candidates freed up.
- Swap restore with penalty L4: assert `restoreNeed.needed` ≈ 2× estimated power.
- Swap target with active setback: assert swap blocked by headroom gate (penalty headroom
  requirement), since setback-block is not checked in `attemptSwapRestore` separately (it was
  already checked in `planRestoreForDevice` which exits early if blocked).


---

## 4. Logging gaps and required changes

### 4.1 Existing prose logs that should become structured

| Location | Current | Required structured event |
|----------|---------|---------------------------|
| `planRestoreHelpers.ts:blockRestoreForRecentActivationSetback` | `logDebug` prose | `restore_blocked_setback` with `deviceId`, `remainingMs`, `penaltyLevel` |
| `planRestore.ts:planRestoreForDevice` — gate block | `logDebug` prose | `restore_blocked_gate` with `deviceId`, `reason` |
| `planRestore.ts:planRestoreForDevice` — waiting block | `logDebug` prose | `restore_blocked_waiting` with `deviceId`, `reason` |
| `planExecutor.ts:applySteppedLoadRestore` | `logDebug` prose only | `restore_keep_invariant_enforced` — see §4.3 |

### 4.2 Existing structured logs that need more fields

| Event | Missing fields |
|-------|---------------|
| `restore_skipped` | `deviceName`, `estimatedPowerKw`, `powerSource` (which branch of `estimateRestorePower` was taken) |
| `restore_swap_approved` | `deviceName`, `estimatedPowerKw`, `powerSource`, `penaltyLevel`, `penaltyExtraKw` |
| `restore_swap_shed` | `shedDeviceName`, `forDeviceName` |
| `restore_headroom_reserved` | `deviceNames` alongside `deviceIds` (per the naming rule: structured logs carry both) |
| `overshoot_attributed` | `deviceName` alongside `deviceId` (naming rule) |

### 4.3 New structured events that must be added

**`restore_admitted`** — emitted from `planRestoreForDevice` when a device passes all gates and
headroom is sufficient (line ~386–389 in `planRestore.ts`, the `availableHeadroom >= restoreNeed.needed`
branch). Currently there is no success-path structured event for a normal restore being approved.

Fields:
```
event: 'restore_admitted'
deviceId: string
deviceName: string
estimatedPowerKw: number
powerSource: 'planning' | 'expected' | 'measured' | 'configured' | 'fallback' | 'stepped'
neededKw: number
availableKw: number
penaltyLevel: number | undefined    // omitted when no penalty (level 0)
penaltyExtraKw: number | undefined  // omitted when no penalty
```

**`restore_blocked_setback`** — emitted from `blockRestoreForRecentActivationSetback` when
`getActivationRestoreBlockRemainingMs` > 0. Currently only a prose `logDebug`.

Fields:
```
event: 'restore_blocked_setback'
deviceId: string
deviceName: string | undefined
remainingMs: number
penaltyLevel: number
stepped: boolean
```

**`restore_keep_invariant_enforced`** — emitted from `applySteppedLoadRestore` in
`planExecutor.ts` when a keep-invariant violation is detected and a restore is issued. This path
is currently invisible in structured logs. Needed to determine whether it contributes to overshoot.

Fields:
```
event: 'restore_keep_invariant_enforced'
deviceId: string
deviceName: string
onoffViolated: boolean
stepViolated: boolean
mode: 'plan' | 'reconcile'
```

**`restore_stepped_admitted`** — emitted from `planRestoreForSteppedDevice` when a step-up is
approved. Currently no structured event for the stepped success path.

Fields:
```
event: 'restore_stepped_admitted'
deviceId: string
deviceName: string
fromStepId: string
toStepId: string
deltaKw: number
neededKw: number
availableKw: number
```


---

## 5. Naming rules

- In markdown and analysis: use device names ("Water Heater")
- In structured logs: always include both `deviceName` and `deviceId`
- In examples: prefer `deviceName`, optionally add ID once where disambiguation matters

---

## 6. Progress

### Observability (§4)

- [x] `restore_admitted` — new event, `planRestoreForDevice` success path
- [x] `restore_stepped_admitted` — new event, `planRestoreForSteppedDevice` success path
- [x] `restore_blocked_setback` — new event in `blockRestoreForRecentActivationSetback`
- [x] `restore_keep_invariant_enforced` — new event in `applySteppedLoadRestore`
- [x] `restore_skipped` — added `deviceName`, `estimatedPowerKw`, `powerSource`
- [x] `restore_swap_approved` — added `deviceName`, `estimatedPowerKw`, `powerSource`, `penaltyLevel`, `penaltyExtraKw`
- [x] `restore_swap_shed` — added `shedDeviceName`, `forDeviceName`
- [x] `restore_headroom_reserved` — added `deviceNames`
- [x] `overshoot_attributed` — added `deviceName`; fixed `recordActivationTransition` to use real name

### Test coverage (§3)

- [x] §3.1 regression: restore → overshoot → same device blocked for 10 min
- [x] §3.1 regression: H3 fix — post-stick shed now refreshes `lastSetbackMs`, block stays active
- [x] §3.2 unit: `estimateRestorePower` for each source branch (planning/expected/measured/configured/fallback)
- [x] §3.2 unit: `expectedPowerKw = 0` edge case — fixed to fall through to next source
- [x] §3.2 unit: `computeRestoreBufferKw` extremes
- [x] §3.2 unit: `getRestoreNeed` with recent-shed multiplier and penalty levels 0/1/4
- [x] §3.2 unit: `resolveCandidatePower` vs `estimateRestorePower` asymmetry for same device
- [x] §3.3 integration: T+0 restore → T+14s attribution → T+60s blocked → T+10min admitted with penalty
- [x] §3.4 swap: admitted only when headroom ≥ needed after swap; penalty L4 doubles threshold

### Fixes

- [x] H3: update `lastSetbackMs` in `recordActivationSetback` even when `stickReached`
      (closes the gap where post-stick sheddings leave the time block unset)
- [ ] H4: decide whether `applySteppedLoadRestore` should check the activation setback
      before issuing a keep-invariant restore (or document the intentional bypass)
- [x] H1: treat `expectedPowerKw === 0` as absent in `estimateRestorePower` — skips to
      `measuredPowerKw` / `powerKw` / fallback instead of making needed = 0.2kW only
