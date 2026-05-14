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

- [x] Flatten `settings/tokens.css` to a single colour layer with no aliasing tier. *(landed —
      this PR introduces a flat `color.role.*` namespace, removes the per-state `-muted` /
      `-strong` alpha triplets and the `color.state.success.*` family, fixes the five aliasing
      bugs called out in the audit, points the deprecated `--pels-status-*` shims at the new
      flat tokens, applies an eco-themed palette (primary `#16a34a` leaf-green, good `#5eead4`
      teal, warning `#f59e0b` solar amber, danger `#ef4444`, info `#60a5fa`), and adds typography
      tokens for M3 display/headline/title scales. Shims are retained for one release while
      chart consumers migrate; final removal lands with the chart-token P0 below.)*
- [x] CSS-side migration: rebind hero + section headers + card titles to the new typography
      tokens. *(landed — `.plan-hero__headline` and `.hero h1` now use `--pels-text-display-*` /
      `--pels-text-headline-*`; section `h2` rules (`.settings-home-hero h2`,
      `.device-detail-heading h2`) use `--pels-text-section-headline-*`; `.card h2` and
      `.usage-hero__stat-value` use `--pels-text-title-*` (the spec's display-small for
      `.usage-hero__stat-value` was rejected — three 36 px values cannot fit the 3-column
      stat grid at 320 px; revisit only if the grid is restructured to wrap). `.eyebrow`
      moved from semibold to medium per the M3 label-small weight. Screenshot baselines need
      a refresh pass — tracked in the residual e2e bullet below.)*
- [x] CSS-side migration: apply existing surface tier tokens per M3 nesting. *(landed —
      `.slide-panel` raised to `--pels-surface-container-high`, `.banner` uses
      `--pels-surface-container-highest`, `.plan-card` is now a flat `--color-surface-1`,
      `[data-state-kind="resuming"]` binds to `--pels-status-good-surface`, and
      `[data-state-kind="unknown"]` gets a 0.6 opacity dim. Screenshot baselines need a refresh
      pass — tracked in the residual e2e bullet below.)*
