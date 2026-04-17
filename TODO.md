# TODO

Only unresolved work belongs here. Completed items live in git history and tests, not in this
file.

## P0 Correctness and control integrity

- [x] Move direct capability writes to the same confirmation-first model as binary settle and
      stepped-load callbacks so temperature and other writable capabilities do not rely on
      post-actuation polling as the normal success path.
      Files: `lib/core/deviceManager.ts`, `lib/core/deviceManagerRuntime.ts`, `app.ts`,
      capability-write/reconcile tests.
- [x] Startup should converge in one clean actionful rebuild unless genuinely new information
      arrives after the first pass.
      Files: startup helpers, `lib/plan/planService.ts`, startup orchestration tests.
- [x] Avoid full plan rebuilds on every power sample. Power updates should normally refresh
      status/headroom and only trigger a full rebuild when a control boundary actually changed.
      Files: power update pipeline, rebuild scheduler, status/headroom path.

## P1 Observability and runtime diagnostics

- [x] Keep default structured event payloads bounded. Normal diagnostics now avoid large
      per-device arrays and full change objects outside explicit incident/debug paths.
      Files: reconcile, incident, and rebuild logging paths.
- [x] Finish the highest-value structured logging gaps: executor failure/skip paths, UI snapshot
      writes, and startup/background-task paths. Success-path actuation and periodic status are
      now structured.
      Files: executor/runtime helpers, `app.ts`, UI snapshot writers.
- [x] Add bounded `reasonCode` values for important failures, fallback paths, and degraded-state
      transitions instead of relying on prose-only diagnostics.
      Files: `lib/logging/**`, runtime log call sites.
- [x] Make `plan_rebuild_completed` semantics fully trustworthy. Fixed: rebuild completion now
      reports `deviceWriteCount`, and `appliedActions` is derived from actual executor writes
      instead of merely entering the apply path.
      Files: `lib/plan/planService.ts`, `lib/plan/planExecutor.ts`, rebuild logging/tests.
- [x] Fix price-optimization transition logging at hour boundaries so logs reflect the resulting
      state, not the previous one.
      Files: price optimization transition logic and tests.
- [x] Sweep logging and diagnostics to ensure `deviceId` is always the identity field and
      `deviceName` stays a plain label without `name || id` fallback rewriting.
      Files: structured logging call sites, diagnostics helpers, executor/reconcile logging.

## P1 UI and product follow-ups

- [x] Clean up stepped-load retry/backoff behavior so delayed feedback does not trigger clumsy
      re-requests while a previous desired step is still plausibly in flight.
      Files: stepped-load planning/executor feedback logic and tests.
- [ ] Treat stepped-load upward transitions for already-on devices as mode transitions, not
      restore UI.
      Files: `packages/settings-ui/src/ui/plan.ts`.
- [x] Align restore-cooldown badge/state text in the plan UI and make true shed states visually
      unambiguous.
      Files: `packages/settings-ui/src/ui/plan.ts`.
- [x] Add gray badge/state handling for unknown or disappeared devices in the overview/device list.
      Files: settings UI overview/device list.
- [x] Debounce or coalesce rapid temperature changes from the device tab so bulk edits do not flap
      the plan or spam writes/retries.
      Files: settings UI device detail/target write path.
- [x] Add a budget-exemption toggle on the device page so budget-exempt status can be edited from
      device detail without leaving the flow.
      Files: settings UI device detail/settings write path.
- [x] Add structured observability plus rate limiting for repeated Settings UI network failures.
      Files: settings UI API/client refresh paths and logging tests.
- [ ] Add a device-log view in the Settings UI, and reuse the shared device overview formatter so
      the visible device-log wording matches backend overview transition logs exactly.
      Files: settings UI advanced/device-log surface, `packages/shared-domain/src/deviceOverview.ts`.
- [ ] Finish the starvation rollout beyond the current diagnostics implementation: add
      per-episode / duration-threshold flow triggers, verify insights coverage, and close any
      remaining snapshot/UI contract gaps against `notes/starvation/README.md`.
      Files: `lib/diagnostics/**`, `flowCards/**`, `drivers/pels_insights/**`,
      plan snapshot/contracts/UI wiring.

