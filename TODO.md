# TODO

Only unresolved work belongs here. Completed items live in git history and tests, not in this
file.

## Priority Rubric

- **P0:** next-release blocker: release-blocking correctness, control-integrity, startup,
  validation, or data-loss issue that can affect current runtime behavior without another feature
  or broad refactor landing first.
- **P1:** next patch-release correctness or data-integrity work after the next release: bounded
  planner/executor risks, settings writes that can corrupt persisted state, supported-width UI
  breakage, or missing validation around commandable device contracts.
- **P2:** later product, observability, documentation, and maintainability work where current
  behavior is usable or has a workaround, but the gap increases support cost or slows future work.
- **P3:** future capability, optional hardening, or exploratory cleanup with no current correctness
  or supportability pressure.

## P0 Release Blockers

- [ ] Make EV deadline plans actually control the charger.
      Admission produces a decision for EV diagnostics but no command path exists:
      `buildDeferredTargetOverrides` skips EV (`lib/plan/deferredObjectives/admission.ts:80-92`)
      and the binary restore lane only fires for `currentOn === false` while
      `plugged_in_paused` reports `currentOn: true`
      (`lib/core/deviceManagerControl.ts:51-60`, `lib/executor/binaryExecutor.ts:56`). Add
      EV-aware executor intent (`ev_resume` / `ev_pause`) emitted when the admission decision
      flips between planned and idle. Honor existing cooldowns and the stale-power failsafe.
      Replace the `test/evDevices.integration.test.ts:292` "no command for paused EV" assertion
      with the new expected behavior.
      Why P0: the `set_ev_charge_deadline` flow card is registered and exposed to users today
      ("Charge [[device]] to [[target_percent]] % by [[ready_by]]"). Firing it succeeds and
      writes a plan, but no command reaches the charger.
      Minimum acceptable completion: a planned EV bucket resumes/starts a paused plugged-in
      charger, an idle bucket pauses/limits it through the normal control path, capacity safety is
      retained, and integration tests cover both the resume and idle transitions.
      Design: `notes/ev-ready-by/README.md`.
      Files: `lib/plan/deferredObjectives/admission.ts`, `lib/executor/`,
      `lib/core/deviceManagerControl.ts`, `test/evDevices.integration.test.ts`.

## P1 Correctness, Data Integrity, and Supported UX

- [ ] Make Settings UI device refresh await in-flight snapshot refreshes. `/ui_refresh_devices`
      currently calls `refreshTargetDevicesSnapshot()` and then returns the current in-memory
      device snapshot, but overlapping refresh calls only queue another refresh and return
      immediately. After removing persisted target snapshots, this can return stale or empty
      device data during startup or overlapping refreshes.
      Files: `lib/app/appSnapshotHelpers.ts`, `lib/app/settingsUiAppRuntime.ts`,
      `lib/app/settingsUiApi.ts`, settings UI API/runtime tests.
- [ ] Investigate repeated stale managed-device refreshes that never become fresh.
      `/tmp/pels/start.main.stdout.log` from 2026-05-13 repeatedly emitted
      `stale_device_observation_refresh` with `staleDevices: 2`, `refreshedDevices: 2`, and
      `freshAfterRefreshDevices: 0`. Determine whether those devices lack fresh telemetry,
      targeted refresh is not replacing stale fields, or freshness metadata is preserved
      incorrectly. Add a regression proving stale observations either become fresh when Homey
      returns fresh data or are degraded with a clear reason when they cannot.
      Files: `lib/app/appSnapshotHelpers.ts`, observer/device-state freshness helpers,
      snapshot-refresh tests.
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
- [ ] Fix redesigned top navigation at 320px. The current five-destination shell can truncate or
      collide, especially `Smart tasks`, on narrow Homey WebView widths. Make the control behave
      like a polished mobile navigation surface: no clipped labels, predictable horizontal
      scrolling or overflow treatment, and Playwright screenshots at 320px / 480px.
      Files: `packages/settings-ui/public/index.html`, `packages/settings-ui/public/style.css`,
      generated `settings/`, focused navigation layout coverage.
- [ ] Clamp stale EV boost stepped-load intent after boost deactivates.
      When EV boost admits a higher charger step and a later SoC update turns boost off, the next
      plan can briefly carry the old higher `desiredStepId` even when the shed-invariant reason
      says the step-up should not be admitted while other devices are still limited. This is
      expected to self-correct on later step/power observations, but the planner should eventually
      clamp the desired/target step to the currently allowed step when the boost exemption no
      longer applies.
      Files: `lib/plan/planRestoreHelpers.ts`, `lib/plan/planDevices.ts`,
      EV boost / stepped restore tests.
