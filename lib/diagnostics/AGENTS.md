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