## P1 Simplification follow-ups

- [x] Keep simplifying `planReasons.ts` so decision flow now uses bounded internal reason codes
      before rendering display strings, instead of keying planner control flow directly off prose
      formatting.
      Why P1: this landed the local decision/presentation split in `planReasons.ts` while keeping
      emitted `reason` text stable for existing consumers.
      Files: `lib/plan/planReasons.ts`, `lib/plan/planReasonStrings.ts`.
- [ ] Move `planServiceInternals.ts` types into `lib/plan/planTypes.ts` and extract the
      snapshot-write path out of `planService.ts` so rebuild orchestration stops carrying
      persistence plumbing.
      Why P1: `planService.ts` mixes rebuilds, timers, throttled settings writes, and metrics in
      one place even though snapshot persistence is a separate concern.
      Files: `lib/plan/planService.ts`, `lib/plan/planServiceInternals.ts`,
      `lib/plan/planTypes.ts`.
- [ ] Extract rebuild-metrics/tracing helpers out of `planService.ts` now that snapshot
      persistence lives in `planSnapshotWriter.ts`.
      Why P1: `planService.ts` no longer owns the throttled snapshot timer/write path, but it
      still mixes rebuild orchestration with perf aggregation, trace recording, and completion
      logging.
      Files: `lib/plan/planService.ts`, new `lib/plan/planRebuildMetrics.ts`.
- [ ] Keep executor-owned actuation metadata persistence from growing ad hoc now that
      `lastControlledMs` is persisted out of `PlanExecutor`. If more per-device actuation state
      needs durable storage, extract a small persistence helper/queue instead of adding more
      direct settings writes to the executor.
      Why P1: batching fixed the immediate write-burst concern, but `PlanExecutor` should not
      become a second persistence hub alongside the plan snapshot/status writers.
      Files: `lib/plan/planExecutor.ts`.
- [ ] Finish the last `app.ts` shrink after the `TimerRegistry` / `AppContext` refactor. The
      remaining cleanup is to decide whether the now-thin `lib/app/appInit.ts` adapter should be
      deleted, move `resolveHasBinaryControl` to a better long-term home if it stays shared, and
      keep trimming any delegates that no longer buy readability or testability.
      Why P1: the broad callback bags and timer teardown scatter are gone, but `app.ts` is still
      the main lifecycle assembly point and still carries more wrapper surface than ideal.
      Files: `app.ts`, `lib/app/**`.
- [ ] Unify the three plan-rebuild coalescers (`appFlowRebuildScheduler`,
      `schedulePlanRebuildFromSignal` in `appPowerHelpers.ts`, `planService` snapshot throttler)
      into a single `PlanRebuildScheduler` with prioritised intents so rebuild/snapshot/hardCap
      debouncing shares one state machine and one cancellation story.
      Why P1: the three coalescers do not coordinate, which leaves a race window between
      flow-card-driven and signal-driven rebuilds and spreads tight-noop backoff across files.
      Design note: `notes/complexity-cleanup/rebuild-scheduler-unification.md`.
      Files: `lib/app/appFlowRebuildScheduler.ts`, `lib/app/appPowerHelpers.ts`,
      `lib/plan/planService.ts`.
- [x] Split `lib/app/appPowerHelpers.ts` into three focused modules:
      `appPowerRebuildPolicy.ts`, `appPowerRebuildScheduler.ts`, and
      `appPowerSampleIngest.ts`. The compatibility barrel remains at
      `appPowerHelpers.ts`. Tight-noop backoff and mitigation holdoff were preserved, which
      unblocks the coalescer unification follow-up.
      Why P1: one file currently owns decision, scheduling, backoff, holdoff, hard-cap fast path,
      sample ingest, persistence, and pruning.
      Files: `lib/app/appPowerHelpers.ts`, `lib/app/appPowerRebuildPolicy.ts`,
      `lib/app/appPowerRebuildScheduler.ts`, `lib/app/appPowerSampleIngest.ts`,
      `test/appPowerHelpers.test.ts`.
