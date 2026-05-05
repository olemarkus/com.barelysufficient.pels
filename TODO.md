# TODO

Only unresolved work belongs here. Completed items live in git history and tests, not in this
file.

## P0 Correctness and control integrity

- [ ] Make observation freshness source-aware. Targeted snapshot refreshes and same-value
      realtime updates should only advance freshness when the value source proves the capability
      was observed, and stale / missing freshness should not be silently considered safe.
      Why P0: freshness is currently easy to stamp from a refresh cycle rather than from trusted
      data, which can hide stale state in control paths.
      Files: `lib/core/deviceManagerObservation.ts`, `lib/core/deviceManager.ts`,
      `lib/plan/planObservationPolicy.ts`, freshness/reconcile tests.
- [ ] Make stepped-load execution drift source-aware when binary and step observations disagree.
      A fresh binary observation should not be masked by a stale stepped-load identity. For example,
      if a plan expects a stepped device to be off, stale `selectedStepId = off` should not override
      fresh `currentOn = true` when deciding whether reconcile needs to reapply control.
      Files: `lib/executor/planExecutionDrift.ts`, `lib/plan/planCurrentState.ts`,
      realtime/reconcile drift tests.
- [ ] Make binary pending-command drift suppression desired-state aware.
      Reconcile should suppress binary drift only when the active pending command's desired value
      matches the current plan's expected binary state. Today some paths expose only "a pending
      binary command exists", which can briefly hide a conflicting restore/limit decision until the
      15s local or 75s cloud pending window expires.
      Files: `lib/executor/planExecutionDrift.ts`, `lib/app/appInit.ts`,
      `lib/plan/planDevices.ts`, binary pending/reconcile tests.
- [ ] Ensure snapshot refresh ordering cannot persist pre-enforcement state. Unsupported-device
      enforcement should complete before the refreshed snapshot is synced and persisted.
      Why P0: persisting before enforcement can expose a snapshot that briefly disagrees with the
      settings the app just enforced.
      Files: `lib/app/appSnapshotHelpers.ts`, snapshot/enforcement tests.

## P1 Observability and runtime diagnostics

- [ ] Normalize comparable `restoreNeed` / `insufficientHeadroom` kW fields so small
      admission-metric jitter does not churn detail signatures, overview transitions, or restore
      debug dedupe while the device remains in the same restore-admission posture.
      Why P1: unlike `shortfall`, these reasons still need coarse device-specific magnitude in the
      comparable path, but raw float noise can still create repeated plan/detail churn when the
      admission decision did not materially change.
      Files: `packages/shared-domain/src/planReasonComparable.ts`, `test/planService.test.ts`,
      `test/deviceOverview.test.ts`, restore debug dedupe tests.
- [ ] Separate observed power from estimated / planning power in headroom state and diagnostics.
      Headroom usage should not prefer `expectedPowerKw` over live or measured usage while carrying
      freshness that looks observational.
      Why P1: estimated planner inputs and observed load have different trust levels; merging them
      makes overshoot and cooldown diagnostics harder to reason about.
      Files: `lib/plan/planHeadroomSupport.ts`, `lib/plan/planHeadroomState.ts`,
      `lib/plan/planPowerResolution.ts`, headroom diagnostics tests.
- [ ] Use the configured device load as the stable expected load for binary restore planning and
      overview copy when live/measurement evidence is absent or the device is off.
      Context: `Termostat kontor` flipped between 1.0kW and 0kW expected load during restore
      logging. For binary/thermostat devices, the Homey device setting / energy load value
      should remain the expected restore load instead of being erased by current off-state power.
      Why P1: restore admission and operator-facing overview text should not lose the configured
      demand estimate just because the device is currently shed.
      Files: `lib/core/deviceManagerControl.ts`, `lib/plan/planPowerResolution.ts`,
      `lib/plan/planDevices.ts`, restore/overview power-source tests.
- [ ] Finish the starvation rollout beyond the current diagnostics implementation: add
      per-episode / duration-threshold flow triggers, verify insights coverage, and close any
      remaining snapshot/UI contract gaps against `notes/starvation/README.md`.
      Files: `lib/diagnostics/**`, `flowCards/**`, `drivers/pels_insights/**`,
      plan snapshot/contracts/UI wiring.

## P1 UI and product follow-ups

- [ ] Add a device-log view in the Settings UI, and reuse the shared device overview formatter so
      the visible device-log wording matches backend overview transition logs exactly.
      Files: settings UI advanced/device-log surface, `packages/shared-domain/src/deviceOverview.ts`.
- [ ] Make Settings UI device setting writes fail closed when a fresh settings read is missing or
      invalid. Avoid falling back to `{}` or caller-provided defaults and writing a partial object
      back as if it were the current state.
      Why P1: fallback writes can erase or overwrite unrelated settings when the UI starts from an
      incomplete read.
      Files: `packages/settings-ui/src/ui/deviceDetail/settingsWrite.ts`,
      `packages/settings-ui/src/ui/deviceDetail/index.ts`,
      `packages/settings-ui/src/ui/deviceDetail/shedBehavior.ts`.
