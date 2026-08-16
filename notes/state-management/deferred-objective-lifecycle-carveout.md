# Smart-task controller: planner knows nothing about smart tasks

Status: **SHIPPED (2026-05-30) — controller/inversion model.** Both ends of the carve-out landed;
`no-plan-to-smarttasks` is enforced as `error` and green. Shipped across PR-A #1298, PR-A2 #1300,
PR-B #1302, PR-C #1311, **PR-D1 #1324** (`@pels/planner-types` + `PlanInputDevice` hoist),
**PR-D2 #1330** (decoration controller; rule flipped to `error`), **PR-E #1338** (clock-driven
terminal device disable). PR-D1b (ExecutablePlan hoist) was dropped — no objectives consumer.
This document is now a historical design record + the home for the remaining follow-ups (see the
*Increments* and *Follow-ups* below; the per-step detail is preserved for context). The earlier
"design" framing below superseded two prior ones (a generic "device-prep layer", then a
"clock-driven producer whose flat facts the planner consumes") — both wrong about the planner's
role; the inversion model is what shipped.

## The invariant (achieved + enforced)

**The planner knows nothing about smart tasks.** Concretely and testably: **`lib/plan/**` imports
nothing from the smart-task controller** — enforced by a dependency-cruiser rule
(`no-plan-to-smarttasks`), now `error` and green. The 8 plan files that originally coupled in
(`planBuilder`, `planEngine`, `admission/deferredObjective`, `admission/index`, `planDevices`,
`planLogging`, `planReasons`, `planTypes`) were burned down to zero (value AND type edges,
source-guard verified); the executor is independently objectives-free.

The shape was a **dependency inversion**, now realized: the planner no longer *pulls* smart tasks
in (it used to advance the lifecycle and apply objective settings in-loop). A **smart-task
controller** *pushes* decorated `PlanInputDevice`s into a smart-task-agnostic planner and emits
clock-owned lifecycle facts. Setup owns home-scope/write authority and deadline disarm; the executor
owns fallback convergence, command claims, pending/retry, diagnostics, and actuation.

**Source-edge enforcement.** The dependency-cruiser config runs in
*post-compilation* mode (`tsPreCompilationDeps` unset), so `import type` edges are invisible to
every rule. The source AST guard behind `npm run arch:grep` now rejects any planner import from
`lib/objectives` or `lib/executor`, including type-only, re-export, `require`, and dynamic-import
forms, before compilation can erase it. The `no-objectives-to-peer-except-power` cruiser rule still
sees value edges only; do not treat that limitation as permission for an objectives type edge.
Flipping
`tsPreCompilationDeps: true` globally surfaces **~18 pre-existing repo-wide violations** (mostly
`no-circular`), so it cannot just be turned on.

## Goal (two-fold, one decoupling)

The smart-task (deferred-objective) lifecycle comes off the planner on **both ends**:

