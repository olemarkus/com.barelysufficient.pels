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
grep-verified); the executor is independently objectives-free.

The shape was a **dependency inversion**, now realized: the planner no longer *pulls* smart tasks
in (it used to advance the lifecycle and apply objective settings in-loop). A **smart-task
controller** *pushes* decorated `PlanInputDevice`s into a smart-task-agnostic planner, and owns
lifecycle + ending + terminal actuation on its own clock.

**Enforcement caveat (standing — still true post-ship).** The dependency-cruiser config runs in
*post-compilation* mode (`tsPreCompilationDeps` unset), so `import type` edges are invisible to
every rule. Both the `no-plan-to-smarttasks` rule *and* the `no-objectives-to-peer-except-power`
gate see only **value** imports — a meter that can read zero while type-only plan↔controller
coupling persists. The flip of `no-plan-to-smarttasks` to `error` was therefore gated on a manual
**type-edge audit** (`grep -rn "from .*objectives" lib/plan/` → zero), NOT cruiser-green alone, and
the same grep must guard any future `lib/plan` change near the seam. Flipping
`tsPreCompilationDeps: true` globally surfaces **~18 pre-existing repo-wide violations** (mostly
`no-circular`), so it cannot just be turned on — durable hardening (burn those down + enable the
flag, or a grep-based CI check) is tracked in `TODO.md`.

## Goal (two-fold, one decoupling)

The smart-task (deferred-objective) lifecycle comes off the planner on **both ends**:

1. **Off the planner's clock (input).** Lifecycle state is *clock-driven* (deadline,
   hours-remaining, progress vs time). The planner is *reactive* — driven by power samples and
   device events. Today `buildDeferredObjectiveDiagnostics` / `emitDeferredObjectiveStatusTransitions`
   run **inside** `planBuilder`, so lifecycle state only advances when a power event wakes the
   planner. **Concrete bug:** in `power_source = flow` mode, plan cycles can be hours apart, so
   deadline transitions / ended events / hours-remaining crossings **lag until the next power
   event**. The lifecycle needs its own clock tick, owned by the controller.

   The controller's hand-off to the planner is **device-input mutation, not fact consumption.**
   The planner does *not* read smart-task status/diagnostics. The controller folds each task's
   effective settings into the `PlanInputDevice` for the current moment ("we're in an active hour
   for this device → enable caps / set the target"); the planner then plans on those decorated
   inputs, ignorant that smart tasks exist. This is the existing override channel
   (`applyDeferredAdmissionToInput` / `buildDeferredTargetOverrides` / `applyDeferredObjectiveAdmission`),
   **relocated to the controller** and made the *sole* channel — with the in-loop lifecycle
   advancement/emission deleted from the planner.

2. **Off the planner's path (output).** The terminal turn-off is currently smuggled out as a
   per-cycle `shed_release` plan intent riding the capacity shed actuation path. The controller
   **ends the task and actuates the terminal disable directly** (controller → transport), on its
   own clock — never through the plan→executor capacity path.

## Vocabulary (load-bearing)

- **Smart-task controller** = the stateful owner of a task's lifecycle: trigger-initiated (a Flow
  trigger starts a task), clock-driven (advances state on time), responsible for **ending** the
  task. Its outputs are (a) device-input mutations the planner consumes and (b) the terminal
  disable actuation. Called a *controller*, not a *producer* — it owns and drives state, it does
  not merely emit facts for the planner to read.
- **Shed** = a *capacity cause* ("over budget → reduce load"). Stays "shed" in the plan path;
  that path genuinely sheds.
- **Disable / limit** = the *effect*: drive a device to its configured **fallback posture**
  (fully off = disable; stepped-down / lower setpoint = limit).
- **Lifecycle-end** = a *different cause* invoking the **same** disable/limit effect (task done
  → return device to fallback). It is **not** a shed.
- Today's `shedBehavior` / `OVERSHOOT_BEHAVIORS` config *is* the device's fallback posture.
  Renaming that config vocabulary touches settings keys + UI + logs — a **follow-up**, not in
  scope here.

## Target architecture (three components)

1. **Smart-task controller** — the `lib/objectives/deferredObjectives/` subsystem (status
   `statusBus`/`statusTransitions`, lifecycle `activePlanRecorder`, `endedEventBus`, horizon
   `rescueReplan`/`policyHorizon`, the concurrent-eligible tracker), **relocated out of `lib/plan`**
   (PR-B, into the objectives peer) and — still to come — advanced on its **own clock tick** wired
   in `setup/`. It already has non-plan consumers
   (`flowCards/deadlineObjectiveCards.ts`, `smartTaskTokens.ts`, `smartTaskRescueCard.ts`,
   settings-UI history) — evidence it is not plan-internal. It reads device data through a narrow
   input contract (`ObjectiveDeviceInput`), not `PlanInputDevice`.