- [ ] Roll back optimistic price-optimization UI state when persistence fails.
      Why P1: the UI currently mutates local state before the write succeeds, so failed writes can
      leave the screen showing settings that Homey did not persist.
      Files: `packages/settings-ui/src/ui/deviceDetail/priceOpt.ts`,
      `packages/settings-ui/src/ui/priceOptimization.ts`.
- [ ] Key stepped-load draft state by device instead of using one module-global draft.
      Why P1: a single draft can bleed between device detail sessions and makes fallback chains
      depend on whichever device wrote the draft last.
      Files: `packages/settings-ui/src/ui/deviceDetail/steppedLoadDraft.ts`.
- [ ] Unify duplicated device-state derivation and keep presentation text out of shared domain
      contracts where possible.
      Why P1: overview/device detail/legacy plan code derive similar states independently, and
      UI-facing wording in shared-domain makes control-state reuse harder to type cleanly.
      Files: `packages/shared-domain/src/deviceOverview.ts`,
      `packages/settings-ui/src/ui/deviceUtils.ts`,
      `packages/settings-ui/src/ui/planLegacy.ts`,
      `packages/contracts/src/settingsUiApi.ts`.
- [ ] Tighten EV SoC layer boundaries before expanding EV objectives.
      Keep synthetic/report-source metadata (`source` and any future flow-only SoC markers) in the
      observation layer unless another layer has a concrete behavioral need, and
      decide whether a synthetic SoC input should move to a `pels_`-prefixed capability instead of
      reusing Homey/native-looking capability ids.
      Files: `lib/core/deviceStateOfCharge.ts`, `lib/core/deviceManagerObservation.ts`,
      `lib/core/flowReportedCapabilities.ts`, EV SoC contracts/UI surfaces.
- [ ] Clamp stale EV boost stepped-load intent after boost deactivates.
      When EV boost admits a higher charger step and a later SoC update turns boost off, the next
      plan can briefly carry the old higher `desiredStepId` even when the shed-invariant reason says
      the step-up should not be admitted while other devices are still limited. This is expected to
      self-correct on later step/power observations, but the planner should eventually clamp the
      desired/target step to the currently allowed step when the boost exemption no longer applies.
      Files: `lib/plan/planRestoreHelpers.ts`, `lib/plan/planDevices.ts`,
      EV boost / stepped restore tests.
- [ ] Harden target-power stepped-load contract validation.
      Homey's `target_power` contract requires the range to include `0`; minimum operating power
      should be modeled with `excludeMin` / `excludeMax`, and `0` means idle. Keep mapping the off
      step to `target_power = 0`, but validate manual/synthetic profiles and warn or ignore invalid
      target-power metadata instead of letting malformed capability options look like normal input.
      Files: `lib/core/nativeSteppedLoadWiring.ts`, `lib/core/deviceManagerNativeEv.ts`,
      target-power/EV stepped-load tests.

## P1 Type-safety and state-boundary follow-ups

- [ ] Remove legacy stepped-load optional fields from persisted/API contracts after the release
      cut. Planner and executor semantics should stay behind typed stepped-state adapters; the
      remaining compatibility fields (`selectedStepId`, `actualStepId`, `assumedStepId`, and
      related provenance) should be retired from public snapshots only with an explicit contract
      migration.
      Files: `packages/contracts/src/types.ts`, `lib/plan/planTypes.ts`, settings UI contract
      tests, persisted snapshot compatibility tests.
- [ ] Replace the broad optional-field device snapshots with stronger discriminated state types.
      `TargetDeviceSnapshot`, `DevicePlanDevice`, and `PlanInputDevice` should not carry all
      binary, temperature, stepped-load, EV, freshness, and power fields as one nullable bag.
      Why P1: unknown, stale, estimated, unsupported, and observed values are currently easy to
      pass through the planner with the same shape.
      Files: `packages/contracts/src/types.ts`, `lib/plan/planTypes.ts`,
      `lib/plan/planBuilder.ts`, settings UI contract tests.
- [ ] Replace optional-bag power helper APIs with explicit power evidence types such as measured,
      live, estimated, fallback, and unknown.
      Why P1: helper inputs like `PowerCandidate`, `LiveUsageCandidate`, `RestorePowerCandidate`,
      and `UsageDevice` make fallback power look structurally similar to measured power.
      Files: `lib/plan/planPowerResolution.ts`, `lib/plan/planUsage.ts`,
      `lib/plan/planHeadroomSupport.ts`, power-resolution tests.
- [ ] Normalize persisted optional state into runtime state with required maps immediately after
      loading. Keep persisted shape and runtime shape separate for power tracker, activation
      attempts, headroom cards, pending commands, and similar planner state.
      Why P1: repeated `Record<string, ...> | undefined`, `?? {}`, and partially populated maps
      spread load-time uncertainty into normal runtime paths.
      Files: `lib/core/powerTracker.ts`, `packages/contracts/src/powerTrackerTypes.ts`,
      `lib/plan/planState.ts`, `lib/utils/appTypeGuards.ts`.
