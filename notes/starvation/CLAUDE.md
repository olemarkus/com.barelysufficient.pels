# Temperature Device Starvation — Invariants

The core intended-target / suppression-only diagnostics model now exists in
`lib/plan/planDiagnostics.ts` and `lib/diagnostics/deviceDiagnosticsService.ts`, but the full
rollout is not complete yet. The main remaining work is per-episode / duration-threshold flow
triggers plus any remaining insights/UI integration gaps — see `TODO.md` and
`notes/starvation/README.md`.

**Scope:** managed temperature-driven devices only (room thermostats, water heaters). Not EV chargers or generic binary loads.

**Core constraint:** starvation is orthogonal metadata — it must **never** change planner decisions (shed order, restore order, priority). It is detection only.

## Key Invariants

- A device in `keep` must **not** become starved merely because it is heating slowly after a target increase.
- Starvation is always evaluated against the **intended normal target**, never against a temporary shed target.
- Entry requires 15 minutes of continuous qualifying suppression — not a single-cycle check.
- Non-counting states pause accumulation; they do not add starvation time.
- `capacity control off` must **clear and reset** starvation entirely.
- Exit requires temperature above the exit threshold for 10 continuous minutes (hysteresis — partial recovery does not clear starvation).
- Duration-threshold flow triggers must fire **once per episode per threshold**, not every planning cycle.
- Accumulated duration must be tracked explicitly — a single start timestamp is insufficient.

**Counting** (do add starvation time): `shed due to capacity`, `shed due to daily budget`, `shed due to hourly budget`, shortfall, swap pending/out, insufficient headroom, shedding active.

**Non-counting** (pause accumulation, keep starved state latched): cooldown, headroom cooldown, restore throttled, activation backoff, inactive, keep, restore, capacity control off.