- [ ] Harden target-power stepped-load contract validation.
      Homey's `target_power` contract requires the range to include `0`; minimum operating power
      should be modeled with `excludeMin` / `excludeMax`, and `0` means idle. Keep mapping the off
      step to `target_power = 0`, but validate manual/synthetic profiles and warn or ignore
      invalid target-power metadata instead of letting malformed capability options look like
      normal input.
      Files: `lib/core/nativeSteppedLoadWiring.ts`, `lib/core/deviceManagerNativeEv.ts`,
      target-power/EV stepped-load tests.
- [ ] Make stepped swap completion use confirmed step evidence instead of planner-effective
      `selectedStepId`. `cleanupCompletedSwaps()` currently treats a pending stepped swap target
      as complete when `selectedStepId` is at or above the requested step, but that field can be
      an observer-resolved planning fallback rather than materialized/reported state. Post-release,
      move this completion check to reported/materialized step evidence so lower-priority swapped
      devices are not released before the target step is actually confirmed.
      Files: `lib/plan/swap/completion.ts`, `lib/plan/swap/lifecycle.ts`,
      `lib/plan/planRestore.ts`, stepped swap lifecycle tests.
- [ ] Tighten the planner-to-executor projection so executable stepped-load intents cannot be
      underspecified. The desired end state is an `input snapshots -> ExecutablePlan` boundary
      where only core planning/admission sees both current and desired state; executable intents
      contain commandable desired state only, and observed current state comes separately from
      `ExecutableObservedState`. In particular, stepped `set_step` limiting should either carry a
      concrete requested step or be represented as non-executable before drift/dispatch code sees
      it.
      Files: `lib/executor/executableSteppedLoadProjection.ts`, `lib/executor/executablePlan.ts`,
      `lib/executor/planExecutionDrift.ts`, stepped executable projection/drift tests.
- [ ] Add typed schemas/parsers for settings maps and flow-card args before values enter app
      logic. Avoid raw `Record<string, ...>`, `unknown`, and inline casts beyond the external
      Homey boundary.
      Why P1: flow cards and settings helpers repeatedly parse loose values with local fallbacks,
      so invalid external input can become normal internal state.
      Files: `lib/app/appSettingsHelpers.ts`, `flowCards/registerFlowCards.ts`,
      `flowCards/deviceSettingsCards.ts`, `flowCards/flowBackedDeviceCards.ts`.
- [ ] Extract a shared `PersistedSettingsState<T>` helper for recorder-style settings storage.
      Three modules currently reimplement the same dirty / debounce / abandon-grace / flush /
      plausibility cascade: `lib/app/appPowerCalibrationWiring.ts` (calibration),
      `lib/plan/deferredObjectives/planHistory.ts`, and
      `lib/plan/deferredObjectives/activePlanRecorder.ts`. After the helper lands, migrate
      calibration first, then the two deferred-objective recorders.
      Design context in `notes/persisted-settings-state.md`.
      Files: new `lib/persistence/` or `lib/utils/persistedSettingsState.ts`,
      `lib/app/appPowerCalibrationWiring.ts`, `lib/plan/deferredObjectives/planHistory.ts`,
      `lib/plan/deferredObjectives/activePlanRecorder.ts`, recorder/persistence tests.
- [ ] Unify stepped restore admission wrappers so pending-swap source-off holds and stepped swap
      executor context are applied consistently across normal restore planning, restore cooldown,
      meter-settling, and active stepped upgrade paths.
      Why P1: the two-phase swap contract is currently enforced by branch-local calls in
      `planRestore.ts`, which makes narrow bypasses easy when a new restore branch calls
      `planRestoreForSteppedDevice()` directly. Include a regression for an active stepped
      pending swap target during restore cooldown while its swapped-out source is still on.
      Files: `lib/plan/planRestore.ts`, `lib/plan/planRestoreHelpers.ts`,
      stepped swap / restore-cooldown tests.
