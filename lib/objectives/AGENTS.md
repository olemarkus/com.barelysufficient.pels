# lib/objectives — Learned Profiles & Deferred Objectives

Sits between measurement and planning: it learns per-device energy-rate profiles (kWh per °C / per
% SoC) from observed samples, and hosts the deferred-objective (smart-task) subsystem that plans
deadline-bound energy delivery. The planner consumes its output only as flat decorations through an
injected seam — never by importing this module (whole-module ban enforced by `npm run arch:grep`;
`no-plan-to-smarttasks` covers `deferredObjectives/` in dep-cruiser).

## Map

- `profiles.ts` — profile orchestrator: turns observed samples into `DeviceObjectiveProfile` updates.
- `samples.ts` — builds `ObjectiveSampleDevice` observations from decomposed snapshot halves.
- `bands.ts` / `stats.ts` — multi-band fitting from the sample buffer and confidence math.
- `energyAccumulator.ts` — sub-interval energy integration for stepped devices.
- `recovery.ts` — draw/refill detection that suppresses poisoned samples.
- `deferredObjectives/` — the smart-task allocator/recorder/admission stack. **Has its own
  AGENTS.md with the two-clock and e2e rules — read it before touching or testing anything there.**

## Invariants

- Governing docs: `notes/deferred-load-objectives/README.md` (concept + lifecycle) and
  `lib/objectives/deferredObjectives/AGENTS.md` (two-clock design, SDK-boundary e2e rules).
- Layering (`no-objectives-to-peer-except-power` in `.dependency-cruiser.cjs`): objectives may
  depend on `lib/power` (type cycle allowed) but on no other peer — no device/plan/price/
  dailyBudget/observer/executor imports.
- Consume `ObservedDeviceState` + descriptor picks, never the raw producer `TargetDeviceSnapshot`.

## Not in this module

- Shed/restore selection or any plan assembly (`lib/plan`); actuation (`lib/executor`).
- Direct Homey SDK access — persistence goes through injected stores/ports.
