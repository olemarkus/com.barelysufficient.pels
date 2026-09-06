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
- `energyBand.ts` — the learned kWh/unit band each candidate window is judged against.
- `deferredObjectives/` — the smart-task allocator/recorder/admission stack. **Has its own
  AGENTS.md with the two-clock and e2e rules — read it before touching or testing anything there.**

## Invariants

- Governing docs: `notes/deferred-load-objectives/README.md` (concept + lifecycle) and
  `lib/objectives/deferredObjectives/AGENTS.md` (two-clock design, SDK-boundary e2e rules).
- Layering (`no-objectives-to-peer-except-power` in `.dependency-cruiser.cjs`): objectives may
  depend on `lib/power` (type cycle allowed) but on no other peer — no device/plan/price/
  dailyBudget/observer/executor imports.
- Consume `ObservedDeviceState` + descriptor picks, never the raw producer `TargetDeviceSnapshot`.
- **A candidate window is judged against the device's own kWh/unit history, and nothing else.**
  There is no fleet-wide plausible rate here and there cannot be one: a tank at 0.23 kWh/°C and a
  car at 0.5 kWh/% share no scale, so any single number is either useless on one or wrong on the
  other. `energyBand.ts` holds the test — a robust (median / median-absolute-deviation) band on the
  LOG of the rate, so the verdict is a multiple of the device's own median rather than an offset,
  and two-sided, because a report that credits units nobody paid for poisons the rate exactly as
  hard as a refill that spends energy nobody got. The coarse absolute ceiling in that file applies
  only while a profile is too young to have a band, and must not grow into a general-purpose limit.
  Two guards keep the test from eating its own inputs, and neither is optional: the band is robust
  (a refused window never enters the history, and an admitted outlier moves a median by one rank,
  not a mean toward itself), and the history is aged out, so a device whose honest rate moved
  further than the band admits falls back to bootstrap and relearns instead of refusing every
  window forever. Do not reintroduce a suppression WINDOW (a fall arming a period in which nothing
  is learned): that punished every ordinary window behind one bad one, and needed a no-progress
  counter and a 24 h timeout to let go of a device that never climbed back.
- **Read producer-resolved bits off `ObjectiveDeviceInput`, never raw observed state.** The input is
  satisfied by `PlanInputDevice` through width-subtyping with no adapter, so when the producer stops
  emitting a field this type declares as optional, the assignment still compiles and the field reads
  `undefined` forever. `evChargingState` failed exactly this way: `toPlanDevice` strips it, the two
  `isEvSessionInactive(device.evChargingState)` reads here were dead for months, and an unplugged
  charger was reported as `objective_progress_stale` — a reading problem — for entire task windows
  while `objective_invalid_session` was never emitted once. Ask `objectiveSessionInactive`,
  `hasStandingDemand`, `steppedLadderMissing`; do not ask what a plug is. Before adding a field
  here, open the producer and confirm it survives — a comment upstream is not evidence, and prefer
  a REQUIRED field so the next silent strip is a compile error.
- **Pick the producer bit that answers YOUR question, not the nearest one.** `commandableNow` and
  `objectiveSessionInactive` look interchangeable on an unplugged charger and are not:
  `commandableNow` also goes false for `available === false` and for PELS's own 15/30/60-minute
  binary-command retry back-off. Substituting it here renders "EV is unplugged — plug in to
  resume." at an owner whose car is plugged in and charging, drops the committed plan before the
  frozen-read bridge, and releases the device from admission — on one flaky SDK read, with no
  grace window. `evPlugState.ts` keeps "may we command it" and "is there a creditable session"
  as separate predicates for exactly this reason.

## Not in this module

- Shed/restore selection or any plan assembly (`lib/plan`); actuation (`lib/executor`).
- Direct Homey SDK access — persistence goes through injected stores/ports.
