# lib/plan — Planning Engine

Owns the planning step of the control flow (measurement → **planning** → execution): it turns power
samples, device states, prices, and budgets into a `DevicePlan` (shed / restore / keep per device).
Execution — converging observed state onto that plan — is `lib/executor`.

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
  plainly does affect them: they are not resumed, they classify as `HOLD_REASON_CODES`, and they
  pause the starvation clock. That version is unfalsifiable and would wave through the next lane
  exactly as `lib/plan/shedding/pauseHold.ts` was waved through — it passed every import check and
  still put a smart-task-shaped shed lane in the planner.

  Reference: `headroomReserve.ts`, and the shipped `reserveHeadroomForPendingRestores`. The
  no-actuation half is enforced by membership in `RESTORE_ADMISSION_HOLD_REASON_CODES` and pinned
  by `test/unit/planDecisionSemantics.test.ts` — if you add a reason here, pin it there. If your
  design needs an exemption clause written into an AGENTS.md or a note, that is evidence to
  redesign it, not permission to write the clause. See
  `notes/deferred-load-objectives/preemptive-power-reservation.md`.
- Shed cooldown ≥60 s; restore cooldown 60–300 s. Plan materialization copies `shedSet` but never selects new sheds.
- **The planner does not JUDGE drift; it does still ask one question about it.** Whether observed
  disagrees with intent is computed in `lib/executor/executorConvergence.ts` (whole-plan) and
  `lib/executor/planExecutionDrift.ts` (per device), and
  `no-plan-to-executor` keeps that import out of every `lib/plan` module except `planEngine.ts` —
  the composition root, and the single seam through which the rest of the planner asks the executor
  anything.

  Be precise about what that buys, because the honest version is weaker than "the planner knows
  nothing about drift": `planServiceRebuild.maybeApplyPlanChanges` still READS a drift verdict
  (through `planEngine.hasExecutionWorkOutstanding`) to decide whether a rebuild that changed no
  decisions should actuate anyway. That is a cost optimization, not a decision — the plan it would
  apply is the one just built from these very observations — but it is a drift question on the
  planner's side of the wall, and the boundary is about imports until it is gone. Removing it means
  actuating unconditionally on every non-dry-run rebuild and letting the executor no-op per device;
  see the P2 in `TODO.md`.

  A device that moved on its own is an ordinary input, so the honest answers include *"put it back"*
  and *"leave it there and shed something else instead"*. The second one is why this matters: a lane
  that re-applies the committed plan can only ever produce the first, and it caused a hard-cap
  breach in production (`TODO.md`, inc_26449fb9). `PlanService` therefore has exactly one way to
  converge a device — `rebuildPlanFromCache`. Do not add an apply-without-decide path back; if a
  rebuild is too slow for some caller, make the rebuild cheaper.

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
