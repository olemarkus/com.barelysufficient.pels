# lib/plan — Planning Engine

Owns the planning step of the control flow (measurement → **planning** → execution): it turns power
samples, device states, prices, and budgets into a `DevicePlan` (shed / restore / keep per device).
Execution — converging observed state onto that plan — is `lib/executor`.

## Map

- `planService.ts` — rebuild orchestration: triggers, signatures/dedupe, status + overview logging.
- `planEngine.ts` — narrow planner-facing behavior contract implemented by the setup-owned composition facade.
- `planBuilder.ts` — pure-ish plan assembly: context → shedding → restore → materialization.
- `admission/` — per-device admission gates (activation backoff, reserve, shedding guard).
- `shedding/` — the only place that *selects* devices to shed. **Has its own AGENTS.md — read it first.**
- `restore/` — restore selection, timing, and accounting (exponential back-off).
- `swap/` — priority-based device swapping lifecycle.
- `rebuildScheduler/` — when to rebuild (power-driven, signal-driven, shortfall suppression).

## Invariants (enforced — see `.dependency-cruiser.cjs` and `docs/technical.md`)

- **No EV cluster on the plan device, and there is not going to be one** (owner ruling
  2026-08-15). `EvKind` / `EvDiscriminantProbe` / `withEvDiscriminant` are deleted, and the
  `isEvPlanDevice` guard that several docblocks used to cite never existed at all. A boost threshold
  is configuration, so the planner does not carry one: it carries a single kind-free `boostActive`
  decision (`planBoost.ts`) resolved from the producer's `boostSupported`/`boostRequested`, and the
  settings UI reads the battery level from the seam that owns it (`getObservedStateOfCharge` in
  `createPlanService`) and the configured thresholds straight from the settings store — those never
  cross the plan wire at all. The three clusters the planner discriminates are temperature, stepped,
  and binary — do not add a fourth for EV. (`EvObservedFields` on the OBSERVER snapshot is a
  different thing and stays.)
  **Scope: this is about the EV CLUSTER and the output `DevicePlanDevice`.** It is not licence to
  strip `stateOfCharge` from `PlanInputDevice`. That field rides the input device undeclared —
  `toPlanDevice` deliberately does not strip it, because `ObjectiveDeviceInput` reads it in
  `lib/objectives/deferredObjectives/diagnosticProgress.ts`, and removing it turned every EV smart
  task's progress into `objective_progress_stale`. The contract and the runtime disagree about that
  field on purpose until someone reconciles them; see the TODO item "`stateOfCharge` rides the plan
  device undeclared".
- **No `lib/device` imports** except the producer seams `deviceObservation.ts`,
  `deviceActionProjection.ts`, `deviceResidualKw.ts` (`no-plan-to-device`). Resolution happens in
  the producer projection; the planner consumes flat `PlanInputDevice` fields, never source/evidence.
- **Smart-task-agnostic**: never import anything from `lib/objectives/**` — the source AST guard
  behind `npm run arch:grep` fails on ANY `lib/plan` → objectives edge, including type and dynamic
  forms (`no-plan-to-smarttasks` additionally covers `deferredObjectives/` in dep-cruiser).
  Deferred decoration arrives only through the
  injected `decorateDeferredObjectives` seam as a flat `DeferredDecorationBundle`.
- **Decorations may only move numbers, never select devices** (convention — dep-cruiser cannot see
  this, since the seam passes flat bits rather than imports). A decoration flag may **subtract from
  a figure admission already consumes**. It must never **add a device to `shedSet`** and must never
  **produce an actuation intent**.

  Those two clauses are the whole rule, and both are greppable. Note what is deliberately NOT in
  it: a restore reject setting `plannedState: 'shed'` on a device that is *already off* is ordinary
  shared machinery (`rejectBinaryRestore` does it for every reject reason) and records "not
  resumed", not "selected for shedding". Do not write the rule as "must not set another device's
  `plannedState`" — the reference implementation does exactly that, through that shared path.

  Equally, do **not** state it as "a decoration must not affect other devices". A headroom reserve
  plainly does affect them: they are not resumed, they classify as `HOLD_REASON_CODES`, and since
  2026-08-08 they **accrue held-back time** — `reservedForStart` counts on the starvation clock
  like any other PELS-imposed hold. That version is unfalsifiable and would wave through the next lane
  exactly as `lib/plan/shedding/pauseHold.ts` was waved through — it passed every import check and
  still put a smart-task-shaped shed lane in the planner.

  Reference: `headroomReserve.ts`, and the shipped `reserveHeadroomForPendingRestores`. The
  no-actuation half is enforced by membership in `RESTORE_ADMISSION_HOLD_REASON_CODES` and pinned
  by `test/unit/planDecisionSemantics.test.ts` — if you add a reason here, pin it there. If your
  design needs an exemption clause written into an AGENTS.md or a note, that is evidence to
  redesign it, not permission to write the clause. See
  `notes/deferred-load-objectives/preemptive-power-reservation.md`.
