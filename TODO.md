# TODO

Only unresolved work belongs here. Completed items live in git history and tests, not in this
file.

## P0 Correctness and control integrity

- [ ] Keep monitoring restore optimism under real load. The big restore-overshoot loop fixes are
      in, but field logs still need watching for cases where delayed element ramp or stale power
      samples admit a restore too early.
      Files: `lib/plan/planRestoreAdmission.ts`, `lib/plan/planRestoreSwap.ts`,
      `lib/plan/planConstants.ts`.
- [ ] If cloud devices still show confirmation or drift gaps after the current freshness model,
      add per-capability realtime subscriptions for managed control capabilities (`onoff`,
      `evcharger_charging`, `target_temperature`).
      Files: `lib/core/deviceManager.ts`.
- [ ] Move direct capability writes to the same confirmation-first model as binary settle and
      stepped-load callbacks so temperature and other writable capabilities do not rely on
      post-actuation polling as the normal success path.
      Files: `lib/core/deviceManager.ts`, `lib/core/deviceManagerRuntime.ts`, `app.ts`,
      capability-write/reconcile tests.
- [ ] Startup should converge in one clean actionful rebuild unless genuinely new information
      arrives after the first pass.
      Files: startup helpers, `lib/plan/planService.ts`, startup orchestration tests.
- [ ] Unify the power-resolution model used by shedding, restore admission, and live usage so the
      same device does not resolve to different power depending on which subsystem asks.
      Files: `lib/plan/planCandidatePower.ts`, `lib/plan/planRestoreSwap.ts`,
      `lib/plan/planUsage.ts`, `lib/plan/planSteppedLoad.ts`.
- [ ] Align `currentOn` vs `currentState` handling across shedding, restore, reconcile, and
      executor paths so binary truth and planning truth do not drift apart.
      Files: `lib/plan/planShedding.ts`, `lib/plan/planRestoreDevices.ts`,
      `lib/plan/planReconcileState.ts`, `lib/plan/planExecutor.ts`.
- [ ] Standardize restore eligibility rules across normal restore, stepped restore, and swap
      restore so "can this device restore?" has one consistent answer.
      Files: `lib/plan/planRestoreDevices.ts`, `lib/plan/planRestoreSwap.ts`.
- [ ] Pick one source of truth for the controlled vs uncontrolled power split. Planning and
      `PowerTracker` still derive it separately.
      Files: `lib/core/powerTracker.ts`, `lib/plan/planBuilder.ts`, `lib/plan/planUsage.ts`.
- [ ] Avoid full plan rebuilds on every power sample. Power updates should normally refresh
      status/headroom and only trigger a full rebuild when a control boundary actually changed.
      Files: power update pipeline, rebuild scheduler, status/headroom path.

## P1 Observability and runtime diagnostics

- [ ] Keep default structured event payloads bounded. Normal diagnostics should avoid large
      per-device arrays and full change objects outside explicit incident/debug paths.
      Files: reconcile, incident, and rebuild logging paths.
- [ ] Finish the highest-value structured logging gaps: executor failure/skip paths, UI snapshot
      writes, and startup/background-task paths. Success-path actuation and periodic status are
      now structured.
      Files: executor/runtime helpers, `app.ts`, UI snapshot writers.
- [ ] Add bounded `reasonCode` values for important failures, fallback paths, and degraded-state
      transitions instead of relying on prose-only diagnostics.
      Files: `lib/logging/**`, runtime log call sites.
- [x] Make `plan_rebuild_completed` semantics fully trustworthy. Fixed: rebuild completion now
      reports `deviceWriteCount`, and `appliedActions` is derived from actual executor writes
      instead of merely entering the apply path.
      Files: `lib/plan/planService.ts`, `lib/plan/planExecutor.ts`, rebuild logging/tests.
- [ ] Fix price-optimization transition logging at hour boundaries so logs reflect the resulting
      state, not the previous one.
      Files: price optimization transition logic and tests.
- [ ] Audit suspicious long overshoot durations and confirm whether they were genuine slow
      recovery or stale lifecycle state.
      Files: overshoot lifecycle/state handling, incident tests/log review.

## P1 UI and product follow-ups

- [ ] Clean up stepped-load retry/backoff behavior so delayed feedback does not trigger clumsy
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
- [ ] Rework temperature-device starvation detection to the intended-target / suppression-only
      model captured in `notes/starvation/README.md`.
      Files: diagnostics model/service, plan snapshot/contracts/UI, flow cards, insights.

## P1 Simplification follow-ups

- [ ] Replace the over-specified `planActivationBackoff.ts` state machine with a simple
      exponential timer model and keep the same public diagnostics surface.
      Why P1: low-risk deletion of complexity, and it shrinks the restore gate surface for later
      cleanup.
      Files: `lib/plan/planActivationBackoff.ts`, restore/shedding tests.
- [ ] Separate decision codes from display strings in `planReasons.ts`, then fold the
      one-consumer helper back into `lib/plan/planReasons.ts`.
      Why P1: restore/shed behavior is harder to reason about than it should be because control
      flow and string building are interleaved.
      Files: `lib/plan/planReasons.ts`, `lib/plan/planReasonHelpers.ts`.
- [ ] Move `planServiceInternals.ts` types into `lib/plan/planTypes.ts` and extract the
      snapshot-write path out of `planService.ts` so rebuild orchestration stops carrying
      persistence plumbing.
      Why P1: `planService.ts` mixes rebuilds, timers, throttled settings writes, and metrics in
      one place even though snapshot persistence is a separate concern.
      Files: `lib/plan/planService.ts`, `lib/plan/planServiceInternals.ts`,
      `lib/plan/planTypes.ts`.
- [ ] Collapse `app.ts` wiring accumulation by extracting snapshot-refresh / Homey Energy polling
      coordination and removing trivial pass-through delegates where services can be passed
      directly.
      Why P1: the main app class is now mostly lifecycle plus timers plus wrappers, which makes
      debugging control flow more expensive than it needs to be.
      Files: `app.ts`, `lib/app/**`.
- [ ] Split `packages/settings-ui/src/ui/deviceDetail.ts` by responsibility and centralize the
      repeated setting-write / refresh / error-handling flow.
      Why P1: the device detail panel mixes render logic, stepped-load draft state, diagnostics
      refresh, and repeated `setSetting(...)` save paths in one 900+ line file.
      Files: `packages/settings-ui/src/ui/deviceDetail.ts`, related device-detail helpers/tests.

## P2 Simplification and cleanup

- [ ] Split `planExecutor.ts` by control type once the shared behavior is stable enough that the
      split reduces cognitive load instead of hiding bugs.
      Files: `lib/plan/planExecutor.ts`.
- [ ] Split the remaining large `deviceManager.ts` internals only where there is a real subsystem
      boundary: parsing, observation tracking, and binary settle management.
      Files: `lib/core/deviceManager.ts`.
- [ ] Audit whether daily-budget confidence scoring materially changes control decisions. If it is
      purely informational, simplify it aggressively.
      Files: `lib/dailyBudget/dailyBudgetConfidence.ts`, daily budget service/plan paths.

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