1. **Off the planner's clock (input).** Lifecycle state is *clock-driven* (deadline,
   hours-remaining, progress vs time). The planner is *reactive* — driven by power samples and
   device events. Before PR-C, `buildDeferredObjectiveDiagnostics` /
   `emitDeferredObjectiveStatusTransitions` ran **inside** `planBuilder`, so lifecycle state advanced
   only when a power event woke the planner. In `power_source = flow` mode, plan cycles could be
   hours apart, so deadline transitions / ended events / hours-remaining crossings lagged until the
   next power event. PR-C moved that lifecycle work to the controller's own clock tick.

   The controller's hand-off to the planner is **device-input mutation, not fact consumption.**
   The planner does *not* read smart-task status/diagnostics. The controller folds each task's
   effective settings into the `PlanInputDevice` for the current moment ("we're in an active hour
   for this device → enable caps / set the target"); the planner then plans on those decorated
   inputs, ignorant that smart tasks exist. This is the existing override channel
   (`applyDeferredAdmissionToInput` / `buildDeferredTargetOverrides` / `applyDeferredObjectiveAdmission`),
   **relocated to the controller** and made the *sole* channel — with the in-loop lifecycle
   advancement/emission deleted from the planner.

2. **Off the planner's path (output).** The former terminal turn-off was smuggled out as a
   per-cycle `shed_release` plan intent riding the capacity shed actuation path. The controller
   now ends the task on its own clock and sends a narrow fallback request to the executor-owned
   lifecycle port. The executor reads fresh observer truth plus the app-owned decorated command
   projection, then converges through the shared actuator and pending/retry machinery. There is
   no controller→transport write and no plan-carried terminal release.

## Vocabulary (load-bearing)

- **Smart-task controller** = the stateful owner of task evaluation and lifecycle progression:
  trigger-initiated (a Flow trigger starts a task), clock-driven (advances state on time), and the
  producer of device decorations plus satisfied/deadline lifecycle facts. Called a *controller*,
  not a *producer*, because it owns and drives task state; it does not own Homey writes.
- **Lifecycle coordinator (setup)** = the authority boundary: resolves home scope, device
  commandability, configured fallback, and deadline disarm, then calls the executor port.
- **Lifecycle fallback executor** = the owner of convergence and every binary/target/step write,
  sharing claims, pending/retry, diagnostics, and the actuator seam with ordinary execution.
- **Shed** = a *capacity cause* ("over budget → reduce load"). Stays "shed" in the plan path;
  that path genuinely sheds.
- **Disable / limit** = the *effect*: drive a device to its configured **fallback posture**
  (fully off = disable; stepped-down / lower setpoint = limit).
- **Lifecycle fallback** = a *different cause* invoking the **same** disable/limit effect (early
  satisfaction or deadline ending returns the device to fallback). It is **not** a shed.
- Today's `shedBehavior` / `OVERSHOOT_BEHAVIORS` config *is* the device's fallback posture.
  Renaming that config vocabulary touches settings keys + UI + logs — a **follow-up**, not in
  scope here.

## Target architecture (three components)

1. **Smart-task controller** — the `lib/objectives/deferredObjectives/` subsystem (status
   `statusBus`/`statusTransitions`, lifecycle `activePlanRecorder`, `endedEventBus`, horizon
   `rescueReplan`/`policyHorizon`, `priorityAllocation`), **relocated out of `lib/plan`**
   (PR-B, into the objectives peer) and advanced on its **own clock tick** wired in `setup/`.
   It already has non-plan consumers
   (`flowCards/deadlineObjectiveCards.ts`, `smartTaskTokens.ts`, `smartTaskRescueCard.ts`,
   settings-UI history) — evidence it is not plan-internal. It reads device data through a narrow
   input contract (`ObjectiveDeviceInput`), not `PlanInputDevice`.

2. **Device-input decoration (controller → planner)** — the controller owns
   `applyDeferredAdmissionToInput` / `buildDeferredTargetOverrides` / `buildDeferredReleaseIntents`
   / the objective admission applier, and emits **decorated `PlanInputDevice`s** (or a narrow
   override set the input pipeline applies). This is the *only* channel into the planner. The
   planner imports nothing smart-task; it just plans on the inputs it is handed.

3. **Clock-driven fallback convergence** — on each lifecycle tick, setup authority-gates a
   satisfied/deadline task on a **`controllable === false`** device, resolves the configured
   binary/target/stepped fallback into a smart-task-neutral executable request, then sends that
   request to the executor-owned lifecycle fallback port. The executor reuses its pending, retry,
   diagnostics, and actuator paths. Self-healing
   (per-tick re-check survives dropped writes / unknown observation), idempotent, and free of
   flow-mode lag. Setup alone owns deadline disarm.

**Power-driven planner (`lib/plan`)** — reactive, smart-task-agnostic. Operates only on the
`PlanInputDevice`s it is handed; decides capacity **sheds**, which invoke the shared disable/limit
effect via the executor. No objective lifecycle, no objective facts, no objective imports.

**No second-writer contention:** lifecycle fallback only touches `controllable === false` devices —
exactly the ones the planner has let go of. Terminal admission is plain `inactive` and emits no
plan-path release intent. The "caps-off-first, then fallback" ordering is structural, not
timing-dependent; shared executor claims serialize any ordinary write already in flight at the handoff.

## Capacity-marker fix (shipped — historical, was the independent first down-payment)

Separate from the relocation; shipped in PR #1278 + `fix/device-control-intent`. The live bug:
the **binary** disable path stamped capacity cooldown markers
(`applyShedReleaseBinaryOff → applyBinarySheddingToDevice → recordShedActuation`), polluting
`lastInstabilityMs` / `lastDeviceShedMs` for a non-capacity event → mis-paced restores. Fixed by
routing the binary disable (direct + flow-backed, non-EV + EV `binary_release`) through a reason-blind
diagnostic-only dispatch off the capacity path (`pendingBinaryCommands.lifecycleRelease`
discriminator), plus the marker-ownership decomposition (`shedDecidedMs` decision-time clock vs
`lastDeviceShedMs` actuation clock). Superseded #1249. This was the first down-payment on goal 2
(disable off the capacity write path).

## Verification status (confirmed findings)

- **Relocation requires a type-boundary prep — confirmed, and resolved by a narrow contract, not
  a `PlanInputDevice` hoist.** `deferredObjectives` imports from `lib/plan` via exactly one path:
  `import type { PlanInputDevice }` (×7), and from `lib/dailyBudget` via `DailyBudget*Payload`
  (×4). `lib/objectives/` (and any leafward peer home) is forbidden from both edges by
  `no-objectives-to-peer-except-power`. The producer only reads a ~15-field device-data subset, so
  the prep is a **narrow `ObjectiveDeviceInput` contract** (read side) + a **DailyBudget-payload
  hoist to `packages/contracts`** (re-export shim keeps the other 33 consumers untouched) — the
  planner adapts `PlanInputDevice → ObjectiveDeviceInput` at the call boundary. `planTypes` does
  not reference `deferredObjectives`, so there is no cycle through the type edge once the import is
  redirected. The `power/tracker` import is the allowed power↔objectives cycle.
- **Priority coordination is controller-owned.** A stateful `PriorityAllocationTracker` keeps
  device ordering stable across transient SDK snapshot gaps. The batch diagnostics bridge plans
  tasks in that order and carries exact higher-task admission-power/useful-energy reservations to
  the next task; no cross-device capacity fact is pushed into the ordinary planner contract.
- **The lifecycle state machinery already exists** — this is relocation + re-clocking + dependency
  inversion, not new machinery.

## Increments

1. **Shipped (PR #1278):** reason-blind binary-disable dispatch off the capacity path.
1b. **Shipped (`fix/device-control-intent`, PR #1296):** the `shedDecidedMs` marker-ownership
   decomposition.
2. **PR-A — device input contract.** Narrow `ObjectiveDeviceInput` read contract in
   `lib/objectives/types.ts` (replaces the 7 `PlanInputDevice` imports). `PlanInputDevice` stays
   structurally assignable, so no runtime adapter — the planner passes its device list straight
   through. Behavior-neutral; no move. Lands the design note + the tracked `no-plan-to-smarttasks`
   dep-cruiser rule (`warn`) so the debt is visible.
2b. **PR-A2 — DailyBudget-payload hoist.** Move `DailyBudgetUiPayload` / `DailyBudgetDayPayload`
   (+ their type closure) to `packages/contracts`, re-export from `lib/dailyBudget/dailyBudgetTypes`
   (keeps the other ~33 consumers untouched), repoint the 4 producer files. After A + A2,
   `deferredObjectives` imports zero plan/dailyBudget peer types.
3. **PR-B — relocate (done).** `git mv lib/plan/deferredObjectives → lib/objectives/deferredObjectives`
   (subdir of the existing objectives peer — same directory depth, so every internal `../../`
   import still resolves; zero internal edits). 36 consumer import paths repointed. Chosen over a
   new `lib/smartTasks/` peer because the same-depth subdir needs no new dep-cruiser rule (the
   existing `no-objectives-to-peer-except-power` already covers it) and no `../../` churn. Type-edge
   audit confirmed zero `lib/plan` imports from the moved subsystem; `no-objectives-to-peer-except-power`
   stays green. `no-plan-to-smarttasks` `to` path updated to the new home. A later rename to
   `lib/smartTasks/` remains an option.
4. **Lift the lifecycle EMISSION onto the clock (done — PR-C).** The historical PR-C shape was
   *emission on clock, decoration synchronous*: status transitions, hours-remaining crossings,
   diagnostics, **plan-history** recording, and deadline-passed disable moved onto the 30 s clock.
   PR-C temporarily kept active-plan commitment in `planBuilder`; that choice was superseded by
   the 2026-06-01 clock-owned write described below. Today the lifecycle emitter owns the scheduled
   active-plan write and the planner only reads its settled record for decoration. This history is
   retained to explain the migration, not as a current ownership rule.
5. **Move the input-decoration appliers into the controller.** The controller emits decorated
   `PlanInputDevice`s; `planBuilder` stops calling the deferred appliers; delete
   `admission/deferredObjective.ts`. Kills the input-mutation half. Realized via a dedicated
   `@pels/planner-types` workspace (`packages/planner-types/`) that hosts the planner's I/O
   contracts below the domain peer layer, so `lib/objectives` can import them *downward* without
   inverting the peer DAG (PR-A's narrow `ObjectiveDeviceInput` decoupled only the read side; the
   controller now needs to *emit* a full `PlanInputDevice`, which is what the hoist enables).
   Sub-sequence:
   - **PR-D1 (done):** create `@pels/planner-types`; move `PlanInputDevice` (+ its
     `StepPowerCalibrationView` helper) there; `lib/plan/planTypes` re-exports both so the ~54
     existing consumers stay untouched. `planner-types` is wired into `arch:check` and the
     `shared-packages-no-runtime` / `no-circular` / `no-runtime-to-tests` dep-cruiser guards
     (browser-safe, may import only sibling shared packages like `@pels/contracts`).
     Behavior-neutral.
   - **PR-D1b — dropped.** Hoisting `ExecutablePlan` was scoped on a wrong premise: `lib/objectives`
     references zero `Executable*` types, and `ExecutablePlan` is consumed only inside
     `lib/executor/`. Neither the controller's input decoration (D2) nor its ending/disable path
     needs it: disable is a settings write, while physical fallback now enters the executor through
     its narrow lifecycle port. The handoff's closure claim was also wrong —
     `SteppedStepActuationState` belongs to `ExecutableSteppedLoadDevice` (an executor reconciliation
     type that stays put), not to `ExecutablePlan`'s closure. So `ExecutablePlan` stays in
     `lib/executor`.
   - **PR-D2 (done):** the 4 admission appliers + the objective eval moved onto the
     `DeferredObjectiveDecorationController` (`lib/objectives/deferredObjectives/`). It owns the
     `PriorityAllocationTracker` and exposes `decorate({devices, dailyBudgetSnapshot, nowTs})
     → DeferredDecorationBundle` (bundle + `DeferredReleaseIntent` + the input type live in
     `@pels/planner-types`). The controller is constructed in the **app-wiring layer**
     (`setup/homeRuntime/homeScope.ts`) and injected into the builder as the opaque
     `decorateDeferredObjectives` function — so **both** `planBuilder` AND `planEngine` import zero
     `lib/objectives` (the engine contract never constructs the controller).
     `admission/deferredObjective.ts` deleted; active-plan commitment is recorded by the lifecycle
     clock and read synchronously by planning; the
     `evaluate_deferred_objectives_ms` / `plan_deferred_objective_observe_ms` perf split is
     preserved (the controller times its own eval). Behavior-neutral: full suite green (4009).
6. **Clock-driven terminal device disable (PR-E — done; terminal plan backstop now retired).**
   Goal 2's *output* side had a
   real flow-mode bug: a disabled task yields no diagnostic (`diagnosticsBridge` →
   `if (!objective.enabled) return []`), and after PR-C the deadline auto-disable runs on the 30 s
   lifecycle clock while the terminal `shed_release` rode the *plan* cycle — so in
   `power_source = flow` mode (plan cycles hours apart) the clock disabled the task before the next
   plan cycle could emit the release, leaving a cap-off device on a **missed/unsatisfied** deadline
   running. PR-E fixes it on the lifecycle clock:
   - Two app-wired lifecycle hooks own the complete terminal sequence. `onSatisfied` returns a
     cap-off device to fallback promptly on every pre-deadline tick without disarming the task;
     `onDeadlineReached(deviceId, deadlineAtMs, nowMs)` fires at **deadline-passed,
     regardless of status** and owns gated disarm. Presentation-only stalled-to-satisfied status
     promotion does not actuate: the producer stamps `actuationSatisfied` before applying that
     display overlay, and lifecycle actuation consumes the typed raw fact.
   - App wiring owns scope fencing, device lookup, commandability, gated disarm, and resolution of
     the objective-specific fallback into a neutral executable request. `LifecycleFallbackDispatcher`
     converges that request through the existing release contexts without knowing objective kinds.
     Pending
     windows, retry backoff, lifecycle diagnostics, and activation-attempt cleanup therefore stay
     executor-owned and exposed directly to setup as a narrow lifecycle-fallback port; the
     `PlanEngine` is not part of this smart-task path. Target retry state is a minimal
     lifecycle-private store so a plan rebuild cannot prune it. Shared target and stepped claims
     are synchronous and skip-only: a colliding command is never captured for later replay. While
     lifecycle authority is active, ordinary execution stands down; abandon merely releases that
     authority so a later plan build can decide afresh.
   - Disarm happens only once the executor reports the fallback observed-settled, or after a 5-min
     deadline grace window. Early satisfaction never disarms the task.
   - The clock is now the **sole terminal trigger**. The duplicated terminal
     `deferredReleaseIntent` backstop has been retired; recurring **idle-bucket holds still ride the
     plan-path release-intent channel** until their separate clock-ownership follow-up lands.

   **Follow-ups (not blocking):** the same
   "task disabled → device stranded" shape exists for a **user/Flow disable**
   mid-run, not just deadline-passed — out of PR-E scope. The former niche
   stepped-only `set_step` gap is closed: a no-binary-handle stepped device now
   gets a direct lifecycle-clock `set_step` shed command, and disarm waits for
   observed stepped posture (or the normal grace window).
7. **Flip `no-plan-to-smarttasks` to `error` — DONE (PR-D2).** `lib/plan/**` imports zero
   `lib/objectives` (value AND type; the manual grep gated the original flip, and the source AST
   guard behind `npm run arch:grep` now enforces it continuously). The
   executor is independently free of `lib/objectives` imports too. The executor does own the generic
   lifecycle-fallback convergence port used by app wiring, but it does not import or evaluate smart-task
   diagnostics, settings, or admission policy.

## Resolved questions / risks (how the ship answered them)

1. **Two loops (clock + power) touching shared state** — RESOLVED: the decoration stays
   **synchronous** with the plan cycle. The controller's `decorate()` runs inline in
   `planBuilder.buildPlanSnapshotWithTimings` (PR-D2), so there is no half-decorated-input window;
   only lifecycle emission and terminal fallback run on the separate 30 s clock (PR-C/PR-E/#2084).
   Active-plan commitment is the one decoration-relevant promotion kept synchronous (PR-C catch).
2. **Clock tick mechanism** — RESOLVED: 30 s tick (`startDeferredObjectiveLifecycleClock`), deadlines
   are absolute timestamps (DST-safe), and executor-owned convergence self-heals per tick (retries until
   the device confirms the shed posture or a 5-min grace; works in `flow` mode + across restart).
3. **`controllable === false` gate** — RESOLVED: the terminal release only touches cap-off
   (`isCapacityControlEnabled === false`) devices; cap-on stays on the planner's lane. No
   contention. The transitional cap-off ending is handled by the gated disarm.
4. **Decoration vs facts boundary** — RESOLVED: priority ordering and the higher-task reservation
   ledger stay controller-owned (`PriorityAllocationTracker` + batch diagnostics) inside the
   decoration channel; the ordinary planner imports nothing smart-task.
5. **Peer dep-cruiser rule** — RESOLVED differently: the subsystem stayed in `lib/objectives` (no new
   `lib/smartTasks/` peer), covered by the existing `no-objectives-to-peer-except-power` rule.

## Resolved: current-hour strand at the committed-window boundary

When a task satisfied inside its committed window and the device then stalled so the need REGREW in
the first hour *after* the window had elapsed, that hour was the current hour and was uncommitted —
phase-2 expansion skipped the current bucket (`bucketAllocation.expandCommittedAllocation`,
`if (bucket.current) continue`) and the merge only adopts an hour while it is still a future hour
(`activePlanSchedule.mergeHoursPreservingCommitment`), so the hour was stranded at 0 kWh and the
device was turned off while behind target (Connected 300, 2026-05-31: stalled at ~64.4 °C, cooled,
03h stranded, missed the 06:00 deadline at 57 °C). `f9809995` had already removed the worse
permanent freeze (the commitment extends forward across elapsed hours); this was the residual single
boundary hour.

A "commit the upcoming hour just before it becomes current" clock tick could **not** close it: the
need only regrows once the hour is already current, so there is nothing to commit ahead of the
boundary. The fix instead removes the unconditional current-bucket skip in
`expandCommittedAllocation`: a *committed* current hour is still protected (left to phase-1 via the
`committedHourSet` skip — its settled budget is the contract for the hour), but an *uncommitted*
current hour is filled cheapest-first like any other hour, so the device stays on and the filled
hour self-commits for subsequent cycles. The cheapest-first sort still defers an expensive current
hour behind cheaper future hours, so price-shaped waiting is preserved. Regression:
`test/integration/deferredObjectiveCommitmentRolloverSimulation.test.ts` plus the `expandCommittedAllocation`
cases in `test/unit/deferredObjectiveHorizon.test.ts`.

## Update (2026-06-01): the active-plan WRITE moves to the clock; revisions settle once per hour at `:58`

This **supersedes PR-C's "active-plan COMMITMENT stays synchronous on the plan cycle" call.**
PR-C kept the recorder's `observe()` on the ~10 s power plan cycle. That coupled *when the plan
is recorded* to power-reading timing and churned `schedule_revised` / `deadline_plan_changed`
mid-hour: whenever a held-off device (price-deferred or capacity-shed) under-delivers, the current
hour's capacity is trimmed to the remaining clock time, so the still-owing residual repeatedly
spilled a sliver into a future hour *before the hour even ended* — a revision per cycle for a plan
that had not meaningfully changed. We cannot know until the hour closes whether the schedule needs
to change.

Two changes, on the principle **write on a schedule, read freely**:

1. **The WRITE rides the clock.** `observe()` is now called from `DeferredObjectiveLifecycleEmitter`
   (the 30 s lifecycle clock), not from `DecorationController` on the power cycle. The decoration
   controller only **reads** the committed plan (via the diagnostics build → `resolveCommittedHours`)
   to decorate device inputs. Reads are free every power cycle; only the write is scheduled. The 30 s
   clock reliably ticks inside any minute, so the settle can never be starved by power-reading timing.
2. **The recorder gates the write to once per hour at `:58`** (`isReplanDueThisCycle` +
   `markReplanSettled`, `activePlanRecorder.ts`) — when the elapsed hour's outcome is known and the upcoming (still-full)
   hour can be scheduled in. A user objective edit (`objectiveChanged`) bypasses the gate (external
   event, revise now); the first revision and pending records are immediate (so a newly-enabled task
   shows its plan within one clock tick, not at the next `:58`).

Why PR-C's caution no longer applies: it kept the write synchronous so the planner's decoration
would not read a stale commitment. But the commitment only *changes* once an hour (at `:58`), so the
planner picking up a new commitment one power cycle (≤10 s) after the clock writes it is negligible
— the committed plan is stable for the whole hour either way.

This does **not** reintroduce the current-hour strand above. Only the persisted RECORD is gated; the
planner's per-cycle live allocation is untouched, so `expandCommittedAllocation` still fills the
uncommitted current hour every cycle and a behind-target device stays on. The note above says the
filled hour "self-commits for subsequent cycles" — under the gate it instead re-fills via phase-2
each cycle until the next `:58` settle records it; the device is controlled identically either way.
Foundation for mid-execution price deferral (a `:58` scheduling decision, not a per-cycle override):
see `notes/deferred-load-objectives/execution-adaptation.md`.
