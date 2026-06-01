# Temperature Device Starvation — Invariants

The core intended-target / suppression-only diagnostics model now exists in
`lib/plan/planDiagnostics.ts` and `lib/diagnostics/deviceDiagnosticsService.ts`, but the full
rollout is not complete yet. The main remaining work is per-episode / duration-threshold flow
triggers plus any remaining insights/UI integration gaps — see `TODO.md` and
`notes/starvation/README.md`.

**Scope:** managed temperature-driven devices only (room thermostats, water heaters). Not EV chargers or generic binary loads.

**Core constraint:** starvation is orthogonal metadata — the *planner* must **never** read it to change its decisions (shed order, restore order, priority). Detection stays planner-orthogonal. The shipped v2 rescue widget (see `notes/starvation/README.md`) is a **separate, user-initiated lane**: the owner explicitly chooses to exempt a starved device from its budget, which is not the planner consuming starvation state. Do not collapse the two — automatic planner behaviour stays detection-only.

## Key Invariants

- **Starve only when PELS holds a device below its mode target.** The signal is
  `commandedTargetC < intendedNormalTargetC` (commanded = `plannedTarget ?? currentTarget`)
  under a real counting cause — NOT the physical temperature. A device PELS commands in full
  (`keep`) is never starved, however cold it is. The old physical-temperature deficit thresholds
  (anchor table in the deleted `starvationThresholds.ts`) are gone.
- Entry requires 15 minutes of continuous below-target counting suppression — not a single-cycle check.
- Non-counting holds (cooldown, retry/backoff, restore, keep, inactive) **cannot start** starvation;
  on a latched episode they **pause** accumulation (the device is not being limited right now) and
  retain the original capacity/budget cause.
- `capacity control off` must **clear and reset** starvation entirely.
- Clear requires PELS to command the full mode target (`commandedTargetC >= intendedNormalTargetC`)
  for 10 continuous minutes (hysteresis — partial recovery does not clear starvation).
- Exactly two overview/badge buckets: **capacity** (physical) and **budget** (releasable). No
  `manual`/`external` bucket.
- Duration-threshold flow triggers must fire **once per episode per threshold**, not every planning cycle.
- Accumulated duration must be tracked explicitly — a single start timestamp is insufficient.

**Counting causes:** `shed due to capacity`, `shed due to daily budget`, `shed due to hourly budget`, shortfall, swap pending/out, insufficient headroom, shedding active.

**Pause reasons (cannot start starvation; pause a latched episode):** cooldown, headroom cooldown, restore throttled, activation backoff, inactive, keep, restore, deferred_objective_avoid.

**Does not add starvation time:** invalid/stale observations, long sample gaps, any non-counting hold, capacity control off.
