# Temperature Device Starvation — Invariants

The core intended-target / suppression-only diagnostics model now exists in
`lib/plan/planDiagnostics.ts` and `lib/diagnostics/deviceDiagnosticsService.ts`, but the full
rollout is not complete yet. The main remaining work is per-episode / duration-threshold flow
triggers plus any remaining insights/UI integration gaps — see `TODO.md` and
`notes/starvation/README.md`.

**Scope:** managed temperature-driven devices only (room thermostats, water heaters). Not EV chargers or generic binary loads.

**Core constraint:** starvation is orthogonal metadata — the *planner* must **never** read it to change its decisions (shed order, restore order, priority). Detection stays planner-orthogonal. The shipped v2 rescue widget (see `notes/starvation/README.md`) is a **separate, user-initiated lane**: the owner explicitly chooses to exempt a starved device from its budget, which is not the planner consuming starvation state. Do not collapse the two — automatic planner behaviour stays detection-only.

## Key Invariants

- Starvation is always evaluated against the **intended normal target**, never against a temporary shed target.
- Entry requires 15 minutes of continuous qualifying suppression — not a single-cycle check.
- Cooldown, retry/backoff, restore holds, and other PELS-created hold states continue starvation
  while the device remains under-served.
- `capacity control off` must **clear and reset** starvation entirely.
- Exit requires temperature above the exit threshold for 10 continuous minutes (hysteresis — partial recovery does not clear starvation).
- Duration-threshold flow triggers must fire **once per episode per threshold**, not every planning cycle.
- Accumulated duration must be tracked explicitly — a single start timestamp is insufficient.

**Counting causes:** `shed due to capacity`, `shed due to daily budget`, `shed due to hourly budget`, shortfall, swap pending/out, insufficient headroom, shedding active.

**Hold/retry attribution that still adds starvation time:** cooldown, headroom cooldown, restore throttled, activation backoff, inactive, keep, restore.

**Does not add starvation time:** invalid/stale observations, long sample gaps, no PELS suppression/hold state, capacity control off.