- [ ] Surface EV deadline device-card state.
      `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx:63` shows only the Smart task chip.
      Once EV actuation lands, the device card should explain what PELS thinks the charger is
      doing. Add a next-planned-start line ("Waiting · charging starts 01:00"), an
      active-charging finish line ("Charging · planned finish 05:30"), and a plug-out paused
      line ("Charging plan paused — car unplugged"). Pull start / finish from the active-plan
      recorder's `latest.hours`; pull the paused state from the existing
      `objective_invalid_session` reason emitted by `resolveEvObjectiveProgress`
      (`lib/plan/deferredObjectives/diagnosticsBridge.ts:380-402`), which fires when the
      observation layer reports `stateOfCharge.status === 'invalid'`.
      Why P1: this is not a P0 blocker, but it is the first support-facing clarity gap once EV
      deadlines actually control charging.
      Design: `notes/ev-ready-by/README.md`.
      Files: `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx`,
      `lib/plan/deferredObjectives/diagnosticsBridge.ts`,
      `packages/contracts/src/` (diagnostic reason additions), device-card tests.
- [ ] Show planning speed and estimated duration on the EV deadline-plan page.
      `packages/settings-ui/src/ui/deadlinePlan.ts:153,164` shows kWh and hours-until-deadline.
      Add "Planning speed: X.X kW" and "Estimated time: Yh Zm" near the energy line, tagged
      with a speed-mode badge ("Auto" / "Learning…" today; "Manual" / "Conservative" once P3
      lands). Plumb the EV side of the existing per-step power calibration view
      (`lib/app/appInit.ts:468-487`, either a synthetic 1-step profile or an EV-specific
      branch) so `resolveStepDeliveryUsefulKw` serves Automatic mode without duplication.
      Why P1: this is not a P0 blocker for the flow-card percent deadline, but it is the core
      trust signal users need soon after the actuation fix.
      Design: `notes/ev-ready-by/README.md`.
      Files: `packages/settings-ui/src/ui/deadlinePlan.ts`, `lib/app/appInit.ts`,
      `lib/plan/deferredObjectives/diagnosticsBridge.ts`, calibration view tests.
- [ ] Surface built-in device control when it blocks device management.
      The control still exists (`packages/settings-ui/public/index.html:1017-1029`) and is wired
      by `packages/settings-ui/src/ui/deviceDetail/nativeWiring.ts`, but it is conditional and
      lives inside the collapsed Setup section. Meanwhile unsupported activation can leave
      "Managed by PELS" disabled with only a tooltip and list-row explanation. For native-wiring
      required devices, users can reasonably miss the hidden switch and think the option is gone.
      Minimum acceptable completion: when a device requires built-in device control before it can
      be managed, the device detail panel makes that action visible near the disabled management
      control or automatically opens or highlights the Setup section, and tests cover the blocked
      management path.
      Files: `packages/settings-ui/public/index.html`,
      `packages/settings-ui/src/ui/deviceDetail/nativeWiring.ts`,
      `packages/settings-ui/src/ui/deviceDetail/index.ts`,
      `packages/settings-ui/src/ui/devices.ts`, device-detail tests.
- [ ] Apply Norgespris to historical price rows instead of falling back to spot pricing.
      `buildCombinedHourlyPricesNorway()` currently skips the Norgespris adjustment for every
      hour before the current hour (`lib/price/priceServiceNorway.ts:221-239`). That avoids
      consuming the forward-looking monthly cap estimate, but it also makes past rows under the
      Norgespris model show spot-price totals. Split "display the fixed-price model" from
      "consume estimated remaining cap" so historical rows still use Norgespris while only current
      and future rows affect the remaining-cap projection.
      Why P1: cost history and any UI using past combined prices can show the wrong price model
      after the user selects Norgespris.
      Minimum acceptable completion: past same-month rows under `norway_price_model = norgespris`
      include a Norgespris adjustment and total, past rows do not reduce current /
      future cap eligibility, and strømstøtte behavior is unchanged.
      Files: `lib/price/priceServiceNorway.ts`, `test/norgesprisPriceService.test.ts`,
      price UI/widget tests that render past combined prices.

## P2 Product, Observability, and Maintainability

- [ ] Finish the starvation rollout beyond the current diagnostics implementation: add
      per-episode / duration-threshold flow triggers, verify insights coverage, and close any
      remaining snapshot/UI contract gaps against `notes/starvation/README.md`.
      Files: `lib/diagnostics/**`, `flowCards/**`, `drivers/pels_insights/**`,
      plan snapshot/contracts/UI wiring.
- [ ] Profile and reduce plan-rebuild CPU spikes seen in live Homey runs.
      `/tmp/pels/start.main.stderr.log` from 2026-05-13 had 11 Homey `cpuwarn` entries, and
      stdout had about 80 `[perf] cpu spike` entries. Plan rebuilds in that run were roughly
      1.6s median, 1.8s p90, and 3.7s max during `hard_cap_breach`. Use the existing perf
      counters to isolate hot paths in plan build, status write, and apply work, then add a
      repeatable perf check or benchmark before changing planner code.
      Files: `lib/plan/planBuilder.ts`, `lib/plan/planService.ts`, `lib/app/perfLogging.ts`,
      perf tests.
