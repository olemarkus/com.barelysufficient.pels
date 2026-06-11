# lib/plan — Planning Engine

Owns the planning step of the control flow (measurement → **planning** → execution → reconciliation):
it turns power samples, device states, prices, and budgets into a `DevicePlan` (shed / restore /
keep per device). Execution is `lib/executor`; reconciliation is `lib/device/deviceTransport.ts`.

## Map

- `planService.ts` — rebuild orchestration: triggers, signatures/dedupe, status + overview logging.
- `planEngine.ts` — per-cycle engine state (pending commands, headroom, overshoot tracking); hands off to the builder and executor.
- `planBuilder.ts` — pure-ish plan assembly: context → shedding → restore → materialization.
- `admission/` — per-device admission gates (activation backoff, reserve, shedding guard).
- `shedding/` — the only place that *selects* devices to shed. **Has its own AGENTS.md — read it first.**
- `restore/` — restore selection, timing, and accounting (exponential back-off).
- `swap/` — priority-based device swapping lifecycle.
- `rebuildScheduler/` — when to rebuild (power-driven, signal-driven, shortfall suppression).

## Invariants (enforced — see `.dependency-cruiser.cjs` and `docs/technical.md`)

- **No `lib/device` imports** except the producer seams `deviceObservation.ts`,
  `deviceActionProjection.ts`, `deviceResidualKw.ts` (`no-plan-to-device`). Resolution happens in
  the producer projection; the planner consumes flat `PlanInputDevice` fields, never source/evidence.
- **Smart-task-agnostic**: never import anything from `lib/objectives/**` — `npm run arch:grep`
  fails on ANY `lib/plan` → objectives edge, value or type (`no-plan-to-smarttasks` additionally
  covers `deferredObjectives/` in dep-cruiser). Deferred decoration arrives only through the
  injected `decorateDeferredObjectives` seam as a flat `DeferredDecorationBundle`.
- Shed cooldown ≥60 s; restore cooldown 60–300 s. Plan materialization copies `shedSet` but never selects new sheds.

## Not in this module

- Actuation/dispatch (`lib/executor`, `lib/actuator`), Homey SDK reads/writes (producer + setup adapters), smart-task logic (`lib/objectives/deferredObjectives/`).
