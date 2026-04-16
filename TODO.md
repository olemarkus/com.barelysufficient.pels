# TODO

Only unresolved work belongs here. Completed items live in git history and tests, not in this
file.

## P0 Correctness and control integrity

- [ ] Keep monitoring restore optimism under real load. The big restore-overshoot loop fixes are
      in, and the overshoot diagnostics now include plan/power sample age fields, but field logs
      still need watching for cases where delayed element ramp or stale power samples admit a
      restore too early.
      Files: `lib/plan/planRestoreAdmission.ts`, `lib/plan/planRestoreSwap.ts`,
      `lib/plan/planConstants.ts`.
- [ ] If cloud devices still show confirmation or drift gaps after the current freshness model,
      add per-capability realtime subscriptions for managed control capabilities (`onoff`,
      `evcharger_charging`, `target_temperature`).
      Files: `lib/core/deviceManager.ts`.
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
- [ ] Audit suspicious long overshoot durations and confirm whether they were genuine slow
      recovery or stale lifecycle state. The new overshoot diagnostics now include plan and power
      sample age fields to make that call easier.
      Files: overshoot lifecycle/state handling, incident tests/log review.
- [ ] Sweep logging and diagnostics to ensure `deviceId` is always the identity field and
      `deviceName` stays a plain label without `name || id` fallback rewriting.
      Files: structured logging call sites, diagnostics helpers, executor/reconcile logging.

## P1 UI and product follow-ups

- [x] Clean up stepped-load retry/backoff behavior so delayed feedback does not trigger clumsy
      re-requests while a previous desired step is still plausibly in flight.
      Files: stepped-load planning/executor feedback logic and tests.
- [ ] Treat stepped-load upward transitions for already-on devices as mode transitions, not
      restore UI.
      Files: `packages/settings-ui/src/ui/plan.ts`.
- [ ] Align restore-cooldown badge/state text in the plan UI and make true shed states visually
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
- [ ] Finish the starvation rollout beyond the current diagnostics implementation: add
      per-episode / duration-threshold flow triggers, verify insights coverage, and close any
      remaining snapshot/UI contract gaps against `notes/starvation/README.md`.
      Files: `lib/diagnostics/**`, `flowCards/**`, `drivers/pels_insights/**`,
      plan snapshot/contracts/UI wiring.

## P1 Simplification follow-ups

- [ ] Keep simplifying `planReasons.ts` so decision flow continues moving toward bounded
      machine-readable reason codes instead of burying planner control flow in display-string
      formatting.
      Why P1: recent cleanup landed `planReasonStrings.ts`, but `planReasons.ts` still mixes
      decision logic and presentation more than it should.
      Files: `lib/plan/planReasons.ts`, `lib/plan/planReasonStrings.ts`.
- [ ] Move `planServiceInternals.ts` types into `lib/plan/planTypes.ts` and extract the
      snapshot-write path out of `planService.ts` so rebuild orchestration stops carrying
      persistence plumbing.
      Why P1: `planService.ts` mixes rebuilds, timers, throttled settings writes, and metrics in
      one place even though snapshot persistence is a separate concern.
      Files: `lib/plan/planService.ts`, `lib/plan/planServiceInternals.ts`,
      `lib/plan/planTypes.ts`.
- [ ] Continue shrinking `app.ts` after the helper extractions already landed. Snapshot refresh,
      Homey Energy polling, and stepped-load helper ownership have moved out; the remaining work
      is to reduce lifecycle/timer/wrapper bulk and remove the remaining trivial pass-through
      delegates where services can be passed directly.
      Why P1: recent PRs reduced `app.ts`, but it is still the main wiring accumulation point and
      still carries broad lifecycle plus timer orchestration.
      Files: `app.ts`, `lib/app/**`.
- [ ] Split `packages/settings-ui/src/ui/deviceDetail.ts` by responsibility and centralize the
      repeated setting-write / refresh / error-handling flow.
      Why P1: the device detail panel mixes render logic, stepped-load draft state, diagnostics
      refresh, and repeated `setSetting(...)` save paths in one 900+ line file.
      Files: `packages/settings-ui/src/ui/deviceDetail.ts`, related device-detail helpers/tests.
- [ ] Unify the three plan-rebuild coalescers (`appFlowRebuildScheduler`,
      `schedulePlanRebuildFromSignal` in `appPowerHelpers.ts`, `planService` snapshot throttler)
      into a single `PlanRebuildScheduler` with prioritised intents so rebuild/snapshot/hardCap
      debouncing shares one state machine and one cancellation story.
      Why P1: the three coalescers do not coordinate, which leaves a race window between
      flow-card-driven and signal-driven rebuilds and spreads tight-noop backoff across files.
      Design note: `notes/complexity-cleanup/rebuild-scheduler-unification.md`.
      Files: `lib/app/appFlowRebuildScheduler.ts`, `lib/app/appPowerHelpers.ts`,
      `lib/plan/planService.ts`.
- [ ] Split `lib/app/appPowerHelpers.ts` (898 LOC, 8 concerns) into three focused modules: pure
      rebuild-decision policy, a rebuild scheduler state machine, and a power-sample
      ingest/persistence path. Must preserve the tight-noop backoff and mitigation holdoff
      contracts; unblocks the coalescer unification.
      Why P1: one file currently owns decision, scheduling, backoff, holdoff, hard-cap fast path,
      sample ingest, persistence, and pruning.
      Files: `lib/app/appPowerHelpers.ts`, `test/appPowerHelpers.test.ts`.
- [ ] Introduce a `TimerRegistry` helper and route the ten timer fields on `app.ts` through it so
      `onUninit` cannot silently leak a newly added timer.
      Why P1: timer cleanup is enforced today only by author discipline; each new timer is a new
      failure mode. Centralising gives a uniform debug surface and a clean teardown.
      Files: `app.ts`, new `lib/app/timerRegistry.ts`.
- [ ] Replace the four large dependency bags at `app.ts` init sites (init settings handler, init
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