- [ ] Improve overshoot attribution for hard-cap incidents.
      The 2026-05-13 log sample included a hard-cap breach with `totalKw: 5.655`,
      `hardCapHeadroomKw: -0.655`, `overshootUnattributedDeltaKw: 3.77`, and empty contributor
      arrays. If telemetry is available, surface the main managed/background contributors; if it
      is not, emit an explicit no-attribution reason so incident logs explain why attribution is
      unavailable.
      Files: `lib/plan/planBuilder.ts`, overshoot attribution tests.
- [ ] Continue the Settings UI reorganization program from
      `notes/settings-ui-reorganization.md` as stacked reviewable PRs. The five-destination
      navigation shell, Budget Plan/Adjust surface, Smart tasks list, and Settings card/list are
      in place; remaining work is Usage history cleanup, per-device price behavior ownership,
      Material primitive consolidation, and final polish.
      Files: `packages/settings-ui/**`, generated `settings/`, relevant settings UI tests.
- [ ] Consolidate Settings UI design primitives around Material Web and shared PELS tokens. Use
      `@material/web` for standard Material components when the semantics fit, and replace
      page-local custom chips, cards, buttons, segmented controls, ripples, and elevation with
      Material Web components or one shared PELS primitive.
      Files: `packages/settings-ui/src/ui/materialWeb.ts`,
      `packages/settings-ui/src/ui/views/materialWebJSX.tsx`, `packages/settings-ui/public/style.css`,
      generated `settings/`, focused visual/e2e coverage.
- [ ] Make the device-detail "When limiting" selection explicit for stepped loads.
      The action segmented control shows `Set to step "<lowest active step>"` via
      `updateSetStepOptionLabel()`, but the dedicated `Limited step` row is always hidden
      (`packages/settings-ui/src/ui/deviceDetail/shedBehavior.ts:332-352`) and saving `set_step`
      stores only `{ action: 'set_step' }` rather than a visible `stepId`
      (`packages/settings-ui/src/ui/deviceDetail/shedBehavior.ts:365-371`,
      `packages/settings-ui/src/ui/deviceDetail/steppedLoadDraft.ts:302-315`). That means users
      cannot inspect the current limited step as its own setting; they must infer it from the
      segmented label and the stepped-load profile.
      Minimum acceptable completion: the Power limiting section clearly displays the effective
      limited step for stepped-load devices, updates when the profile draft changes, and keeps the
      runtime behavior of using the lowest active step unless an explicit product decision
      reintroduces a configurable limited-step selector.
      Files: `packages/settings-ui/src/ui/deviceDetail/shedBehavior.ts`,
      `packages/settings-ui/src/ui/deviceDetail/steppedLoadDraft.ts`,
      `packages/settings-ui/public/index.html`, device-detail tests.
- [ ] Consider moving Temperature boost into its own device-detail card.
      `device-detail-temperature-boost` currently renders inside the Stepped load profile section,
      after the step editor and save/reset controls (`packages/settings-ui/public/index.html:925-943`).
      The setting is a runtime behavior rule and can be more operationally important than editing
      the stepped-load profile itself, so testing feedback suggests it is too easy to miss when it
      sits below the profile editor.
      Minimum acceptable completion: decide whether Temperature boost remains grouped with stepped
      loads or becomes a separate, higher-priority card; if moved, keep it visible only for
      eligible stepped temperature devices, preserve existing persistence behavior, and update
      screenshots/tests.
      Files: `packages/settings-ui/public/index.html`,
      `packages/settings-ui/src/ui/deviceDetail/temperatureBoost.ts`,
      `packages/settings-ui/src/ui/deviceDetail/index.ts`, device-detail tests/screenshots.