- [x] Demote accent, promote good. *(landed — `pels.status.good` token now resolves to
      `color.role.good` (teal #5eead4); accent (`#22c55e` brighter leaf) stays on selected-tab,
      focus ring, primary buttons, switch/checkbox. Positive-state surfaces, meter tone, ripple
      hover, chart `--pels-chart-plan`, and resuming plan-card all cascade automatically.)*
- [ ] Replace fake-M3 segmented controls and active badges with real M3 components.
      `.day-view-toggle` (Budget Plan/Adjust), `.segmented` (Devices, Modes), and the
      "When limiting" segmented row inside device-detail (Turn off / Set to temperature /
      Set to step) all reinvent `md-outlined-segmented-button` + `md-segmented-button`
      without matching state layers — the device-detail one renders all three options as
      leaf-green text on transparent with no selected-state surface fill (M3 follow-up
      audit, 2026-05-14). `.active-badge` (device-detail per-mode priority rows) uses a
      4 px square corner — inconsistent with the 9999 px `--chip-radius` everywhere else,
      and under leaf-green the fill reads as "sticker" rather than "active". Replace with
      `md-assist-chip` carrying tonal good-teal (`rgba(94,234,212,.15)` bg +
      `#5eead4` text) so it matches Succeeded chips. Component-level change.
      Files: `packages/settings-ui/public/index.html`,
      `packages/settings-ui/src/ui/views/BudgetOverview.tsx`,
      `packages/settings-ui/src/ui/views/PlanModes.tsx`,
      `packages/settings-ui/src/ui/deviceDetail/shedBehavior.ts`, related styles.
- [x] Align every chart series, heatmap cell, and tooltip with the same flat tokens the rest of
      the UI uses. *(landed — `resolveCssColor` in `budgetRedesignChart.ts`,
      `usageDayChartEcharts.ts`, `usageStatsChartsEcharts.ts`, and `powerWeekChartEcharts.ts`
      dropped its hex-fallback signature; all chart palette reads now resolve through CSS vars
      only. `grep -E "#[0-9a-f]{3,6}"` in `packages/settings-ui/src/ui/*Chart*.ts` returns
      zero. Heatmap low/high series in `powerWeekChartEcharts.ts` rebound to
      `--color-role-info` / `--color-role-danger`. Cross-surface hue parity vs. Overview chips
      still relies on the screenshot baseline refresh tracked in the e2e bullet below.)*
- [ ] Unify the hero and section-label primitive across every settings-UI surface.
      Overview hero, Budget header, Usage header, Smart tasks header, Settings header, Advanced
      header, and deadline-plan hero should read as one component: same eyebrow (font-size,
      letter-spacing, colour token), same headline weight / size / line-height, same status-tone
      bindings (`data-tone="good|warn|alert"` → flattened tokens from the entry above), same
      accent radial-gradient atmosphere rule, same supporting-text token. Same for section
      labels (`eyebrow`) — one font-size + one weight + one colour token, applied uniformly.
      Acceptance: a Playwright screenshot matrix of all primary surfaces at 320 / 480 px shows
      hero typography and section-label typography each trace to a single source of truth in
      `style.css`; the screenshot snapshots are committed and diff-gated; no surface defines its
      own one-off hero rule. Files: `packages/settings-ui/public/index.html`,
      `packages/settings-ui/public/style.css`, `packages/settings-ui/src/ui/views/PlanHero.tsx`,
      `packages/settings-ui/src/ui/views/BudgetOverview.tsx`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/src/ui/power.ts`, generated `settings/`, screenshot suite under
      `packages/settings-ui/tests/e2e/`.
      *Sub-bullets from M3 visual pass (2026-05-14, after eco-palette landed):*
      - **`.plan-hero[data-tone="alert"]` is visually overloaded.** In an over-hard-cap
        state the hero stacks four semantic signals at once: red rim, red headline
        ("5.6 kW"), red subline ("0.6 kW above hard cap"), red power-bar fill, plus an
        amber over-budget sub-bar with a red end marker, plus an alert chip and a
        muted chip in the same row. M3 wants one tonal-container story per surface — the
        red rim alone communicates the alert. Drop the headline-red, keep the rim and one
        alert chip; let the rest of the type stay neutral primary so the hero reads as
        "elevated card in danger state", not "danger shouted four ways".
      - **`0.6 kW above hard cap` subline** quadruples information already encoded by
        rim + chip + headline colour + bar overshoot. Either remove it or convert to an
        instruction (e.g. "Reduce load now").
      - **Info as a role is sparse on Overview** — only the Smart-task chip and the
        info-tinted histogram on Budget/Usage tabs. That's M3-appropriate (info is for
        neutral explanation), but worth confirming during hero work that we're not
        artificially restraining it; if there's a natural "Price low / Price high" hint
        for the hero meta-row, use info there.
      Chips, cards, buttons, segmented controls, ripples, and elevation are currently duplicated
      across views with subtle per-page variations (padding, border colour, ripple behaviour,
      focus ring). A first-impression UI should read as one system, not five-plus near-duplicates.
      Acceptance: one shared CSS class / JSX wrapper per primitive type, every consumer rebound,
      no inline overrides beyond data-attribute state. Implementation may use the existing custom
      primitives or `@material/web` — that choice stays with the P2 entry below; this P0 only
      requires that consumers converge. Files: `packages/settings-ui/public/style.css`,
      `packages/settings-ui/src/ui/views/*.tsx`,
      `packages/settings-ui/src/ui/views/materialWebJSX.tsx`,
      `packages/settings-ui/src/ui/materialWeb.ts`, generated `settings/`, focused visual/e2e
      coverage.
- [ ] Fix chart clarity issues from the first-impression Settings UI audit.
      Tighten the graphs users are most likely to inspect on first load. Normalize deadline-plan
      price values and units against the Budget chart convention (`kr/kWh` or `øre/kWh` shown
      explicitly), make the Budget hourly-plan legend match the rendered `Managed` / `Background`
      split series, and resize/reinitialize Usage ECharts when a hidden panel becomes visible so
      SVGs cannot keep a too-wide fallback size after tab navigation. While fixing the resize
      path, review module-level chart instance state and move lifecycle ownership to the
      rendering view or component where needed. Promoted from P1: a chart whose legend lies
      about its colours, or that renders the wrong width after a tab switch, is exactly the
      first-impression problem the rubric now scopes into P0.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`,
      `packages/settings-ui/src/ui/views/BudgetOverview.tsx`,
      `packages/settings-ui/src/ui/budgetRedesignChart.ts`,
      `packages/settings-ui/src/ui/usageDayChartEcharts.ts`,
      `packages/settings-ui/src/ui/usageStatsChartsEcharts.ts`,
      `packages/settings-ui/tests/e2e/charts-layout.spec.ts`.
- [ ] Refresh Playwright e2e screenshot baselines for the design-token theme PR
      (2026-05-14 token+typography+surface refresh). The bundled CSS-only P0s above shift
      the accent hue (`#16a34a` → `#22c55e`), promote teal `--color-base-good-default` as the
      positive-state color, raise hero headlines to display-small, repaint plan-cards as flat
      `--color-surface-1`, retune the surface/border ramps, and replace state-container hex
      with `color-mix(...)`. Visually verify each baseline at 320 px and 480 px before
      committing the new snapshots — do not regenerate blind. Files:
      `packages/settings-ui/tests/e2e/*.spec.ts` and their `__snapshots__/` siblings.

## P1 Correctness, Data Integrity, and Supported UX

- [ ] Give settings-form text-field / select controls an accessible name. M3 follow-up audit
      (2026-05-14) re-checked the previous "duplicate visible labels" finding and corrected the
      framing: `md-filled-text-field` and `md-filled-select` in `Limits & safety`,
      `Electricity prices`, daily-budget advanced, and device-detail have **no `label`
      attribute and no `aria-label` / `aria-labelledby` set anywhere**, so only one label
      *renders* visually (the sibling `<span class="field__label">`). The bug is a11y, not
      dual-rendering: 32 of 33 `.field__label` are bare `<span>` (not `<label for=>`), so the
      M3 control has no accessible name at all to screen readers. Acceptance: every control
      either receives the text via the component's `label=""` attribute or is bound to its
      sibling label via `aria-labelledby` referencing a `.field__label[id]`. The visible
      label rendering should stay the same as today.
      Files: `packages/settings-ui/public/index.html`,
      `packages/settings-ui/src/ui/deviceDetail/*.ts`, related layout tests.
- [ ] Replace `.plan-hero__meta-row` "Home mode" plain text with a real `md-assist-chip`. M3
      audit found the element is named like a chip (`.plan-hero__meta-row`) but renders with
      `bg: transparent`, no border, no radius — visually indistinguishable from body text. Apply
      the existing `.chip` styles or migrate to `md-assist-chip`. Markup change in
      `packages/settings-ui/src/ui/views/PlanHero.tsx`.
- [ ] Lift touch targets to M3 minimum (48 px). Audit found `md-tabs` 36 px, segmented buttons
      40 px, back-buttons 38 px, `md-checkbox` 20 px visible with no extended hit area. The
      WebView is finger-touch at 480 px wide. CSS-only via `--md-primary-tab-container-height`
      and `min-height` on custom controls; wrap `md-checkbox` rows in a 48 px-min `.toggle-row`
      surface so the row catches taps. Files: `packages/settings-ui/public/style.css`,
      `packages/settings-ui/public/index.html`.
- [ ] Refresh the PELS leaf icon to match the new eco palette. The current app icon and any
      in-UI leaf graphic should align with the leaf-green primary (`#16a34a`) rather than the
      previous emerald (`#10b981`). Out of scope for the redesigned settings UI; touches Homey
      app metadata. Files: `assets/icon.svg`, `.homeycompose/app.json`, any in-UI SVG leaf.

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
- [ ] Handle App Not Ready during PELS restart as a retry/loading state in the Settings UI rather
      than an error. Observed from `/ui_power` immediately after restarting the app: the UI
      currently surfaces the not-ready response as a hard error, which looks like a failure during
      the normal startup window. Detect the not-ready signal at the API boundary and degrade to a
      loading state with bounded retry/backoff until the runtime responds, instead of rendering an
      error toast or empty error card.
      Files: `packages/settings-ui/src/ui/**` API call sites for `/ui_power` and related routes,
      `lib/app/settingsUiApi.ts` not-ready response shape, settings UI loading/error tests.
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
      Update: keep-invariant gate now reads `hasExecutableShedDevices` from the executable plan
      so a dropped underspecified set_step shed no longer phantom-blocks unrelated stepped
      restores; dropped intents are also surfaced via the `stepped_load_shed_intent_dropped`
      structured debug event. The deeper refactor of removing observed current state from intents
      is still outstanding.
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
      Also surface the kWhPerUnit provenance the planner is using so users do not need to read
      logs or settings to understand EV learning state: whether the current plan is using the
      bootstrap estimate or the learned profile, the learned `kWhPerUnit` value, accepted sample
      count, confidence, and the last accepted sample timestamp. The active-plan recorder
      already carries `kwhPerUnitSource`; the rest comes from the EV learning store.
      Design: `notes/ev-ready-by/README.md`.
      Files: `packages/settings-ui/src/ui/deadlinePlan.ts`, `lib/app/appInit.ts`,
      `lib/plan/deferredObjectives/diagnosticsBridge.ts`, EV learning store, calibration view
      tests.
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
- [ ] Align user-visible Homey labels, Flow cards, and public docs with the redesigned Settings UI
      terminology.
      The settings UI mostly follows `notes/ui-terminology.md`, but Homey-facing labels and public
      docs still teach old wording and old navigation. Replace visible `headroom`, `soft limit`,
      `shed`, `controlled/uncontrolled`, `shortfall`, `Soft margin`, `Dry run`, `Cheap delta`, and
      `Expensive delta` with the approved vocabulary. Update docs to describe the current shell:
      `Overview`, `Budget`, `Usage`, `Smart tasks`, and `Settings`, with setup paths such as
      `Settings > Limits & safety`, `Settings > Devices`, `Settings > Electricity prices`, and
      `Settings > Simulation mode`.
      Files: `.homeycompose/capabilities/*.json`, `.homeycompose/flow/**/*.json`,
      `docs/configuration.md`, `docs/getting-started.md`, relevant generated `app.json` after
      `homey app validate`.
- [ ] Do a bounded first-impression copy polish pass on the redesigned Settings UI.
      This should stay small and user-visible: change `Mode: Home` to `Home mode`, explain the
      `Safe pace now` tooltip from `softLimitSource`, replace `Price-shaped plan` with
      `Cheaper-hour planning`, replace `Unmanaged usage reserve` with `Background usage reserve`,
      avoid `model` in daily-budget success toasts, and refine device-card limited/off wording
      such as `Paused by PELS` so it matches `notes/ui-terminology.md`. Do not rename internal
      identifiers, fixtures, or log strings.
      Files: `packages/settings-ui/public/index.html`,
      `packages/settings-ui/src/ui/views/PlanHero.tsx`,
      `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx`,
      `packages/settings-ui/src/ui/budgetRedesign.ts`,
      `packages/settings-ui/src/ui/budgetAdjustController.ts`,
      `packages/shared-domain/src/planTemperatureCardText.ts`,
      `packages/shared-domain/src/planSteppedCardText.ts`.
- [ ] Make the browser Homey stub reliable enough for future screenshot UI audits.
      Keep audit states at the Homey SDK boundary instead of injecting component props. Add missing
      route handlers for diagnostics, deferred-objective history, refresh/reset actions, and daily
      budget recompute. Add `deferredObjectiveActivePlans` to the shared unit mock bootstrap state,
      and add typed audit scenario fixtures around `SettingsUiBootstrap`, `SettingsUiPlanSnapshot`,
      `SettingsUiPowerPayload`, and `DailyBudgetUiPayload` so normal, pressure, over-budget,
      missing-price, empty-history, and dense-device states can be rendered repeatedly.
      Files: `packages/settings-ui/tests/e2e/fixtures/homey.stub.js`,
      `packages/settings-ui/test/helpers/homeyApiMock.ts`,
      `packages/contracts/src/settingsUiApi.ts`,
      settings UI mock and browser smoke tests.

## P2 Product, Observability, and Maintainability

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
      Files: `lib/price/priceCoordinator.ts`, `test/plan.test.ts`, plan throttle tests.
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
- [ ] Evaluate migrating shared PELS primitives to `@material/web` components.
      Once the consistency P0 above lands and every chip / card / button reads one primitive,
      decide whether the shared primitive should be replaced by `@material/web` components
      (`md-filled-button`, `md-elevated-card`, etc.) for standard Material semantics, or whether
      the custom primitive remains. Out of scope for v1.
      Files: `packages/settings-ui/src/ui/materialWeb.ts`,
      `packages/settings-ui/src/ui/views/materialWebJSX.tsx`,
      `packages/settings-ui/public/style.css`, focused visual/e2e coverage.
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
- [ ] Finish chart-test hardening from the first-impression UI audit. The colour-token subset is
      now P0 (see above); this P2 entry covers the remaining non-colour test surface: deterministic
      visual assertions for legend text matching rendered series, explicit axis/tooltip units,
      price-unit normalization, SVG bounds, and no deadline legend/axis overlap at 320 / 480 px.
      Files: `packages/settings-ui/src/ui/budgetRedesignChart.ts`,
      `packages/settings-ui/src/ui/dailyBudgetChartEcharts.ts`,
      `packages/settings-ui/src/ui/usageDayChartEcharts.ts`,
      `packages/settings-ui/src/ui/usageStatsChartsEcharts.ts`,
      `packages/settings-ui/src/ui/powerWeekChartEcharts.ts`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/tests/e2e/charts-layout.spec.ts`,
      screenshot/audit Playwright coverage.
- [ ] Promote the Price-aware devices value adjuster or replace it with a Material Web control.
      `PriceAwareDevicesView` currently owns a page-local `ValueAdjuster` for cheap-hour boost and
      expensive-hour reduction. If the +/- stepper UX remains the right product shape, promote it
      to one token-driven shared PELS primitive; otherwise use `md-filled-text-field` or another
      suitable Material Web component.
      Files: `packages/settings-ui/src/ui/views/PriceAwareDevicesView.tsx`,
      `packages/settings-ui/public/style.css`, shared settings UI component primitives.
- [ ] Add a reusable audit-state Playwright matrix for the redesigned Settings UI.
      Current screenshot specs are docs/capture oriented. Add an audit-only suite that renders the
      main surfaces and important states at 320px and 480px from the Homey SDK boundary, writes
      artifacts to ignored output by default, and only writes docs assets behind an explicit env
      var. Include normal, capacity pressure, hard-cap exceeded, device limited but still drawing,
      unavailable/inactive device, daily budget tight/over, missing/unreliable prices, empty
      history, dense devices, graph-heavy pages, and device-detail surfaces.
      Files: `packages/settings-ui/tests/e2e/**`,
      `packages/settings-ui/tests/e2e/fixtures/homey.stub.js`,
      ignored `output/` artifacts only.
- [ ] Make the browser Homey stub follow the injected SDK handoff more closely.
      After assigning `window.Homey`, call `window.onHomeyReady?.(Homey)` so full-browser audits
      exercise the same delivery path as Homey's injected settings SDK. Keep the existing global
      fallback covered for compatibility.
      Files: `packages/settings-ui/tests/e2e/fixtures/homey.stub.js`,
      settings UI boot tests.
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
- [ ] Bring the smart-task history detail view to full live-plan chart parity.
      The history detail page currently renders a summary card plus original/final planned-hour
      tables (`packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`). The live
      `DeadlinePlan` view shows a richer hour-by-hour chart with price tone, projected progress,
      and original-vs-current charge overlay. Reconciling the two would let users compare past
      runs apples-to-apples with the current plan instead of switching mental models.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      `packages/settings-ui/src/ui/deadlinePlan.ts` (synthesise a `DeadlinePlanPayload` from a
      history entry without depending on stale bootstrap prices/profile).
- [ ] Add PELS-side unit tests for EV kWhPerUnit learning. Cover: a plan with no learned profile
      uses the bootstrap estimate; an accepted SoC rise records a `kWhPerUnit` sample; subsequent
      plans switch from bootstrap to the learned estimate; and rejection reasons fire as expected
      for no-progress samples, duplicate samples, and SoC rises below the minimum-delta threshold.
      Files: EV learning store / sample acceptance code under
      `lib/plan/deferredObjectives/**` or `lib/core/**`, new EV learning tests under `test/`.
- [ ] Hide duplicate responsive tab controls from the accessibility tree. Playwright snapshots
      showed duplicate tab labels, indicating both the desktop and mobile navigation surfaces are
      exposed simultaneously rather than the inactive one being hidden via `aria-hidden` or
      removed from the DOM. Decide whether to render only the active surface or mark the inactive
      one as inert, and assert in an a11y test that each destination appears exactly once in the
      accessibility tree at 320px and 480px.
      Files: `packages/settings-ui/public/index.html`,
      `packages/settings-ui/public/style.css`, navigation shell code under
      `packages/settings-ui/src/ui/**`, a11y / e2e tests.
- [ ] Debounce or sequence plan rebuilds around budget/price-shaping toggle changes. Toggling daily
      budget or price-shaping briefly produced `objective_missing_price_horizon` plan reasons
      before recovering. The reason is correct in isolation, but the transient flash makes the
      planner look unhealthy to users watching a live UI during settings edits. Either debounce
      the rebuild until the dependent settings are coherent, or show an explicit "applying"
      loading state on the plan surface so the user sees a pending state instead of an odd
      reason. Confirm the recovery still happens within one rebuild cycle once settled.
      Files: `lib/plan/planService.ts`, `lib/app/planRebuildScheduler.ts`,
      settings UI plan view loading states, plan-reason regression tests.
- [ ] Clarify log severity and wording for expected planner states. Several normal outcomes look
      like failures in log review: `cannot_meet` on a deadline objective, `failed: false` fields
      where `false` is the success path, and expected EV learning sample rejections
      (`no_progress`, `duplicate`, `too_small_rise`). Choose log severities that match real
      operational impact (likely `info` or `debug` for expected states, reserve `warn`/`error`
      for actual control or data faults), and reshape wording so logs read as state transitions
      rather than failures. Keep field semantics stable; only adjust level and human-readable
      messages.
      Files: `lib/logging/**`, `lib/plan/deferredObjectives/**`, EV learning sample-rejection
      sites, log/wording regression tests.
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
- [ ] Quiet repeated `stale_device_observation_refresh` log entries that never resolve.
      The headroom-for-device fix (Unit 4) makes stale-but-stable devices contribute their
      configured load to headroom math, but the snapshot-refresh fallback in
      `appSnapshotHelpers.ts` still wakes every 60s, refreshes those devices, and emits the
      same `stale_device_observation_refresh` event with `freshAfterRefreshDevices: 0` whenever
      a Homey driver only republishes per-capability `lastUpdated` on value change. Add a
      backoff or one-shot per-device "still stale after refresh" log so the stream doesn't
      grow proportionally to uptime, and consider whether `'unknown'` (never observed)
      devices should also stop triggering the refresh loop after one attempt.
      Files: `lib/app/appSnapshotHelpers.ts`, `lib/observer/observationFreshness.ts`,
      snapshot-refresh tests.
- [ ] Mark stale-on devices `available=false` when Homey's own availability signal goes false.
      The headroom-for-device path now credits configured load for stale-on devices on the
      assumption that they are still in their last-seen state. A device that has been
      physically disconnected (long comm gap, removed from Z-Wave/Zigbee mesh) but still
      reports `currentOn=true` from a cached snapshot can over-credit headroom. Verify that
      Homey's `available` flag flips on real disconnects and that `isActivelyDrawing` /
      headroom-for-device correctly drop the contribution when `available === false`. If the
      `available` signal is unreliable, consider degrading stale-on credit to 0 after a
      second, longer threshold (e.g. 4 hours) where the device has had no observation
      whatsoever.
      Files: `lib/observer/observedPower.ts`, `lib/plan/planHeadroomDevice.ts`, related
      activation/headroom tests.

## P3 Future and Exploratory Work

- [ ] Revisit deadline-hero "Need X kWh" staleness if users find the original-vs-remaining
      framing confusing. The active-plan recorder no longer persists `energyNeededKWh` /
      `plannedKWh` decrements within an unchanged schedule (to avoid Homey settings churn on
      every plan cycle), so the Settings UI hero reads the original starting energy until the
      schedule, plan status, kWh-per-unit source, or objective changes. If the UX needs the
      live remaining kWh, route it through a non-persisted live snapshot (e.g. include the
      current diagnostic's `energyNeededKWh` in the UI bootstrap payload) rather than re-
      enabling per-cycle persistence.
      Files: `lib/plan/deferredObjectives/activePlanRecorder.ts`, `lib/app/settingsUiApi.ts`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`,
      `packages/settings-ui/src/ui/deadlinePlanResolvers.ts`.
- [ ] Distinguish "missed by an unknown amount" from "missed by exactly 0 kWh" on the
      `deadline_missed` flow trigger. The Homey SDK rejects `null` for `number`-typed tokens
      (see `homey-apps-sdk-v3/lib/FlowCardTrigger.js`), so `shortfall_kwh` currently falls back
      to `0` when the device-side delta is unknown. Today `shortfall_text` carries the
      qualitative fallback (empty string for unknown), but a dedicated `shortfall_known: boolean`
      token would let user flows gate numeric comparisons cleanly.
      Files: `flowCards/deadlineObjectiveCards.ts`, `.homeycompose/flow/triggers/deadline_missed.json`,
      flow-card tests.
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
- [ ] Add a scripted regression runner for the SHS test scenario. The manual runbook works but
      automation would make repeat runs safer and faster. Snapshot relevant settings before
      starting, drive the Settings UI / API checks the runbook covers, exercise the EV learning
      acceptance and rejection paths, collect logs and any UI artifacts, and restore the
      pre-run settings on completion regardless of pass/fail. Keep the runner out of the
      pre-commit CI path; treat it as an on-demand validation tool for release prep.
      Files: new top-level `scripts/` runner, supporting fixtures, possibly Playwright helpers.
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
- [ ] Once Unit 4's tri-state observer freshness signal lands, replace the
      `binaryControlObservation`-based projection in
      `lib/executor/executablePlanProjection.ts:resolveObservedBinaryStateFromSnapshot`
      with the observer-resolved discriminator. The current projection re-derives
      "trusted binary observation" from raw snapshot fields, which duplicates
      what the observer freshness layer should own.
      Files: `lib/executor/executablePlanProjection.ts`, `lib/executor/executablePlan.ts`,
      `lib/executor/planExecutionDrift.ts`.