2. **Device-input decoration (controller → planner)** — the controller owns
   `applyDeferredAdmissionToInput` / `buildDeferredTargetOverrides` / `buildDeferredReleaseIntents`
   / the objective admission applier, and emits **decorated `PlanInputDevice`s** (or a narrow
   override set the input pipeline applies). This is the *only* channel into the planner. The
   planner imports nothing smart-task; it just plans on the inputs it is handed.

3. **Clock-driven disable actuator** — on each lifecycle tick, for any task in a **terminal**
   state on a **`controllable === false`** device still observed `on`, the controller drives it
   to its configured fallback posture (**disable/limit**) via the **transport**. Self-healing
   (per-tick re-check survives dropped writes / unknown-observation), idempotent (observed-on
   gate), no flow-mode lag (clock-driven). Not a one-shot. This is today's release-actuation
   logic, decoupled from the capacity path and re-homed onto the controller's clock.

**Power-driven planner (`lib/plan`)** — reactive, smart-task-agnostic. Operates only on the
`PlanInputDevice`s it is handed; decides capacity **sheds**, which invoke the shared disable/limit
effect via the executor. No objective lifecycle, no objective facts, no objective imports.

**No second-writer contention:** the disable actuator only touches `controllable === false`
devices — exactly the ones the planner has let go of (`shouldEmitTerminalRelease` already gates
on this). The "caps-off-first, then disable" ordering is structural, not timing-dependent.

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
- **`concurrentEligibleCount` is a controller-owned per-bucket RESOLVER, not a flat input.** It is
  a stateful `ConcurrentEligibleTaskTracker` (cross-cycle grace map, per-bucket deadline filter)
  returning `(bucketStartMs) => number`. The controller owns the tracker + closure; the seam
  carries stateful bucket-parameterized logic, not a scalar — so it must ride the decorated-input
  channel, not be flattened to a number.
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
4. **Lift the lifecycle EMISSION onto the clock (done — PR-C).** Shape chosen: *emission on
   clock, decoration synchronous*. Only the non-planning emission — status transitions,
   hours-remaining crossings, diagnostics, **plan-history** recording, and the deadline-passed
   disable — moved onto a 30 s clock tick (`DeferredObjectiveLifecycleEmitter` +
   `startDeferredObjectiveLifecycleClock`, wired via `BackgroundTasksController`). The
   **active-plan COMMITMENT stays synchronous in `planBuilder`** (review catch): the planner
   reads committed plans via `resolveCommittedHours` for its decoration, so promoting them is
   decoration-relevant and must not lag a clock tick. The clock only *clears* an ended task's
   plan (via `onDeadlinePassed → disable`), phase-separated from planBuilder's commit. The emitter
   owns its own `ConcurrentEligibleTaskTracker` + the watermark closure; it is the sole writer to
   the plan-history recorder. Fixes the `power_source = flow` lag with no two-loop staleness — the
   decoration (admission/overrides/active-plan commit) stays synchronous per plan cycle; the full
   decoration relocation is PR-D (step 5). The planner still imports the subsystem for the
   decoration eval, so `no-plan-to-smarttasks` still fires until step 5/6.
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
     (the disable is a settings write; the physical release rides the `deferredReleaseIntent` field
     already on `PlanInputDevice`) needs it. The handoff's closure claim was also wrong —
     `SteppedStepActuationState` belongs to `ExecutableSteppedLoadDevice` (an executor reconciliation
     type that stays put), not to `ExecutablePlan`'s closure. So `ExecutablePlan` stays in
     `lib/executor`.
   - **PR-D2 (done):** the 4 admission appliers + the objective eval moved onto the
     `DeferredObjectiveDecorationController` (`lib/objectives/deferredObjectives/`). It owns the
     `ConcurrentEligibleTaskTracker` and exposes `decorate({devices, dailyBudgetSnapshot, nowTs})
     → DeferredDecorationBundle` (bundle + `DeferredReleaseIntent` + the input type live in
     `@pels/planner-types`). The controller is constructed in the **app-wiring layer**
     (`lib/app/appInit.ts`) and injected into the engine as the opaque `decorateDeferredObjectives`
     function — so **both** `planBuilder` AND `planEngine` import zero `lib/objectives` (the engine
     forwards the function; it never constructs the controller). `admission/deferredObjective.ts`
     deleted; active-plan commitment stays synchronous (PR-C catch); the
     `evaluate_deferred_objectives_ms` / `plan_deferred_objective_observe_ms` perf split is
     preserved (the controller times its own eval). Behavior-neutral: full suite green (4009).
