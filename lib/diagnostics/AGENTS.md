# Diagnostics Layer — Orientation and Starvation Invariants

`lib/diagnostics` records per-device diagnostics and app-health telemetry. It observes planner output and device state; it must never feed decisions back into the planner.

## Map

- `deviceDiagnosticsService.ts` — per-device diagnostics hub, including the starvation state machine (entry/clear constants live here).
- `deviceDiagnosticsModel.ts` / `deviceDiagnosticsStateStore.ts` — diagnostics types and typed persistence boundary.
- `periodicStatus.ts` — periodic status snapshot logging.
- `perfLogging.ts` / `gcObserver.ts` / `resourceWarnings.ts` / `smapsRollup.ts` / `heapSnapshotHandler.ts` — performance and memory telemetry (Homey RSS ceiling is 160 MB; baseline ~130 MB).

Design-of-record: `notes/starvation/README.md`; intended-target model also in `lib/plan/planDiagnostics.ts`.

## Temperature Device Starvation — Invariants

**Scope:** managed temperature-driven devices only (room thermostats, water heaters). Not EV chargers or generic binary loads.

**Core constraint:** starvation is orthogonal metadata — the *planner* must **never** read it to change its decisions (shed order, restore order, priority). Detection stays planner-orthogonal. The shipped v2 rescue widget (see `notes/starvation/README.md`) is a **separate, user-initiated lane**: the owner explicitly chooses to exempt a starved device from its budget, which is not the planner consuming starvation state. Do not collapse the two — automatic planner behaviour stays detection-only.

- **Starve only when PELS holds a device below its mode target.** The signal is `commandedTargetC < intendedNormalTargetC` (commanded = `plannedTarget ?? currentTarget`) under a real counting cause — NOT the physical temperature. A device PELS commands in full (`keep`) is never starved, however cold it is. The old physical-temperature deficit thresholds (anchor table in the deleted `starvationThresholds.ts`) are gone.
- Entry requires 15 minutes of continuous below-target counting suppression — not a single-cycle check.
- **The clock runs whenever PELS has turned the device off** (owner ruling, 2026-08-08). Its own cooldowns, restore throttling, activation backoff, pending restores and startup reservations COUNT — they used to pause, and a device cycling between a capacity hold and its 60 s cooldown was never being served. Non-counting holds (`keep`, `inactive`, a step-up `restore_need`, and the owner-set `deferred_objective_avoid` / `awaiting_solar_surplus`) **cannot start** starvation; on a latched episode they **pause** accumulation and retain the original counting cause.
- `capacity control off` must **clear and reset** starvation entirely.
- Clear requires PELS to command the full mode target (`commandedTargetC >= intendedNormalTargetC`) for 10 continuous minutes (hysteresis — partial recovery does not clear starvation).
- **No overview/badge cause bucket** (the flat `capacity | budget` fold was removed 2026-08-04). It was overwritten on every accumulation tick, so a device held steadily across a budget-bound and a capacity-bound cycle flipped its badge, its copy, and its rescue button with nothing about the device having changed. The overview payload carries `isStarved` and `accumulatedMs` only (`startedAtMs` went with it on 2026-08-07 — no surface ever read it, and an episode's start says nothing about how much of it counted); the granular counting cause below is unaffected and still feeds device detail and the `device_starvation_*` logs. No `manual`/`external` bucket either.
- Duration-threshold flow triggers must fire **once per episode per threshold**, not every planning cycle.
- Accumulated duration must be tracked explicitly — a single start timestamp is insufficient.

**Counting causes:** `shed due to capacity`, `shed due to daily budget`, `shed due to hourly budget`, shortfall, swap pending/out, insufficient headroom, shedding active, cooldown, restore, restore throttled, activation backoff, reserved for start.

**Pause reasons (cannot start starvation; pause a latched episode):** keep, inactive, restore (the step-up `restore_need` only — a keep-state device that is ON), deferred_objective_avoid, awaiting_solar_surplus, plus the observation-quality ones (invalid_observation, sample_gap, suppression_none, unknown_suppression_reason). `external_off_hold` never reaches the classifier — it is excluded from eligibility upstream.

**Does not add starvation time:** invalid/stale observations, long sample gaps, any non-counting hold, capacity control off.

**Consequence of the 2026-08-08 rule:** starvation is strictly more sensitive — more devices reach `Held back` and more are offered `Let it run now`. The gate on that offer did not move: entry still needs 15 continuous minutes of below-target counting suppression, so a device inside an ordinary 60 s cooldown is nowhere near a rescue offer. The weather advisor's day totals (`targetDeficitMs` / `blockedByHeadroomMs`) derive from `blockCause`, not the suppression state, so that loop is untouched.

**`pelsHoldsBelowTarget` is producer-owned (2026-08-11).** "PELS holds this device below its intended target" — a lowered commanded setpoint OR a turn_off shed while the room sits below target — is resolved once, in `lib/plan/planDiagnostics.ts`, and carried on the observation. `normalizeStarvationObservation` copies it; never recompute it in this layer. `resolveUnmetDemand` consults the same signal, because the setpoint-gap test alone read a turn_off-shed device as fully satisfied — that zeroed `unmetDemandMs`/`blockedByHeadroomMs` for a week on production (2026-08-03 → 08-10, not backfillable) while the starvation clock correctly counted hours.

**The day-close budget-denial verdict (2026-08-11).** What the weather advisor now gates on is `budgetDeniedKwh`: energy the daily budget was still denying LATCHED episodes when the local day ended — joined from live episode state at the just-after-midnight pull (`resolveDayCloseBudgetDenial`), never persisted in this layer. The rules, all owner-ruled: deferral is the feature working (an episode cleared before midnight contributes nothing); only `starvationCause === 'daily_budget'` counts; unprovable is not damage (a restart or >10-min sample gap across midnight → no verdict at all, which is different from a witnessed zero). The day-scoped accrual lives on `LiveStarvationState` (`deniedBudgetDay*` slots, rolled by the first continuous span crossing local midnight); it mirrors the episode clock exactly — starts at the latch, never backdated into the 15-minute entry window — and dies with the episode reset. The 15-minute entry latch is the only debounce; the verdict gate is `> 0`. Two subtleties are load-bearing: the closing CAUSE is snapshotted per accrued slice and rolled with the slot (`deniedBudgetDayCauseWasBudget` → `deniedBudgetPrevDayClosedByBudget`) — never read from the live `starvationCause` at the pull, because a zero-length span at the first post-midnight observation refreshes the live cause before the roll runs, and the budget's own midnight reset makes exactly that re-attribution likely. And a verdict-capable build marks any day it rolls up without a witness (`budgetDeniedUnwitnessed`), which blocks the legacy hold-time fallback — it counts served deferrals — for modern days: unprovable is not damage. In flow mode the witness follows the sample cadence — sparse flow-driven samples mean fewer witnessed closes, by design.