- [ ] Rework device detail into focused sections or a dedicated setup page.
      The current device detail side sheet is a long mixed surface: mode targets, smart task,
      price response, power limiting, stepped-load profile, boost controls, setup toggles,
      control model, native wiring, SoC, and diagnostics all live in one scroll path
      (`packages/settings-ui/public/index.html:741-1067`). Setup and Advanced diagnostics are
      already collapsed by default, but important setup controls can still feel hidden, while
      diagnostics is a dense read-only support surface that may deserve its own destination
      instead of sitting at the bottom of the operational device controls.
      Minimum acceptable completion: choose an information architecture for device detail, such as
      a concise per-device overview with separate Behavior / Setup / Diagnostics subpages or tabs;
      keep the common operational controls reachable without long scrolling, move advanced setup
      controls and diagnostics out of the primary path, preserve lazy diagnostics loading, and
      update mobile screenshots/e2e coverage.
      Files: `packages/settings-ui/public/index.html`,
      `packages/settings-ui/src/ui/deviceDetail/**`, device-detail e2e tests/screenshots.
- [ ] Evaluate whether Usage needs both 7-day and 14-day daily-history views.
      The Usage history card defaults to "Last 14 days" and exposes a 7 / 14 day segmented
      range toggle (`packages/settings-ui/public/index.html:408-412`,
      `packages/settings-ui/src/ui/power.ts:45,48,242,400-413`). Daily history is already capped
      at 14 days in the UI, so this is mainly a product and layout question: whether the 14-day
      option adds enough value over a simpler 7-day view to justify the extra control.
      Minimum acceptable completion: decide whether to keep both ranges, make 7 days the only
      daily-history view, or keep 14 days as an advanced/secondary option; update the title, range
      hint, toggle, chart tests, and screenshots to match.
      Files: `packages/settings-ui/public/index.html`, `packages/settings-ui/src/ui/power.ts`,
      usage chart tests/screenshots.
- [ ] Improve dropdown menu UX in the redesigned Settings UI.
      The Planning behavior card still uses compact `md-filled-select` controls for short option
      sets (`packages/settings-ui/src/ui/views/BudgetOverview.tsx:560-599`). In the Homey-sized
      WebView, the opened menu can feel cramped and visually ambiguous: the popup is nearly the
      same width as the field, overlaps the next row, and the selected/current value is not clearly
      distinguished from hovered or adjacent options. Existing select coverage only checks theme
      tokens/readability for the price-source dropdown
      (`packages/settings-ui/tests/e2e/material-select.spec.ts`) and does not assert budget-card
      menu geometry, selected-state clarity, or mobile screenshots.
      Minimum acceptable completion: evaluate replacing these short dropdowns with segmented
      controls/radio rows or improve the shared Material select styling so menus have clear
      selected and hover states, adequate width, predictable overlay placement, and no confusing
      overlap in 320px / 480px Homey WebView screenshots.
      Files: `packages/settings-ui/src/ui/views/BudgetOverview.tsx`,
      `packages/settings-ui/public/style.css`,
      `packages/settings-ui/tests/e2e/material-select.spec.ts`, budget/settings screenshots.
- [ ] Update the Settings UI Homey API mock to stop serving devices from
      `target_devices_snapshot`. Production now serves `/ui_devices` and `/ui_refresh_devices`
      from runtime app state, so the mock should model live device data explicitly and avoid
      masking runtime-backed device API regressions.
      Files: `packages/settings-ui/test/helpers/homeyApiMock.ts`, settings UI tests.
- [ ] Add a device-log view in the Settings UI, and reuse the shared device overview formatter so
      the visible device-log wording matches backend overview transition logs exactly.
      Files: settings UI advanced/device-log surface, `packages/shared-domain/src/deviceOverview.ts`.
- [ ] Move presentation text out of `shared-domain/deviceOverview.ts`.
      Why P2: the overview generator emits human-readable English strings
      (`'Charging requested'`, `'Restoring'`, `'Active (temperature-managed)'`,
      `'Shed (charging paused)'`, ...). That couples shared-domain to a single UI language and
      makes control-state reuse harder to type cleanly. The 2026-05-13 log review confirmed
      those strings reach overview payloads as `stateMsg`/`statusMsg`/`reasonText`, including
      current user-facing text that should render through `notes/ui-terminology.md` instead:
      `Shed (powered off)`, `insufficient headroom to restore`, `shortfall (...)`, and
      `cooldown (restore, ... remaining)`.
      Files: `packages/shared-domain/src/deviceOverview.ts`,
      `packages/contracts/src/settingsUiApi.ts`,
      `packages/settings-ui/src/ui/**` rendering call sites.