6. **Clock-driven terminal device disable (PR-E — done, additive).** Goal 2's *output* side had a
   real flow-mode bug: a disabled task yields no diagnostic (`diagnosticsBridge` →
   `if (!objective.enabled) return []`), and after PR-C the deadline auto-disable runs on the 30 s
   lifecycle clock while the terminal `shed_release` rode the *plan* cycle — so in
   `power_source = flow` mode (plan cycles hours apart) the clock disabled the task before the next
   plan cycle could emit the release, leaving a cap-off device on a **missed/unsatisfied** deadline
   running. PR-E fixes it on the lifecycle clock:
   - A single app-wired `onDeadlineReached(deviceId, objectiveKind, deadlineAtMs, nowMs)` hook
     (`statusTransitions` → `DeferredObjectiveLifecycleEmitter` →
     `deferredObjectiveLifecycle.handleDeferredDeadlineReached`) fires at **deadline-passed,
     regardless of status** — so missed/unsatisfied tasks are covered, not just `satisfied`.
   - It returns the cap-off device to its configured fallback posture via a **thin, set-and-forget
     device-layer primitive** (`lib/device/shedBehaviorActuation.applyShedBehavior`: one transport
     write per `turn_off`/`set_temperature`/EV-pause, observed-state idempotency, no `ExecutablePlan`
     types, no executor reconciliation). The executor is untouched.
   - The **disarm is gated** (`planTerminalEnding`): disarm only once the device is observed in the
     shed posture, or after a 5-min grace window — so the diagnostic survives and the release
     re-fires across ticks (a transient `unknown` observation or a dropped write self-heals) instead
     of being a single shot.
   - **Additive, not a retirement.** The plan-path `deferredReleaseIntent` (`attachDeferredReleaseIntents`
     + the executor release intent) **stays** as an idempotent backstop AND because the recurring
     **idle-bucket holds still ride it** (Fork A keeps idle on the plan path — those need the shared
     release-intent channel; only the *terminal* ending moved to the clock).

   **Follow-ups (not blocking):** (a) fully retiring the *terminal* release from
   the plan path (so it isn't double-covered) is a later cleanup; (b) the same
   "task disabled → device stranded" shape exists for a **user/Flow disable**
   mid-run, not just deadline-passed — out of PR-E scope. The former niche
   stepped-only `set_step` gap is closed: a no-binary-handle stepped device now
   gets a direct lifecycle-clock `set_step` shed command, and disarm waits for
   observed stepped posture (or the normal grace window).
7. **Flip `no-plan-to-smarttasks` to `error` — DONE (PR-D2).** `lib/plan/**` imports zero
   `lib/objectives` (value AND type, confirmed by `grep -rn "from .*objectives" lib/plan/` → none;
   the rule is type-edge-blind so the grep audit, not cruiser-green alone, gated the flip). The
   executor is independently objectives-free too. Planner and executor now know nothing about smart
   tasks.

## Resolved questions / risks (how the ship answered them)

1. **Two loops (clock + power) touching shared state** — RESOLVED: the decoration stays
   **synchronous** with the plan cycle. The controller's `decorate()` runs inline in
   `planBuilder.buildPlanSnapshotWithTimings` (PR-D2), so there is no half-decorated-input window;
   only the lifecycle EMISSION + the terminal disable run on the separate 30 s clock (PR-C/PR-E).
   Active-plan commitment is the one decoration-relevant promotion kept synchronous (PR-C catch).
2. **Clock tick mechanism** — RESOLVED: 30 s tick (`startDeferredObjectiveLifecycleClock`), deadlines
   are absolute timestamps (DST-safe), and the terminal actuator self-heals per-tick (re-fires until
   the device confirms the shed posture or a 5-min grace; works in `flow` mode + across restart).
3. **`controllable === false` gate** — RESOLVED: the terminal release only touches cap-off
   (`isCapacityControlEnabled === false`) devices; cap-on stays on the planner's lane. No
   contention. The transitional cap-off ending is handled by the gated disarm.
4. **Decoration vs facts boundary** — RESOLVED: `concurrentEligibleCount` stays a controller-owned
   stateful resolver (`ConcurrentEligibleTaskTracker`) inside the decoration channel; no cross-device
   capacity fact had to cross as data — the planner imports nothing smart-task.
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
