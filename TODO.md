# TODO

Only unresolved work belongs here. Completed items live in git history and tests, not in this
file.

## Priority Rubric

- **P0:** v1 / next-release blocker: release-blocking correctness, control-integrity, startup,
  validation, or data-loss issue that can affect current runtime behavior without another feature
  or broad refactor landing first. Also includes first-impression visual coherence that would
  cost user trust on the v1 release — token sanity, hero / typography consistency, primitive
  consolidation, and chart palette alignment — because the redesigned UI is the user's first
  contact with v1. Only P0 items are required before the v1 release.
- **P1:** next patch-release correctness, data-integrity, first-impression UI polish, and
  supported UX work after v1: bounded planner/executor risks, settings writes that can corrupt
  persisted state, supported-width UI breakage, confusing visible wording, or missing validation
  around commandable device contracts.
- **P2:** later / future product, observability, documentation, and maintainability work where
  current behavior is usable or has a workaround, but the gap increases support cost or slows
  future work.
- **P3:** future capability, optional hardening, or exploratory cleanup with no current correctness
  or supportability pressure.

The redesigned Settings UI is expected to be many users' first exposure to the new UI direction.
P1 UI items should prioritize a pleasant surprise: compact, calm, coherent, and clear enough that
users trust the redesign immediately, while still keeping non-P0 polish out of the v1 release gate.

## P0 Release Blockers