- **The planner trusts power data and holds no concept of staleness.** `lib/power`
  owns the meter, so it decides what a doubtful reading means and answers in kW:
  `PlanContext` carries `headroomForLimitKw`, `powerIsMeasured`, and
  `powerMeasuredAtOrBelowKw` — no total, no freshness label, nothing to
  discriminate. `PowerFreshnessState` must not be importable from `lib/plan`. This
  is the twin of `observationStale` being off the plan kinds, and it exists
  because four control paths had each re-derived "is power observable" from a
  freshness label, disagreeing with the producer's own answer. Display facts
  (`powerFreshnessState`, the raw total) travel BESIDE the context to the meta
  writer, never on it — a field a builder can reach is a field a builder will
  branch on. Owner ruling 2026-08-16; `notes/safe-pace-two-constraints.md`.
- Shed cooldown ≥60 s; restore cooldown 60–300 s. Plan materialization copies `shedSet` but never selects new sheds.
- **The planner does not import the executor.** Setup composes planner and executor behind the
  `PlanEngine` behavior contract, while shared result shapes live in `lib/planContract/`.
  `no-plan-to-executor` enforces value edges for every `lib/plan` module; the same source AST guard
  behind `npm run arch:grep` also rejects type-only and dynamic executor imports.

  Be precise about what that buys: `planServiceRebuild.maybeApplyPlanChanges` still READS a drift
  verdict (through `planEngine.hasExecutionWorkOutstanding`) to decide whether a rebuild that changed
  no decisions should actuate anyway. That is a cost optimization, not a decision, and it is a drift
  question on the planner's side of the wall; the boundary is about imports until it is gone.
  Removing it means actuating unconditionally on every non-dry-run rebuild and letting the executor
  no-op per device; see the P2 in `TODO.md`.

  What the planner no longer does is supply the live side of that verdict. It used to pass the same
  `PlanInputDevice[]` the plan was built from, which meant the executor never saw an observation —
  only a plan with observations folded into it, and one whose `observedBinaryState` therefore meant
  two different things by construction path (`TODO.md`, the drift P0). The executor now reads the
  observation from the observer and the in-flight command state from its own stores. Do not hand it
  a device list again: the moment a plan-layer shape carries the live side, the executor is once
  more comparing intent against something the planner produced.

  A device that moved on its own is an ordinary input, so the honest answers include *"put it back"*
  and *"leave it there and shed something else instead"*. The second one is why this matters: a lane
  that re-applies the committed plan can only ever produce the first, and it caused a hard-cap
  breach in production (`TODO.md`, inc_26449fb9). `PlanService` therefore has exactly one way to
  converge a device — `rebuildPlanFromCache`. Do not add an apply-without-decide path back; if a
  rebuild is too slow for some caller, make the rebuild cheaper.

  That observation reaches the planner as STATE, not as a trigger. A whole-home meter reading is
  what triggers a rebuild (`PLAN_REBUILD_TRIGGERS` in `planRebuildTrigger.ts`, root `AGENTS.md`
  § Control Flow), and the reading that arrives next carries the drifted device with it — so the
  rebuild it drives is a full re-decide and both answers above are still on the table. What is gone
  is the device-event trigger that used to run a capacity decision against a reading taken before
  the change. The executor needs no lane of its own for this: in production `applyPlanActions` is
  reached only from `maybeApplyPlanChanges`, so every executor tick already IS a rebuild.

  Two asymmetries to know about, and they are the same shape. `rebuildPlanFromCache` consults
  `planBuildGate` while the public `buildDevicePlanSnapshot` on the same class does not; and
  `maybeApplyPlanChanges` decides before actuating while the public `PlanService.applyPlanActions`
  (re-exposed as `protected` on `AppRuntimeApi`) actuates a plan handed to it. Neither has a
  production caller — `applyPlanActions` survives because `test/integration/plan.test.ts` drives the
  executor through it with hand-built plans — so nothing is wrong today. But the second one is
  literally an apply-without-decide door, and the difference is invisible at the call site. If you
  reach for either, route it through the gate or make it non-public rather than adding a second
  door; do not let a production caller grow onto `applyPlanActions`.

  `planLiveStateMerge.ts` is the trap adjacent to this rule: it merges observations onto a plan
  while carrying the decision fields through untouched, so its output is by construction the OLD
  decision seen freshly. It is for publishing snapshots, never for deciding to actuate.

## Terminology: the safe-pace family

`notes/safe-pace-two-constraints.md` § "Canonical names" is the definition of record
for every pace/limit/exempt quantity, and its translation subsection maps the local
names onto the canonical ones. Read it before naming, renaming, or comparing any of
them — the local names here are still mid-migration, and `softLimit` in particular
means two different quantities depending on the site.

The trap it exists to prevent: `capacityPaceKw` and `budgetPaceKw` sit on **different
axes** (all of net import vs net import minus exempt draw), so they are not directly
comparable. Rebasing between them happens at three known sites, and the exempt sum
each uses is the point:

- `planBuilder` rebases forward with the **projected** sum, producing the binding
  pace and the display tick.
- `planContext` rebases forward with the **measured** sum, producing
  `budgetHeadroomKw` for per-axis restore admission, so an off exempt device
  reserves nothing on the budget axis.
- `planStatusHelpers` applies the inverse subtraction to keep the displayed
  composition additive.

Before adding a fourth, be explicit about which exempt sum it needs and why.

## Not in this module

- Actuation/dispatch (`lib/executor`, `lib/actuator`), Homey SDK reads/writes (producer + setup adapters), smart-task logic (`lib/objectives/deferredObjectives/`).
