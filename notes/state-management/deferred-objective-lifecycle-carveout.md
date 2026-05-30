# Smart-task controller: planner knows nothing about smart tasks

Status: **design — controller/inversion model.** Supersedes two earlier framings: a generic
"device-prep layer" (round 1), then a "clock-driven producer whose flat facts the planner
consumes" (round 2). Both were wrong about the planner's role — see *Goal*. This is the current
design.

## The invariant (definition of done)

**The planner knows nothing about smart tasks.** Concretely and testably: **`lib/plan/**` imports
nothing from the smart-task controller** — enforced by a dependency-cruiser rule
(`no-plan-to-smarttasks`). That rule going green *is* the goal. Today it would fail on **8 plan
files** (`planBuilder`, `planEngine`, `admission/deferredObjective`, `admission/index`,
`planDevices`, `planLogging`, `planReasons`, `planTypes`); the program burns them down to zero.

The shape is a **dependency inversion**. Today the planner *pulls* smart tasks in (it advances the
lifecycle and applies objective settings in-loop). Target: a **smart-task controller** *pushes*
decorated `PlanInputDevice`s into a smart-task-agnostic planner, and owns lifecycle + ending +
terminal actuation on its own clock.

**Enforcement caveat (must fix before the finish line is trustworthy).** The dependency-cruiser
config runs in *post-compilation* mode (`tsPreCompilationDeps` unset), so `import type` edges are
invisible to every rule. Both the `no-plan-to-smarttasks` burn-down meter *and* the
`no-objectives-to-peer-except-power` relocation gate therefore see only **value** imports — a
meter that can read zero while type-only plan↔controller coupling persists. Flipping
`tsPreCompilationDeps: true` globally surfaces **~18 pre-existing repo-wide violations** (mostly
`no-circular`), so it cannot just be turned on. Until that prerequisite cleanup lands, each
relocation/finish-line step must prove decoupling with a **type-edge audit** (grep the moved
module for `from '..plan'` imports, or a scoped pre-compilation-deps run), not the dep-cruiser
green alone. Tracked in `TODO.md`.

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
routing the binary disable (direct + flow-backed, non-EV + EV `ev_pause`) through a reason-blind
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
6. **Controller owns ending + the direct disable actuator — NOT DONE (this is PR-E, the real
   end-game).** Goal 2's output side is *not* satisfied yet. Today the deadline-passed **task**
   disable (`disableDeferredObjectiveInSettings`) runs on the clock-driven
   `DeferredObjectiveLifecycleEmitter` (PR-C), but the **device** terminal turn-off still rides the
   plan→executor path: the controller stamps a flat `deferredReleaseIntent` on the plan cycle, the
   planner attaches it (`attachDeferredReleaseIntents`), the executor actuates it. The planner is
   *agnostic* (flat intent, satisfies `no-plan-to-smarttasks`), but the terminal actuation has NOT
   come off the plan→executor path.

   **Concrete flow-mode bug this leaves open (high confidence by construction; repro pending).**
   The task-disable (30 s lifecycle clock) and the terminal `shed_release` (plan cycle) are now on
   **different clocks**. A disabled task yields **no diagnostic** (`diagnosticsBridge.ts` →
   `if (!objective.enabled) return []`), so once disabled it produces no release intent. In
   `power_source = flow` mode plan cycles can be hours apart, so the 30 s clock reliably disables
   the task **before** the next plan cycle — and that cycle then emits no `shed_release`. A cap-off
   device the task was driving (e.g. a water heater) is **left running** past a missed/unsatisfied
   deadline. (Satisfied-before-deadline is fine: the release fires on the satisfying cycle and
   re-emits idempotently. Pre-PR-C this was also fine — the disable ran *inside* the plan cycle,
   after admission. PR-C's move of the disable to the clock opened the race.)

   **PR-E fix — actuation belongs in the DEVICE layer, not the executor.** The executor's
   `applyShedReleaseIntent` is *not* the actuation primitive — every input it takes is an
   `ExecutablePlan` artifact (`ExecutableReleaseIntent`, `ExecutableSteppedLoadIntent`,
   `ExecutableObservedDeviceState`, `TargetDeviceSnapshot`, `PlanActuationMode`); it is a
   *plan-context wrapper* (cooldown-skip, observed-state idempotency, stepped re-projection) over
   the real primitive, the **device transport** (`lib/device/deviceTransport`:
   `setCapability` / `applyDeviceTargets` / `requestSteppedLoadStep`). A smart task is not a plan, so
   it must not synthesize a fake `ExecutablePlan` to feed the executor.

   **Design (extract-and-share, decided).** Extract a device-layer shed-actuation primitive —
   `lib/device/<shedActuation>` — `applyShedBehavior({ deviceId, behavior, observed, transport })`
   that issues the idempotent transport write for `turn_off` / `set_temperature` / `set_step` (+ the
   EV pause/resume variant), parameterized by `getShedBehavior` (already an app resolver) and
   observed state, with **no `ExecutablePlan` types**. **Both** consumers delegate to it:
   - the executor's plan-driven `applyShedReleaseIntent` (its plan-context wrapper now calls the
     shared primitive instead of writing the transport itself), and
   - the smart-task terminal callback: the emitter decides the terminal release on its clock and
     invokes an app-wired callback → the device-layer primitive → transport, never via the executor.

   Then retire the *terminal* release from the plan path (`attachDeferredReleaseIntents` + the
   `DevicePlanDevice.deferredReleaseIntent` field + the executor's plan-driven terminal handling).
   Constraints found while scoping:
   - `lib/objectives` **cannot** import `lib/device`/`lib/executor` (`no-objectives-to-peer-except-power`),
     so the terminal actuation is an **app-wired callback** (the app layer may touch device/executor);
     the emitter only *decides + triggers*, it never imports the actuator.
   - The emitter sees only the **narrow `ObjectiveDeviceInput`** view; the terminal-release decision
     (`shouldEmitTerminalRelease`: `satisfied && controllable === false` → `shed_release`/`ev_pause`)
     needs `controllable` + the device's shed behavior, so either widen that input or compute the
     decision app-side.
   - **Idempotency** must hold on the clock (don't re-command an already-off device) — the shared
     device-layer primitive carries the observed-state guard that the plan path re-emits with today.
   - **Fork (decided: A).** Move only the **terminal** (satisfied/ended) actuation to the controller;
     leave the recurring **idle-bucket holds** on the plan path (they are per-cycle planning, not
     terminal). Revisit if the idle holds prove to want the same treatment.
   - Regression test: flow-mode task, deadline passes unsatisfied → assert the cap-off device is
     turned off via the lifecycle clock, not left running.
7. **Flip `no-plan-to-smarttasks` to `error` — DONE (PR-D2).** `lib/plan/**` imports zero
   `lib/objectives` (value AND type, confirmed by `grep -rn "from .*objectives" lib/plan/` → none;
   the rule is type-edge-blind so the grep audit, not cruiser-green alone, gated the flip). The
   executor is independently objectives-free too. Planner and executor now know nothing about smart
   tasks.

## Open questions / risks (reviewers, attack these)

1. **Two loops (clock + power) touching shared state** — what snapshot/ordering discipline
   prevents the planner reading half-decorated inputs? The decoration must complete before the
   plan cycle reads the input; is an immutable per-cycle decorated-input snapshot the seam, and
   where does it live (`setup/` assembly, or a controller method the plan-input builder calls)?
2. **Clock tick mechanism** — timer granularity (minute-ish?), restart behavior, DST 23/25 h.
   Does the actuator's per-tick self-heal hold in `flow` mode and across restart?
3. **`controllable === false` gate** — does it *fully* prevent controller/planner write
   contention, including the transitional cycle where a task is ending as caps releases?
4. **Decoration vs facts boundary** — `concurrentEligibleCount` and the floor/headroom coupling:
   are these fully expressible as device-input decoration, or is there a genuinely cross-device
   capacity quantity that has no per-device home? If the latter, that is the one fact that must
   cross as data — find it explicitly rather than letting the planner re-import the controller.
5. **New peer dep-cruiser rule** — `lib/smartTasks/` (if chosen) needs its own
   `no-smarttasks-to-peer-except-(power|objectives)` rule; confirm it consumes only
   power/objectives/contracts/shared-domain downward.