*(prior closures shipped on the v2.9 train via PRs #975, #977, #978, #980,
#982, #983; surviving follow-ups demoted to P1/P2.)*

No open P0 release blockers after the 2026-05-31 release-review cleanup. The
remaining dashboard-widget desirability work is tracked as P1/P3 follow-up below;
the concrete release-readiness bugs from the `v2.10.0..HEAD` pass were fixed in
the release-review cleanup PR.

## P1 Correctness, Data Integrity, and Supported UX

*v2.9.0 closeout and v2.8.x release-review follow-ups. These are safe for
patch releases, not release blockers; each item carries its own source/date.
(The v2.8.0 card-title rename landed in PR #934.)*

*The bulk of the P1 backlog shipped in the 2026-06-03 reconciliation train (PRs #1450–#1461):
insights mode-options coalescing, headroom over-cap overage, the history-detail title/link fixes,
deviceOverview canonical-string routing, the flow-reported / pendingBinaryCommands /
stepped-restore-wrapper / stepped-swap-completion refactors, the settings.test.ts flake, the
plan_budget truncation, the starvation confirm-sheet sub-parts, and the shared widget runtime.
What remains open is below.*

### P1 — Widget loveability follow-ups (demoted from P0, 2026-05-31)

*Source: owner walked the live dashboard with all five PELS widgets stacked
(real-device screenshots) and rejected the "shippable polish" verdict of the
2026-05-30 widget-polish train (`notes/widget-review.md` § Shipped). The
2026-05-31 release-review cleanup fixed the concrete release blockers: New smart
task and Held-back devices now surface/block `Cannot finish`, preview-unavailable
copy names the missing input instead of always blaming prices, unknown EV/temperature
rows no longer render bare units, smart-task recourse copy is non-imperative, and
public docs now describe all five widgets. Remaining work is desirability polish,
not a release gate.*

- [ ] **Widget desirability (`headroom` / `plan_budget`), residual & subjective.** The concrete
      defects shipped (plan_budget status-line truncation, PR #1458). Remaining is subjective only —
      `headroom` hierarchy / price-chip weight / over-cap tone, and the `plan_budget` projected
      summary dominating the chart — which needs a hands-on harness walk, not an autonomous PR.

### P1 — targeted refactors (deferred)

*Concrete, bounded changes to specific named surfaces (not structural re-splits — those stay P2).
The flow-reported / pendingBinaryCommands / stepped-restore-wrapper / stepped-swap-completion /
deviceOverview entries shipped in the 2026-06-03 train; the two below remain deferred.*

- [x] **Remove the legacy stepped-load evidence fields from persisted/API contracts.** Shipped:
      retired the redundant raw-evidence trio `actualStepId` / `assumedStepId` / `actualStepSource`
      (type `SteppedLoadActualStepSource`) from `TargetDeviceSnapshot`, `PlanInputDevice`, and
      `DevicePlanDevice`. Provenance now lives solely in the discriminated
      `NormalizedSteppedLoadStepState` adapter (`lib/plan/planSteppedLoadState.ts`); producers stopped
      emitting the trio and consumers gate on `reportedStepId` presence. No persisted-state migration
      needed (snapshots are runtime-only, rebuilt from the Homey SDK each boot). `selectedStepId` was
      intentionally KEPT: it is not a compatibility shim but the producer-resolved EFFECTIVE step
      (`reportedStepId ?? planning fallback`) read by ~30 planner/executor/restore sites. Collapsing it
      into per-site `resolveEffectiveStepId(...)` calls is a much larger, riskier rewrite tracked by the
      discriminated-snapshots item below (which would discriminate stepped variants and naturally
      subsume the effective-step read). Do not re-file `selectedStepId` removal as a standalone item.
- [ ] **Tighten the device-state snapshots to discriminated types.** `TargetDeviceSnapshot`,
      `DevicePlanDevice`, and `PlanInputDevice` carry binary/temperature/stepped/EV/freshness/power
      fields as one nullable bag; discriminate by control kind so the compiler enforces per-variant
      field presence (removes a class of nullable-field bugs). Files: `packages/contracts/src/types.ts`,
      `lib/plan/planTypes.ts`, `lib/plan/planBuilder.ts`, settings UI contract tests.

## P2 Product, Observability, and Maintainability

*v2.11.0..HEAD release-review findings (2026-06-02). Non-blocking follow-ups.*

- [ ] **Finish migrating the remaining ambiguous flat `test/*.test.ts` specs into tier folders.**
      The testing taxonomy (`notes/testing-taxonomy.md`) + scaffolding landed first; then the
      *obviously-classified* specs moved (app/SDK-harness → `integration/`, single-concrete-file
      imports → `unit/`, `*E2E` → `e2e/`). ~165 flat specs remain — the ones whose tier needs
      per-file judgment: multi-subsystem imports without the app harness (unit vs sub-layer
      integration), specs that import the SDK mock but don't spin up the app, and the 7
      environment-special `*Browser.test.ts` / `settings-ui.test.ts` / `*.perf.test.ts` (jsdom /
      explicit-include in the dom configs — moving them needs the dom/perf config include lists
      updated too). Migrate opportunistically — when you touch a spec, move it into its tier
      folder and bump its relative-import depth (`'../X'` → `'../../X'`, `'./X'` → `'../X'`), then
      run `knip` (type-only imports pass vitest but fail `deadcode:check` on wrong depth). When
      every spec is under a tier folder, re-scope
      `test:unit` from the whole-suite glob to `test/unit/` so the three tier commands partition
      the runtime suite, and (optionally) split CI into per-tier jobs (see the CI-actions note
      below). Persona: contributor; hypothesis: a path-obvious tier speeds review and lets CI
      fan out unit→integration→e2e for faster signal.

- [ ] **Render-gate seed misses the two genuinely-new pixel paths shipped this range.** The
      populated `Cost ≈ X kr · Y kWh delivered` past-list meta line and the "Revised trajectory"
      overlay / re-anchored staircase ship in v2.11.0..HEAD but the standing gate
      (`packages/settings-ui/tests/e2e/smart-tasks-surface-screenshots.spec.ts`) seeds neither
      (`revisionCount: 1`, no `totalCost`). Add one seed with `revisionCount: 2` + a mid-window
      `revisedAtMs` and one with `totalCost`/`delivered` populated, and extend the spec to
      navigate into the history-detail surface (currently list-only). Source: `pels-m3-critic` +
      `pels-ux-fit`, v2.11.0..HEAD release-review.

- [ ] Persist price-display provenance on smart-task history entries so archived cost survives a
      price-scheme/currency change. `DeferredObjectivePlanHistoryEntry` stores `totalCost` /
      `deliveredKWh` but NOT the scheme/unit/divisor it was recorded with, and the archive
      (past-task list rows + ISO-week roll-up — both surfaces wired by PR #1417) formats them with
      the CURRENTLY-bootstrapped `CostDisplay`. Correct for users who never change scheme; but a
      Norway run recorded as 150 øre later renders ~"150 EUR" instead of "≈ 2 kr" after switching to
      a Flow/Homey scheme (divisor 1, different unit). Fix: persist the `CostDisplay`
      (scheme + divisor + unit) on the entry at record time + a migration/fallback for legacy
      entries (absent → assume the recording-era default øre/kr scheme). Contract + persistence
      change (part of the deferred plan-device/provenance theme — do deliberately, not as a quick
      win). Source: codex P2 on PR #1417, 2026-06-01.

*2026-06-03 review-findings investigation (pels-copy-and-terminology / pels-m3-critic).
The dangling note ref, starvation_rescue preview-fixture blindness, and the back-button
title colour were fixed in the same change; items below are the deferred remainder.*

- [ ] **Hoist starvation-reason + held-back diagnostics labels into shared-domain.**
      `STARVATION_REASON_LABELS` and the held-back status strings are inlined in
      `packages/settings-ui/src/ui/deviceDetail/diagnostics.ts` (~L109-156) instead of a
      `packages/shared-domain/**` helper, and duplicate copy that `planStarvation.ts`'s
      `formatStarvationReason` already owns (e.g. "Waiting for available power"). A label can
      therefore drift between the device-detail panel and the runtime log breadcrumb — breaks the
      log/UI-parity rule (`feedback_ui_text_shared_with_logs`). Move the map + formatters into
      shared-domain and have both the settings UI and runtime logging consume the one source.
      Source: pels-copy-and-terminology, 2026-06-03 review-findings investigation.

- [ ] **`plan_budget` widget reads half-empty above the fold.** At 320/480 px a large empty
      vertical band sits above the bottom-anchored chart (header `flex: 0 0 auto`, chart
      `flex: 1 1 auto` in `widgets/plan_budget/src/public/index.css`), so the card looks
      half-filled before the chart paints. Confirm against the widget render-gate at both widths,
      then rebalance (centre the chart or fill the band with meta/legend). Pre-existing layout
      pass, not a regression. Source: pels-m3-critic, 2026-06-03 review-findings investigation.

*v2.10.0..HEAD release-review findings (2026-05-29, six-agent fan-out:
`pels-runtime-reality` + `pels-layering-guardian` + `pels-copy-and-terminology` +
`pels-m3-critic` + `pels-ux-fit`). No P0 blockers; the past-tasks hit-rate
reorder and the remaining widget-copy hoist shipped as their own follow-up
PRs. Items below are later polish.*

- [ ] **Create-smart-task load-error — add a tap-to-retry affordance.** When the
      device fetch fails, the picker shows `CREATE_SMART_TASK_WIDGET_COPY.loadError`
      ("Could not load devices. Try again later.") as static text with no way to
      retry without leaving and reopening the widget
      (`widgets/create_smart_task/src/public/render.ts` empty/error branch). Give
      the error state a retry tap target that re-runs `loadAndRender`. User-visible
      outcome: a stuck load can be recovered in place. Source: PR #1274 fix-up,
      2026-05-29.

- [ ] **Migrate the remaining `lib/app/**` inhabitants to `setup/`.**
      `CLAUDE.md` lists `lib/app/` as sunsetting with only `appContext.ts`
      as the long-term inhabitant. The `appInit` surface (`appInit.ts` +
      `appInit/**`) has been relocated to `setup/appInit/` — that move
      proved `no-lib-to-setup` is NOT a blocker (the arrow stays
      `setup -> lib`; nothing in `lib/**` imports the moved wiring, only
      `app.ts` did). The still-pending inhabitants are the other wiring
      helpers (`appDebugHelpers.ts`, `appSnapshotHelpers.ts`,
      `appSettingsHelpers.ts`, `appDeviceSupport.ts`,
      `appDeviceControl*.ts`, `appRealtimeDeviceReconcile*.ts`,
      `appLifecycleHelpers.ts`, `settingsUiApi*.ts`, etc.). Each follows
      the same pattern: confirm only entry-layer code imports it, then
      `git mv` to `setup/` and rewrite import depths. `appContext.ts`
      stays in `lib/app/`.

- [ ] **Release remaining planned-bucket hours back to the budget when a smart
      task satisfies early.** The tight-gap `near_target_idle` path (1 °C /
      1 min, added alongside learned thermostat deadband) lets a temperature
      smart task finalise met/stalled mid-plan rather than at the deadline.
      The currently-planned remaining hours stay reserved in
      `plansByDeviceId` even though the device has nothing to do with them.
      Releasing those reserved hours back to the daily-budget shaper would
      hand cheap-hour headroom to lower-priority devices. Hook:
      `DeferredObjectiveActivePlanRecorder` already observes plan
      transitions; emit a `plan_released_early` revision when the planHistory
      recorder fires `onMetStalledEntry`, and have the daily-budget producer
      drop the reserved kWh for those buckets. Test gate: a second device's
      `at_risk` verdict flips to `on_track` after the first device satisfies
      early. Source: kontor smart-task forensics conversation, 2026-05-26.

*v2.9.1 RC release-review carry-forward (re-added on `v2.9.1..main`
release-review pass, 2026-05-26 — the original entry committed as
`6dea64be` on the v2.9.1 release branch never propagated to main).*

- [ ] **Hero subtitle "Easing devices off" is misleading when the shed cascade is exhausted.**
      Live snapshot (2026-05-25, Marie Michelets Homey Pro): Power now 5.6 kW, hard cap
      5.0 kW, hero says *"Over the hard cap right now. Easing devices off."* — but every
      controllable managed device is already in `cooldown_shedding` / `Limited by the
      hard cap`, and the 0.6 kW breach comes from Connected 300 at Max (2.87 kW) which
      PELS cannot touch because the device has `capacity_control_off`. The copy
      overpromises active mitigation that PELS has actually finished doing; the user is
      left thinking "PELS is handling it" while in reality the breach is structural
      until the opt-out device drops out on its own. Differentiate the hero subtext when
      `remainingSheddableLoad` for managed devices is ≤ 0 AND the breach attribution is
      a capacity-control-off device: e.g. *"Above hard cap. <DeviceName> isn't under
      PELS control — PELS has eased everything it can."* Files:
      `packages/shared-domain/src/planHeroSummary.ts:~257` (subtitle composition),
      `packages/settings-ui/src/ui/views/PlanHero.tsx`,
      `packages/shared-domain/src/planStateLabels.ts`,
      `notes/ui-terminology.md` (add the new subtitle variant). Source:
      v2.9.1 RC release-review walk, 2026-05-25.

*Session P2 deferrals from batch 21 reviews (2026-05-24).*

*v2.9.0 retrospective P2 cleanup and docs follow-ups (2026-05-23).*

- [ ] Re-evaluate `RECOVERY_PROGRESS_RESET_MULTIPLIER = 5` against the
      noisy-thermostat device class. At 0.05 °C reset threshold (5 × the
      0.01 °C epsilon), Mill/Adax/Glamox sensors that report 0.1-0.2 °C
      jitter will keep clearing the band and resetting the no-progress
      counter, so the `no_progress` disarm never trips and only the
      24-hour `RECOVERY_SAFETY_TIMEOUT_MS` bounds the worst case. The
      wall-clock floor caps the harm to "won't disarm during the first
      30 min", but past 30 min a noisy device is back to the original
      stuck-state. Couple to the open thermostat-noise work (stashed
      `missing_capacity` draft) rather than blindly raising the
      multiplier here; the right fix is likely a noise-aware threshold
      keyed to the device's observed jitter floor.
      Files: `lib/objectives/recovery.ts`.
      Source: `pels-runtime-reality`, PR #1001 follow-up, 2026-05-23.

*Confidence-model Step-2 follow-ups (2026-05-23). Step 2 of Cause #1
(`resolveBandedProfileConfidence` + `applyBandedConfidence`) shipped — the
overall `kwhPerUnit.confidence` now reflects the pooled within-band residual,
so a converged multi-step device can escape `low` (the standing v2.9 P0 signal
seen 985/985 in prod). These are `pels-runtime-reality` follow-ups that didn't
block merge.*

- [ ] `resolveDisplayConfidence` fallback misalignment. The fallback path
      (integration interval extends outside band coverage) reads the now
      band-aware `kwhPerUnit.confidence`, while the energy estimate for the
      uncovered slice still uses the raw global `mean ± k·σ`. For thermal
      devices with a uniform rate this is benign; for EV-style tapering where
      the uncovered slice has a genuinely different rate, the chip could
      over-promise. Cleanest fix: introduce a separate `bandedConfidence` field
      on `ObjectiveProfileStat` so consumers opt in (chip reads
      `bandedConfidence ?? confidence`; `resolveDisplayConfidence` fallback
      keeps the raw `confidence`). Alternative: have the fallback re-compute
      raw RSD from `{sampleCount, mean, m2}` directly. Files:
      `lib/objectives/deferredObjectives/profileEnergyResolution.ts`,
      `packages/contracts/src/objectiveProfileTypes.ts`,
      `lib/objectives/profiles.ts`.
*v2.7.4 train follow-ups (2026-05-19). Three items from the v2.7.3
release-review fan-out that did not ride the train; deferred as
maintenance-tier polish without user-visible impact at supported widths.
Re-applied after the train merged because the in-session TODO additions
were rolled back before they could land.*

- [ ] Smart-task temperature overshoot. Live prod walk (2026-05-22):
      multiple "Connected 300" successes overshot the 65 °C target by
      double digits — `70.7 → 79.4 °C · Overshoot 14.4 °C`,
      `29.3 → 77.7 °C · Overshoot 12.7 °C`. Surfacing overshoot is good,
      but a consistent ~14 °C overrun wastes energy and hints at a
      stop-condition/sensor lag. Recorded as `Succeeded`, so no
      correctness/data break — energy-waste + comfort concern.
      Investigate the heat stop condition vs. target before changing
      control behaviour (over-tightening risks under-heating).
      Source: live prod UI walk, 2026-05-22.

- [ ] **Make the postmortem strip honest about unobserved-gap hours** (consolidates three
      former items: persist-anchors + mark-restart-gap + flow-mode proration).
      *Support cost:* every Homey restart mid-task (settings change, OOM, deploy) currently drops
      one hour of delivery from the strip and renders it as a falsely-empty bar that reads "device
      did nothing" to a user inspecting a run — a predictable confusion scenario.
      - **Root-cause fix (persist anchors):** `currentHourOpening`/`lastKWhPerUnit` live only on
        the in-memory `InProgressRecord` (`planHistory.ts`) and aren't written to
        `DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING`, so a restart loses the in-flight hour. The
        `restarts mid-run drop the in-flight hour anchor` regression test pins this. Persist them
        alongside the rest of the record. Files: `lib/objectives/deferredObjectives/planHistory.ts`,
        `packages/contracts/src/deferredObjectiveActivePlans.ts`.
      - **Cheap mitigation (UI signal), if anchors aren't persisted:** mark restart-straddling
        hours in `DeadlinePlanHistoryDetail.tsx` (dashed cell + `data unavailable across restart`
        tooltip) so a measurement gap is distinguishable from a quiet hour. The gap is always the
        hour the pre-restart opening was anchored in.
      - **Out of scope (telemetry-blocked):** proper proration of multi-hour gaps under
        `power_source = flow` needs per-hour power telemetry that doesn't exist; the rollover
        detector attributes the whole delta to the opening hour. Documented in
        `planHistoryV4Helpers.ts:detectHourRollover`; revisit only if per-hour telemetry lands.
      Source: `pels-runtime-reality`, v2.8.0 PR1 review pass (PRs #990 + hour-rollover).

*v2.7.1 release-review P2 batch (2026-05-17), six-agent fan-out — non-blocking
polish/drift/follow-up. (Most resolved or discarded in the 2026-06-03 scrutiny pass.)*

*Phantom-design items removed (2026-05-31 m3-critic merit pass): the
"Electricity-prices two-select contrast" and "inconsistent active-vs-history chart
styling" items were written against UI that no longer exists — there are zero
`md-outlined-select` in shipped markup (every select is the token-bound dark-themed
`md-filled-select`, and migrating would break `segmentedControl.ts`), and both
smart-task charts already share the palette tokens and are deliberately different
chart types, not two languages for one chart. Do not re-raise from the stale
live-walk screenshots.*
- [ ] Refresh `state.deferredObjectiveActivePlans` on plan revision events. Today the field
      is populated once during `loadBootstrapData` in `packages/settings-ui/src/ui/boot.ts`
      and never updates from runtime emissions. `EvDeadlineStateLine` reads the field every
      render, so later replans, session changes (e.g. unplug mid-schedule), and updated
      start/finish hours are not reflected on Overview device cards until the user reloads
      the page. The runtime emits revision events via the active-plan recorder
      (`active_plan_revision_written` / `active_plan_revision_pending`); subscribe at the
      settings-UI API boundary and update the cached state, then re-render the affected
      cards. Surfaced by Codex on PR #793 review.
      Files: `packages/settings-ui/src/ui/boot.ts`, `lib/app/settingsUiApi.ts`,
      `packages/contracts/src/settingsUiApi.ts` (a streaming endpoint or pull-with-version
      contract).
- [ ] Cold-start catch-up for flow-scheme combined-prices rotation. `startPriceRefresh()`
      only schedules the next local midnight via `getNextLocalDayStartUtcMs(now)`, so if the
      app boots after midnight the first rotation is delayed until the following midnight.
      In flow mode both periodic refresh calls are no-ops, so yesterday's `combined_prices`
      classification can persist all day. A naive immediate `updateCombinedPrices()` at boot
      was previously tried and reverted because it broke the
      "should throttle restoration of set_temperature devices to one per cycle" plan test
      (the unconditional rebuild fires settings handlers that perturb the test's cooldown
      state). A conditional catch-up — only when `combined_prices` is from a prior local
      day — should be safe; verify it does not regress the plan throttle test.
      Files: `lib/price/priceCoordinator.ts`, `test/integration/plan.test.ts`, plan throttle tests.
- [ ] Improve overshoot attribution for hard-cap incidents.
      The 2026-05-13 log sample included a hard-cap breach with `totalKw: 5.655`,
      `hardCapHeadroomKw: -0.655`, `overshootUnattributedDeltaKw: 3.77`, and empty contributor
      arrays. If telemetry is available, surface the main managed/background contributors; if it
      is not, emit an explicit no-attribution reason so incident logs explain why attribution is
      unavailable.
      Files: `lib/plan/planBuilder.ts`, overshoot attribution tests.
- [ ] Add a device-log view in the Settings UI, and reuse the shared device overview formatter so
      the visible device-log wording matches backend overview transition logs exactly.
      Files: settings UI advanced/device-log surface, `packages/shared-domain/src/deviceOverview.ts`.
- [ ] Debounce or sequence plan rebuilds around budget/price-shaping toggle changes. Toggling daily
      budget or price-shaping briefly produced `objective_missing_price_horizon` plan reasons
      before recovering. The reason is correct in isolation, but the transient flash makes the
      planner look unhealthy to users watching a live UI during settings edits. Either debounce
      the rebuild until the dependent settings are coherent, or show an explicit "applying"
      loading state on the plan surface so the user sees a pending state instead of an odd
      reason. Confirm the recovery still happens within one rebuild cycle once settled.
      Files: `lib/plan/planService.ts`, `lib/plan/rebuildScheduler/scheduler.ts`,
      settings UI plan view loading states, plan-reason regression tests.
- [ ] Clarify log severity and wording for expected planner states. Several normal outcomes look
      like failures in log review: `cannot_meet` on a deadline objective, `failed: false` fields
      where `false` is the success path, and expected EV learning sample rejections
      (`no_progress`, `duplicate`, `too_small_rise`). Choose log severities that match real
      operational impact (likely `info` or `debug` for expected states, reserve `warn`/`error`
      for actual control or data faults), and reshape wording so logs read as state transitions
      rather than failures. Keep field semantics stable; only adjust level and human-readable
      messages.
      Files: `lib/logging/**`, `lib/objectives/deferredObjectives/**`, EV learning sample-rejection
      sites, log/wording regression tests.
- [ ] Finish the planner/executor/device-transport state boundary split.
      Planner output should carry desired state and planner reasons; `DeviceTransport` should
      provide observed current state and own native / flow / capability transport; executor should
      compare current with desired and handle sequencing, pending commands, retries, and
      materialization. `ExecutablePlan` now carries executor intent and `ExecutableObservedState`
      carries snapshot-built observer truth at the dispatch and drift-detection boundaries.
      Remaining work is to move the last flow-backed binary transport details fully behind
      `DeviceTransport`.
      Files: `lib/executor/**`, `lib/device/deviceTransport.ts`, binary transport tests.
- [ ] Split app lifecycle context into initialized vs initializing phases so services that are
      required after startup are not exposed forever as optional fields.
      Files: `lib/app/appContext.ts`, `app.ts`, app init/service tests.
- [ ] Split planner state from render-only explanation data so keep/shed/inactive decisions no
      longer depend on UI-facing `reason` objects.
      Files: `lib/plan/planRestore.ts`, `lib/plan/planReasons.ts`, plan/executor/rendering
      boundaries.
- [ ] Keep executor-owned actuation metadata persistence from growing ad hoc now that
      `lastControlledMs` is persisted out of `PlanExecutor`. If more per-device actuation state
      needs durable storage, extract a small persistence helper/queue instead of adding more
      direct settings writes to the executor.
      Files: `lib/executor/planExecutor.ts`.
- [ ] Finish the last `app.ts` shrink after the `TimerRegistry` / `AppContext` refactor. The
      remaining cleanup is to split/trim `setup/appInit.ts` (still ~506 LOC, over the `setup/`
      one-purpose-per-file convention), move `resolveHasBinaryControl` to a better long-term home if
      it stays shared, and keep trimming any delegates that no longer buy readability or testability.
      Files: `app.ts`, `setup/appInit.ts`, `lib/app/**`.
- [ ] Stop granting blanket `max-lines` exemptions. Classify each currently-oversized runtime file
      as either Bucket A ("must shrink to <=500") or Bucket B ("documented exception with a
      concrete raised ceiling"), replace file-level `eslint-disable` pragmas with per-file config
      overrides in `eslint.config.mjs` that cite the structural reason.
      Proposal: `notes/complexity-cleanup/god-file-policy.md`.
      Files: `eslint.config.mjs`, file-level disables in `app.ts`, `lib/**`.
- [~] Add a hero summary to the Electricity prices settings panel. *(partial, landed in
      `v2-7-3-budget-rhythm-and-polish`, 2026-05-18: one-sentence lede added under the panel
      `pels-hero` h2 so users know what the panel controls.)* Remaining for a later pass:
      a live "current tier / cheap / expensive / last-fetched" summary card. That requires
      a new wiring path from the price service into the settings UI and was out of scope.
      Files: `packages/settings-ui/src/ui/views/ElectricityPricesView.tsx` (done);
      `packages/settings-ui/public/index.html` (Electricity prices panel hero — pending);
      `packages/settings-ui/src/ui/electricityPrices.ts` (pending).
- [ ] Tighten the planner-to-executor projection so executable stepped-load intents cannot be
      underspecified. The desired end state is an `input snapshots -> ExecutablePlan` boundary
      where only core planning/admission sees both current and desired state; executable intents
      contain commandable desired state only, and observed current state comes separately from
      `ExecutableObservedState`. In particular, stepped `set_step` limiting should either carry a
      concrete requested step or be represented as non-executable before drift/dispatch code sees
      it.
      Update: keep-invariant gate now reads `hasExecutableShedDevices` from the executable plan
      so a dropped underspecified set_step shed no longer phantom-blocks unrelated stepped
      restores; dropped intents are also surfaced via the `stepped_load_shed_intent_dropped`
      structured debug event. The deeper refactor of removing observed current state from intents
      is still outstanding.
      Why P2 (demoted from P1 in release-review pass): the user-visible symptom is already
      fixed by the keep-invariant gate; the remaining work is internal-only refactor.
      Files: `lib/executor/executableSteppedLoadProjection.ts`, `lib/executor/executablePlan.ts`,
      `lib/executor/planExecutionDrift.ts`, stepped executable projection/drift tests.
- [ ] Add a "Picked the N cheapest hours of next M (avg P kr/kWh vs Q baseline)" caption under
      the live deadline-plan chart. The chart today is honest — price bars are tone-coded,
      planned hours stack on the same x-axis — but a skeptical user can't tell at a glance
      whether PELS actually picked the cheapest available hours. The data is already in
      `payload.timeline.hours` (`priceValue` + `planned` flag); the math is trivial. Live-Homey
      walk found this is the second-most-asked product question on the live page after cost.
      Why P2: trust signal for the skeptical EV-commuter persona; not blocking but
      meaningfully closes the "is PELS doing what it says?" question.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`,
      `packages/shared-domain/src/deadlineLabels.ts` (new label string),
      live-plan chart caption tests.
- [ ] **Close the transitive widget WebView import hole.** The
      `no-widget-to-runtime-except-node-entries` arch rule catches only DIRECT
      `widgets/*/src/public/** -> lib|app|setup|...` edges, not the transitive
      `public/** -> *WidgetPayload.ts -> lib` path (the `*WidgetPayload.ts` node
      builders are allowlisted to import lib, and `public/render.ts` imports them
      for constants/types). Today every payload->lib edge is type-only (erased at
      build), but a future VALUE import in a payload builder would silently ship
      runtime code into the browser bundle while `arch:check` stays green. Fix:
      split the browser-safe constants/types into a shared browser-safe module,
      then add a rule forbidding `widgets/*/src/public/** -> (api.ts|*WidgetPayload.ts)`.
      (Tracked by the `no-widget-to-runtime-except-node-entries` comment in
      `.dependency-cruiser.cjs`.) Source: codex review of PR #1286, 2026-05-29.

*Smart-task controller extraction (2026-05-30, `feat/smarttask-lifecycle-producer`).
Program to make the planner know nothing about smart tasks (deferred objectives):
relocate the lifecycle out of `lib/plan` into a clock-driven controller that
mutates `PlanInputDevice`s and owns ending + terminal actuation; planner stays
smart-task-agnostic. **Finish line REACHED (PR-D2): `no-plan-to-smarttasks` is now
`error` and green — `lib/plan` (and the executor) import zero `lib/objectives`,
value AND type (grep-verified).** See
`notes/state-management/deferred-objective-lifecycle-carveout.md`. Shipped: PR-A
(`ObjectiveDeviceInput` read contract), PR-A2 (DailyBudget-payload hoist), PR-B
(subsystem relocation to `lib/objectives`), PR-C (lifecycle emission on a 30 s
clock), PR-D1 (`@pels/planner-types` + `PlanInputDevice` hoist), PR-D2 (decoration
appliers + eval onto the `DeferredObjectiveDecorationController`, constructed in
app-wiring; rule flipped to `error`), **PR-E #1338 (clock-driven terminal device
disable — Goal 2 output side, the "disable-after-task-ends" end-game)**. PR-D1b
dropped (ExecutablePlan has no objectives consumer — see carve-out note step 5).
**PROGRAM COMPLETE; remaining items below are non-blocking follow-ups.***

- [ ] P2: direct emit-side test for `DeferredObjectiveLifecycleEmitter`. The current
      `test/deferredObjectiveLifecycleEmitter.test.ts` covers recorder forwarding + the no-settings
      no-op; the emit side (status-transition publish, hours-remaining crossing, and especially the
      `onDeadlinePassed` → disable firing through the clock tick) is only covered indirectly
      (migrated `appInit.test.ts` + the per-module `statusTransitions`/`hoursRemainingCrossings`
      tests). Add a direct emitter test that constructs a deadline-passed diagnostic and asserts the
      disable + status emit fire on `tick()`, to lock the behavioral contract of PR-C. Source:
      pels-runtime-reality on `feat/smarttask-clock`, 2026-05-30.

## P3 Future and Exploratory Work

*Entry bar: each item states a **hypothesis**, **why it's needed**, and the **persona**
(`notes/personas.md`) it serves. Items that can't name all three are maintainability/
cosmetic chores — do them in passing or drop them; don't park them here.*

- [x] **Create-screen `Extra permissions` opt-out is additive-only.** (done 2026-06-04)
      The compose screen now surfaces the selected device's CURRENT standing rescue
      permissions as a read-only "Already allowed (set via Flow): …" line above the
      toggles, so the section reads as additive on top of standing grants rather than
      authoritative. Threaded via a new `app.getDeviceStandingRescue` →
      widget `/devices` payload (`CreateSmartTaskDevice.standingRescue`) →
      `formatSmartTaskStandingPermissionsLine` (reuses `formatSmartTaskExtraPermissionsValue`).
      Additive write semantics (the `preserve` policy) unchanged — visibility only.

- [ ] **Surface the learned thermostat deadband to the owner.**
      *Persona:* skeptical optimiser / curious tinkerer (`notes/personas.md` #4/#3) — the
      owner who notices PELS commanding 65.2 °C when they set 65.0 °C.
      *Hypothesis:* the silent `learned_thermostat_deadband_c` offset reads as PELS
      misbehaving; showing "PELS adds +0.2 °C so the device satisfies at-target" (plus a
      `Reset learned deadband` control for reconfigured/replaced devices) turns a
      trust-eroding mystery into visible, deliberate learning.
      *Why it's needed:* the skeptical optimiser is an explicitly underserved persona, and a
      commanded value that differs from the user's own setpoint is exactly the unexplained
      behaviour that loses their trust.
      *Validate first:* no user has reported this confusion yet — confirm the signal (support
      thread / forensics) before spending UI on it; today the value lives only in the persisted
      settings map and feeds the setpoint silently. Source: kontor smart-task forensics, 2026-05-26.

*Smart-task failure-investigation & live UX — the underserved panic / skeptical
visitors (`notes/personas.md` #4–6).*

- [ ] **Smart-task live-detail energy band reads as a typo at a glance.**
      *Persona:* notification-driven panic visitor (deep-linked to the live detail mid-stress)
      and first-time user (needs the number to read as trustworthy on first contact).
      *Hypothesis:* `Needs 0.9–11 kWh` (en-dash, `smart-task-live-v2-480.png`, 2026-05-27 prod
      walk) is misread as a typo or one garbled number, undermining trust in the load-bearing
      figure on the page these personas land on.
      *Why it's needed:* the estimate is the answer on a deep-linked surface; an illegible
      number fails the "earn its visit" test. Render with `to` (`0.9 to 11 kWh`), space the
      dash, or fold to a single number once `displayConfidence !== 'low'`.
      Files: `packages/shared-domain/src/deadlineLabels.ts` (banded formatter, ~L1803),
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`. Source: 2026-05-27 prod walk.
- [ ] **Deadline-hero "Need X kWh" shows the original requirement, not live remaining.**
      *Persona:* curious tinkerer (watches the plan progress and expects the number to tick
      down) and skeptical optimiser (cross-checks remaining vs delivered).
      *Hypothesis:* the active-plan recorder no longer persists `energyNeededKWh`/`plannedKWh`
      decrements within an unchanged schedule (to avoid Homey settings churn), so the hero
      reads the original starting energy until the schedule/status/source/objective changes —
      a user watching for hours reads the static number as stuck or wrong.
      *Why it's needed:* the original-vs-remaining framing may erode trust for active monitors.
      *Validate first:* only act if users actually report confusion; then route live remaining
      through a non-persisted live snapshot (current diagnostic's `energyNeededKWh` in the UI
      bootstrap payload), never per-cycle persistence.
      Files: `lib/objectives/deferredObjectives/activePlanRecorder.ts`, `lib/app/settingsUiApi.ts`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`, `.../deadlinePlanResolvers.ts`.
- [ ] **Make the live → completed → history transition happen in place.**
      *Persona:* curious tinkerer (#3) watching a plan run, becoming the failure-investigation
      visitor (#5) at completion.
      *Hypothesis:* if the live page transitions in place — same URL, chart fading from
      "planned + measured" to "planned vs delivered", hero re-shaping from "what's next" to
      "what happened", adding `historyId=…` once persisted — the user who watched for hours
      lands on the verdict instead of being bounced to a thin "See History" card.
      *Why it's needed:* the Live-Homey walk flagged the hard-cut as jarring; the page
      *becoming* the history-detail pays off both the watcher and the postmortem reader.
      Related: `notes/smart-task-ui/README.md` §4. Files:
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`, `.../deadlinePlan.ts`,
      `lib/objectives/deferredObjectives/planHistory.ts` (transient handoff).
- [ ] **Breadcrumb a recent miss on the active-task hero.** Show "Last [kind] task missed:
      {short reason}" for ~24 h after a finalized miss.
      *Persona:* notification-driven panic visitor (#6) — reopens the app worried about a
      repeating deadline pattern, and lands on the *active* task, not history.
      *Hypothesis:* a 24 h breadcrumb sourced from the same postmortem resolver as history
      detail gives the prior-failure context on the surface they actually land on, without the
      Smart tasks → past row → detail navigation dance.
      *Why it's needed:* the persona most likely to reopen under stress is shown only current
      state today; the breadcrumb earns the visit. Related: `notes/smart-task-ui/README.md` Q2.
      Files: `packages/settings-ui/src/ui/deadlinePlanHero.ts`, `.../deadlinePlan.ts`
      (recent-miss query against `DeferredObjectivePlanHistoryEntry`).
- [ ] **Stop under-labeling real price advances as `schedule_revised`.**
      *Persona:* skeptical optimiser / failure-investigation visitor (#4–5) reading "why did
      my plan change?".
      *Hypothesis:* `resolveHorizonPriceWatermark` uses `max(plannedBuckets[].endMs)`, but
      buckets are clamped to `deadlineAtMs` (`policyHorizon.ts`/`bucketAllocation.ts`), so the
      watermark is usually just the deadline and `hasPriceHorizonAdvanced` rarely flips — real
      Nordpool publications get shown as "schedule revised" instead of "prices published".
      *Why it's needed:* the revision reason is user-facing copy the optimiser trusts; the
      wrong cause misleads them. PR #890 fixed the inverse (no false "prices published" on
      internal replans), not this. Fix: thread a real `pricesAvailableUpToMs` cutoff through
      `DeferredObjectiveHorizonPlan` to the recorder. Files: `lib/objectives/deferredObjectives/replanReason.ts`,
      `policyHorizon.ts`, `bucketAllocation.ts`. Source: chatgpt-codex P2 on PR #890.
- [ ] **Fold the revision-history panel into "What PELS has learned" at 320 px.**
      *Persona:* curious tinkerer (#3) — expands cards to debug their own setup.
      *Hypothesis:* at 320 px the standalone collapsed panel costs ~80–96 px of chrome before
      any content; nesting "…and what changed since the plan was first written" inside the
      existing `PlanInputsCard` recovers that space and groups related debug info.
      *Why it's needed:* on the 320 px-min webview the extra card shell pushes the actual
      revision content below the fold, weakening the one surface this persona uses to
      reconstruct what changed. Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `PlanInputsCard`. Source: pels-m3-critic/ux-fit on PR #1197 (batches 1–3 shipped).
- [ ] **Run the startup back-fill after an in-session migration retry.**
      *Persona:* failure-investigation visitor (#5) who opens history detail to learn *what
      happened* on a past deadline.
      *Hypothesis:* a boot-time `getKeys()` flake defers migration; when the plan-cycle retry
      completes mid-session, back-fill never re-runs, so the observation watermark advances to
      `now` and the offline window for migrated legacy tasks is permanently skipped — silently
      dropping the smart-task history this persona depends on.
      *Why it's needed:* history completeness is the only surface that reconstructs a failure;
      a gap fails this persona at their highest-stress moment. Fix: trigger back-fill on the
      in-session marker unset→set, or freeze the watermark until a back-fill has run that
      session. (Narrow: boot-flake + timing; history completeness, not live tasks.)
      Source: codex P2 on PR #1294.

*EV charging — the skeptical optimiser / EV commuter (`notes/personas.md` #4).*

- [ ] **EV deadline automation: per-charger defaults and plug-in auto-trigger.**
      *Persona:* skeptical optimiser / EV commuter (#4) — daily plug-in after the commute.
      *Hypothesis:* a per-charger automation profile that auto-materializes a deadline
      objective on the `sessionStartedAtMs` boundary means the commuter never fires
      `set_ev_charge_deadline` manually and still gets cheap-hour charging every night.
      *Why it's needed:* the v1 flow-card path works but imposes per-session friction; the
      daily charger is exactly the persona who tires of the ritual and stops trusting
      ready-by charging. Profile = enabled / target % or kWh / ready-by / enforcement / speed
      mode / optional manual kW + derating, upserted via the flow-card path; persistence should
      stay feature-specific rather than reviving the cut shared-state helper
      (`notes/persisted-settings-state.md`). Design:
      `notes/ev-ready-by/README.md`. Files: new `packages/contracts/src/evChargerDefaults.ts`,
      new wiring, `lib/device/transport/stateOfCharge.ts`, tests.
- [ ] **EV deadline polish: manual override actions + imminent-deadline urgency rule.**
      *Persona:* notification-driven panic visitor (#6) with EV-commuter overlap (#4) —
      realizes mid-evening the car won't be ready by morning and needs to intervene.
      *Hypothesis:* exposing `charge_now` / `pause_until_next_planned_slot` actions and
      force-admitting planned charging when `(deadline − now) < requiredHours + 1 h buffer`
      lets the panicking user override manually *and* trust the system to self-rescue when the
      window gets tight.
      *Why it's needed:* today an imminent deadline can stay shed under capacity/price logic
      with no escape hatch and no auto-urgency — the worst failure mode for the
      highest-intensity persona. (Notification delivery is the user's own flow; PELS supplies
      the trigger tokens — that token work lives in the P2 observability entry, not here.)
      Design: `notes/ev-ready-by/README.md`. Files: new flow action JSONs + registrations.

*Usage & budget — the curious tinkerer and set-and-forget owner (`notes/personas.md` #1, #3).*

- [ ] **Per-device usage history page with step-change context.**
      *Persona:* curious tinkerer ("what did this device cost last week?") and skeptical
      optimiser (per-device kWh/cost, did it run in cheap hours).
      *Hypothesis:* users debugging their own setup want measured kWh over time per device,
      and the number is uninterpretable without knowing which step/mode was active during each
      period — so the page needs step-change context to be trustworthy.
      *Why it's needed:* both personas' Usage rows in `notes/personas.md` ask for per-device
      drill-down PELS doesn't render today. Build the page and the 30-day hourly-retention
      per-device step-change tracker that feeds it together — the tracker is not shippable on
      its own. Files: future device-level step-change tracker; per-device usage-history route + chart.
- [ ] **Salvage the Usage half of closed PR #883 (`v2.7.3/budget-usage-loveable`).**
      *Persona:* set-and-forget owner / first-time user (a day-aware "Your typical Sunday runs
      X kWh" voice and a clean 14d default give the one-glance Usage summary), plus skeptical
      optimiser (NOK money line on Usage).
      *Hypothesis:* a day-aware natural-language Usage hero reads as more trustworthy and human
      than a raw total, and a money line answers the optimiser's "what did it cost" on the
      surface they check.
      *Why it's needed:* pays off the Usage first-glance rows in `notes/personas.md` (Budget
      half already superseded by `dd92fa42`). Scope: typical-day voice (`usageHero.ts` +
      `usageVoice.ts`); drop the 7d toggle in `power.ts` (keep 14d); NBSP between number and
      `kr`; NOK money line (deferred). Small focused PR.
- [ ] **Auto-adjust the daily budget from past eligible exemptions** (policy in
      `notes/daily-budget-auto-adjust/README.md`).
      *Persona:* skeptical optimiser (heat-tank owner) and failure-investigation user — both
      hit by repeated starvation-driven exemptions that signal the configured budget is
      chronically too tight.
      *Hypothesis:* raising tomorrow's effective budget by recent eligible exempted kWh
      (always relative to the configured base, never compounding) stops the planner chasing
      weather/thermal demand too aggressively and reduces repeat starvation, without touching
      hourly capacity protection.
      *Why it's needed:* recurring exemptions are a latent "your budget doesn't match reality"
      failure these personas keep hitting; automating the correction closes a loop they
      otherwise manage by hand. Honour the note's guards (base-relative, source-filtered, no
      hourly bypass). Files: daily budget state/service/UI/settings/diagnostics.

*Planner accuracy for multi-device homes — the skeptical optimiser (`notes/personas.md` #4).
Both are data-gated: act only when prod evidence shows the gap, else leave alone.*

- [ ] **Promote committed-task floor reservations beyond priority 1.**
      *Persona:* skeptical optimiser with several managed devices — a deadline-committed device
      that isn't the single top-priority one.
      *Hypothesis:* floor promotion is gated on `priority === 1 && both rescue permissions ===
      'always'` because the reserved-headroom forecast (`hardCap − uncontrolled`) assumes every
      controlled watt is displaceable — true only at the very top. A richer forecast that also
      subtracts higher-priority controlled load (`hardCap − uncontrolled − higherPriorityControlled`)
      would let the gate broaden to "highest priority present on this Homey", so a default-priority
      committed device's rescue stops being budget-exemption-only and can claim a guaranteed floor.
      *Why it's needed:* today a non-top committed device can still `cannot_meet` while its rescue
      grant sits inert; the optimiser with a mixed-priority home is the one who hits it. *Validate
      first:* pick up only if post-Slice-2 prod logs show a long-tail `cannot_meet` rate on
      non-top-priority tasks (user-confirmed the design is safe — it only sheds strictly
      lower-priority devices than the rescued one; the success flash stays honest meanwhile).
      Files: `lib/objectives/deferredObjectives/policyHorizon.ts`, `.../rescueReplan.ts`,
      `lib/dailyBudget/dailyBudgetBreakdown.ts`. Source: pels-runtime-reality on PR #983 / #1373.
- [ ] **Weather-condition the learned thermostat deadband.**
      *Persona:* skeptical optimiser / comfort-sensitive heat-tank owner whose sensor lag varies
      with conditions.
      *Hypothesis:* the single-value EMA (0.7/0.3) collapses every met/stalled observation onto one
      per-device deadband, but real lag is mildly weather-dependent (cold-start vs mild mid-day); if
      rate-confidence stays low after several samples, splitting learning by outdoor-temperature
      bucket (or recent-trajectory slope) — the way `dailyBudgetLearning.ts` keys per-day buckets —
      would track the true deadband and stop over/under-shooting target.
      *Why it's needed:* a biased deadband wastes energy or misses comfort for the persona who
      notices. *Validate first:* only act once the single-value EMA shows measurable bias in
      production. Source: kontor smart-task forensics, 2026-05-26.

*Demoted from P2 (2026-06-03 scrutiny pass) — real product / future-capability work with a
persona but no current support-cost pressure; reframed to the P3 bar.*

- [ ] **Smart-tasks widget — legible `at_risk` tone on the dark host.**
      *Persona:* notification-driven panic visitor scanning the widget for which task is in trouble.
      *Hypothesis:* the `data-tone="warn"` 12%-mixed wash is near-invisible over the dark Homey host,
      so the "at risk" signal leans almost entirely on the status chip; bumping the warn fill to a
      legible state-layer makes risk readable at a glance.
      *Why:* the persona most likely to open the widget under stress can miss the one row that matters.
      Files: `widgets/smart_tasks/public/index.css` (warn wash + eta recolor). Source: release-review
      pels-ux-fit + pels-m3-critic.
- [ ] **Miss-streak rollup on Overview.**
      *Persona:* recovering-from-mistake owner (#5) — reaches Overview from a notification, not via
      Smart-tasks.
      *Hypothesis:* `formatMissStreakAggregateLine` already renders on the Smart-tasks list but never
      reaches persona-5 on Overview; a per-device miss chip/rail on Overview answers "is this the same
      task failing again?" on the surface they actually land on.
      *Why:* the highest-intensity persona lands where the data isn't. Needs a new Overview API field
      (history isn't fetched there today). Files: `packages/contracts/src/settingsUiApi.ts`,
      `packages/settings-ui/src/ui/views/PlanOverview.tsx`.
- [ ] **Per-device kWh + money column on Usage.**
      *Persona:* skeptical optimiser (#4).
      *Hypothesis:* Usage emits total kWh only while the smart-task hero and Budget already show kr, so
      the optimiser can't answer "what did this device cost last week?"; a per-device kr column
      (`Σ priceValue × deviceKwh`, derivable today) closes it.
      *Why:* money visibility is exactly this persona's question; Usage is the one surface that withholds
      it. Needs a per-device kWh API field. Files: `packages/contracts/src/settingsUiApi.ts`,
      `packages/settings-ui/src/ui/usageHero.ts`, `.../usageStatsChartsEcharts.ts`.
- [ ] **Replace mechanically-generated widget preview PNGs with Figma-template exports** before App
      Store publish.
      *Persona:* prospective user evaluating PELS from the App Store listing.
      *Hypothesis:* the hand-rolled SVG-via-script mockups are compliant stop-gaps but read as
      amateurish; polished previews raise first-impression install trust.
      *Why:* store first-impression for a not-yet-user. Files: `widgets/*/scripts/build-previews.mjs`
      + SVG sources. Source: pels-m3-critic.
- [ ] **Sticky/debounced `at_risk` smart-task rescue (phase 2).**
      *Persona:* skeptical optimiser whose plan churns around the satisfied↔at_risk boundary.
      *Hypothesis:* the contract/runtime already parse an `at_risk` rescue mode that the JSON dropdown
      deliberately doesn't expose; if exposed without hysteresis it would flap and remove its own
      trigger, so it needs sticky/debounced engage-once-at-risk / exit-only-after-solidly-not semantics
      before it can ship.
      *Why:* future capability; flapping would oscillate lower-priority limit/resume.
      *Validate first:* unexposed today (dropdown is `never`/`always`); only build when the rescue lane
      needs it. Files: `lib/objectives/deferredObjectives/**`, `flowCards/smartTaskRescueCard.ts`,
      `.homeycompose/flow/actions/allow_smart_task_rescue.json`.
- [ ] **Profile and reduce plan-rebuild CPU spikes / `cpuwarn`.**
      *Persona:* every persona — the app staying responsive within Homey's CPU/RSS envelope.
      *Hypothesis:* startup `planRebuild` up to ~6 s and steady `planBuild` ~1 s delay shed/restore
      reactions to power changes; isolating hot paths (plan build dominates) behind a repeatable perf
      benchmark keeps control reactive.
      *Why:* degraded reactivity is felt as the app being slow to protect the cap. *Validate first:* no
      missed-shed has been tied to it yet — benchmark before optimizing. Files: `lib/plan/planBuilder.ts`,
      `lib/plan/planService.ts`, `lib/diagnostics/perfLogging.ts`.
- [ ] **Model backup-hour reservations for committed smart-task schedules.**
      *Persona:* skeptical optimiser with a tight deadline.
      *Hypothesis:* day-zero committed schedules degrade straight to `cannot_meet` with no backup-hour
      spill; modeling backup hours distinct from committed delivery hours (and reserving budget for them)
      would let a task that can't deliver in its committed hours use reserved capacity instead of failing.
      *Why:* future capability; `cannot_meet` is correct-but-blunt today. Files:
      `lib/objectives/deferredObjectives/horizonPlanner.ts`, `.../bucketAllocation.ts`,
      `notes/deferred-load-objectives/`.
- [ ] **Finish the starvation rollout beyond detection.**
      *Persona:* curious tinkerer building their own automations.
      *Hypothesis:* starvation detection + the user-initiated rescue widget shipped, but there are no
      per-episode/duration flow triggers or insights coverage, so a tinkerer can't react to starvation
      in their own Flows.
      *Why:* future product rollout against `notes/starvation/README.md`; the feature works without it.
      Files: `flowCards/**`, `drivers/pels_insights/**`, plan snapshot/contract wiring.
- [ ] **Rework device detail into focused Behavior / Setup / Diagnostics sections.**
      *Persona:* curious tinkerer configuring a device, and support reading diagnostics.
      *Hypothesis:* device detail is one long mixed scroll (modes, deadline, price, limiting, stepped,
      boost, setup, control model, native wiring, SoC, diagnostics); a focused IA keeps common controls
      reachable and moves the dense read-only diagnostics surface off the primary path.
      *Why:* important setup controls feel hidden and the diagnostics surface is a dense support read at
      the bottom of operational controls — functional but unloved. Files:
      `packages/settings-ui/src/ui/deviceDetail/**`, device-detail e2e/screenshots.
- [ ] **Define the binary operating precondition for temperature-lowered devices.**
      *Persona:* skeptical optimiser with a device that is both temperature- and binary-controllable.
      *Hypothesis:* `set_temperature` limiting only lowers the target; if such a device is observed
      off, the lowered target never takes effect — decide whether drift detection should turn it back
      on, then encode that as executable intent rather than special-casing drift.
      *Why:* a real but currently-undecided control-correctness edge. *Validate first:* needs a design
      decision (no evidence it has bitten). Files: `lib/executor/executablePlanProjection.ts`,
      `lib/executor/planExecutor.ts`, `lib/executor/planExecutionDrift.ts`.
- [ ] **Support a kWh target on the EV deadline flow card.**
      *Persona:* EV commuter whose charger doesn't report SoC.
      *Hypothesis:* the `ev_soc` variant accepts only `targetPercent`; a kWh target is the one EV path
      that needs no SoC observation/freshness at all, so accepting `targetEnergyKwh` broadens supported
      chargers and removes a fragile dependency.
      *Why:* widens device support for the EV persona. Design: `notes/ev-ready-by/README.md`. Files:
      `packages/contracts/src/deferredObjectiveSettings.ts`, `flowCards/deadlineObjectiveCards.ts`,
      `lib/objectives/deferredObjectives/diagnosticsBridge.ts`,
      `.homeycompose/flow/actions/set_ev_charge_deadline.json`.