- [ ] Investigate Settings UI bundle growth and the runtime module-type warning from Homey runs.
      Current start logs show esbuild warning on `dist/script.js 1.2mb` and Node
      `[MODULE_TYPELESS_PACKAGE_JSON]` warnings for
      `packages/shared-domain/src/planReasonSemanticsCore.js`, despite
      `packages/shared-domain/package.json` declaring ESM. Verify why the packaged runtime import
      path does not see the workspace package metadata, fix the warning without broad package-mode
      churn, and decide whether the settings script needs an explicit size budget.
      Files: `package.json`, `packages/shared-domain/package.json`,
      `packages/shared-domain/src/planReasonSemanticsCore.js`,
      `packages/settings-ui/package.json`, settings build/sync scripts.
- [ ] Update public deadline documentation once the feature enters testing. Keep
      `docs/technical.md`, `docs/flow-cards.md`, and any deadline-plan docs aligned with the
      runtime semantics for EV and heater objectives: already-met targets are live `satisfied`
      states until the deadline, and a later below-target reading returns to tracking. Keep
      terminology aligned with `notes/ui-terminology.md`.
- [ ] Make past smart-task plans enterable from history.
      The deadline-plan route is keyed only by `deviceId` (`packages/settings-ui/src/ui/deadlineUrls.ts`),
      and `resolveObjectiveContext()` only builds the detailed chart from the active objective /
      active-plan recorder (`packages/settings-ui/src/ui/deadlinePlan.ts:247-281`). Past entries
      render as static summary cards with no link or detailed route
      (`packages/settings-ui/src/ui/views/DeadlinePlanHistory.tsx:27-44`). As a result, once a
      task has moved to history, the user cannot open that specific plan view; they can only see
      the summary card.
      Minimum acceptable completion: history entries have a stable route keyed by the history
      entry identity, the deadline-plan page can reconstruct the detailed chart from the history
      record plus available price/usage buckets, and missing historical detail degrades to a clear
      summary state instead of the generic current-plan unavailable card.
      Files: `packages/settings-ui/src/ui/deadlineUrls.ts`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`,
      `packages/settings-ui/src/ui/views/DeadlinePlanHistory.tsx`,
      `packages/contracts/src/deferredObjectivePlanHistory.ts`, deadline-plan history tests.
- [ ] Add missing swap lifecycle coverage from the pre-release review. Cover completed stepped
      swap cleanup with a stepped target and requested step, assert approved stepped swaps persist
      the stale-cleanup timestamp, and add an `applyRestorePlan()` integration test for orphan
      measurement deferral before a fresh power sample.
      Files: `test/swapLifecycle.test.ts`, `test/planRestoreBackoff.test.ts`,
      `lib/plan/planRestore.ts`.
- [ ] Finish the planner/executor/device-manager state boundary split.
      Planner output should carry desired state and planner reasons; `DeviceManager` should
      provide observed current state and own native / flow / capability transport; executor should
      compare current with desired and handle sequencing, pending commands, retries, and
      materialization. `ExecutablePlan` now carries executor intent and `ExecutableObservedState`
      carries snapshot-built observer truth at the dispatch and drift-detection boundaries.
      Remaining work is to move the last flow-backed binary transport details fully behind
      `DeviceManager`.
      Files: `lib/executor/**`, `lib/core/deviceManager.ts`, binary transport tests.
- [ ] Define the binary operating precondition for temperature-lowered devices.
      `set_temperature` limiting currently lowers the target only. For devices that also expose
      binary control, decide whether an observed off state should be treated as drift and turned
      back on so the lowered target can take effect, then encode that as executable intent instead
      of special-casing drift detection.
      Files: `lib/executor/executablePlanProjection.ts`, `lib/executor/planExecutor.ts`,
      `lib/executor/planExecutionDrift.ts`, temperature-lowered executor/drift tests.
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
      Files: `packages/contracts/src/types.ts`, `lib/plan/planTypes.ts`,
      `lib/plan/planBuilder.ts`, settings UI contract tests.
- [ ] Normalize persisted optional state into runtime state with required maps immediately after
      loading. Keep persisted shape and runtime shape separate for power tracker, activation
      attempts, headroom cards, pending commands, and similar planner state.
      Files: `lib/core/powerTracker.ts`, `packages/contracts/src/powerTrackerTypes.ts`,
      `lib/plan/planState.ts`, `lib/utils/appTypeGuards.ts`.
- [ ] Replace deeply partial flow-reported capability state with a normalized runtime
      representation at the boundary.
      Files: `lib/core/flowReportedCapabilities.ts`.
- [ ] Split app lifecycle context into initialized vs initializing phases so services that are
      required after startup are not exposed forever as optional fields.
      Files: `lib/app/appContext.ts`, `app.ts`, app init/service tests.
- [ ] Split planner state from render-only explanation data so keep/shed/inactive decisions no
      longer depend on UI-facing `reason` objects.
      Files: `lib/plan/planRestore.ts`, `lib/plan/planReasons.ts`, plan/executor/rendering
      boundaries.
- [ ] Extract rebuild-metrics/tracing helpers out of `planService.ts` now that plan snapshots are
      in-memory/realtime only. Fold or delete the remaining tiny `planServiceInternals.ts` helper
      surface if it no longer pays for itself.
      Files: `lib/plan/planService.ts`, `lib/plan/planServiceInternals.ts`,
      new `lib/plan/planRebuildMetrics.ts`.
- [ ] Keep executor-owned actuation metadata persistence from growing ad hoc now that
      `lastControlledMs` is persisted out of `PlanExecutor`. If more per-device actuation state
      needs durable storage, extract a small persistence helper/queue instead of adding more
      direct settings writes to the executor.
      Files: `lib/executor/planExecutor.ts`.
- [ ] Finish the last `app.ts` shrink after the `TimerRegistry` / `AppContext` refactor. The
      remaining cleanup is to decide whether the now-thin `lib/app/appInit.ts` adapter should be
      deleted, move `resolveHasBinaryControl` to a better long-term home if it stays shared, and
      keep trimming any delegates that no longer buy readability or testability.
      Files: `app.ts`, `lib/app/**`.
- [ ] Finish post-unification cleanup for plan rebuild scheduling.
      `PlanRebuildScheduler` exists and is wired, but the compatibility surface in
      `appPowerRebuildScheduler.ts` still owns signal/backoff bridging. Either fold that surface
      into the unified scheduler or document it as an explicit compatibility layer.
      Files: `lib/app/planRebuildScheduler.ts`, `lib/app/appPowerRebuildScheduler.ts`,
      scheduler tests.
- [ ] Remove redundant downstream `managed !== false` filters now that unmanaged devices are
      excluded from `latestTargetSnapshot` at parse time. Current sites:
      `lib/app/appSnapshotHelpers.ts:264`, `lib/app/appInit.ts:341`,
      `lib/plan/planEvBoost.ts:15`, `lib/plan/planTemperatureBoost.ts:22`, and
      `lib/plan/planDiagnostics.ts:130`.
- [ ] Deduplicate `applyDeviceDriverOverride` along the snapshot pipeline. Today the override is
      applied in `DeviceManager.refreshSnapshot`, again in the private `parseDeviceList`, and a
      third time inside `resolveParseDeviceIdentity`.
      Files: `lib/core/deviceManager.ts`, `lib/core/deviceManagerParseDevice.ts`,
      `lib/core/deviceManagerParseIdentity.ts`.
- [ ] Audit whether daily-budget confidence scoring materially changes control decisions. If it is
      purely informational, simplify it aggressively.
      Files: `lib/dailyBudget/dailyBudgetConfidence.ts`, daily budget service/plan paths.
- [ ] Stop granting blanket `max-lines` exemptions. Classify each currently-oversized runtime file
      as either Bucket A ("must shrink to <=500") or Bucket B ("documented exception with a
      concrete raised ceiling"), replace file-level `eslint-disable` pragmas with per-file config
      overrides in `eslint.config.mjs` that cite the structural reason.
      Proposal: `notes/complexity-cleanup/god-file-policy.md`.
      Files: `eslint.config.mjs`, file-level disables in `app.ts`, `lib/**`.
- [ ] Land low-risk file consolidations once their target files have headroom. Merge tiny helpers
      only where doing so reduces directory surface without hiding real subsystem boundaries.
      Files: `lib/plan/**`, `lib/app/appRealtimeDeviceReconcile*`.
- [ ] Support a kWh target on the EV deadline flow card.
      `packages/contracts/src/deferredObjectiveSettings.ts:14-16` accepts only `targetPercent`
      for the `ev_soc` variant. The kWh target is the only EV deadline path that does not
      depend on SoC observation at all — no native capability, no session validity, no
      freshness window. Discriminate the `ev_soc` variant to accept either `targetPercent` or
      `targetEnergyKwh`, add a `target_kwh` arg path to `set_ev_charge_deadline`, and teach
      the diagnostics bridge to compute `energyNeededKwh` directly from `targetEnergyKwh` when
      present.
      Why P2: stand-alone feature; broadens supported chargers (no SoC integration required)
      and removes a fragile dependency for chargers that do report SoC. Not a prerequisite for
      the v1 EV release unless the release copy promises "add X kWh before HH:mm".
      Design: `notes/ev-ready-by/README.md`.
      Files: `packages/contracts/src/deferredObjectiveSettings.ts`,
      `flowCards/deadlineObjectiveCards.ts`,
      `lib/plan/deferredObjectives/diagnosticsBridge.ts`,
      `.homeycompose/flow/actions/set_ev_charge_deadline.json`, contract and bridge tests.
- [ ] Make `enforcement: 'hard'` actually bypass daily-budget pressure on EV deadlines.
      `lib/plan/planBuilder.ts:258` uses `min(capacitySoftLimit, dailySoftLimit)` uniformly,
      so the `hard` flag accepted by the flow card has no behavioral effect. Plumb a "hard
      objective active" signal from admission into the soft-limit selector and apply only to
      EV chargers admitted under `enforcement: 'hard'`; bypass the daily-tightened soft limit
      while still respecting the hard cap. Until this lands, the EV flow card should default to
      `soft` and hide the `hard` option from users.
      Design: `notes/ev-ready-by/README.md`.
      Files: `lib/plan/planBuilder.ts`, `lib/plan/deferredObjectives/admission.ts`,
      `flowCards/deadlineObjectiveCards.ts`, headroom and admission tests.
- [ ] Close the EV deadline observability loop: measured deviation and richer trigger tokens.
      Two connected items: (a) emit the `measured_deviation` revision reserved in
      `activePlanRecorder.ts:379-380` by comparing observed delivery (read from the calibration
      EMA via `getDeliveryPowerKw`) against the planned bucket allocation; (b) expand
      `buildTriggerTokens` (`flowCards/deadlineObjectiveCards.ts:161-179`) with
      `planned_start_local`, `planned_finish_local`, `required_kwh`, `planning_speed_kw`,
      `estimated_duration_text`, and `risk_reason`. The active-plan recorder already carries
      `energyNeededKWh`, `planStatus`, `kwhPerUnitSource`, and the bucket allocation needed.
      Design: `notes/ev-ready-by/README.md`.
      Files: `lib/plan/deferredObjectives/activePlanRecorder.ts`,
      `flowCards/deadlineObjectiveCards.ts`,
      `.homeycompose/flow/triggers/deadline_status_changed.json`, related tests.

## P3 Future and Exploratory Work

- [ ] Track per-device step changes with the same 30-day hourly retention model, so measured
      usage history can explain which step or mode was active during each measured period.
      Files: future device-level step-change tracker; usage-history UI.
- [ ] Add a per-device usage history page showing measured kWh over time with step-change context.
      Files: future device-level usage-history route and chart.
- [ ] Consider allowing Homey Energy-backed `powerKw` as a fallback for stepped restore
      post-confirmation settlement when `measure_power` is missing, but keep manual overrides and
      other derived power sources non-authoritative for that release check.
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
      cooldowns, explicit available-power reservations, richer price explainability,
      weather-aware budget context, and small per-device action history in the UI.
- [ ] Add EV deadline automation: per-charger defaults and plug-in auto-trigger.
      Per-charger automation profile (enabled, target percent or kWh, ready-by time,
      enforcement, speed mode, optional manual kW and derating) plus a hook on the
      `sessionStartedAtMs` boundary in `lib/core/deviceStateOfCharge.ts` that materializes the
      defaults into a `DeferredObjectiveSettingsV1` entry through the same upsert path the flow
      card uses. Persistence must align with the shared `PersistedSettingsState<T>` helper from
      `notes/persisted-settings-state.md`.
      Why P3: stand-alone polish; removes the per-session friction of firing
      `set_ev_charge_deadline` manually, but the v1 flow-card path is workable without it.
      Design: `notes/ev-ready-by/README.md`.
      Files: new `packages/contracts/src/evChargerDefaults.ts`,
      new `lib/app/evChargerDefaultsWiring.ts`, `lib/core/deviceStateOfCharge.ts`,
      defaults / auto-trigger tests.
- [ ] EV deadline polish: manual override actions and urgency rule.
      Add `charge_now` and `pause_until_next_planned_slot` flow actions. Add a
      deadline-imminent emergency rule that forces planned admission when
      `(deadline − now) < requiredHours + 1h buffer`. (Notification delivery is the user's own
      flow — PELS supplies the trigger tokens needed to compose useful messages; the work for
      those tokens lives in the P2 observability entry above, not here.)
      Design: `notes/ev-ready-by/README.md`.
      Files: new flow action JSONs and registrations.