- [x] Introduce a `TimerRegistry` helper and route the ten timer fields on `app.ts` through it so
      `onUninit` cannot silently leak a newly added timer.
      Why P1: timer cleanup is enforced today only by author discipline; each new timer is a new
      failure mode. Centralising gives a uniform debug surface and a clean teardown.
      Files: `app.ts`, new `lib/app/timerRegistry.ts`.
- [x] Replace the four large dependency bags at `app.ts` init sites (init settings handler, init
      plan engine, register flow cards, start app services — 22-28 callbacks each) with a single
      `AppContext` struct passed by reference.
      Why P1: the bags are the largest single source of `app.ts` bulk and they drift independently
      as new features land. Collapsing them also enables cleanup of the one-line delegate getters.
      Files: `app.ts`, `lib/app/**`.

## P2 Simplification and cleanup

- [ ] Audit whether daily-budget confidence scoring materially changes control decisions. If it is
      purely informational, simplify it aggressively.
      Files: `lib/dailyBudget/dailyBudgetConfidence.ts`, daily budget service/plan paths.
- [ ] Stop granting blanket `max-lines` exemptions. Classify each currently-oversized runtime file
      as either Bucket A ("must shrink to <=500") or Bucket B ("documented exception with a
      concrete raised ceiling"), replace file-level `eslint-disable` pragmas with per-file config
      overrides in `eslint.config.mjs` that cite the structural reason.
      Why P2: the files most in need of the LOC rule are currently the ones waived from it, which
      makes the limit effectively unenforced in the hotspots.
      Proposal: `notes/complexity-cleanup/god-file-policy.md`.
      Files: `eslint.config.mjs`, file-level disables in `app.ts`, `lib/**`.
- [ ] Land the Phase 1 file consolidations once their target files have headroom: merge
      `planRestoreAdmission.ts` and `planRestoreSupport.ts` into `planRestoreSwap.ts`; merge
      `planStatusHelpers.ts` into `planStatusWriter.ts`; merge `appRealtimeDeviceReconcileRuntime.ts`
      into `appRealtimeDeviceReconcile.ts`; bundle the tiny plan files (`planCandidatePower`,
      `planSort`, `planHourContext`, `planOvershoot`, `planStateHelpers`, `planObservationPolicy`)
      into a single `planBuilderHelpers.ts`; merge `planDebugDedupe.ts` and `planReasonStrings.ts`
      into a new `planReasonFormatting.ts`.
      Why P2: low-risk move-only work reducing directory surface. Blocked only where targets are
      currently at or over the 500 LOC ceiling.
      Files: `lib/plan/**`, `lib/app/appRealtimeDeviceReconcile*`.

## P3 Tooling, architecture, and future work

- [ ] Remove the remaining `lib/utils/** -> lib/{core,plan}` imports, then make the architecture
      check strict instead of advisory.
      Files: `lib/utils/**`, architecture checks.
- [ ] Expand unused-export checks to shared packages and the settings UI, then remove the
      temporary allowlist exceptions.
      Files: dead-code checks, shared packages, settings UI.
- [ ] Keep investigating long-running `planRebuildApply` stalls now that the stepped-load flow
      wait bug is fixed.
      Files: apply-path instrumentation, perf logging, executor/plan-service timing.
- [ ] Add stale-measurement failsafe handling so planning does not silently continue on old power
      data for minutes at a time.
      Files: power sample pipeline, capacity guard, plan engine, settings/config.
- [ ] Add per-phase ampere limit support once there is a trustworthy phase-level telemetry source.
      Files: power tracking, capacity guard, plan context, settings UI.
- [ ] Auto-adjust daily budget from past eligible exemptions using the policy in
      `notes/daily-budget-auto-adjust/README.md`.
      Files: daily budget state/service/UI/settings/diagnostics.
- [ ] Keep the remaining future feature ideas small and design-driven: configurable per-device
      cooldowns, explicit headroom reservations, richer price explainability, weather-aware budget
      context, and small per-device action history in the UI.