- [ ] Replace deeply partial flow-reported capability state with a normalized runtime
      representation at the boundary.
      Why P1: `Partial<Record<...Partial<Record<...>>>>` makes every caller defend against missing
      nested objects and encourages merge-by-fallback writes.
      Files: `lib/core/flowReportedCapabilities.ts`.
- [ ] Add typed schemas/parsers for settings maps and flow-card args before values enter app
      logic. Avoid raw `Record<string, ...>`, `unknown`, and inline casts beyond the external
      Homey boundary.
      Why P1: flow cards and settings helpers repeatedly parse loose values with local fallbacks,
      so invalid external input can become normal internal state.
      Files: `lib/app/appSettingsHelpers.ts`, `flowCards/registerFlowCards.ts`,
      `flowCards/deviceSettingsCards.ts`, `flowCards/flowBackedDeviceCards.ts`.
- [ ] Split app lifecycle context into initialized vs initializing phases so services that are
      required after startup are not exposed forever as optional fields.
      Why P1: `AppContext` currently carries optional service references and broad maps across
      code that usually assumes those services exist.
      Files: `lib/app/appContext.ts`, `app.ts`, app init/service tests.

## P1 Simplification follow-ups

- [ ] Split planner state from render-only explanation data so keep/shed/inactive decisions no
      longer depend on UI-facing `reason` objects. The stepped restore admission path now keeps
      rejected off restores explicit in the plan, and cooldown / meter-settling restore blocks now
      stay non-executable until admission. Continue with the remaining reason-derived rendering
      boundaries.
      Why P1: this is the next boundary cleanup after the local `planReasons.ts` split and would
      remove a recurring source of state/reason coupling bugs.
      Files: `lib/plan/planRestore.ts`, `lib/plan/planReasons.ts`, plan/executor/rendering
      boundaries.
- [ ] Extract rebuild-metrics/tracing helpers out of `planService.ts` now that plan snapshots
      are in-memory/realtime only. Fold or delete the remaining tiny
      `planServiceInternals.ts` helper surface if it no longer pays for itself.
      Why P1: `planService.ts` no longer owns the throttled snapshot timer/write path, but it
      still mixes rebuild orchestration with perf aggregation, trace recording, and completion
      logging.
      Files: `lib/plan/planService.ts`, `lib/plan/planServiceInternals.ts`,
      new `lib/plan/planRebuildMetrics.ts`.
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
- [ ] Finish post-unification cleanup for plan rebuild scheduling.
      Why P1: `PlanRebuildScheduler` exists and is wired, but stale migration notes and any
      remaining legacy scheduler fallback surface should be removed or documented as an explicit
      compatibility layer.
      Files: `lib/app/planRebuildScheduler.ts`, `lib/app/appPowerRebuildScheduler.ts`,
      `notes/complexity-cleanup/rebuild-scheduler-unification.md`,
      `notes/complexity-cleanup/README.md`.

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
- [ ] Refresh complexity-cleanup notes so phase status, LOC snapshots, and migration writeups
      match the current codebase.
      Why P2: several notes still describe pre-implementation plans or old file sizes even though
      the code has moved on.
      Files: `notes/complexity-cleanup/README.md`,
      `notes/complexity-cleanup/rebuild-scheduler-unification.md`,
      `notes/complexity-cleanup/god-file-policy.md`.
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

- [ ] Consider allowing Homey Energy-backed `powerKw` as a fallback for stepped restore
      post-confirmation settlement when `measure_power` is missing, but keep manual overrides and
      other derived power sources non-authoritative for that release check.
      Why P3: the stepped restore settlement path is now intentionally gated on `measure_power`
      only; broadening it to a narrower Homey Energy fallback is optional follow-up work, not a
      correctness blocker.
      Files: `lib/plan/planSteppedRestorePending.ts`, stepped restore settlement tests.
- [ ] Remove the remaining `lib/utils/** -> lib/{core,plan}` imports, then make the architecture
      check strict instead of advisory.
      Files: `lib/utils/**`, architecture checks.
- [ ] Expand unused-export checks to shared packages and the settings UI, then remove the
      temporary allowlist exceptions.
      Files: dead-code checks, shared packages, settings UI.
- [ ] Keep investigating long-running `planRebuildApply` stalls now that the stepped-load flow
      wait bug is fixed.
      Files: apply-path instrumentation, perf logging, executor/plan-service timing.
- [ ] Add per-phase ampere limit support once there is a trustworthy phase-level telemetry source.
      Files: power tracking, capacity guard, plan context, settings UI.
- [ ] Auto-adjust daily budget from past eligible exemptions using the policy in
      `notes/daily-budget-auto-adjust/README.md`.
      Files: daily budget state/service/UI/settings/diagnostics.
- [ ] Keep the remaining future feature ideas small and design-driven: configurable per-device
      cooldowns, explicit headroom reservations, richer price explainability, weather-aware budget
      context, and small per-device action history in the UI.
