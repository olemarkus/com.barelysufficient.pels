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
      `--pels-text-headline-*`; section `h2` rules (`.settings-home-hero h2`, `.card h2`,
      `.device-detail-heading h2`) use `--pels-text-section-headline-*` 24/400, with
      `.usage-hero__stat-value` also bound to section-headline 24/400 and compressed to
      `--pels-text-title-*` 16 px at `<380 px` so three stats still fit the row (the spec's
      display-small 36 px was rejected — three 36 px values cannot fit the 3-column stat grid
      at 320 px). `.section-title`, `.deadlines-history__heading`, and
      `.settings-current-mode__summary h3` use `--pels-text-title-*` 16/500. `.eyebrow` moved
      from semibold to medium per the M3 label-small weight and now binds `line-height` to
      `--font-line-height-tight`. Role utility classes `.text-hero-number / -page-headline /
      -section-headline / -title / -section-label / -body / -caption` published in `style.css`
      as the documented entry points for new surfaces; `.text-body` and `.text-caption` bind to
      the corresponding `--pels-text-*` role tokens. Screenshot baselines refreshed in a
      follow-up PR.)*
- [x] CSS-side migration: apply existing surface tier tokens per M3 nesting. *(landed —
      `.slide-panel` raised to `--pels-surface-container-high`, `.banner` uses
      `--pels-surface-container-highest`, `.plan-card` is now a flat `--color-surface-1`,
      `[data-state-kind="resuming"]` binds to `--pels-status-good-surface`, and
      `[data-state-kind="unknown"]` gets a 0.6 opacity dim. Screenshot baselines refreshed in
      a follow-up PR.)*
- [x] Demote accent, promote good. *(landed — `pels.status.good` token now resolves to
      `color.role.good` (teal #5eead4); accent (`#22c55e` brighter leaf) stays on selected-tab,
      focus ring, primary buttons, switch/checkbox. Positive-state surfaces, meter tone, ripple
      hover, chart `--pels-chart-plan`, and resuming plan-card all cascade automatically.)*
- [x] Replace `.active-badge` with a proper M3 chip primitive. *(landed — the
      per-mode "Active" indicator now renders as `md-assist-chip` with tonal-teal
      custom-property overrides (`--color-base-good-default` text on
      `color-mix(... 15%, transparent)` background, M3 default 9999 px radius). Chip
      is `aria-hidden` + `tabindex="-1"` because it is a non-interactive status
      pill — the same information is already conveyed by the row representing the
      user's active mode. `md-assist-chip` is now registered in `materialWeb.ts`.)*
- [x] Align every chart series, heatmap cell, and tooltip with the same flat tokens the rest of
      the UI uses. *(landed — `resolveCssColor` in `budgetRedesignChart.ts`,
      `usageDayChartEcharts.ts`, `usageStatsChartsEcharts.ts`, and `powerWeekChartEcharts.ts`
      dropped its hex-fallback signature; all chart palette reads now resolve through CSS vars
      only. `grep -E "#[0-9a-f]{3,6}"` in `packages/settings-ui/src/ui/*Chart*.ts` returns
      zero. Heatmap low/high series in `powerWeekChartEcharts.ts` rebound to
      `--color-role-info` / `--color-role-danger`. Cross-surface hue parity vs. Overview chips
      is now reflected in the refreshed Playwright baselines.)*
- [x] Revise smart task flow cards: single trigger per lifecycle event, stable-id tokens.
      *(landed in two steps — PR #798 dropped the `outcome` / `status` dropdown args and
      introduced stable-id token values. A follow-up then trimmed the bag to the minimum
      that matches other Homey apps' conventions (Easee, Home Connect, Power by the Hour):
      `deadline_ended` → `device_name` + `outcome` + `shortfall`; `deadline_status_changed`
      → `device_name` + `status`; `deadline_plan_changed` → `device_name` +
      `remaining_kwh` + `planned_hours` + `projected_finish_local_time`. Token values for
      `outcome` and `status` are the stable lowercase ids (`succeeded`/`missed`/`abandoned`
      and `waiting`/`on_track`/`at_risk`/`unachievable`/`satisfied`); display formatting
      and composed notification text are user-side concerns. Diagnostic introspection
      tokens — `risk_reason`, planned start/finish, `required_kwh`, `planning_speed_kw`,
      `estimated_duration_text`, `kind`, `change_reason_id` — were not Homey-conventional
      on triggers; if future demand surfaces, expose them as device capabilities, not
      tokens. Shared bag lives in `flowCards/smartTaskTokens.ts`.)*
- [x] Hide the tab strip while a smart-task plan-detail page is open. *(landed — added
      `#shell-nav.hidden { display: none; }` next to the existing `.panel.hidden` rule in
      `packages/settings-ui/public/style.css`; regenerated `settings/style.css`. The router
      already toggles the `hidden` class via `deadlinePlanRouter.ts:14`; the missing CSS binding
      is what kept the tab strip painted underneath the plan overlay at 320 / 480 px.)*
- [x] Drive the deadline-plan hero `data-tone` from the resolved plan status. *(landed — the
      producer `deadlinePlan.ts` now resolves `latest.planStatus → tone` via the new
      `resolveHeroTone` helper in `deadlinePlanHero.ts`, surfaces the resolved tone on
      `payload.hero.tone`, and `views/DeadlinePlan.tsx` binds `data-tone={payload.hero.tone}`
      instead of the previous string literal. Mapping: `cannot_meet → alert`, `at_risk → warn`,
      `on_track`/`satisfied → good`, `invalid → info`. All four target the existing CSS rim
      bindings at `style.css` 1287-1325. Unit tests cover the mapping in
      `test/deadlinePlan.test.ts`.)*
- [x] Suppress the liveState chip when the plan cannot finish. *(landed — gated at the caller
      in `buildHeroChips` (`deadlinePlanHero.ts`) so the resolver stays a single-purpose helper
      shared with the smart-task list and device card. When `cannotMeet === true`, the hero
      now renders chips `[kind, cannotMeet, ?confidence]` only; the live-state chip is
      omitted. Canonical order preserved; unit tests assert the suppression and the
      `[kind, cannotMeet, confidence]` sequence in `test/deadlinePlan.test.ts`.)*
- [x] Fix chart clarity issues from the first-impression Settings UI audit.
      Tighten the graphs users are most likely to inspect on first load. Normalize deadline-plan
      price values and units against the Budget chart convention (`kr/kWh` or `øre/kWh` shown
      explicitly), make the Budget hourly-plan legend match the rendered `Managed` / `Background`
      split series, and resize/reinitialize Usage ECharts when a hidden panel becomes visible so
      SVGs cannot keep a too-wide fallback size after tab navigation. A chart whose legend lies
      about its colours, or that renders the wrong width after a tab switch, is exactly the
      first-impression problem the rubric scopes into P0. (Refactor sub-item — moving chart
      lifecycle ownership from module-level state to the rendering view — was split out of this
      P0 in the release-review pass; track it as P2 below if useful.)
      Shipped across `9026cb4c` (chart-clarity review findings + `powerWeekChartEcharts`
      tab-shown wiring), `37ea7604` (deadline-plan price normalization + Usage/Budget
      `attachTabShownResize` + legend swatch rebinding), `c1ea3dc2` (E2E colour-parser
      normalization), and PR #812 (deadline-plan price axis label precision aligned with the
      Budget chart's `toFixed(1)`). Acceptance verified by `charts-layout.spec.ts` tests:
      `'budget legend swatches match rendered series fills'`, `'usage charts have non-zero
      size on first tab activation'`, `'budget chart SVG matches container width after tab
      switch'`, and `'deadline-plan horizon chart labels the price axis with a unit'`
      (12 passes across chromium-mobile + firefox-mobile).
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`,
      `packages/settings-ui/src/ui/views/BudgetOverview.tsx`,
      `packages/settings-ui/src/ui/budgetRedesignChart.ts`,
      `packages/settings-ui/src/ui/usageDayChartEcharts.ts`,
      `packages/settings-ui/src/ui/usageStatsChartsEcharts.ts`,
      `packages/settings-ui/tests/e2e/charts-layout.spec.ts`.
- [x] Plan-history recorder dropping `startProgressC` and `observedIntervals` on recent runs.
      Live-Homey walk on 2026-05-16 (`notes/smart-task-ui/README.md`) found that the four most
      recent past entries for Connected 300 render as device-only rows (no progress line, no
      coverage note) while older entries (Wed 13 May and earlier) have both populated. The
      `formatPlanHistoryProgressLine` helper returns `null` when `startProgressC` is null, so
      the visible regression is "row gives the user nothing to chew on" on the most
      consequential rows. The history-detail Missed page also renders a chart titled
      `Plan vs observed` with zero observations rendered, because `observedIntervals` is empty
      for the same entries. Either path is a recorder regression: the in-progress record should
      stamp `startProgressC` at creation and accumulate `observedIntervals` over the run.
      Why P0: data-integrity regression that misleads the failure-investigation page (chart
      title promises observations the data can't show). Promoted from P1 in the release-review
      pass (see `notes/smart-task-ui/README.md`).
      Acceptance: a Jest test that mocks the diagnostic stream from in-progress through
      finalize and asserts the persisted entry has non-null `startProgressC` and
      `observedIntervals.length > 0`. Add the same for `startProgressPercent` on the EV path.
      Files: `lib/plan/deferredObjectives/planHistory.ts`,
      `lib/plan/deferredObjectives/activePlanRecorder.ts`,
      plan-history recorder tests.
      Fixed: `planHistory.ts` `mergeRecord` / `clearSatisfiedWithProgress` /
      `recordObservedTick` now back-fill `startProgressC` / `startProgressPercent`
      from the first non-null observation via a new `backfillStartProgress` helper.
      `observedIntervals` accumulation was already wired via `extendIntervals` on
      every plannable and non-plannable tick. Regression coverage added in
      `test/deferredObjectivePlanHistory.test.ts` under
      "back-fills start progress from the first non-null observation".
- [x] Make Settings UI device-setting writes fail closed when a fresh settings read is missing or
      invalid. Avoid falling back to `{}` or caller-provided defaults and writing a partial object
      back as if it were the current state.
      Why P0 (promoted from P1 in release-review pass): fallback writes can erase or overwrite
      unrelated settings when the UI starts from an incomplete read. Settings writes that can
      corrupt persisted state is an explicit P0 category per the rubric.
      Files: `packages/settings-ui/src/ui/deviceDetail/settingsWrite.ts`,
      `packages/settings-ui/src/ui/deviceDetail/index.ts`,
      `packages/settings-ui/src/ui/deviceDetail/shedBehavior.ts`.
- [x] Fix redesigned top navigation at 320px. *(landed — at ≤360 px the shell tab labels now
      wrap onto two lines instead of ellipsis-truncating: removed `overflow:hidden` /
      `text-overflow:ellipsis` on `.tab`, set `--md-primary-tab-container-height: auto`, and
      held the touch target at ≥48 px via `min-height: var(--pels-touch-target-min)`. The
      five-destination shell now renders all labels in full on a 320 px Homey WebView. The
      existing 320 px Playwright assertion was tightened to also verify
      `scrollWidth ≤ clientWidth` so future label changes can't reintroduce silent ellipsis
      clipping.)*
- [x] Fix the "This month" usage stat truncation at 480 px. *(landed — the
      `.usage-hero__stat-value` responsive font block moved from `@media (max-width: 380px)`
      to `@media (max-width: 480px)` so the 24 px → 16 px drop fires at the Homey dialog's
      actual width. Confirmed at 480 px: a synthesised "1642.1 kWh" value now fits its 124 px
      column with scrollWidth = clientWidth.)*
- [x] Stop clipping the "New mode name" placeholder and per-device mode-temp inputs at narrow
      widths. *(landed — `#modes-panel .inline-actions` now uses a three-column grid with the
      text field forced to a full-row span (`grid-column: 1 / -1`), so the Add/Delete/Rename
      buttons share the row below and the placeholder always renders in full. The mode-row
      temperature column was widened from `minmax(80px, 96px)` to `minmax(96px, 112px)` so a
      two-digit value plus the Material number-field spinner fits without clipping the second
      digit. Verified at 480 px: the input is 412 px wide and the per-mode temp readouts
      ("21", "20") render with their spinners.)*
- [x] Overview at 320 px clips heavily; "About this card" button vanishes and falls below the
      48 px touch target. *(landed — `.plan-hero__info-button` now uses
      `--md-icon-button-state-layer-{height,width}: var(--pels-touch-target-min)` so the
      touch target is the project-floor 48 px instead of the previous 36 px. Confirmed at
      320 px: button measures 48 × 48 px at x=237, fully on-screen, and no element on the
      Overview panel exceeds the 305 px usable client width.)*
- [x] Disambiguate the stepped-indicator unit on Overview device cards and fix the 320 px clip.
      *(landed — new `formatStepDisplayLabel` helper in `packages/shared-domain/src/planSteppedCardText.ts`
      recognises stored ampere step ids (`/^([0-9]+)a$/i`) and renders them as `"N A"` per
      SI convention. Applied to the step-rail label, `resolveSteppedStateLabel`, the
      `findStepLabel` helper used by transit/shed status lines, and the `shedInvariant`
      "Limited to …" status line. The persisted stepId (`6a`, `8a`, `32a`) stays unchanged so
      log schemas and plan signatures aren't affected. At 320 px the step rail also hides
      intermediate labels via `.plan-card__step-label:not(:first-child):not(:last-child) { display: none }`
      so the endpoint labels ("6 A" / "32 A") stay on-card — the active-step dot still
      anchors the user on the rail. New unit tests in
      `packages/settings-ui/test/planSteppedCardText.test.ts` cover the ampere mapping and
      the non-ampere fallback. E2E fixture updated to expose `steppedLoad.profile` so the
      Playwright suite can verify the rail at both widths.)*
- [x] Fix word-wrap on Budget segmented controls at 480 px. *(landed — `.segmented .segmented__option`
      switched from `overflow-wrap: anywhere` to `overflow-wrap: break-word; word-break: normal`
      and gained `min-width: 96px` so "Conservative" stays on a single line at 480 px. The
      narrow-viewport override `.segmented .segmented__option { min-width: 0 }` at
      `@media (max-width: 360px)` keeps the 3-option "Low / Medium / High" control from
      pushing past the viewport at 320 px. The `.budget-setting-row--stacked` modifier was
      also moved after the base `.budget-setting-row` declaration so its single-column
      grid template actually wins the cascade (the prior source order meant the base
      two-column template overrode the stacked variant and squeezed "Conservative" into a
      mid-word break). The `#device-detail-panel .segmented__option` override picked up
      the same `break-word` change.)*
- [x] Stop hardcoding "Observed charging" on thermostat history runs.
      `DeadlinePlanHistoryDetail.tsx` hardcodes the "Observed charging" tooltip label; for
      thermostat history runs it should read "Observed heating" (or the kind-aware label the
      active chart already pulls from `deadlineLabels(kind).actualDeviceSeriesName`). The
      planner-noun "Original plan" / "Final plan" rename half of the original entry stays at
      P1 — that is a copy sweep, not a wrong-content bug.
      Why P0 (promoted from P1 in release-review pass, narrowed scope): wrong noun on
      user-visible text — thermostat history shows "Observed charging" which is factually
      wrong for the device.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      `packages/shared-domain/src/deadlineLabels.ts`.
- [x] Usage "Daily usage" chart shows April dates while the rest of the tab shows
      May 16, 2026. *(landed — `getPowerStats` in
      `packages/settings-ui/src/ui/power.ts` now always merges `tracker.dailyTotals`
      (long-term storage of days that have aged out of the 30-day hourly window)
      with bucket-derived recent days, so the chart, the weekday/weekend averages
      and the hero pace stats reflect the latest 14 days ending today instead of
      the 14 days that sat right before the 30-day cliff. The pre-fix bug came
      from `aggregateAndPruneHistory` only moving >30-day-old buckets into
      `dailyTotals`; recent days lived exclusively in `tracker.buckets` and were
      never visible to the chart. `getWeekMonthTotals` was simplified to read
      from the merged map only — the old `sumBucketTotalsBeforeToday` path would
      have double-counted recent days after the merge. `getWeekdayWeekendAverages`
      now drops `todayKey` so partial in-progress days never drag the average
      down. Regression test in `packages/settings-ui/test/power-ui.test.ts`
      mocks the clock to 2026-05-16, seeds 14 stale `dailyTotals` ending 15 Apr
      AND 30 days of recent hourly buckets, and asserts the chart window is
      `2026-05-15` down to `2026-05-02` with no April dates leaking through.)*

- [x] Smart task history chart Y-axis labels clipped (leading digit cut off). *(landed in PR #821 — `DeadlinePlanHistoryDetail.tsx` chart grid uses ECharts `containLabel: true` so the full `1.2 / 0.9 / 0.6 / 0.3 kWh` labels fit; chart container height bumped 220→240 px; legend.width: 100% added so long localized labels wrap cleanly — incidentally closes the P1 chart-legend truncation cluster.)*
      Live-walk 2026-05-16 (`/tmp/pels-live-walk/04-smart-task-history-succeeded-480.png`,
      `y-axis-clip-evidence.png`) shows the per-row Y-axis labels rendering as `.2 kWh`,
      `.9 kWh`, `.6 kWh`, `.3 kWh` instead of `1.2 / 0.9 / 0.6 / 0.3 kWh` on every smart-task
      history detail page. The leading digit is hidden under the chart container's left edge.
      Why P0: first-impression visual coherence break on a feature-card chart; reproduces on
      every history-detail row, not edge-case. Likely root cause is left-margin / padding
      miscalculation on the chart container. Same fix likely also addresses the cluster of
      legend-truncation P1 entries below (Background usa…, Original Heatin…, Measured Heati…,
      Original pla…) — chart shell and legend behavior should be reviewed as a single primitive.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`, smart-task
      chart shell (echarts grid.left / padding), CSS selectors driving chart container width.

- [x] PELS segmented control inactive / hover / disabled styling loses specificity *(landed in PR #821 — extended the duplicate-attribute trick already used on the selected state to inactive, hover, and disabled; PELS now wins the (0,3,1) cascade tie against Homey's `_base.css` button rule.)*
      battle against Homey's host stylesheet — inactive segments render cream `#e7e7e7`
      with dark `#555` text in EVERY Homey theme (light or dark). Live walk 2026-05-16
      confirmed root cause in `/tmp/pels-rewalk/budget/inspect-segmented.json`.

      Homey's `_base.css` ships
      ```css
      button:not(.hy-nostyle):not([class*='homey-button']):not([class*='hy-button']) {
        background-color: #e7e7e7; color: #555; padding: 6px 16px; border-radius: 3px; …
      }
      ```
      Specificity **(0, 3, 1)**. PELS's `.segmented .segmented__option` rule at
      `packages/settings-ui/public/style.css:3618` is specificity **(0, 2, 0)** and loses.
      PELS's *selected* selector at lines 3651–3654 uses the duplicate-attribute trick
      (`[aria-checked="true"][aria-checked]`) to reach (0, 4, 0) and wins — that is
      why the active pill is correctly themed but the inactive pill is not. Hover
      (line 3672) and disabled (line 3667) have the same bug.

      The CSS comment at `style.css:3609-3617` already acknowledges Homey's `_base.css`
      and applied the duplicate-attribute fix to the selected state only — extend the
      pattern to inactive, hover, and disabled states too.

      Why P0: first-impression visual coherence break that hits every user on every
      Homey theme; affordance reads inverted on `Plan / Adjust`, day segmented,
      `Progress / Hourly plan`, and any other segmented control on the redesigned UI.
      Not a Homey-dark-mode artifact — easily reproducible in Homey light theme too.

      Fix candidates (smallest first):
      1. Change the base selector to `.segmented button.segmented__option` — raises
         specificity to (0, 3, 1) and beats Homey's button rule.
      2. Apply the same duplicate-class trick used on selected
         (`.segmented .segmented__option.segmented__option` → (0, 3, 0)) — slightly
         less specific than option 1.
      3. Or move the styling to a more specific scoped selector that always wins.

      Verify the fix in both Homey light theme (segments are cream today) and Homey
      dark theme (segments are inverted to white through the filter) via PR #817's
      `PELS_E2E_SIMULATE_HOMEY=dark` simulator. Touch every state: inactive, hover,
      `:focus-visible`, disabled.

      Files: `packages/settings-ui/public/style.css` (lines 3618, 3667, 3672 + the
      comment block at 3609-3617 explaining the pattern), `settings/style.css` (regen).
      Evidence: `/tmp/pels-rewalk/budget/inspect-segmented.json` and
      `/tmp/pels-rewalk/budget/zoom-segmented-view.png`.

- [x] Settings → Modes priority list truncates device names. *(landed in PR #821 — `#modes-panel .mode-row .device-row__name { white-space: normal; overflow-wrap: anywhere; }` lets long Norwegian device names wrap to 2 lines instead of clipping.)* Live-walk 2026-05-16
      (`/tmp/pels-live-walk/05-settings-modes-480-hovedsoverom-crop.png`) shows
      "Termostat hovedsoverom" rendering as "hovedsoveron" — the final `m` is clipped by the
      adjacent number-input + #priority chip cluster at the supported 480 px width.
      Why P0: settings UI hiding part of a label the user is being asked to compare against
      priority numbers; user is selecting per-mode targets for a device whose name they
      cannot read in full.
      Acceptance: every Norwegian device name in the priority list renders completely at
      480 px (or wraps cleanly) without ellipsis or cut characters. Fix candidates: shrink
      the number-input/chip cluster, allow the name column to wrap, or move the
      input/chip to a second line on narrow widths.
      Files: `packages/settings-ui/public/style.css` (modes priority row grid),
      `packages/settings-ui/src/ui/views/...` (modes panel markup), `settings/style.css`
      (regen).

- [x] Extend the Homey-wrap fixture with Homey's host CSS so PELS-vs-Homey CSS *(landed in PR #821 — `_base.css`, `_homey-button.css`, `homey.css` added to fixture; `static-server.mjs` injects them into the PELS iframe document in the real Homey load order under `PELS_E2E_SIMULATE_HOMEY=light|dark`.)*
      cascade bugs reproduce locally. PR #817 captured Homey's iframe-level CSS and
      the dark-mode filter — but missed the host stylesheets Homey injects into the
      iframe document itself (`_base.css`, `_homey-button.css`, `homey.css`). Those
      are the ones that just broke our segmented-control styling for every user
      (cream `#e7e7e7` inactive segments, the P0 above) by beating PELS's lower-
      specificity rules. Without them in the fixture, the fix for that P0 can't be
      verified locally and any future PELS rule that competes with a Homey selector
      will only surface after deployment.

      Captured copies of all three stylesheets exist at
      `/tmp/pels-rewalk/budget/_base-css.txt`,
      `/tmp/pels-rewalk/budget/homey-button-css.txt`,
      `/tmp/pels-rewalk/budget/homey-css.txt` (from the 2026-05-16 Budget rewalk).
      Move those into `packages/settings-ui/test/fixtures/homey-wrap/` and update
      `packages/settings-ui/scripts/static-server.mjs` so the
      `PELS_E2E_SIMULATE_HOMEY=light|dark` mode injects them into the PELS iframe
      document (not just the parent page) before PELS's own stylesheets — matching
      the real Homey load order.

      Why P0: gates the segmented-control specificity fix above (no way to test it
      locally otherwise), and unblocks every future styling change from hitting
      "looked fine locally, broke under Homey" surprises. The fixture is already a
      P0 enabler — it just isn't complete.

      Acceptance: with the fixture extended, running
      `PELS_E2E_SIMULATE_HOMEY=light node packages/settings-ui/scripts/static-server.mjs --port <N>`
      and opening Budget reproduces the cream `#e7e7e7` inactive segmented buttons
      identical to the live screenshot at `/tmp/pels-rewalk/budget/01-budget-plan-480-full.png`.
      A Playwright snapshot test that fails today and passes after the segmented
      specificity fix is the natural regression gate.

      Files: `packages/settings-ui/test/fixtures/homey-wrap/` (add the three CSS
      files), `packages/settings-ui/scripts/static-server.mjs` (inject into iframe
      document not just parent), optionally a new Playwright spec in
      `packages/settings-ui/tests/e2e/` that asserts inactive segments don't render
      `#e7e7e7` under the simulator.

## P1 Correctness, Data Integrity, and Supported UX

*v2.7.1 release-review findings (2026-05-17). Six items below from the
six-agent fan-out pass on `v2.7.0..HEAD`; safe for the next patch
release, not v2.7.1 merge-blockers.*

- [ ] Norgespris historical display uses live monthly cap snapshot, not
      snapshot-at-the-time. `priceServiceNorway.ts` initialises
      `remainingNorgesprisCapByMonth` from `monthlyCap − monthUsageKwh` at
      fetch time, then renders historical hours' `eligibleShare` against
      that live snapshot. Late in the month a user with `monthUsageKwh`
      near the cap will see every past hour rendered at reduced
      Norgespris eligibility, even hours that actually occurred when the
      cap was untouched. Decision-side is unaffected — the forward cap
      gating remains correct (commit `7c6c4363`).
      Why P1: misleading historical price display; not a decisioning bug.
      Fix candidates: (a) force `eligibleShare = 1` unconditionally for
      historical hours; (b) persist per-hour eligibility snapshots.
      Prefer (a) — simpler and matches "the model was either active or
      not" framing.
      Files: `lib/price/priceServiceNorway.ts:223-233`.
      Source: `adversarial-review` skill, v2.7.1 release-review pass.

- [ ] `closeSteppedLoadDraft()` clears the entire per-device draft map.
      The per-device map shipped in TODO 740 to isolate in-progress edits
      across devices, but the close handler still wipes all entries.
      Switching device-detail panes drops unsaved edits on every other
      device.
      Why P1: not a regression (pre-change used a single global), but the
      new per-device keying advertises an isolation guarantee that the
      close handler erases.
      Acceptance: only the closed device's entry is removed; switching
      panes preserves drafts on devices the user hasn't closed.
      Files: `packages/settings-ui/src/ui/deviceDetail/steppedLoadDraft.ts:248-251`.
      Source: `adversarial-review` skill, v2.7.1 release-review pass.

- [ ] `dailyBudgetAllocationWarning.ts` double-violates terminology rules.
      Title `"Daily budget is larger than your hourly limit allows"` and
      the two-branch body strings are inlined in settings-ui (Rule 4 —
      shared-domain origin so runtime logs match user-visible text) AND
      use "hourly power limit" / "hourly limit" as a threshold label
      (Rule 6 — `notes/ui-terminology.md § "Safe pace, hard cap, and
      safety margin"` forbids this; the physical breaker/tariff ceiling
      is `hard cap`).
      Why P1: violates two canonical terminology rules in a banner that
      reaches every user whose budget shape mismatches their tariff.
      Acceptance: strings move to `packages/shared-domain/**` (e.g.
      `dailyBudgetWarningStrings.ts`); copy reframes to "Daily budget
      exceeds what your hard cap can deliver" / "…more than your hard
      cap can deliver in a day."
      Files: `packages/settings-ui/src/ui/dailyBudgetAllocationWarning.ts`,
      new `packages/shared-domain/src/dailyBudgetWarningStrings.ts`,
      `notes/ui-terminology.md`.
      Source: `pels-copy-and-terminology` agent, v2.7.1 release-review pass.

- [ ] PlanHero tooltip copy hardcoded in the view. `INFO_TOOLTIP_TEXT`,
      `SAFE_PACE_TOOLTIP_BY_SOURCE`, `HARD_CAP_TOOLTIP` live inline at
      `PlanHero.tsx:47-62`, but `notes/ui-terminology.md § "Safe pace
      now"` defines these as canonical strings. Runtime logging must
      emit the same wording (Rule 7), which requires a shared home.
      Why P1: copy renders correctly; the issue is shared-domain origin
      so logs and UI cannot drift.
      Acceptance: tooltip strings exported from
      `packages/shared-domain/src/planHeroSummary.ts` (or a sibling);
      `PlanHero.tsx` imports them with no inline literals.
      Files: `packages/settings-ui/src/ui/views/PlanHero.tsx:47-62`,
      `packages/shared-domain/src/planHeroSummary.ts`.
      Source: `pels-copy-and-terminology` agent, v2.7.1 release-review pass.

- [ ] Pending smart-task hero is missing `headlineReason` + `recourse`.
      `DeadlinePlan.tsx:792` `PendingHero` only exposes
      `headline / subline / metaLine`. The ready hero adds
      `headlineReason` and `recourse`, both of which answer the page
      mission ("when and at what price, and why those hours?"). A task
      that lands pending for hours (no prices yet / pre-window) leaves
      the user with no "why" line and no recourse — every newly-created
      smart task lands on this hero first.
      Why P1 (not P0): same shape already shipped in v2.7.0; this is a
      first-impression gap, not a regression introduced by v2.7.1.
      `pels-ux-fit` graded P0; downgraded because the rubric reserves P0
      for introduced bugs or exposed half-implemented features.
      Acceptance: pending hero mirrors `headlineReason` (at minimum) and
      `recourse` when available. Wording stays plain ("prices land at
      14:00", "task starts at 02:00", etc.).
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx:792`,
      `packages/shared-domain/src/deadlineLabels.ts` (pending reason
      copy).
      Source: `pels-ux-fit` agent, v2.7.1 release-review pass.

*Pro Homey runtime-log audit (2026-05-17, log
`/tmp/pels/start.main.0a4464c3.stdout.log`, 2h40m window).*

- [ ] Profile recovery armed on a thermostat that cannot reach
      `recoveryTargetValue` locks learning out for up to 24h.
      `lib/core/objectiveProfileRecovery.ts:67-106` disarms only when
      `sample.value ≥ recoveryTargetValue` (recovered) or after
      `RECOVERY_SAFETY_TIMEOUT_MS = 24h` (timed out). A capacity-shed
      heater (cap-on) that cools below its previously-armed target will
      stay in `reject_recovering` indefinitely — every sample rejected,
      no stat update, no band update, no kwh-per-unit refinement —
      because the device is *cooling away* from the target, not warming
      toward it. In this audit window `Connected 300` (water heater
      with an active 65 °C / 16:00 smart task) was held off the full
      session and emitted 4× `reject_recovering` with
      `recoveryTargetValue:60.1`, sample drifting 45.3 → 44.7 °C.
      `Nordic S4 REL` showed the same pattern (armed 19.8 °C, sample
      13.8 → 15.1 °C, 6× rejected). When this happens, the smart-task
      planner keeps consuming the *stale* learned rate
      (`kWhPerDegreeC` from before the lockout) and reports
      `rateConfidence:"low"` forever even when fresh samples are
      available. Worst case: the only thermostats users routinely place
      under smart-task control are also the ones most likely to trigger
      this lockout, because the smart task itself is what's shedding
      them.
      Why P1: data-integrity / planner-input bug; visible user impact
      is "smart task says cannot finish and never improves". Not a
      release blocker by itself (current behavior is degraded, not
      destructive), but should ship in the next patch.
      Acceptance: add a forward-progress check to `resolveArmedRecovery`
      so a device that has been armed for ≥ N minutes with zero net
      forward progress disarms cleanly (treat as "we lost the refill
      assumption; resume baseline learning") instead of waiting 24h.
      Cross-check that the disarm clears `recoveryTargetValue` /
      `recoveryArmedAtMs` and preserves `samples` / `bands` per
      `notes/objective-profile-bands.md`.
      Files: `lib/core/objectiveProfileRecovery.ts`,
      `lib/core/objectiveProfiles.ts` (recovery dispatch),
      `notes/objective-profile-bands.md` (update the "Interaction with
      #775 recovery window" section), recovery tests.
      Source: Pro Homey runtime-log audit 2026-05-17.

- [x] Homey dark theme inverts the PELS iframe via `filter: invert(1) hue-rotate(180deg)`.
      *(landed: the prior CSS-only counter-filter — which proxied Homey theme via
      `prefers-color-scheme` and broke whenever OS and Homey themes disagreed — is
      retired. PELS now ships as a **light-canvas app on desktop** and lets Homey's
      own invert produce the dark skin in Homey dark mode (the design pattern every
      other Homey app uses). Mobile keeps today's designer-tuned dark palette
      unchanged. The gate is `@media (hover: hover) and (pointer: fine)`, a hardware
      probe that matches Homey's actual behaviour: mobile Homey never applies the
      iframe filter, desktop Homey always applies it in dark mode. All four OS/Homey
      combinations now render correct semantics. See
      `notes/desktop-light-mobile-dark.md` for the empirical probe (no in-iframe
      signal exists for Homey's parent theme — verified across cross-origin
      sandbox, canvas readback, Homey SDK surface, and parent postMessage stream)
      and the palette decisions.)*

- [x] Smart-task chart legend labels truncate to ellipsis across multiple views. *(landed in PR #821 — fixed alongside the P0 chart Y-axis bug via `legend.width: '100%'` + grid-top 28→44 px on the smart-task chart shell.)*
      Live-walk 2026-05-16:
      - Active detail (`/tmp/pels-live-walk/04-smart-task-active-detail-480.png`):
        "Background usa…" and "Original Heatin…" truncated at 480 px.
      - History detail (`/tmp/pels-live-walk/04-smart-task-history-succeeded-480.png`):
        "Original pla…" truncated.
      - 320 px active detail (`/tmp/pels-live-walk/04-smart-task-active-320.png`):
        "Measured Heati…" right-edge collides with chart's "1.7" Y-axis label — legend
        overlaps the plot, not just truncates.
      Why P1: legend lies about what the colors represent and on 320 px overlaps live
      chart data. Same cluster as the P0 Y-axis clip — likely one chart-shell + legend
      width primitive fix covers all. Acceptance: every legend entry fully readable at
      both 480 and 320 px on smart-task active and history details; no overlap.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      smart-task chart shell (echarts legend wrap config), `packages/settings-ui/public/style.css`.

- [x] Smart tasks list: "Cannot finish" active task renders deadline in success-green. *(landed in `50bd8d7c`: `resolveSmartTaskListReadyByTone` mirrors the chip tone so cannot-meet cards no longer paint the Ready-by row success-green.)*
      Live-walk 2026-05-16 (`/tmp/pels-live-walk/smart-tasks-top.png`): an active task
      card shows status pill "Cannot finish" but "Ready by Sat 16 May, 16:00" is
      rendered in the success-green color used elsewhere for healthy on-track tasks.
      Why P1: color semantically contradicts the status pill — user reads a red/amber
      pill and a green deadline at the same time. Either drop the deadline line for
      `cannot_meet` plans, or render it in the same alert/warn tone as the pill (per
      the `resolveHeroTone` mapping shipped in PR #812).
      Files: `packages/settings-ui/src/ui/views/SmartTasksList.tsx` (or equivalent),
      `packages/settings-ui/public/style.css`.

- [x] Smart task copy: "Short by about 41.9 °C" misleading on tank heat target. *(landed in `50bd8d7c`: `cannotMeetShortfall()` drops the raw progress-unit delta; the magnitude is moved to the Needs N kWh meta line.)*
      Live-walk 2026-05-16 (`/tmp/pels-live-walk/04-smart-task-active-detail-480.png`)
      shows the cannot-finish active detail body copy reading literally "Short by about
      41.9 °C". Users will read this as a wild temperature anomaly. The shortfall is
      energy / kWh against the plan, not raw temperature delta.
      Why P1: factually misleading user-visible string at the very moment the user is
      trying to understand why PELS says it cannot finish.
      Fix candidates: render shortfall as `kWh` / `% of energy needed`, or rephrase to
      "won't reach the target temperature in time" without a misleading magnitude.
      Files: `packages/shared-domain/src/deadlineLabels.ts` (or smart-task copy
      helper), `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`.

- [x] Smart task missed-history detail page omits observed-vs-target line and reason. *(landed in `50bd8d7c`: `formatPlanHistoryMissedReason` composes a one-sentence postmortem from `planStatus` + `discoveredFrom`; `dailyBudgetExhaustedBucketCount` branch documented for v2.7.2 since the persisted snapshot lacks it.)*
      Live-walk 2026-05-16 (`/tmp/pels-live-walk/04-smart-task-history-missed-480.png`)
      shows the missed-task history page rendering a single solid green bar at 15:00
      with no copy explaining why it was marked missed and no comparison to the target.
      Why P1: missed is the failure case where users most need explanation; page
      drops exactly that information. Succeeded rows show observed-vs-target detail —
      thread the same render through the missed path.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      missed-detail data plumbing.

- [x] Budget Plan: "On budget" Tomorrow pill has very low contrast.
      Live-walk 2026-05-16 (`/tmp/pels-live-walk/02-budget-plan-tomorrow-480.png`)
      shows the "On budget" pill rendering as faint mint-green text on a faint
      mint-green background. Borderline legibility.
      Why P1: chip is a primary signal on the Tomorrow card; users skim for it and
      currently miss it. Either bump the chip's foreground/background contrast or
      adopt the higher-contrast `good`-tone treatment used on other surfaces.
      Files: `packages/settings-ui/public/style.css` (pill / chip tokens for the
      "good"/"on track" variant).

- [x] Day segmented control wraps mid-word at 320 px ("Yesterd / ay", "Tomorr / ow").
      Live-walk 2026-05-16 (`/tmp/pels-live-walk/02-budget-plan-320.png`) shows the
      Yesterday/Today/Tomorrow segmented breaking mid-word at the documented narrow
      width. Same primitive as Plan/Adjust (which PR #816 fixed for those specific
      labels). The day segmented control isn't using whatever `min-width` /
      `overflow-wrap` rule PR #816 introduced.
      Why P1: visible mid-word breakage at a documented supported width.
      Acceptance: at 320 px, the day segmented either uses abbreviations
      (`Yest. / Today / Tom.`), shortens labels via icons + screen-reader text, or
      stacks the segments vertically — but does not wrap mid-word.
      Files: `packages/settings-ui/public/style.css`, `packages/settings-ui/src/ui/views/BudgetOverview.tsx`.

- [x] Budget Today: "kWh to spare now" vs "projected today" don't visibly reconcile.
      Live-walk 2026-05-16 (`/tmp/pels-live-walk/02-budget-plan-480.png`) shows
      "59.9 / 60.0 kWh" with sub-text "28.9 kWh to spare now". 28.9 + 59.9 ≠ 60, so a
      user trying to reason about the deltas can't trace where each number comes from.
      "to spare now" is the gap against the *current cumulative target at this hour*,
      not against 60.
      Why P1: dashboards lose user trust the moment two numbers in the same card don't
      add up. Disambiguate copy ("X kWh to spare vs current pace" / "X kWh to spare vs
      projection") so the baseline is explicit.
      Files: `packages/settings-ui/src/ui/views/BudgetOverview.tsx`,
      `packages/shared-domain/src/...` (budget copy helpers).

- [x] Usage hero shows two different "vs typical" deltas in the same card.
      *(landed in PR 3.3 — `formatDeltaChipLabel` in `packages/settings-ui/src/ui/usageHero.ts`
      now derives the chip number from the projected-vs-typical delta when the
      projection window is open, so the chip ("−4.0 kWh vs typical") and the
      prose ("On track for ~8.0 kWh by midnight (below typical).") share one
      baseline. In the early-morning window where projection is suppressed,
      the chip falls back to "On pace" / "±X.X kWh vs pace" — only one number
      ever surfaces.)*

- [x] Overview hero surface tier hierarchy inverted. *(landed in `21e1500b`: `.plan-hero` raised to a surface tier above device cards so the hero now reads as the primary card on the page.)* Live-walk 2026-05-16
      (`/tmp/pels-rewalk/overview/02-overview-hero-480.png`,
      `/tmp/pels-rewalk/overview/inspect-overview.json`): the hero card computes
      `background: rgba(0,0,0,0)` with `border: 1px solid #2a3340`, while device cards
      below compute `background: #141923` with the same border. Net effect: the hero
      reads as *less* prominent than the device cards underneath it — the eye is
      drawn to the cards rather than the headline summary. First-impression visual
      coherence break on the page every user lands on. Bump the hero to a
      surface-container tier above the device cards (e.g.
      `--pels-surface-container-high`) or restructure so the visual weight matches
      the information hierarchy.
      Files: `packages/settings-ui/public/style.css` (`.plan-hero` / `.pels-hero`
      surface binding), `packages/settings-ui/src/ui/views/PlanHero.tsx`,
      `settings/style.css` (regen).

- [x] Overview hero markers (power-now + energy-used bars) have no titles or *(landed in `21e1500b`: every meter marker now carries an `aria-label`, plus a sublegend row below the bar names safe-pace / hard-cap / projected.)*
      ARIA labels. Live-walk 2026-05-16
      (`/tmp/pels-rewalk/overview/09-power-now-bar-detail.png`,
      `10-energy-used-bar-detail.png`, `13-energy-bar-end.png`): four marker
      elements (`--target`, `--cap`, `--projected`) sit on the meter bars purely as
      colored ticks/dots with no `title`, `aria-label`, legend, or hover affordance.
      Users can't tell which dot is "safe pace" vs "hard cap" vs "projected end of
      hour" without reading the docs. First-impression clarity gap + accessibility
      blocker for screen-reader users on the headline meters.
      Acceptance: every marker has either an `aria-label` (single-marker case) or a
      small legend row below the bar (multi-marker case) plus `title` tooltips on
      hover. Verify Playwright accessibility snapshot doesn't drop unlabeled
      `aria-hidden=false` elements.
      Files: `packages/settings-ui/src/ui/views/PlanHero.tsx` (marker rendering),
      `packages/settings-ui/public/style.css` (legend row), copy in
      `packages/shared-domain/src/...`.

- [x] Stepped-load device card "stepped control" is a fake affordance. *(landed in `86a36c56`: `cursor: pointer` dropped from `.plan-card__step-rail` / `.plan-card__step-stop` so the rail reads as a status indicator — real-button refactor deferred.)* Live-walk
      2026-05-16 (`/tmp/pels-rewalk/overview/11-segmented-control-detail.png`,
      `14-connected-300-card.png`): the `.plan-card__step-rail` and
      `.plan-card__step-stop` elements on Connected 300 (and presumably all
      stepped-load cards) use `cursor: pointer` on every dot/label, but have no
      `role`, no `aria-checked`, no `<button>` or `<radio>` semantics, and no click
      handlers. The only actual click target is the parent card (which navigates
      to detail). Users see what looks like an Off / Low / Medium / Max selector
      and try to tap individual stops — nothing happens; they have to discover the
      card itself is the link.
      Fix candidates: either remove the misleading `cursor: pointer` so the strip
      reads as a status indicator only, or make the individual stops real
      `<button>` controls that select a step (with the card click still working as
      the fallback to open detail).
      Files: `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx` (stepped
      card markup), `packages/settings-ui/public/style.css` (cursor / hover state).

- [x] Low-contrast metric label on device cards (`.plan-card__metric-label`). *(landed in `21e1500b`: rebound to an AA-safe token.)*
      Live-walk 2026-05-16 (`/tmp/pels-rewalk/overview/15-elbillader-card.png`):
      "~1.0 kW when active" on the Elbillader card renders as 11 px
      `rgb(107, 114, 128)` on `rgb(20, 25, 35)` — fails WCAG AA contrast for
      small body text. Bump the color to a token that meets AA on the device-card
      surface (e.g. `--pels-text-secondary`).
      Files: `packages/settings-ui/public/style.css` (`.plan-card__metric-label`
      color), `settings/style.css` (regen).

- [x] Usage tab — Y-axis top-tick collides with the prior gridline on every
      chart. *(landed in PR 3.1 — `roundedAxisMaxToInterval(dataMax, splitNumber)`
      in `dayViewChart.ts` picks the smallest nice multiplier (1 / 2 / 2.5 / 5 / 10
      × 10^k) ≥ `dataMax / splitNumber`, so `max = splitNumber * interval` and
      ECharts never tacks an extra top tick above the prior gridline. Inputs
      3.7 → ticks 0/1/2/3/4; 71 → 0/20/40/60/80; 1 → 0/0.25/0.5/0.75/1.)*

- [x] Usage heatmap "Unreliable data" legend swatch doesn't visually match
      the cells it labels. *(landed in PR 3.1 — `.usage-legend__swatch--unreliable`
      now reads the same `--pels-chart-unreliable-cell` fill and
      `--pels-chart-heatmap-border` border tokens the heatmap cell uses, rendered
      as a 10×10 square with 2 px radius matching the cell. An E2E test in
      `charts-layout.spec.ts` asserts the parity through `getComputedStyle` so
      future palette tweaks can't drift them apart.)*

- [x] Usage "Typical day" Weekdays / Weekend segmented control updates the
      bars but not the stat strip. *(landed in PR 3.1 — `power.ts`
      `syncPatternAverageVisibility` hides the inactive metric strip on every
      `renderHourlyPattern` call. The `data-pattern-metric` attribute values
      match the `HourlyPatternView` strings so the comparison is direct;
      "All days" keeps both visible.)*

- [x] Smart task hero: `estimatedDurationText` shrinks across revisions. *(landed in `4b88a325`: `initialPlanningSpeedKw` + `initialEstimatedDurationText` snapshotted on `DeferredObjectiveActivePlanV1` at first real revision, preserved across replans with legacy back-fill, reset on `objective_changed`.)* The recorder formats
      the value every revision from the current `energyNeededKWh / planningSpeedKw`
      (`lib/plan/deferredObjectives/activePlanRecorder.ts:267`); `energyNeededKWh` is
      recomputed from `progress.remainingUnits` each cycle
      (`lib/plan/deferredObjectives/diagnosticsBridge.ts:266-279`), so the persisted
      `Estimated: Yh Zm` shrinks every time a new revision is written. User expectation
      (clarified 2026-05-15): "hours remaining" can shrink, but the *plan-level total
      duration* should be set once at plan creation and never reduced. Either snapshot
      `initialEstimatedDurationText` + `initialPlanningSpeedKw` on
      `DeferredObjectiveActivePlanV1` at `createPlanFromDiagnostic` time and have the hero
      read those, or rename the metaLine value so the shrink is honest (e.g. "Remaining:
      Yh Zm"). Decide which side of the contract holds the truth.
      Files: `packages/contracts/src/deferredObjectiveActivePlans.ts`,
      `lib/plan/deferredObjectives/activePlanRecorder.ts`,
      `packages/settings-ui/src/ui/deadlinePlanHero.ts`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`.

- [x] Smart task hero headline names a time but no reason. *(landed in `50bd8d7c`: `headlineReason` subline branches on `computedFromPricesUpTo` / `dailyBudgetExhaustedBucketCount` to name prices / today's budget / cheaper-than-now.)* When `firstChargingHour > now`,
      `resolveHeroHeadline` (`packages/settings-ui/src/ui/deadlinePlanHero.ts:58-70`) emits
      "Heating from HH:MM" / "Charging from HH:MM" with zero context for *why* that hour.
      User reads it as a mystery: waiting for prices? next cheap window? plug-in? Add a
      subline or extra meta line resolving against the data already on the latest revision
      (`computedFromPricesUpTo` vs `deadlineAtMs`, `dailyBudgetExhaustedBucketCount`,
      `firstPlannedHourMs`). Three primary cases:
      - prices not through deadline → "Waiting for tomorrow's prices through HH:MM."
      - daily budget exhausted in the run-up → "Today's budget is full — next cheap window
        after midnight."
      - prices known + window deliberately chosen → "Cheaper than now — starts at HH:MM."
      Reason copy lives in `packages/shared-domain/src/deadlineLabels.ts`. Helper goes in
      shared-domain to stay browser-safe.

- [x] Smart task live chart: price grid and load grid bars don't align by hour.
      *(landed in PR 3.3 — `barWidth` + `barCategoryGap` are pinned on every bar series
      across both grids in `DeadlinePlan.tsx`, both grids set `containLabel: true`, and
      a phantom left axis on the price grid mirrors the load grid's progress axis so
      both grids reserve identical horizontal insets. A new Playwright spec in
      `tests/e2e/deadline-plan.spec.ts` reads per-grid bar centres via the chart's
      `convertToPixel` (exposed as `data-test-bar-centres` on the chart container) and
      asserts they agree to within 1 px at 320 + 480 px.)*

- [x] Smart task chip "Queued" is redundant on the hero and misleading on list cards. *(landed in `cd4bce6d`: live-state chip dropped on the active hero; `queued` label renamed to `Scheduled` in `deadlineLabels.ts` while the internal enum value stays `queued` for log/JSON stability.)*
      On the deadline-plan hero, the chip duplicates the headline for `queued`, `active`,
      `on_track`, and `cannot_finish` cases (headline already says "Heating from HH:MM" /
      "Heating now" / "On track …" / "Cannot finish"). On list cards
      (`packages/settings-ui/src/ui/views/DeadlinesList.tsx`), the chip is the *only*
      state signal — but "Queued" implies a task queue that doesn't exist. The semantics
      are "plan ready, first hour > now" — i.e. "scheduled for later." Two-part fix:
      (a) drop the live-state chip from the active hero
      (`packages/settings-ui/src/ui/deadlinePlanHero.ts:46-56`); keep the kind chip and
      the cannot-meet chip;
      (b) rename `queued` *label* to "Scheduled" in
      `packages/shared-domain/src/deadlineLabels.ts:49` and the kind-specific
      `liveStateChipLabel` block. Keep the internal LiveState enum value `queued`
      unchanged so log schemas aren't affected. Pending-hero chips ("Building plan…",
      "Paused — unplugged") stay — they carry unique info. The `Heat queued` / `Charge
      queued` rows in `notes/ui-terminology.md:168` also need updating once landed.

- [x] Smart task hero "Confidence low" chip carries no explanation. *(landed in `cd4bce6d`: confidence chip suppressed on `high`; on `low` / `medium` it now renders the action-oriented `Estimating` / `Refining` copy on the hero. List keeps `Confidence low/medium/high` via its own helper.)* The chip is built as
      a bare `Confidence ${confidence}` string
      (`packages/settings-ui/src/ui/deadlinePlanHero.ts:55`) with no tooltip, supporting
      copy, or aria-label. Users have no way to know that the bands come from sample
      count + relative std-dev of the learned `kWhPerUnit` profile
      (`lib/core/objectiveProfileStats.ts:38-49`; low: <4 samples OR relStdDev >0.75;
      medium: 4-9 samples + relStdDev 0.35-0.75; high: ≥10 samples AND relStdDev ≤0.35),
      or what to do about it. Two-part fix:
      (a) drop the chip when `confidence === 'high'` (no signal needed in the common
      case); for `low` / `medium`, replace text with action-oriented copy ("Estimating" /
      "Refining") and surface `sampleCount` so the user can see basis;
      (b) add a row to the "Smart task inputs" card via
      `packages/settings-ui/src/ui/deadlinePlanInputs.ts` showing "Learned from N samples"
      and a one-line explanation: "Plan estimates may drift until PELS has more
      observations of this device's energy use." Plumb `sampleCount` through from
      `kwhPerUnitProvenance.acceptedSamples` (already on the revision contract). Companion
      to the existing P1 entry "Surface confidence and progress on Smart-tasks list cards"
      which covers the same signal on the list surface.

- [x] Give settings-form text-field / select controls an accessible name. *(landed in `11a02380`: `aria-labelledby` referencing the sibling `.field__label[id]` on M3 controls in Limits & safety, Electricity prices, daily-budget advanced, and current-mode. Visible label rendering unchanged.)* M3 follow-up audit
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
- [ ] Refresh the PELS leaf icon to match the new eco palette. The current app icon and any
      in-UI leaf graphic should align with the leaf-green primary (`#16a34a`) rather than the
      previous emerald (`#10b981`). Out of scope for the redesigned settings UI; touches Homey
      app metadata. Files: `assets/icon.svg`, `.homeycompose/app.json`, any in-UI SVG leaf.

- [x] Make Settings UI device refresh await in-flight snapshot refreshes. *(landed in `c1a2fb5a`: `refreshTargetDevicesSnapshot` now awaits the in-flight loop promise for overlapping callers; synchronous re-entry from `emitFlowBackedRefreshRequests` keeps the legacy queue-and-return behavior.)* `/ui_refresh_devices`
      currently calls `refreshTargetDevicesSnapshot()` and then returns the current in-memory
      device snapshot, but overlapping refresh calls only queue another refresh and return
      immediately. After removing persisted target snapshots, this can return stale or empty
      device data during startup or overlapping refreshes.
      Files: `lib/app/appSnapshotHelpers.ts`, `lib/app/settingsUiAppRuntime.ts`,
      `lib/app/settingsUiApi.ts`, settings UI API/runtime tests.
- [x] Roll back optimistic price-optimization UI state when persistence fails. *(landed in `c1a2fb5a` + `751c128a`: per-field rollback gated on "is the current value still our optimistic write?" — newer concurrent saves are not clobbered. `priceOpt.ts` DOM rebind also gated on `getCurrentDetailDeviceId()` so mid-save navigation doesn't reapply stale inputs.)*
      Why P1: the UI currently mutates local state before the write succeeds, so failed writes can
      leave the screen showing settings that Homey did not persist.
      Files: `packages/settings-ui/src/ui/deviceDetail/priceOpt.ts`,
      `packages/settings-ui/src/ui/priceOptimization.ts`.
- [x] Key stepped-load draft state by device instead of using one module-global draft. *(landed in `c1a2fb5a`: stepped-load drafts are now a `Map` keyed by `deviceId`; each device-detail open starts fresh from the persisted profile.)*
      Why P1: a single draft can bleed between device detail sessions and makes fallback chains
      depend on whichever device wrote the draft last.
      Files: `packages/settings-ui/src/ui/deviceDetail/steppedLoadDraft.ts`.
- [x] Handle App Not Ready during PELS restart as a retry/loading state in the Settings UI rather *(landed in `c1a2fb5a`: API layer throws `PELS_APP_NOT_READY:`-prefixed errors during the boot window; `callApi` applies a bounded backoff (~8.25 s) covering POST writes; `showToastError` surfaces a stable "PELS is still starting" message after the budget is exhausted.)*
      than an error. Observed from `/ui_power` immediately after restarting the app: the UI
      currently surfaces the not-ready response as a hard error, which looks like a failure during
      the normal startup window. Detect the not-ready signal at the API boundary and degrade to a
      loading state with bounded retry/backoff until the runtime responds, instead of rendering an
      error toast or empty error card.
      Files: `packages/settings-ui/src/ui/**` API call sites for `/ui_power` and related routes,
      `lib/app/settingsUiApi.ts` not-ready response shape, settings UI loading/error tests.
- [x] Harden target-power stepped-load contract validation. *(landed in `d95d835e`: `assessTargetPowerCapabilityOptions` gates the Homey boundary in `nativeSteppedLoadWiring` + `deviceManagerNativeEv`; `warnIfTargetPowerCapabilityViolatesContract` emits a dedup'd structured log when malformed.)*
      Homey's `target_power` contract requires the range to include `0`; minimum operating power
      should be modeled with `excludeMin` / `excludeMax`, and `0` means idle. Keep mapping the off
      step to `target_power = 0`, but validate manual/synthetic profiles and warn or ignore
      invalid target-power metadata instead of letting malformed capability options look like
      normal input.
      Files: `lib/core/nativeSteppedLoadWiring.ts`, `lib/core/deviceManagerNativeEv.ts`,
      target-power/EV stepped-load tests.
- [x] Add typed schemas/parsers for settings maps and flow-card args before values enter app *(landed in `d95d835e`: new `flowArgParsers` helpers + extended `appTypeGuards` replace inline casts; normalizers in `appSettingsHelpers` + `flowCards/*` call sites tightened.)*
      logic. Avoid raw `Record<string, ...>`, `unknown`, and inline casts beyond the external
      Homey boundary.
      Why P1: flow cards and settings helpers repeatedly parse loose values with local fallbacks,
      so invalid external input can become normal internal state.
      Files: `lib/app/appSettingsHelpers.ts`, `flowCards/registerFlowCards.ts`,
      `flowCards/deviceSettingsCards.ts`, `flowCards/flowBackedDeviceCards.ts`.
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
- [x] Make "Cannot finish" hero copy always name a reason. *(landed in `50bd8d7c`: the bare `cannotMeetFallback` branch was replaced with a reasoned-or-honest sentence; the producer-side `resolveCannotMeetMeta` always returns named copy.)* `deadlinePlan.ts:resolveCannotMeetMeta`
      has three branches: `cannotMeetDailyBudgetExhausted`, `cannotMeetShortfall(text)`, and a
      bare `cannotMeetFallback`. The fallback path renders the warning chip with no reasoned
      explanation, which is the worst combination — user sees a problem signal but cannot tell
      what's wrong.
      Why P1: copy bug that undermines trust precisely in the moment users need it. Replace the
      fallback with either a named reason from the diagnostic (e.g. plan-status reason code) or
      escalate to logging + show a generic-but-honest copy ("PELS can't determine why this task
      is at risk — check the device's setup").
      Files: `packages/settings-ui/src/ui/deadlinePlan.ts`,
      `packages/shared-domain/src/deadlineLabels.ts`.
- [ ] Surface `objective_invalid_session` (car unplugged) on hero and list. The diagnostics
      bridge already emits `objective_invalid_session` when SoC reads invalid (car unplugged or
      session ended), and the user-facing flow status maps to `'waiting'`. The hero and list
      both render "Waiting" without explanation. Add a copy branch — "Charging plan paused —
      car unplugged" — to the pending-reason handling in `deadlinePlan.ts` and to the list-card
      status chip (extension of the entry above).
      Why P1: users plug back in expecting PELS to resume; with no signal they may think the
      task is broken. Companion to the existing P1 entry "Surface EV deadline device-card
      state" which already covers the device card.
      Files: `packages/settings-ui/src/ui/deadlinePlan.ts`,
      `packages/settings-ui/src/ui/views/DeadlinesList.tsx`,
      `packages/shared-domain/src/deadlineLabels.ts`,
      `lib/plan/deferredObjectives/diagnosticsBridge.ts` (confirm the reason flows into the
      pending-payload).
- [x] Disambiguate the "Waiting" chip across Smart task surfaces. *(landed in `cd4bce6d`: chip cleanup canonicalises `Building plan…` / `Scheduled` / `Paused — unplugged` variants; live-state chip dropped from active hero so the kind chip carries identity and the headline carries state.)* Today the same chip text
      serves three meanings: plan still being built (`pending: true`), plan ready but charging
      not started yet (queued for first bucket), and (proposed via existing entry above) car
      unplugged. Split into `Building plan…` / `Queued` / `Paused — unplugged` chip variants
      so users can tell at a glance which is active. Pair with the
      `objective_invalid_session` entry above so the unplugged variant lands in the same pass.
      Why P1: trust signal — three indistinguishable "Waiting" states erode confidence in what
      PELS is doing right now.
      Files: `packages/settings-ui/src/ui/views/DeadlinesList.tsx`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`,
      `packages/shared-domain/src/deadlineLabels.ts`.
- [x] Suppress live-plan original-series in legend and chart when identical to current. *(landed in `cd4bce6d`: the live-plan original-series legend + chart suppress when every hour's `originalDeviceKwh === deviceKwh`, mirroring the existing history-detail behaviour.)*
      `DeadlinePlanHistoryDetail.tsx:317-320` already gates `hasOriginalSeries` on
      `Math.abs(originalKwh - finalKwh) > 0.001`. The live `DeadlinePlan.tsx` always renders the
      original-series legend entry plus the dashed-border bar (with transparent fill when
      `originalDeviceKwh === 0`), producing two visually near-identical legend entries on
      first-load plans that haven't revised. Mirror the history-detail suppression: hide the
      series and the legend entry when every hour's `originalDeviceKwh === deviceKwh`.
      Why P1: chart clutter on the most common case (first-load, never-revised plan) — small UI
      fix with measurable first-impression payoff.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`.
- [x] Canonicalize chip ordering across Smart task surfaces. *(landed in `cd4bce6d`: ordering canonicalised across hero + list — kind identity first, state second.)* Today three orderings ship:
      list card `[kind, ?Waiting]`, pending hero `[Waiting, kind]`, live hero `[state, kind,
      ?cannotMeet, ?confidence]`. Pick one canonical order — suggested: kind first as identity,
      state second as live signal — and apply uniformly so glance-scanning the same chip across
      surfaces lands on the same position.
      Why P1: first-impression consistency; inconsistent ordering hurts glance comprehension
      of a multi-surface feature.
      Files: `packages/settings-ui/src/ui/views/DeadlinesList.tsx`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`.
- [x] Hero headline indicates planned start window when not currently active. *(landed in `50bd8d7c`: queued hero now emits `headlineReason` subline — "Waiting for tomorrow's prices through HH:MM" / "Today's budget is full — next cheap window after midnight" / "Cheaper than now — starts at HH:MM" — alongside the existing time-anchored headline.)* Today when
      `firstChargingHour` exists but its `startsAtMs > nowMs`, `resolveHeroHeadline`
      (`packages/settings-ui/src/ui/deadlinePlan.ts`) returns `Waiting until HH:MM`. When the
      hero is in the active-now branch it returns `Charging now` / `Heating now`. The bare
      "On track" branch can fire when there's no `firstChargingHour` at all; consider whether
      that branch should instead say something like "On track — no action needed yet" or
      similar. Audit and tighten the headline so users always get a concrete time or status
      cue rather than a bare status label.
      Why P1: hero is the top-line user signal; bare "On track" is the weakest possible answer
      to "what's happening?".
      Files: `packages/settings-ui/src/ui/deadlinePlan.ts`.
- [x] Rename `deadline_ended.json` dropdown option keys from `title` to `label`. Sibling
      trigger / condition JSONs (`deadline_status_changed.json`, `deadline_status_is.json`,
      condition `outcome`-typed cards across the project) all use `label: { en: … }` on
      dropdown option objects. `deadline_ended.json` uses `title` — non-standard per the
      Homey SDK convention and may render raw ids (`succeeded`/`missed`/`abandoned`) in the
      mobile UI instead of the localized labels. ~1-minute fix.
      Files: `.homeycompose/flow/triggers/deadline_ended.json`.
      Resolved by upstream: commit 50a395c5 dropped the outcome dropdown entirely from
      `deadline_ended.json`, so no dropdown option keys remain to rename. The dropdown was
      replaced by stable-id tokens that flow authors filter on downstream.
- [x] Decouple Smart tasks list empty-state copy from flow-card action titles. *(landed in `cd4bce6d`: empty state now references the PELS `Heat … by Ready by` / `Charge … by Ready by` Flow actions so users can find them in the picker.)*
      `DeadlinesList.tsx:99-100` hard-codes "Add heating task" / "Add charging task" as the
      action names. The flow-card redesign P0 may rename or unify the actions; this copy
      would then silently go stale. Either extract action titles to a shared label constant
      consumed by both the `.homeycompose/flow/actions/*.json` source and the UI, or drop the
      names entirely (e.g. "Open the Flow editor to schedule a heating or charging task").
      Why P1 polish: depends on flow-card redesign sequencing; bundle with that work for
      single-PR safety.
      Files: `packages/settings-ui/src/ui/views/DeadlinesList.tsx`,
      `.homeycompose/flow/actions/set_*_deadline.json` (if shared constants).
- [x] Surface built-in device control when it blocks device management. *(landed in `41a481a2`: inline notice next to the disabled toggle pointing the user to the activation switch; first-open auto-expands the Setup section and the action button scrolls + focuses the wiring switch.)*
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
- [x] Apply Norgespris to historical price rows instead of falling back to spot pricing. *(landed in `7c6c4363`: past hours under `norway_price_model = norgespris` now include the Norgespris adjustment; only current and future hours decrement the forward-looking monthly cap projection. Strømstøtte behavior unchanged.)*
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
- [x] Do a bounded first-impression copy polish pass on the redesigned Settings UI.
      This should stay small and user-visible: change `Mode: Home` to `Home mode`, explain the
      `Safe pace now` tooltip from `softLimitSource`, replace `Price-shaped plan` with
      `Cheaper-hour planning`, avoid `model` in daily-budget success toasts, and refine device-card
      limited/off wording such as `Paused by PELS` so it matches `notes/ui-terminology.md`. Do not
      rename internal identifiers, fixtures, or log strings.
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
- [x] Sweep planner-noun "plan" leakage from smart-task user-facing surfaces. *(landed in `cd4bce6d`: kind-aware `sectionLabel` + `progressSeriesName` in `deadlineLabels(kind)`; tooltip / heading / card titles lose the Plan-prefix; series renamed Initial/Revised schedule; "Replanned N times" → "Schedule updated N times".)*
      A live-Homey pass on the smart-task UI surfaced several places where the planner-layer
      noun "plan" leaks into copy a user reads. Per `notes/ui-terminology.md` §"Plan vs deadline
      terminology", the user-facing surface is "smart task" / "schedule" / "ready-by", not "plan".
      Hits to address: hero eyebrow `${kindChipLabel} plan` in `deadlinePlanHero.ts:161` and
      `deadlinePlan.ts:247` (renders "EV plan" / "Temperature plan") — pull a kind-specific
      `sectionLabel` from `deadlineLabels(kind)`; chart tooltip line `` `Plan ${planLabel}` ``
      at `DeadlinePlan.tsx:237`; legend / series `'Target progress'` at `DeadlinePlan.tsx:354,
      540` — make kind-aware ("Charge level" for EV, "Temperature" for thermal, driven by a new
      `labels.progressSeriesName`); `"Plan not found"` heading at `DeadlinePlan.tsx:656` →
      "Smart task record not found"; `"Plan vs observed"` card title at
      `DeadlinePlanHistoryDetail.tsx:370` → "Scheduled vs observed"; `"Original plan"` /
      `"Final plan"` series and `Original ${…} kWh` / `Final ${…} kWh` tooltip lines at
      `DeadlinePlanHistoryDetail.tsx:174, 183, 235, 249` → "Initial schedule" / "Revised
      schedule" or plain "Original" / "Final"; `"Replanned {n} times."` at
      `DeadlinePlanHistoryDetail.tsx:358` → "Schedule updated {n} times.".
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      `packages/settings-ui/src/ui/deadlinePlanHero.ts`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`,
      `packages/shared-domain/src/deadlineLabels.ts` (add the new kind-aware label).
- [x] Drop recorder jargon from past-task fallback copy and align with the "Smart tasks" tab name. *(landed in `cd4bce6d`: past-task fallback copy aligned with the Smart tasks tab name; recorder-jargon "revision" / "plan-snapshot tracking" / "planner" prose dropped.)*
      `packages/shared-domain/src/deadlineLabels.ts:270, 348` set the body to
      `"See History for the outcome."` and the past-plan unavailable fallback (rendered through
      `DeadlinePlan.tsx`) reads
      `"No plan detail was recorded for this run. It may have finalized before the planner
      produced a revision, or it predates plan-snapshot tracking."` — "History" is not a tab
      name (the canonical tab is **Smart tasks**), and "revision" / "plan-snapshot tracking" /
      "planner" leak recorder-layer language a user never asked about. Also reword the
      `Revised because …` tooltip lines at `deadlineLabels.ts:163–167` to `Updated after …`.
      Suggest: `"See Smart tasks for the outcome."`, `"No hourly plan was saved for this run."`,
      and `"Updated after the task was set"` / `"Updated as prices became available"` etc.
      Files: `packages/shared-domain/src/deadlineLabels.ts`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`.
- [x] Scope the past-plan detail heading so deep-links land with context. *(landed in `832c53ba`: `Smart task` eyebrow added above the timestamp; device name moved onto the heading line in primary weight with the timestamp following in muted text.)*
      Past-task detail today renders just a timestamp ("Mon 11 May 23:00") as h1 with the device
      name as a subline. A user who deep-links into the page (e.g. from a Homey notification or
      shared URL) only sees "PELS" in the dialog title bar — no "Past plan" / "Smart task" eyebrow
      explains what they are looking at. Add a section-label eyebrow above the timestamp and
      consider folding the device name into the heading line. Live-UI verified.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`.
- [ ] Drop the redundant "SMART TASKS" eyebrow above the same-named h2 on the Smart tasks tab.
      The empty-state hero on the Smart tasks tab currently renders eyebrow "SMART TASKS" + h2
      "Smart tasks" — the eyebrow says the same word as the heading. Either remove the eyebrow
      on this tab or replace it with a per-state hint ("EMPTY" / "ACTIVE" depending on whether
      a task is queued). Other tabs (Budget, Usage, Settings) use the eyebrow to name the panel,
      so dropping it here keeps consistency: the tab itself already names the panel.
      Files: `packages/settings-ui/src/ui/views/DeadlinesList.tsx`,
      `packages/settings-ui/public/index.html`.
- [x] Reword the Smart tasks empty state to match what users see in the Flow action picker. *(landed in `cd4bce6d`: empty state references the PELS Heat … by Ready by / Charge … by Ready by Flow actions so users can find them.)*
      `packages/settings-ui/src/ui/views/DeadlinesList.tsx:110` says "add a heating or charging
      smart task" and `.homeycompose/flow/actions/set_temperature_deadline.json` /
      `set_ev_charge_deadline.json` have `title` `"Add heating task"` / `"Add charging task"`,
      but Homey's action picker shows the `titleFormatted` body — "Heat Device to Target
      temperature (°C) °C by Ready by" / "Charge EV charger to Target battery (%) % by Ready by".
      A user reading the empty state and scanning the picker has no visible match. Suggest:
      reference PELS's **Heat … by Ready by** / **Charge … by Ready by** actions (or quote the
      `title` exactly: "Add heating task" / "Add charging task") so the empty state is findable
      both by search and by visual scan. Live-UI verified.
      Files: `packages/settings-ui/src/ui/views/DeadlinesList.tsx`.
- [x] Hide the "Temperature per mode" section on on/off devices.
      Device detail for the Easee / Zaptec chargers (both on/off) today renders the full
      "Temperature per mode" card with body "Temperature targets are not available for on/off
      devices." Empty-state placeholder + card title is wasted real estate — the section should
      not render at all when `device.controlModel === 'on_off'`. Same applies to any non-thermal
      control model (stepped-load chargers don't take per-mode target temperatures either).
      Live-UI verified on Easee and Zaptec.
      Files: `packages/settings-ui/src/ui/deviceDetail/` (the section visibility gate),
      `packages/settings-ui/public/index.html` (per-mode-temp card template).
- [x] Reword stepped-load copy that leaks "lower-priority devices" and "stepped-load device".
      `Charge boost` / `Temperature boost` descriptions in `packages/settings-ui/public/index.html`
      (around the existing "Step this charger up while the car stays below the minimum battery
      level, using only lower-priority devices if room must be made." line) and the stepped-section
      footer "When a limited stepped-load device resumes, PELS starts from the lowest active step
      and only climbs higher when there is room for it." both leak internal classification
      ("lower-priority devices" / "stepped-load device") into user copy. Suggest: "…drawing from
      devices PELS is already allowed to lower." for the boost description; "When this charger is
      limited and then starts again, PELS climbs back up step by step." for the footer.
      Files: `packages/settings-ui/public/index.html`.
- [x] Reword "Managed devices ran above plan" budget-overflow line.
      `packages/settings-ui/src/ui/budgetRedesign.ts:290` emits "Managed devices ran above plan —
      check device priorities." — "above plan" reads as planner-noun usage, the same pattern this
      pass is sweeping elsewhere. Suggest: "Managed devices used more than expected — check device
      priorities." (or a kind-aware variant if the helper has access to per-device context).
      Files: `packages/settings-ui/src/ui/budgetRedesign.ts`.
- [x] Clean up smart-task Flow card user-facing copy.
      Surface jargon / inconsistencies the Flow audit found: in
      `.homeycompose/flow/triggers/deadline_ended.json` rename token titles `"Shortfall"` →
      `"Gap to target"` and `"Shortfall (text)"` → `"Gap to target (text)"`, and update the hint
      "missed (deadline passed below target)" → "missed (ready-by time passed below target)".
      In `.homeycompose/flow/triggers/deadline_plan_changed.json` rename trigger title
      "Smart task planned hours changed" → "Smart task schedule changed" (sync `titleFormatted`)
      and reword the hint "replanned with a different number of hours" → "rescheduled with a
      different number of hours". In `.homeycompose/flow/triggers/deadline_status_changed.json`
      add the `notification_text` token that the spec in `notes/smart-task-flow-cards/README.md`
      lists as shipped but the JSON is missing. After updating, regenerate `app.json` with
      `homey app validate` and commit it.
      Files: `.homeycompose/flow/triggers/deadline_ended.json`,
      `.homeycompose/flow/triggers/deadline_plan_changed.json`,
      `.homeycompose/flow/triggers/deadline_status_changed.json`,
      `app.json` (regenerated).
- [x] Give the Cannot-finish deadline-plan hero an actionable recourse path. *(landed in `50bd8d7c`: producer-side `{label, targetTab}` recourse — daily-budget-exhausted routes to the Budget tab per `feedback_hard_cap_is_physical`; other cannot-meet causes route to Overview. Router close-handler accepts a `fallbackTab` option so the click flows in one pass.)*
      The body text correctly explains why ("Your daily budget is tight…" / "The deadline is too
      close…") but it's plain prose with no affordance: no button, no inline deeplink to Budget
      tab, no "Clear task" escape hatch. Users on Homey's mobile WebView land in a dead-end. Add
      a small action row under the hero body that surfaces the right next step per cause —
      typically "Open Budget", "Lower target", "Extend deadline", or "Clear task". For
      `cannotMeetDailyBudgetExhausted`, link to the Budget tab; for shortfall cases, surface the
      EV/heater settings.
      Files: `packages/settings-ui/src/ui/deadlinePlanHero.ts`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/public/style.css`,
      `packages/shared-domain/src/deadlineLabels.ts` (per-cause recourse-action label).
- [x] Drop "Plan Charge" / "Plan Idle" / "Plan Heat" tooltip jargon from the deadline-plan chart. *(landed in `cd4bce6d`: `Plan ${planLabel}` prefix dropped from the chart tooltip; verified — `planTooltipIdle: 'Idle'` is rendered bare.)*
      The chart tooltip in `packages/settings-ui/src/ui/views/DeadlinePlan.tsx:232` prefixes the
      `planLabel` with the planner-layer noun "Plan", rendering "Plan Charge", "Plan Idle",
      "Plan Heat" as visible tooltip text. Drop the prefix or use a status verb: "Charging",
      "Idle", "Heating". Source: `deadlineLabels.ts` `planTooltipActive` / `planTooltipIdle`
      values feeding the formatter.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/shared-domain/src/deadlineLabels.ts`.
- [x] Add a CSS rule for `.plan-inputs__row-note`.
      The Smart task inputs card emits the bootstrap caveat ("Estimated — refining as PELS
      observes charging.") inside a `<dd>` with class `.plan-inputs__row-note`, but
      `settings/style.css` has no matching rule. The note inherits parent `<dd>` styles
      (semibold primary color) and renders visually indistinguishable from the actual value
      it annotates. Add a small-size, supporting-color, normal-weight rule.
      Files: `packages/settings-ui/public/style.css`,
      `settings/style.css` (regen).
- [x] Surface the "X kW above safe pace" subline on the Overview hero when above safe pace. *(landed in `21e1500b`: above-pace subline branch added in `PlanHero.tsx` to match the spec's quantitative requirement.)*
      The hero spec (`notes/overview-hero-spec.md`) requires a quantitative subline whenever the
      mode chip indicates "Above safe pace", but `PlanHero.tsx:465–469` only renders the matching
      "Safe pace now X kW" subline in the on-track state. As a result, the above-pace state shows
      a chip + "Power now X kW" but no overshoot figure. Add the missing branch.
      Files: `packages/settings-ui/src/ui/views/PlanHero.tsx`.
- [x] Show priority on Overview device cards. *(landed in `86a36c56`: `#1` / `#2` / `#3` priority chip aligned with device name on Overview cards, reusing the Modes-priorities chip primitive.)*
      Today priority is only visible in the device-detail drawer; the Overview cards show device
      name + current state + draw + (for steppers) the level strip. Priority is the user's
      mental model of "what gets shed first" — they shouldn't have to drill into each device to
      see the shed order. Add a small priority chip ("#1", "#2", "#3") aligned with the device
      name, matching the chip primitive already used in Modes priorities.
      Files: `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx`,
      `packages/settings-ui/public/style.css`.
- [x] Make the energy-this-hour headline format consistent across the Overview hero.
      `PlanHero.tsx:524` emits "0.95 / 0.9 kWh" but the spec says "0.95 of 0.9 kWh used" (or
      "0.95 of 0.9 kWh" — readable English, not the math `/` separator). Decimal precision also
      drifts within the same pair (`toFixed(2)` for the numerator, `toFixed(1)` for the
      denominator). Pick "X of Y kWh used" and one precision (one decimal) and apply uniformly.
      Files: `packages/settings-ui/src/ui/views/PlanHero.tsx`.
- [ ] Add loading skeletons across the five panels.
      Loading state today is a plain `<p class="muted">Awaiting data…</p>` in all panels —
      identical wording, identical styling, no M3 shimmer / skeleton. First-paint after the
      Configure dialog opens shows a flat grey wall until the bootstrap fetch resolves.
      Standardize on a single M3 skeleton primitive (one shape per panel: hero placeholder +
      card placeholders) and use it everywhere.
      Files: `packages/settings-ui/src/ui/views/*.tsx`,
      `packages/settings-ui/public/style.css`.
- [x] Sweep Budget panel for remaining planner-noun leakage and terminology drift.
      Two sibling sites still leak `plan` as a planner noun: `budgetRedesign.ts:245` emits
      "Cheaper-hour planning" (compare to the documented "Use cheaper hours" wording in the
      Adjust view and `docs/daily-budget.md`); `BudgetOverview.tsx:582` uses the section heading
      "Planning behavior" (consider "Shaping behavior" / "Budget shaping"). Both should align
      with the rest of the planner-noun sweep landing alongside the smart-task copy work.
      Files: `packages/settings-ui/src/ui/budgetRedesign.ts`,
      `packages/settings-ui/src/ui/views/BudgetOverview.tsx`,
      `packages/shared-domain/src/**` (if helpers exist there).
- [x] Fix Budget chart legend color collision between Managed and Price series.
      `tokens.css:219, 224` both bind to `--color-role-warn` (orange). The two series are
      distinguishable only by shape (filled circle vs line), which is fragile at small swatch
      sizes. Reassign the Price series to a distinct semantic token (or extend the chart palette
      with a dedicated `--pels-chart-price` hue that contrasts both Managed and Background).
      Files: `tokens/component.json`, `settings/tokens.css` (regen),
      `packages/settings-ui/src/ui/budgetRedesignChart.ts`.
- [x] Remove the ghost "Warning" legend entry from the Usage day ECharts chart.
      *(landed in PR 3.1 — `usageDayChartEcharts.ts` now adds a zero-data dummy
      bar series named "Warning" alongside the "Measured" series whenever
      warn bars are present. The legend's `Warning` entry binds to this real
      series so ECharts no longer drops it; `barMaxWidth` caps both series so
      the dummy can't shrink the real bars.)*
- [x] Surface confidence and progress on Smart-tasks list cards. *(landed in `832c53ba`: `Confidence low/medium/high` chip + `currently 18.5 °C` / `currently 45 %` line beside the target. Helpers in shared-domain so logs and UI share strings.)*
      `DeadlinesListCard` shows kind chip + device + target + ready-by + status, but no
      confidence indicator and no current-value indicator. A user scanning the list cannot tell
      which queued task is in trouble without tapping into each one. Add a small confidence
      chip ("Low" / "Medium" / "High" — matching the hero detail page's confidence chip) and a
      "currently X" row line ("currently 18 °C", "currently 45 %") so the list answers "what's
      at risk?" at a glance.
      Files: `packages/settings-ui/src/ui/views/DeadlinesList.tsx`,
      `packages/contracts/src/settingsUiApi.ts` (add `confidence` / `currentValue` to the list
      card shape if not already there),
      `packages/shared-domain/src/deadlineLabels.ts` (confidence label per kind).
- [x] Smart-tasks list: empty Past tasks section silently vanishes; date format inconsistent *(landed in `832c53ba`: new `empty` state on `DeadlinesHistoryListState` renders the heading + explanatory line; both active and past lists routed through `formatSmartTaskListDateTime(ms, timeZone)` so dates render uniformly as `Sat 16 May 06:50`.)*
      between active and past cards.
      The Past tasks region lives in `DeadlinesHistoryList.tsx`; when `historyEntries.length === 0`
      it renders as `null` instead of an explanatory placeholder — leaves the user wondering where
      the section is supposed to be. Same panel, active cards rendered in `DeadlinesList.tsx` use
      `Sat 16 May, 06:50` (with comma) while past cards in `DeadlinesHistoryList.tsx` use
      `Mon 11 May 23:00` (no comma). Pick one format helper and route both lists through it; add
      an empty-state stanza for past tasks ("No completed tasks yet — they'll appear here after
      a smart task finishes.").
      Files: `packages/settings-ui/src/ui/views/DeadlinesHistoryList.tsx`,
      `packages/settings-ui/src/ui/views/DeadlinesList.tsx`,
      `packages/shared-domain/src/dateFormat.ts` (or wherever the date helper lives).
- [x] Promote the History detail outcome chip and add a scoping eyebrow. *(landed in `832c53ba`: outcome chip promoted to its own row above the heading; `Smart task` eyebrow added; device name on the heading line with timestamp following in muted text. Per `feedback_terminology_plan_vs_deadline`, the eyebrow is `Smart task`, not `Smart task plan`.)*
      Today the past-plan detail opens with an 18 px semibold h1 timestamp ("Mon 11 May 23:00")
      and an 11 px chip ("Succeeded") tucked to the right — the timestamp answers first and the
      outcome (the thing the user came to confirm) is the quietest element. Also: no eyebrow
      labels the surface as "Past plan" / "Smart task plan", so a user landing here from a
      deep-link or notification has no scoping ("PELS" in the dialog title bar is not enough).
      Fix: add a "Smart task plan" eyebrow above the heading, raise the outcome chip to be
      visually at least the weight of the timestamp (or move it inline above), and bring the
      device name onto the heading line.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      `packages/settings-ui/public/style.css`.
- [ ] Unify hero structure across the five settings panels.
      Every panel except Settings uses `<header class="pels-hero"><div><eyebrow><h2></div></header>`;
      the Settings panel hero (`#settings-panel`) drops the inner `<div>` wrapper and puts the
      eyebrow, h2, and supporting paragraph as direct grid children. The result is a different
      vertical rhythm, most noticeable at 320 px where the Settings hero feels taller and looser
      than its siblings. Fix: re-wrap Settings hero contents in the canonical `<div>`.
      Files: `packages/settings-ui/public/index.html` (Settings panel hero),
      `packages/settings-ui/public/style.css` (verify selector specificity still wins).
- [x] Unify the settings-UI icon vocabulary. *(landed in `11a02380`: Feather-style Managed and Limit icons in the device legend migrated to Material-style fills so the legend reads as one icon family with Price (already Material-filled).)*
      Icons in the device legend split between Feather-style strokes (`stroke-width="2"` on the
      Managed / Limit icons) and Material-style fills (`fill="currentColor"` on the Price icon
      and all navigation icons). Rendered side-by-side in the same row, they read as a mismatched
      set. Pick one — Material Symbols are already the dominant family — and migrate the Feather
      stragglers.
      Files: `packages/settings-ui/public/index.html` (device legend icons),
      `packages/settings-ui/src/ui/views/icons.tsx`.
- [x] Replace `&times;` close buttons with the Material `close` SVG icon. *(landed in `11a02380`: smart-task plan-detail close glyph swapped from `&times;` to a Material `close` SVG so weight and size match the rest of the icon set.)*
      The smart-task plan-detail close button is declared in `packages/settings-ui/public/index.html:331–332`
      as `<md-icon-button class="deadline-page-close">` wrapping `<span class="deadline-page-close__icon">&times;</span>`.
      The HTML entity has a different optical weight and size than every other icon in the app,
      and visually collides with the outer Homey dialog `×` at 480 px (the two `×` buttons sit
      within ~20 px vertically at the right edge — first-time-user confusion). Swap the inner
      span for a Material `close` SVG so weight and size match the rest of the icon set, and
      consider replacing the close affordance with a back-arrow to disambiguate from the outer
      Homey dismiss.
      Files: `packages/settings-ui/public/index.html`,
      `packages/settings-ui/public/style.css`.
- [x] Lift `.pels-icon-toggle` and `.pels-device-card__detail-button` to the 48 px touch *(landed in `11a02380`: both controls raised from 36 px to `--pels-touch-target-min` (48 px) so the most-used Overview interaction surface meets the project's own floor.)*
      target. Both are sized at 36 × 36 px in CSS, below the project's own
      `--pels-touch-target-min: 48px` token. They sit in the most-used interaction surface
      (the device-card grid on Overview). Raise them, or expand the hit area beyond the visible
      icon via padding.
      Files: `packages/settings-ui/public/style.css`, `settings/style.css` (regen).
- [x] Replace the ⚠️ Unicode emoji in banners with a Material `warning` SVG. *(landed in `11a02380`: dry-run, stale-data, and budget allocation warning banners now use a Material `warning` SVG so they render consistently across Apple / Google / Microsoft glyph sets.)*
      The banner / warning primitives render the OS-native emoji glyph (`⚠️`), which has a
      different color and shape across OSes (yellow Apple, orange Google, monochrome Microsoft),
      while every other icon in the app is an SVG. Use a Material `warning` SVG so the banner
      visual is consistent across platforms.
      Files: `packages/settings-ui/public/index.html`,
      `packages/settings-ui/public/style.css`,
      `packages/settings-ui/src/ui/views/icons.tsx`.
- [x] Switch the Flow card `target_percent` argument to Homey's `range` type.
      `.homeycompose/flow/actions/set_ev_charge_deadline.json` currently declares
      `"type": "number"` with min/max/step for `target_percent` — renders as a text/numeric
      input. Homey supports `"type": "range"` which renders as a slider, a much better UX for
      a bounded 0–100 % value. Audit other bounded-percentage arguments across `.homeycompose/`
      (battery-level report condition / similar) and switch them too. Keep `target_temperature`
      as `number` because the bounds are wider and exact values matter. Regenerate `app.json`
      via `homey app validate` after the change.
      Files: `.homeycompose/flow/actions/set_ev_charge_deadline.json`,
      `.homeycompose/flow/conditions/*battery*.json` (audit),
      `.homeycompose/flow/actions/report_battery_level.json` (audit),
      `app.json` (regenerated).
      Audit result: `target_percent` switched to `range` (2.7.0-new card, breaking change
      permitted). `report_evcharger_battery_level.json` `battery_percent` (also 0–100 %)
      shipped in v2.6.0 — type change is a pre-2.7.0 breaking change; deferred to v2.7.1
      entry below. No other bounded-percentage args were found.
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
      own one-off hero rule.
      Why P1 (demoted from P0 in release-review pass): the unfinished work is rebinding 5 panel
      headers to the shared `.eyebrow` primitive plus consolidating duplicated chip/card/button
      primitives. Both are refactor-for-coherence — the panels render today, just with subtle
      per-page differences. No user-visible incorrectness, so does not gate the release.
      *Sub-bullets from M3 visual pass (2026-05-14, after eco-palette landed):*
      - **Overview hero side landed (hero-rework PR):** headline tone no longer flips to
        warning/critical, the redundant `"X kW above hard cap"` subline was dropped, the
        power bar now renders segmented [managed][background] blocks on a single track,
        and the section labels reuse the shared `.eyebrow` primitive. Budget / Usage /
        Smart tasks / Settings / Advanced headers + the deadline-plan hero still need
        the same rebind.
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
      primitives or `@material/web` — that choice stays with the P2 entry below.
      Files: `packages/settings-ui/public/index.html`,
      `packages/settings-ui/public/style.css`, `packages/settings-ui/src/ui/views/PlanHero.tsx`,
      `packages/settings-ui/src/ui/views/BudgetOverview.tsx`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/src/ui/power.ts`, generated `settings/`, screenshot suite under
      `packages/settings-ui/tests/e2e/`.
- [x] Restore "Needs X kWh · Y hours left · Auto/Learning…" context on the `Cannot finish` hero. *(landed in `50bd8d7c`: meta line composes the reasoned cannot-meet sentence with the rich `Needs N kWh · Y kW max · duration · speedMode` line — e.g. "PELS may not reach the target temperature before the deadline. Needs 17 kWh, 1.3 kW max, 8 hours left, Learning…".)*
      `deadlinePlanHero.ts:buildHero` routes through `resolveCannotMeetMeta` on `planStatus
      === 'cannot_meet'`, which returns only the shortfall sentence (e.g. `Short by about
      29.6 °C`). The on-track / at-risk path keeps the rich `Needs ${energy} · ${speed} ·
      ${duration} · ${speedMode}` line via `formatMetaLine`. The user loses the answer to
      "how bad is this?" — `29.6 °C short` is meaningless without the energy/duration anchor
      (is that "4 more hours that aren't there" or "80 kWh past the budget"?). Append the
      formatMetaLine output after the cannot-meet sentence so both signals coexist:
      `Short by about 29.6 °C — needs 17 kWh, 1.3 kW max, 8 hours left, Learning…`.
      Why P1: confusing visible wording exactly when the user needs context most. Companion
      to the existing "actionable recourse path on Cannot-finish hero" P1.
      Related: `notes/smart-task-ui/README.md`.
      Files: `packages/settings-ui/src/ui/deadlinePlanHero.ts:buildHero`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`, deadlinePlanHero tests.

## P2 Product, Observability, and Maintainability

*Smart-task history-detail trio below was demoted from P1 in the v2.7.1
release-review pass (2026-05-17). All three depend on the history schema
v3 → v4 migration, which is out of scope for v2.7.1; sequence them together
in v2.7.2+.*

*Claimed by the **v2.7.2 PR train** (long-lived branch `v2.7.2`, started
2026-05-17). In scope for the train: the history-detail trio below
(L1215 / L1249 / L1260) plus the smart-task trust-signal cluster
(L2121, L2133, L2155, L2167, L2179, L2191, L2205, L2216, L2228) plus
small UI polish (L915, L1383, L1393, L1987). Theme: failed runs deserve
a different page shape than succeeded runs — see `notes/v2-7-2/README.md`
and `notes/smart-task-ui/README.md`. Skip these items in v2.7.1
release-review passes.*

*v2.7.1 release-review P2 batch (2026-05-17). Eight items from the
six-agent fan-out pass — non-blocking polish, drift, and follow-up.*

- [ ] `notes/overview-hero-spec.md` decision-sentence ladder drift: the
      note documents 6 branches; `PlanHero.tsx:108` now has 7 (added
      "projected over budget"). The note's own "keep this ladder in
      sync" instruction is referenced from the code comment. Update the
      note to match, or move it to historical if the spec/code contract
      is retired. Source: `pels-ux-fit` agent.
      Files: `notes/overview-hero-spec.md`,
      `packages/settings-ui/src/ui/views/PlanHero.tsx:108`.

- [ ] Resolution-in-producer smell in `deadlinePlanInputs.ts:51-55`. UI
      branches on `latest.kwhPerUnitSource === 'bootstrap'` to recompute
      `rateMean` from `BOOTSTRAP_EV_SOC_KWH_PER_PERCENT` because
      `profile.kwhPerUnit.mean` is absent during bootstrap. The producer
      (`profileEnergyResolution`) already resolves an `effectiveKwhPerUnit`;
      persist that on the active-plan revision so the UI reads one flat
      field and `kwhPerUnitSource` collapses to label-only provenance
      (matches `resolveSpeedModeLabel` at `deadlinePlanHero.ts:170-216`).
      Source: `pels-layering-guardian` agent.
      Files: `lib/plan/deferredObjectives/profileEnergyResolution.ts`,
      `lib/plan/deferredObjectives/activePlanRecorder.ts`,
      `packages/contracts/src/deferredObjectiveActivePlans.ts`,
      `packages/settings-ui/src/ui/deadlinePlanInputs.ts`.

- [ ] Promote heatmap cell radius `2px` to a token. `settings/style.css`
      `.usage-legend__swatch--unreliable` uses `border-radius: 2px`, and
      `powerWeekChartEcharts.ts` carries the same constant as a chart
      cell radius. No token analog exists today; promote to
      `--pels-chart-cell-radius` so the legend/cell shape contract is
      enforced at the token layer rather than two parallel literals.
      Source: `pels-m3-critic` agent.
      Files: `settings/tokens.css` (or `tokens/component.json`),
      `settings/style.css`,
      `packages/settings-ui/src/ui/powerWeekChartEcharts.ts`.

- [ ] Light-canvas tooltip contrast spot-check on Homey light. The
      `967365c5` pivot rebound `.tippy-box[data-theme~='pels']` to
      `color: var(--text)` on `background: var(--color-surface-elevated)`
      (resolves `#181818` on `#ffffff` — clean). Verify warn/critical
      tippy variants if they inherit `--text` still meet AA contrast on
      `--color-surface-elevated`. Visual QA only; no code evidence of
      breakage.
      Source: `pels-m3-critic` agent.
      Files: `settings/style.css` `.tippy-box[data-theme~='pels']` rule
      block.

- [ ] Smart-task error banners + "plan" wording on smart-task surfaces.
      `deadlinePlanMount.ts:27,221,273` and `deadlinePlan.ts:500` inline
      strings like `"Smart task plan data could not be loaded: …"` and
      `"Smart task plan unavailable"`. Two issues: (1) Rule 4 — strings
      should live in `packages/shared-domain/**`; (2) `notes/ui-terminology.md
      § Plan vs deadline` reserves *plan* for the planning layer. Use
      `"Smart task record not found"` at `DeadlinePlan.tsx:815` as the
      model. Source: `pels-copy-and-terminology` agent.
      Files: `packages/settings-ui/src/ui/deadlinePlanMount.ts`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx:823,832`.

- [ ] Pre-existing jargon in `packages/shared-domain/src/deviceOverview.ts:135-140,178,187`.
      Still emits raw `"Shed (charging paused)"`, `"Shed (lowered
      temperature)"`, `"Shed to {step}"`, `"Shed (reduced step)"`, `"Shed
      (powered off)"`, `"Restore requested"`. Terminology guide mandates
      `Limited`, `Charging paused`, `Lowered`, `Turned off`, and
      `Resume requested`. Not introduced by v2.7.1 — pre-existing cleanup.
      Source: `pels-copy-and-terminology` agent.
      Files: `packages/shared-domain/src/deviceOverview.ts`,
      `notes/ui-terminology.md`.

- [ ] `formatPlanHistoryMissedReason` recourse copy is wrong when the
      cause was daily-budget-exhausted. `deferredPlanHistory.ts:160-180`
      collapses that branch into the `cannot_meet` copy "Try lowering
      the target or moving the deadline later" — but the correct
      recourse in that case is raising the daily budget. Either persist
      the `dailyBudgetExhausted` distinction in the history snapshot
      (requires v3→v4 migration, claimed by v2.7.2 train) or soften copy
      to "Try lowering the target, moving the deadline later, or raising
      today's energy budget." Source: `adversarial-review` skill.
      Files: `packages/shared-domain/src/deferredPlanHistory.ts:160-180`.

- [ ] `activePlanRecorder.ts:584-594` sets explicit `undefined` on
      snapshot fields and relies on `JSON.stringify` dropping them. The
      comment is intentional, but the in-memory object exposes explicit
      `undefined` keys that violate `exactOptionalPropertyTypes`-style
      contracts elsewhere and risk inconsistent round-tripping if Homey
      ever serialises via a path that preserves `undefined`. Switch to
      conditional spread for the `objective_changed` reset path so the
      field is only set when defined.
      Source: `adversarial-review` skill.
      Files: `lib/plan/deferredObjectives/activePlanRecorder.ts:584-594`.

- [x] Smart task history detail: rebuild around temperature/SoC actual-vs-plan, not
      hourly bar comparisons. *(Step 1 landed in `a5b8116a` as v2.7.2/PR1 — schema v4
      with `progressSamples`, `kwhPerUnitMean`, `revisions[]`. Step 2 landed in the
      v2.7.2/PR4 commit on this train — `DeadlinePlanHistoryDetail.tsx` now renders a
      stepped planned staircase + observed-progress line on a unit-space y-axis,
      target reference, `metAtMs` marker, and falls back to the legacy kWh-bar
      chart when neither samples nor `kwhPerUnitMean` was captured.)*

- [ ] Add `deliveredKWh` and `totalCost` to `DeferredObjectivePlanHistoryEntry`.
      The History detail page is supposed to answer "how much did it cost?" and "by how much
      did it succeed?" — but the contract has neither `deliveredKWh` nor `totalCost`, so the UI
      cannot show them. The runtime recorder needs to capture these (sum observed kWh per hour,
      multiply by hourly price), the contract needs the fields, and the view needs the
      corresponding rows in the header card (e.g. "Delivered 5.4 kWh • 6.50 kr").
      Files: `packages/contracts/src/deferredObjectiveActivePlans.ts`,
      `lib/plan/deadlineRecorder.ts` (or equivalent),
      `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`.

- [ ] Show a real revision log on the History detail page.
      Today the entire revision surface is the single line "Replanned N times." — no timestamps,
      no per-revision reasons, no diff of which hours changed. The page's whole mission of
      "did PELS change the plan and why?" goes unanswered. Render a chronological list of
      revisions with: revision time, plain-English reason (from a kind-aware helper), and an
      optional inline mini-diff showing hours added / removed.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      `packages/shared-domain/src/deadlineLabels.ts` (revision-reason copy),
      contract additions for per-revision metadata.

- [ ] v2.7.1: Switch `report_evcharger_battery_level.json` `battery_percent` argument from
      `type: "number"` to `type: "range"` for a slider-style picker. The card shipped in
      v2.6.0, so changing the arg type is a pre-2.7.0 breaking change — defer to a release
      where breaking pre-2.7.0 flow-card surfaces is in scope. Step is currently `0.1`
      (not all Homey clients render fractional steps on `range`); evaluate whether to keep
      0.1 (slider with float step) or coarsen to `1` (typical battery-percent precision)
      when this lands. Surfaced by the v2.7.0 PR 4.1 audit.
      Files: `.homeycompose/flow/actions/report_evcharger_battery_level.json`, `app.json`.
- [ ] Power tracker persisted `dailyTotals` keys use UTC dates while UI-derived
      bucket totals use the Homey timezone date. After the P0 merge fix in
      `packages/settings-ui/src/ui/power.ts`, the chart, week/month totals, and
      weekday/weekend averages combine both maps; in non-UTC timezones a day
      that sits at the UTC/local boundary can appear at two adjacent date keys
      (one from the persisted UTC key, one from the bucket-derived local key).
      The typical-case Daily-usage chart window is unaffected because the last
      14 days come exclusively from buckets, but pre-30-day historical entries
      that show up in `getWeekdayWeekendAverages` and `sumDailyTotals` are
      keyed off by 1 day in zones like Europe/Oslo. Fix the backend to write
      `dailyTotals` keys with the Homey timezone (or normalise the UI to
      reparse both sources into one canonical zone-local representation).
      Files: `lib/core/powerTracker.ts` (`formatDateUtc` -> zone-aware),
      `packages/settings-ui/src/ui/power.ts` (or carry the dual-key
      normalisation here if backend can't change without a migration).
- [ ] "Typical day" hourly-pattern chart ignores the most recent 30 days of
      data. `derivedHourlyAverages` in `packages/settings-ui/src/ui/power.ts`
      still falls back to bucket-derived values only when persisted
      `hourlyAverages` is empty; once it has any entry, the chart shows only
      the >30-day-old slice that `aggregateAndPruneHistory` has rotated in.
      The Daily-usage merge fix did not extend here because the persisted
      `hourlyAverages` count is per-day (incremented for all 24 slots once per
      processed day) while the bucket-derived count is per-hour, so additive
      merge would mis-weight the average. Either rework the persisted format
      to per-hour counts, or compute a unified pattern by grouping merged
      day-hour entries before averaging.
      Files: `packages/settings-ui/src/ui/power.ts`,
      `lib/core/powerTracker.ts` (`processDayHourBuckets`).
- [ ] `processDayHourBuckets` in `lib/core/powerTracker.ts` over-counts the
      day count for boundary days that have their hours moved into
      `hourlyAverages` across multiple prune runs. Each prune that moves at
      least one hour of a given day calls the helper for that day, which
      increments count by 1 for all 24 weekday-hour slots. A day whose hours
      cross the threshold across two prune ticks therefore contributes count
      +2 instead of +1, biasing the typical-day averages slightly low.
      Files: `lib/core/powerTracker.ts` (`aggregateAndPruneHistory`).

- [ ] Budget tab vertical rhythm + density audit. The user's live walk 2026-05-16
      flagged the page as feeling visually loose / off-rhythm at the dialog's actual
      width.

      **Acceptance bar — fix all three of these consolidation candidates (or
      explicitly close each with a one-line "rejected because…" in the PR):**
      1. **Daily-budget header tile collapses out of its own card.** Today the
         "BUDGET / Daily budget" eyebrow + headline occupy a full card holding
         nothing else, with another full card immediately below for the segmented
         `Plan / Adjust` row. Move the headline into a header row of the segmented
         card, or use a section-eyebrow pattern that doesn't claim a card-tier
         surface, so one card's worth of vertical chrome (border + padding × 2 +
         gap) is removed.
      2. **`Plan / Adjust` and `Yesterday / Today / Tomorrow` stop stacking as two
         independent 50 px-tall segmented controls.** At 480 px there's room to
         either render them inline on one row (one segmented per axis), reduce
         their heights/gaps, or rebuild as a single 2D selector. Either keep both
         50 px high or both ≤36 px high — not the current mix.
      3. **`Plan confidence` card stack collapses at 480 px.** Today: title row,
         two-line body copy, `What this means` expander — each on its own line
         with generous gap. Collapse the expander affordance + label onto the
         title row (or into a single line that summarises both the level and the
         "what this means" affordance) at the dialog width.

      **Baseline / rhythm sweep (do once after the three above land):** confirm
      section gaps use a consistent `--spacing-*` step across cards and tiles
      (no ad-hoc pixels), and that the baseline grid implied by
      `--font-line-height-*` doesn't drift across stat values, body copy, and
      chip labels on this page.

      **Quantitative aim:** cut at least one fold-worth of vertical scroll on the
      Budget tab at both 480 px and 320 px without sacrificing tap-target sizes
      (≥48 px per `--pels-touch-target-min`).

      Cross-reference: the Overview hero spec at `notes/overview-hero-spec.md`
      for the typographic rhythm the redesign targets.
      Files: `packages/settings-ui/public/style.css` (segmented spacing, card
      padding, section gaps), `packages/settings-ui/src/ui/views/BudgetOverview.tsx`
      (markup consolidation for #1 and #3), `settings/style.css` (regen).

- [ ] Overview Power-Now bar end-marker leaves a small visible gap from the main fill.
      Live-walk 2026-05-16 (`/tmp/pels-live-walk/overview-hero-480.png`) shows the
      orange "current draw" marker rendering slightly offset from the right edge of the
      filled bar — visually ragged. Minor visual rough edge on a hero element.
      Files: `packages/settings-ui/src/ui/views/PlanHero.tsx`,
      `packages/settings-ui/public/style.css`.

- [ ] Settings → Advanced page H2 "Device diagnostics" doesn't describe the page.
      Live-walk 2026-05-16 (`/tmp/pels-live-walk/05-settings-advanced-480-1.png`):
      the page header reads "Device diagnostics" but the page contains Debug logging
      categories + Daily-budget tuning + Data management + Device cleanup + Device
      log. Rename to "Diagnostics & maintenance" or similar so users can predict
      what they'll find under the entry.
      Files: `packages/settings-ui/src/ui/views/AdvancedSettings.tsx` (or markup
      equivalent), `packages/shared-domain/src/...` (copy helper if heading sourced
      from there).

- [ ] Settings → Electricity prices: two `<select>` controls render at different
      contrast on the same page. Live-walk 2026-05-16
      (`/tmp/pels-live-walk/05-settings-prices-480-top.png`) shows one select inverted
      / washed and another at full contrast. Material `md-outlined-select` falls back
      to light-theme defaults that ghost on the dark UI (per project memory
      `feedback_form_styling`); the fix is to follow the Limits & safety / Simulation
      mode pattern (native `<select>` + `.field`) — but apply it once globally
      wherever an `md-outlined-select` is still in use, not surface-by-surface.
      Files: `packages/settings-ui/src/ui/views/...` (electricity prices markup),
      grep for `md-outlined-select` across `packages/settings-ui/src/`.

- [ ] Inconsistent chart styling between Smart-task active and history details.
      Live-walk 2026-05-16 (`/tmp/pels-live-walk/04-smart-task-active-detail-480.png`,
      `04-smart-task-history-succeeded-480.png`): active detail uses pale-grey
      rectangle bars + green dashed step markers; history detail uses dashed-outline
      bars with no fill. Two different chart languages for the same feature surface.
      Pick one (likely the active one — filled bars + step markers is more readable)
      and apply across both views.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`.

- [ ] Smart-task active detail repeats "Cannot finish" 3× (pill, headline, body).
      Live-walk 2026-05-16 (`/tmp/pels-live-walk/04-smart-task-active-detail-480.png`).
      Reads as alarm spam rather than information. Keep the pill + one explanatory
      line; drop the duplicate copies.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`.

- [ ] Usage heatmap: color-scale legend on the right edge lacks a kWh unit label.
      Live-walk 2026-05-16 (`/tmp/pels-live-walk/03-usage-detailed-480.png`) shows
      the heatmap right-edge color scale with numeric values but no unit. Add `kWh`
      (or `kr/kWh` if that's what the scale encodes — verify) so the user knows
      what intensity means.
      Files: `packages/settings-ui/src/ui/views/UsageOverview.tsx`,
      `packages/settings-ui/src/ui/powerWeekChartEcharts.ts`.

- [ ] Overview "Termostat TV-stue" device card missing temperature line.
      Live-walk 2026-05-16 (`/tmp/pels-rewalk/overview/07-tv-stue-missing-temp.png`):
      renders as `On / 0.0 kW` only; every other temperature card shows
      `xx.x° · target yy°`. Card height drops to 99 px while peers are 125 px.
      Data fallback inconsistency when the measure is missing/null — either render
      a placeholder ("Temperature unavailable") or reserve the line so the card
      grid stays uniform.
      Files: `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx`,
      `packages/shared-domain/src/...` (per-device summary builder).

- [ ] Overview cards use two parallel chip primitive families for similar roles.
      Live-walk 2026-05-16: Elbillader uses `plan-state-chip plan-state-chip--neutral`
      (`/tmp/pels-rewalk/overview/15-elbillader-card.png`); Nordic S4 REL uses
      `plan-chip plan-chip--muted` (`/tmp/pels-rewalk/overview/16-nordic-s4-card.png`).
      Same semantic role ("manual control" / off-by-user status) rendered through
      two unrelated chip primitives. Token/primitive consolidation gap; pick one
      chip family and migrate the other call sites.
      Files: `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx`,
      `packages/settings-ui/public/style.css` (chip primitive definitions),
      `settings/style.css` (regen).

- [ ] Overview "Smart task" chip nested in clickable card has no `aria-label`.
      Live-walk 2026-05-16 (`/tmp/pels-rewalk/overview/14-connected-300-card.png`):
      the chip is rendered as `<a>` and announces only "Smart task link" to screen
      readers. Add `aria-label="Smart task for {deviceName}"` and clarify the
      hit-target so the chip click separates from the parent card-navigation click.
      Files: `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx`.

- [ ] Overview hero warning indicator uses raw unicode emoji instead of the
      design-system SVG icon set. Live-walk 2026-05-16
      (`/tmp/pels-rewalk/overview/18-hero-states-compare.png` right pane): the
      "projected X kWh ⚠️" annotation in above-safe-pace state renders a literal
      ⚠️ character rather than the project's SVG icon primitive used everywhere
      else. Design-system inconsistency.
      Files: `packages/settings-ui/src/ui/views/PlanHero.tsx`,
      `packages/settings-ui/src/ui/...` (icon imports).

- [ ] Overview energy bar `--projected` marker misaligned with printed projection.
      Live-walk 2026-05-16 (`/tmp/pels-rewalk/overview/10-energy-used-bar-detail.png`,
      `02-overview-hero-480.png`): teal projected dot sits at ~75 % of the track
      while the printed projection reads 1.95 / 2.3 ≈ 85 %. Either the marker
      uses a different basis or there's a small positioning bug. Reconcile so the
      visual position matches the printed number to within 1-2 %.
      Files: `packages/settings-ui/src/ui/views/PlanHero.tsx`,
      `packages/settings-ui/public/style.css` (marker percent calculation).

- [ ] Overview hero "Safe pace now X kW" subline disappears in above-safe-pace
      state. Live-walk 2026-05-16
      (`/tmp/pels-rewalk/overview/18-hero-states-compare.png`): the safe-pace
      numeric reference is shown only in the on-pace state; in the very state
      the user most wants the number ("how much over am I?"), the subline
      vanishes leaving only "Power Now". Keep the safe-pace reference visible
      in both states.
      Files: `packages/settings-ui/src/ui/views/PlanHero.tsx`,
      `packages/shared-domain/src/...` (copy resolver).

- [ ] Overview device-card stack has uneven vertical rhythm.
      Live-walk 2026-05-16 (`/tmp/pels-rewalk/overview/01-overview-480-full.png`,
      `04-overview-bottom-cards-480.png`): card heights vary 99–163 px because
      the temperature line, status-reason line, and stepped-control row are
      conditional. Stack reads as jagged on the tall list. Reserve content with
      a min-height or render placeholder lines so the card grid stays uniform.
      Files: `packages/settings-ui/public/style.css` (`.plan-card` min-height /
      content reservation), `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx`.

- [ ] Punctuation drift on device-card status copy: spec uses em-dash
      (`Limited — staying under the hard cap`, per `notes/ui-terminology.md:9`),
      live render uses middle-dot (`Limited · staying under the hard cap`).
      Live-walk 2026-05-16 noted as a verified-not-glitch but flagged for
      consistency. Pick one separator and apply across the per-device status
      copy helpers.
      Files: `packages/shared-domain/src/...` (per-device status copy),
      `notes/ui-terminology.md` (if the dot is the new intent).

- [ ] Usage heatmap week-navigation chevrons have no visible chrome + use the
      wrong ARIA attribute. Live walk 2026-05-16
      (`/tmp/pels-rewalk/usage/08-heatmap-close.png`): `<md-text-button>`
      chevrons render as tiny bare green icons with no visible affordance, AND
      the accessibility name is set as `data-aria-label` (an arbitrary data
      attribute) instead of `aria-label` — so screen readers will announce the
      button with no label at all. Fix: rename `data-aria-label` → `aria-label`
      (real attribute), and bump the visual chrome (background fill or border)
      so users see something tappable.
      Files: `packages/settings-ui/src/ui/views/UsageOverview.tsx` (or wherever
      the heatmap week-nav lives), `packages/settings-ui/public/style.css`.

- [ ] Usage hero "Daily avg" stat duplicates the "Typical weekend: 62.8 kWh"
      already in the subline. Live walk 2026-05-16
      (`/tmp/pels-rewalk/usage/02-usage-hero-480.png`): same number rendered
      twice in a single hero, only 24 px apart. Pick one location and drop the
      other.
      Files: `packages/settings-ui/src/ui/views/UsageOverview.tsx`.

- [ ] Usage hero double-capsule wastes ~80 px of vertical real estate. Live
      walk 2026-05-16 (`/tmp/pels-rewalk/usage/02-usage-hero-480.png`,
      `/tmp/pels-rewalk/usage/01-usage-480-full.png`): the
      `<header class="pels-hero">` "USAGE / Energy history" eyebrow capsule
      sits above the actual `34.x kWh` hero card with no content between
      them. Two stacked dark capsules consuming ~80 px before the user reaches
      the headline number. Same shape as the Budget tab's "Daily-budget header
      tile" candidate in the P2 rhythm audit — fold the eyebrow into the
      hero card.
      Files: `packages/settings-ui/src/ui/views/UsageOverview.tsx`,
      `packages/settings-ui/public/style.css` (`.pels-hero` markup / padding).

- [ ] Usage tab chart palettes don't share a family. Live walk 2026-05-16:
      three unrelated palettes coexist on the same tab — Daily-usage bars are
      ECharts-default blue, segmented active uses the accent green
      `rgba(34,197,94,0.28)`, heatmap is teal-to-red. None reference the
      documented PELS accent. Pick a palette family rooted in the accent and
      apply across all three chart types so the tab reads as one surface.
      Files: `packages/settings-ui/src/ui/usageDayChartEcharts.ts`,
      `packages/settings-ui/src/ui/usageStatsChartsEcharts.ts`,
      `packages/settings-ui/src/ui/powerWeekChartEcharts.ts`,
      `settings/tokens.css` (chart palette tokens).

- [ ] Delete the dead `#shell-nav .tab[data-tab="settings"]` block at
      `packages/settings-ui/public/style.css:397-403`. The selector duplicates `.tab`'s
      base `margin-left`, `padding-inline`, and `opacity` declarations, and its
      `font-size` / `font-weight` declarations actively fight the compact-mode media
      query at `style.css:2420,2427` — keeping the Settings tab at the non-compact label
      size (13px) while the other four tabs (Overview, Budget, Usage, Smart tasks) shrink
      to the compact size (11px) at narrow widths. Result: Settings reads as visibly
      larger and bolder than the other four in the top nav, breaking typographic
      consistency on the first thing a user sees. Live-confirmed at 480px in both
      light-wrap and dark-wrap via PR #817's fixture
      (`packages/settings-ui/test/fixtures/homey-wrap/homey-wrap-nav.png`). Fix: delete
      the whole block (leftover from a previous design iteration; nothing else depends
      on it). Regen `settings/style.css`.
      Files: `packages/settings-ui/public/style.css`, `settings/style.css` (regen).

- [ ] Idle classifier: surface a signal when a device has a temperature setpoint but no
      `currentTemperature` reading. Today `lib/observer/idleDetector.ts` requires
      `hasTemperatureSetpoint` but allows `currentTemperature` to be absent — `gap` then
      resolves to `undefined` and the classifier short-circuits to `active`. The exact
      fault case the `unresponsive` warning is meant to catch (a sensor stopping
      reporting on a heater that should be heating) silently produces no signal. Either
      tighten eligibility to require both readings and emit a distinct
      `device_sensor_missing` event, or have `classifyByGapAndDuration` return
      `unresponsive` (with undefined `temperatureGapC`) past the long window when
      `gap === undefined`.
      Files: `lib/observer/idleDetector.ts`, `lib/observer/idleClassifier.ts`,
      `packages/shared-domain/src/idleClassificationCopy.ts`, tests.
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
- [ ] Apply the `md-select-option` `displayText` / `typeaheadText` fix outside the mode selects.
      `packages/settings-ui/src/ui/modes.ts:createModeOption` now sets both properties so the
      closed select field reliably shows a non-empty label on first paint, but the same option
      construction pattern still appears in
      `packages/settings-ui/src/ui/advanced.ts:createSelectOption` and
      `packages/settings-ui/src/ui/components.ts:createSelectInput`. They are vulnerable to the
      same Material Web first-render race (the slot-walk for the headline can read empty before
      the option's own first update). Extract a shared `createMdSelectOption(value, label,
      selected?)` helper in `components.ts`, set `displayText` and `typeaheadText` explicitly,
      and route the three callers through it. Extend the regression test in
      `packages/settings-ui/tests/e2e/settings-smoke.spec.ts` (or add focused specs) to assert
      non-empty headline text for Advanced and components-driven selects on first paint.
      Files: `packages/settings-ui/src/ui/advanced.ts`,
      `packages/settings-ui/src/ui/components.ts`,
      `packages/settings-ui/src/ui/modes.ts`,
      `packages/settings-ui/tests/e2e/settings-smoke.spec.ts`.
- [ ] Finish chart-test hardening from the first-impression UI audit. The colour-token subset
      landed (charts now read `--pels-chart-*` role-token aliases, no remaining hex literals).
      This P2 entry covers the remaining non-colour test surface: deterministic visual assertions
      for legend text matching rendered series, explicit axis/tooltip units, price-unit
      normalization, SVG bounds, and no deadline legend/axis overlap at 320 / 480 px. A
      token-resolution regression test that asserts `--pels-chart-plan` resolves to the same hex
      as the on-page Plan legend swatch would also belong here.
      Files: `packages/settings-ui/src/ui/budgetRedesignChart.ts`,
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
- [ ] Add `objective_missing_capacity` user-facing copy for thermal smart tasks. A new water
      heater (or any thermal device without `measure_power`) never builds a `kWhPerUnit`
      profile, so the diagnostics bridge emits `objective_missing_capacity` and the task sits
      "Waiting" indefinitely with no explanation. Thermal objectives intentionally have no
      bootstrap rate (thermal mass varies orders of magnitude across devices), so the only fix
      is to tell the user. One-line copy fix on the pending-reason path: "Learning energy use
      — needs power readings from this device."
      Files: `packages/settings-ui/src/ui/deadlinePlan.ts`,
      `packages/shared-domain/src/deadlineLabels.ts`,
      `packages/contracts/src/deferredObjectiveActivePlans.ts` (if a new pending-reason value is
      needed).
- [ ] Reassess `isLegacyNoneStatusMatch` in `flowCards/deadlineObjectiveCards.ts:167-175`.
      The runlistener accepts legacy dropdown ids (`'none'`, `'pending_prices'`, `'cannot_meet'`,
      `'cannot_finish'`, `'done'`) that don't appear in the shipped dropdown JSON for the
      `deadline_status_is` condition. Either confirm older PELS releases stored these ids in
      user flows (in which case keep the compatibility layer and add a comment + note entry
      documenting the accepted ids) or remove it as dead code. The current state — code accepts
      ids that have never been part of the public API — is technically harmless but invites
      future confusion.
      Files: `flowCards/deadlineObjectiveCards.ts`, `.homeycompose/flow/conditions/deadline_status_is.json`
      (for documentation only).
- [x] "Plan inputs" card title in smart task plan view — rename or clarify terminology rule.
      Renamed to "Smart task inputs" to remove ambiguity and keep the smart-task surface free
      of "plan" terminology (Path A). The existing carve-out in notes/ui-terminology.md remains
      correct for reference but is now moot.
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
- [ ] Animate the "Building plan…" chip so users can tell planning is alive.
      The chip is static text rendered identically whether the planner just started or has been
      stuck for two minutes (live-observed: both seeded tasks stayed in this state past 100 s
      with zero visual change). Add a low-key M3 pulse / progress indicator alongside the chip
      so users have a liveness signal. Same chip primitive across active and detail surfaces;
      reuse the existing tokens.
      Files: `packages/settings-ui/src/ui/views/DeadlinesList.tsx`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/public/style.css`.
- [ ] Reconcile chip tone between the Smart tasks list and the plan detail.
      For the same `Building plan…` state the list card uses `muted` tone but the plan-detail
      pending hero uses `info` tone. Pick one and apply uniformly.
      Files: `packages/settings-ui/src/ui/views/DeadlinesList.tsx`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`.
- [ ] Bring the pending-hero body copy up to action-text weight.
      The "why it's blocked" explanation ("Waiting for a reading from the EV.", "Learning energy
      use — heater needs power readings…") today renders inside `plan-hero__subline--muted` —
      muted secondary color, low contrast. This is the most actionable text on the pending hero
      and should not be demoted. Bump to default-weight body color.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/public/style.css`.
- [ ] Highlight the correct tab when deep-linking into a smart-task plan from the Overview
      device card. Today clicking a smart-task affordance from an Overview device card lands on
      the plan-detail page but leaves the "Overview" tab marked as selected; the user lost the
      visual breadcrumb that they're now under "Smart tasks". Wire the router so the tab
      indicator follows the deep-link.
      Files: `packages/settings-ui/src/ui/deadlinePlanRouter.ts`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`.
- [ ] Add a budget-line overlay to the daily-usage 14-day chart.
      Today the bar chart shows kWh values only; days that exceeded the daily budget or hard
      cap are visually identical to compliant days. Add a horizontal budget reference line and
      color over-budget bars in the warn tone so the user can spot bad days at a glance.
      Files: `packages/settings-ui/src/ui/usageStatsChartsEcharts.ts`.
- [ ] Fix the Usage heatmap "Unreliable data" swatch color.
      The legend swatch in `#power-legend` uses `--color-surface-4` (`#232b38`) while the actual
      heatmap cells use `--pels-chart-unreliable-cell` (`#2a3242`) — perceptibly different. Bind
      the swatch to the same token. While there, delete the dead `.usage-legend__swatch--warn`
      class (never instantiated, references the wrong negative-bg token).
      Files: `packages/settings-ui/public/style.css`, `settings/style.css` (regen).
- [ ] Collapse the Advanced "Data management" / "Daily budget tuning" disclosures by default.
      Both currently render expanded on first view of the Settings → Advanced surface.
      "Data management" lists destructive recovery tools (reset, refresh, etc.) and "Daily
      budget tuning" surfaces low-level planner knobs — neither belongs open before the user
      has asked for them.
      Files: `packages/settings-ui/public/index.html`,
      `packages/settings-ui/src/ui/advanced.ts`.
- [ ] Add a hero summary to the Electricity prices settings panel.
      The panel today opens at the source/tariff configuration; the actual *current* price
      tier and the cheap/expensive thresholds the user sees on Budget aren't visible at the top
      of this panel. A user can't confirm "Yes, PELS thinks 18 öre is cheap right now" without
      digging through the form. Add a small summary card at the panel top: current tier, cheap
      threshold, expensive threshold, last-fetched timestamp.
      Files: `packages/settings-ui/public/index.html` (Electricity prices panel hero),
      `packages/settings-ui/src/ui/electricityPrices.ts`,
      `packages/settings-ui/public/style.css`.
- [ ] Link the Price-aware devices empty state to Settings → Devices.
      Today the empty state references the "Settings > Devices" path as plain text. Make it a
      direct link / button that navigates to the Devices sub-panel.
      Files: `packages/settings-ui/src/ui/priceAwareDevices.ts`,
      `packages/settings-ui/public/index.html`.
- [ ] Consolidate the three near-identical pulse keyframe animations.
      `settings/style.css` defines three pulse keyframes at 1.4 s / 1.5 s / 1.6 s — imperceptibly
      different and not driven from a shared token. Pick one duration, expose as a token, and
      route all three call sites through it.
      Files: `packages/settings-ui/public/style.css`, `tokens/base.json` (add motion token),
      `settings/tokens.css` + `settings/style.css` (regen).
- [ ] Audit `settings/style.css` for hardcoded px / rem values that should bind to tokens.
      Unit 9 catalogued: `gap: 12px`, `gap: 10px`, `padding: 12px`, `border-radius: 8px` in
      `.price-summary`, `margin: 4px`, `font-size: 0.62rem` — none of which map to existing
      tokens. Either bind to existing tokens or introduce missing ones (a `--font-size-xs` or
      a `--spacing-1.5` if those are real gaps). Goal: zero hardcoded geometry/typography
      values outside the token layer.
      Files: `packages/settings-ui/public/style.css`,
      `tokens/base.json`, `settings/tokens.css` (regen).
- [ ] Investigate repeated stale managed-device refreshes that never become fresh.
      `/tmp/pels/start.main.stdout.log` from 2026-05-13 repeatedly emitted
      `stale_device_observation_refresh` with `staleDevices: 2`, `refreshedDevices: 2`, and
      `freshAfterRefreshDevices: 0`. Determine whether those devices lack fresh telemetry,
      targeted refresh is not replacing stale fields, or freshness metadata is preserved
      incorrectly. Add a regression proving stale observations either become fresh when Homey
      returns fresh data or are degraded with a clear reason when they cannot.
      Why P2 (demoted from P1 in release-review pass): investigation work; no confirmed
      user-visible regression. The companion P2 below ("Quiet repeated stale_device_observation_refresh
      log entries") covers the log-noise half.
      Files: `lib/app/appSnapshotHelpers.ts`, observer/device-state freshness helpers,
      snapshot-refresh tests.
- [ ] Deferred-objective diagnostics advertise plan inputs that admission won't apply for
      cap-on devices. `lib/plan/deferredObjectives/admission.ts:72-77` intentionally only
      overrides the cap-off (`device.controllable === false`) fallback — the inline comment
      is explicit that soft objectives "should not bypass restore admission, cooldowns, or
      daily-budget logic" when capacity control is on. But the diagnostic emitted upstream
      (`diagnosticsBridge.ts`) still publishes `requestedMinimumStepId`,
      `usesDeadlineReserve`, and per-bucket `plannedUsefulEnergyKWh` regardless of
      device-controllable state. Result: the runtime log, flow tokens, and (potentially)
      UI/devtools surfaces all describe a planning intent the executor never seeds for
      cap-on devices, so an operator inspecting "why my heater isn't running" cannot tell
      from the diagnostic alone that admission has silently no-op'd. In this audit window
      80/80 horizon plans for `Connected 300` (cap-on water heater) emitted
      `requestedMinimumStepId:"low"` and `usesDeadlineReserve:true` while the device was
      held off the entire session by the normal capacity guard.
      Why P2: behavior is correct by design; the gap is observability, not control
      integrity. Related to but distinct from the existing P2 about `enforcement: 'hard'`
      having no behavioral effect on EV deadlines (`TODO.md` "Make `enforcement: 'hard'`
      actually bypass…").
      Acceptance: either (a) the diagnostic carries a flag that marks plan intent as
      advisory-only when `device.controllable === true && enforcement === 'soft'` (so UI
      and trigger token consumers can render the soft contract honestly), or (b) those
      fields are suppressed for that case. Acceptance test: cap-on soft objective in
      `cannot_meet` produces a diagnostic that does not invite a "we'll heat at low step"
      reading.
      Files: `lib/plan/deferredObjectives/diagnosticsBridge.ts`,
      `lib/plan/deferredObjectives/admission.ts` (read-only — comment is the contract),
      `flowCards/deadlineObjectiveCards.ts` (trigger token shape), diagnostics-bridge tests.
      Source: Pro Homey runtime-log audit 2026-05-17 (`/tmp/pels/start.main.0a4464c3.stdout.log`).
- [ ] Quiet duplicate-snapshot `objective_profile_non_monotonic_time` rejections.
      `lib/core/deviceManagerParseSnapshot.ts:58-84` (`resolveLastFreshDataMs`) takes
      `Math.max(...)` over multiple Homey capability `lastUpdated` timestamps. When the
      device temperature value hasn't moved but another capability (target_temperature,
      measure_power, evcharger_charging_state, etc.) emits a fresh `lastUpdated`, the
      snapshot rebuilds with the *same* `value` and a flat-or-slightly-shifted floor —
      occasionally `-2` to `-4 ms` when one capability ages out of the `Math.max` and an
      older capability becomes the new winner. The monotonicity guard at
      `lib/core/objectiveProfiles.ts:346` then emits an `objective_profile_sample_rejected
      reasonCode:objective_profile_non_monotonic_time` event with `valueDelta:0`. In this
      audit window 14/27 sample rejections are this pattern. No correctness impact (the
      duplicate would not have improved learning) but the log noise burns 15-minute
      rejection-throttle windows on real same-reason rejections and inflates the per-device
      "rejected" counter.
      Why P2: observability/log-quality cleanup, no user-visible regression.
      Acceptance: suppress the `objective_profile_non_monotonic_time` rejection event (and
      `rejectedSamples` increment) whenever the rejected sample has `value` equal to
      `previous.lastSample.value` — this covers both exact `(observedAtMs, value)` duplicates
      (`intervalMs === 0`) and the `intervalMs ∈ {-2, -4}` cases where a different capability
      ages out of the `Math.max` floor and `value` is unchanged. Regression: feed (a) two
      identical `(observedAtMs, value)` samples and (b) a sample with `observedAtMs` 4 ms
      less than previous and unchanged `value`; assert no rejection event fires in either case
      and `rejectedSamples` is not incremented.
      Files: `lib/core/objectiveProfiles.ts`, `lib/core/objectiveProfileSamples.ts`,
      sample-pipeline tests.
      Source: Pro Homey runtime-log audit 2026-05-17 (`/tmp/pels/start.main.0a4464c3.stdout.log`).
- [ ] Plan engine fires before the first device snapshot lands, producing a one-cycle
      `deferred_objective_unknown reasonCode:objective_missing_device` event on every
      restart. `app.ts:758-771` calls `initDeviceManager` then `initPlanEngine` without
      awaiting `refreshSnapshot()`; `lib/core/deviceManager.ts:1457-1460` emits
      `device_api_initialized` immediately after `liveFeed.start()`. The first scheduled
      plan rebuild fires before the snapshot resolves and
      `lib/plan/deferredObjectives/diagnosticsBridge.ts:216` correctly emits
      `unknown / objective_missing_device` for any objective whose device isn't in
      `deviceById` yet. In this audit window the spurious event fired at 09:52:01.227Z and
      was replaced by a valid horizon plan ~2.7s later. Persistence is safe (1h
      abandon-grace in `activePlanRecorder.ts:24`) but the status snapshot is published via
      `statusBus`, so a one-cycle `waiting → unachievable` flow trigger fires every
      restart for any objective whose post-warmup status is `cannot_meet`.
      Why P2: cosmetic/spurious-flow-trigger, recurs every restart. Not data-destructive.
      Acceptance: hold the first plan rebuild and the first `statusBus` publish until the
      first `refreshSnapshot()` completes (or until a configurable bound expires).
      Regression: start the app with an unresolvable Homey Manager fetch and confirm no
      `deferred_objective_unknown` is emitted until the snapshot bound elapses.
      Files: `app.ts`, `lib/core/deviceManager.ts`,
      `lib/plan/deferredObjectives/diagnosticsBridge.ts`, app-startup integration test.
      Source: Pro Homey runtime-log audit 2026-05-17 (`/tmp/pels/start.main.0a4464c3.stdout.log`).
- [ ] Energy training stuck at `bandsCount:0` for thermostats with no `crediblePowerW`.
      `lib/core/objectiveProfileSamples.ts:57-82` returns `kwhPerUnit:null` when neither
      `measuredPowerKw > 0` nor `reportedStep.planningPowerW > 0` is present at sample
      time. `lib/core/objectiveProfiles.ts:436-438` then skips the band buffer update, so
      the device's adaptive band fitter (per `notes/objective-profile-bands.md`) never
      sees any input. `Termostat Synne` in this audit window had `acceptedSamples:67` but
      `bandsCount:0`, `rateConfidence:"low"`, `energyConfidence:"low"`. For thermostats
      without an inline meter and without a per-step planning-power configured, energy
      training is effectively disabled — no warning, no recourse surfaced to the user.
      Why P2: silent gap; user expectation is "the longer this runs the smarter it gets"
      and the reality is that some devices will not improve regardless of sample count.
      Acceptance: either (a) when `crediblePowerW` is unresolved across N consecutive
      accepted samples, emit a one-shot `objective_profile_no_power_source` diagnostic so
      the user knows which devices need step power configured; or (b) fall back to a
      device-class default `planningPowerW` for the reported step when the user has not
      configured one, with a clear logging trace. Either path documents the requirement in
      `notes/objective-profile-bands.md`.
      Files: `lib/core/objectiveProfileSamples.ts`, `lib/core/objectiveProfiles.ts`,
      `notes/objective-profile-bands.md`, profile-sample tests.
      Source: Pro Homey runtime-log audit 2026-05-17 (`/tmp/pels/start.main.0a4464c3.stdout.log`).
- [ ] Clamp stale EV boost stepped-load intent after boost deactivates.
      When EV boost admits a higher charger step and a later SoC update turns boost off, the next
      plan can briefly carry the old higher `desiredStepId` even when the shed-invariant reason
      says the step-up should not be admitted while other devices are still limited. This is
      expected to self-correct on later step/power observations, but the planner should eventually
      clamp the desired/target step to the currently allowed step when the boost exemption no
      longer applies.
      Why P2 (demoted from P1 in release-review pass): the entry's own text confirms
      "expected to self-correct on later observations" — no persistent user-visible state.
      Files: `lib/plan/planRestoreHelpers.ts`, `lib/plan/planDevices.ts`,
      EV boost / stepped restore tests.
- [ ] Make stepped swap completion use confirmed step evidence instead of planner-effective
      `selectedStepId`. `cleanupCompletedSwaps()` currently treats a pending stepped swap target
      as complete when `selectedStepId` is at or above the requested step, but that field can be
      an observer-resolved planning fallback rather than materialized/reported state. Post-release,
      move this completion check to reported/materialized step evidence so lower-priority swapped
      devices are not released before the target step is actually confirmed.
      Why P2 (demoted from P1 in release-review pass): the entry's own text says "Post-release";
      internal hardening, not user-visible.
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
      Why P2 (demoted from P1 in release-review pass): the user-visible symptom is already
      fixed by the keep-invariant gate; the remaining work is internal-only refactor.
      Files: `lib/executor/executableSteppedLoadProjection.ts`, `lib/executor/executablePlan.ts`,
      `lib/executor/planExecutionDrift.ts`, stepped executable projection/drift tests.
- [ ] Extract a shared `PersistedSettingsState<T>` helper for recorder-style settings storage.
      Three modules currently reimplement the same dirty / debounce / abandon-grace / flush /
      plausibility cascade: `lib/app/appPowerCalibrationWiring.ts` (calibration),
      `lib/plan/deferredObjectives/planHistory.ts`, and
      `lib/plan/deferredObjectives/activePlanRecorder.ts`. After the helper lands, migrate
      calibration first, then the two deferred-objective recorders.
      Design context in `notes/persisted-settings-state.md`.
      Why P2 (demoted from P1 in release-review pass): pure refactor — three modules
      duplicating the same pattern. No user-visible difference.
      Files: new `lib/persistence/` or `lib/utils/persistedSettingsState.ts`,
      `lib/app/appPowerCalibrationWiring.ts`, `lib/plan/deferredObjectives/planHistory.ts`,
      `lib/plan/deferredObjectives/activePlanRecorder.ts`, recorder/persistence tests.
- [ ] Unify stepped restore admission wrappers so pending-swap source-off holds and stepped swap
      executor context are applied consistently across normal restore planning, restore cooldown,
      meter-settling, and active stepped upgrade paths.
      Why P2 (demoted from P1 in release-review pass): hardening against future bugs ("makes
      narrow bypasses easy when a new restore branch calls planRestoreForSteppedDevice
      directly"). Not a current user-visible bug.
      Files: `lib/plan/planRestore.ts`, `lib/plan/planRestoreHelpers.ts`,
      stepped swap / restore-cooldown tests.
- [ ] Bring the smart-task history detail view to full live-plan chart parity.
      The history detail page currently renders a summary card plus original/final planned-hour
      tables (`packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`). The live
      `DeadlinePlan` view shows a richer hour-by-hour chart with price tone, projected progress,
      and original-vs-current charge overlay. Reconciling the two would let users compare past
      runs apples-to-apples with the current plan instead of switching mental models.
      Why P2 (demoted from P1 in release-review pass): feature enrichment — the history page
      is functional today, just thinner than the live page. Parity is product improvement, not
      bug fix.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      `packages/settings-ui/src/ui/deadlinePlan.ts` (synthesise a `DeadlinePlanPayload` from a
      history entry without depending on stale bootstrap prices/profile).
- [ ] Compose a one-sentence postmortem on the smart-task history detail page.
      Live-Homey walk on 2026-05-16 (`notes/smart-task-ui/README.md`) confirmed the page a
      missed-deadline notification visitor lands on shows date + chip + device + (sometimes)
      plan-vs-plan chart and nothing else. The diagnostic data needed to compose
      `The daily energy budget ran out during planned hours 03:00–05:00.`
      or `The heater needed ~17 kWh but PELS could only fit ~12 kWh in the cheap window`
      or `EV was unplugged at 02:45 during planned charging`
      is already on the diagnostic stream and the persisted entry. Build a postmortem
      resolver in `packages/shared-domain/src/deferredPlanHistory.ts` that takes the entry
      shape (outcome, final progress, target, deadline, observed intervals,
      `cannotMeetDailyBudgetExhausted`-derived flag if persisted) and returns one sentence.
      Render it at the top of `DeadlinePlanHistoryDetail.tsx` hero. Six outcome variants:
      `met-with-margin`, `met-with-overshoot`, `met-at-buzzer`, `missed-by-shortfall`,
      `missed-by-budget-exhaustion`, `abandoned-by-clear` / `abandoned-by-unplug`, `unknown`.
      Companion to the existing P1 entries that promote the outcome chip and add the recourse
      path. The recourse path tells the user *what to do*; the postmortem tells them *why*.
      Why P2: the largest single trust improvement for the failure-investigation persona;
      the page barely earns its visit without it.
      Files: `packages/shared-domain/src/deferredPlanHistory.ts` (new resolver),
      `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      `packages/contracts/src/deferredObjectivePlanHistory.ts` (only if the budget-exhaustion
      flag needs to be persisted), six-variant resolver tests.
- [ ] Render `Cost ≈ X kr` on the smart-task live hero, past-task list rows, and history detail.
      The existing P1 entry "Add `deliveredKWh` and `totalCost` to
      `DeferredObjectivePlanHistoryEntry`" lands the contract; this is the rendering follow-up.
      For the live hero, derive `Σ priceValue × deviceKwh` over the planned hours each cycle
      (no persistence needed). For past entries, use `totalCost` once persisted. The single
      biggest hole on a price-optimization product's most-visited pages.
      Why P2: depends on the upstream contract change. Sequence after.
      Files: `packages/settings-ui/src/ui/deadlinePlan.ts` (live cost derivation),
      `packages/settings-ui/src/ui/deadlinePlanHero.ts` (meta line),
      `packages/settings-ui/src/ui/views/DeadlinePlanHistory.tsx` (past list row),
      `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx` (history hero),
      price/cost rendering tests.
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
- [ ] Add a "delivered so far" strip to the smart-task live hero for queued / active /
      cannot-meet plans. Today the live page tells the user the *plan* but tells them very
      little about *actual delivery so far in this run*. The dotted `Measured Heating` /
      `Measured Charging` line in the chart is the only acknowledgement and easy to miss.
      Render `Delivered 1.8 of 4.2 kWh · 35 → 42 °C of 65 °C target · on plan / 0.3 kWh behind`
      in the hero meta or as a third subline. The cannot-meet branch should show the same strip
      reframed: `Delivered 1.8 of 4.2 kWh · still 35 °C of 65 °C target · won't reach by 16:00`.
      Why P2: matches the live page emphasis "what's next" with the missing emphasis "what's
      happened so far"; closes the live-during-run history gap discussed in
      `notes/smart-task-ui/README.md`.
      Files: `packages/settings-ui/src/ui/deadlinePlanHero.ts`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`, live-hero unit tests.
- [ ] Add an `Overshoot {N} {unit}` muted line on Succeeded history entries where the final
      progress materially exceeded the target. Live-Homey walk found a Succeeded run with
      `29.3 °C → 77.7 °C · target 65.0 °C` — overshot by 12.7 °C — surfaced as a normal success
      with no flag. Overshoots that large often indicate the deferred override stopped applying
      when satisfied flipped live and the device-local thermostat kept running on its own; a
      muted line is enough to let the user spot a tuning problem. Threshold: > 5 °C for
      thermal, > 10 % for EV (mirror the bands the hysteresis design proposes).
      Why P2: passive support-cost reduction; users who notice the overshoot today have no
      surface that confirms it's interesting.
      Files: `packages/shared-domain/src/deferredPlanHistory.ts` (new
      `formatPlanHistoryOvershootLine` helper),
      `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      `packages/settings-ui/src/ui/views/DeadlinePlanHistory.tsx` (past list row variant),
      overshoot-resolver tests.
- [ ] Surface miss-streak aggregate on the Smart tasks landing page when recent miss density
      is high. A user with three consecutive missed deadlines today sees three Missed chips in
      sequence but no aggregate signal that the device is failing a *pattern*. Add a section
      subhead under `Past tasks`: `Past tasks (3 of last 4 missed)` when
      `missed / first-4-entries >= 0.5`. Pure aggregation over the already-loaded
      `DeferredObjectivePlanHistoryEntry[]`. Discoverable via
      `notes/smart-task-ui/README.md` (lived-state Connected 300 example).
      Why P2: the pattern is what tells the user "investigate this device's setup," not the
      individual miss; the current surface forces them to mentally aggregate.
      Files: `packages/settings-ui/src/ui/views/DeadlinesHistoryList.tsx`,
      `packages/settings-ui/src/ui/deadlinesList.ts`, list aggregate tests.
- [ ] Reuse one chart vocabulary for past-hours-in-a-live-run and past-hours-in-history.
      Today the live chart paints planned bars + a dotted measured line; the eye treats them
      as separate. After a run, the history chart shows planned bars + (eventually, when the
      `deliveredKWhByHour` contract addition lands) overlay delivered bars. Once both surfaces
      can render planned-vs-delivered overlay bars, switch the live chart to use the same
      overlay shape for past hours within the active run. Users learn one chart vocabulary,
      not two. Depends on the upstream `deliveredKWh` contract change.
      Why P2: vocabulary unification, supports the live → history end-of-run transition
      below.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      shared chart-option helper if extracted.
- [ ] Cross-link from smart-task history detail to Usage's same-day chart for the device.
      A user investigating "why did this run miss?" benefits from seeing the device's
      whole-day power profile around the deadline. Today neither view links to the other.
      One-line link below the history hero: `See {device name} usage on {date} →`. Reverse
      direction (Usage → Smart tasks) is intentionally not added; Usage users aren't asking
      task-shaped questions.
      Why P2: bridges two parallel surfaces that today co-exist without acknowledgement.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      `packages/settings-ui/src/ui/deadlineUrls.ts` (usage deep-link builder).
- [ ] Complete the `--day-view-color-*` → `--pels-chart-*` migration on Budget surfaces.
      The shimmed token pair (`--day-view-color-background-usage` /
      `--day-view-color-managed-usage`) is still bound to `--color-role-info` /
      `--color-role-warn` at `packages/settings-ui/public/style.css:4490-4493`, with four
      remaining consumers (`style.css:4615, 4620, 4728, 4732`) reading the shim with
      `--color-base-*-default` fallbacks. The Playwright e2e
      `packages/settings-ui/tests/e2e/daily-budget-rollover.spec.ts:205,209` also asserts
      against the shim names. Two budget chart legend swatches at lines 4188 and 4192 are
      currently on the shim and visually need to match the actual chart cells they label.
      An ad-hoc patch sat as WIP on the main worktree (rebind only the two legend swatches
      directly in the generated `settings/style.css`) — rejected because (a) editing the
      generated bundle is reverted on next `npm run build:settings`, and (b) two-of-six
      rebound is half a migration that risks legend/chart-cell divergence on the
      unmigrated surfaces.
      Minimum acceptable completion: rebind all 6 consumers in
      `packages/settings-ui/public/style.css` from `--day-view-color-*` to
      `--pels-chart-*` tokens, remove the shim definitions, update
      `daily-budget-rollover.spec.ts` to read the new names, regen `settings/style.css`
      via `npm run build:settings`, confirm the Budget legend and rendered chart cells
      bind to the same hex at 320 / 480 px.
      Why P2: pure visual-token cleanup; current rendering is coherent (legends and cells
      both read the shim), so user-visible incorrectness does not apply yet. Required
      before the chart-token P0's "shims removed after one release" promise can land.
      Files: `packages/settings-ui/public/style.css`,
      `packages/settings-ui/tests/e2e/daily-budget-rollover.spec.ts`,
      `settings/style.css` (regen).
- [ ] Extend the snapshot-fallback pattern used by `writeFreshSetting` callers in
      `deviceDetail/index.ts` and `deviceDetail/shedBehavior.ts` to the remaining
      settings-write call sites. `managedControl.ts`, `nativeWiring.ts`,
      `targetPowerConfig.ts`, `evBoost.ts`, and `temperatureBoost.ts` still pass
      `fallbackValue: {}` and would synthesise an empty map if the Homey SDK
      transiently returned a non-null, non-object value (e.g. a string from
      corrupted state). The helper already protects the realistic null transient
      blip, so this is a defence-in-depth item, not a release blocker.
      Files: `packages/settings-ui/src/ui/deviceDetail/managedControl.ts`,
      `packages/settings-ui/src/ui/deviceDetail/nativeWiring.ts`,
      `packages/settings-ui/src/ui/deviceDetail/targetPowerConfig.ts`,
      `packages/settings-ui/src/ui/deviceDetail/evBoost.ts`,
      `packages/settings-ui/src/ui/deviceDetail/temperatureBoost.ts`.
- [ ] Sync `docs/plan-states.md` device-card secondary-text language with `notes/ui-terminology.md`.
      `docs/plan-states.md:26` still describes the held-state secondary text as "Limited by PELS"
      while `notes/ui-terminology.md:100` and the live UI (post PR 4.4) now use `Lowered by PELS`
      / `Charging paused`. Update the doc paragraph so the public docs site matches the shipped UI.
      Why P2: docs-only drift; live UI is already authoritative.
      Files: `docs/plan-states.md`.

## P2 M3 alignment pass (post desktop-light-mode-fix)

Deferred from the desktop-light theme-model review (2026-05-17). The theme-model
change scoped itself strictly to the colour palette — the items below are the
broader Material 3 / Homey-look alignment direction surfaced during that review
but explicitly out of scope for the patch landing. Each is a separate effort,
should not be folded into the same PR.

- [ ] Real M3 token layer: migrate PELS from its current mixed
      `--color-base-*` / `--color-role-*` / `--md-sys-color-*` graph to a strict
      M3 `--md-sys-color-*` role layer. Components consume roles only — no raw
      hex, no opacity stacks, no one-off colours. Touches every component CSS
      file, every `--md-*` binding in `packages/settings-ui/public/style.css`,
      every chart palette consumer under `packages/settings-ui/src/ui/charts/`.

- [ ] Calmer PELS primary on light surfaces: tone `--color-base-accent-default`
      from the current vivid `#22c55e` to something nearer `#16a34a` (green-600)
      so the accent reads as "calm green" against white cards rather than
      "bright fluorescent". Verify against Homey's own primary blue intensity
      for parity. Re-verify the post-invert form for desktop dark.

- [ ] Reduce orange weight on PELS-controlled / over-budget / simulation-mode
      device and hero cards: today's CSS paints a full amber border around any
      card in a warning state (Water Heater "Turned off by PELS", simulation
      hero rim). On the new light canvas three warning cards in one viewport
      reads as "everything is on fire". Migrate to a chip / state-rail (4 px
      left rail in role colour + role-toned title + neutral border on the other
      three sides) per the M3 status pattern. Files:
      `packages/settings-ui/public/style.css` (`.plan-hero[data-tone]`,
      `.pels-hero[data-tone]`, device-card warning state rules).

- [ ] Replace the heavy filled-pill tab strip with an M3 tabs / navigation
      treatment (underline indicator + label, or a smaller pill). Verify the
      `Smart tasks` label still fits at 320 px without wrapping. Files: shell
      navigation rules near `.tabs` / `.tab` selectors in
      `packages/settings-ui/public/style.css`, focus styles, panel transitions.

- [ ] Rework metric hero typography: drop long headline strings like
      "0.3 of 4.5 kWh used" in favour of numeric-first stacks
      ("0.3 kWh" → "of 4.5 kWh used this hour"). Enable `font-feature-settings:
      "tnum"` on metric numbers, scale display type down at 320 px. Also drop
      the all-caps eyebrow above section h2s ("DAILY BUDGET" / "ENERGY HISTORY"
      / "SMART TASKS" / "CONFIGURE PELS") — Homey-native uses single-weight
      sentence-case section labels with no eyebrow; today's eyebrow + display
      heading reads as a marketing idiom. Files: `packages/shared-domain/src/`
      metric format helpers, every hero template in
      `packages/settings-ui/src/ui/views/`.

- [ ] Progress visual cleanup: standardise on M3 tracks + semantic colour for
      bar/segment progress (Energy used, Daily usage, smart-task plan).
      Self-explanatory markers; remove unlabelled dark ticks; legends compact
      and readable. Files: `packages/settings-ui/src/ui/charts/`,
      `packages/settings-ui/public/style.css` (`.power-meter*`, `.pels-meter*`).

- [ ] Calmer device-card defaults on the light canvas: keep normal devices on
      plain white cards with neutral borders; reserve tone treatment for true
      attention states only (paired with the orange-weight item above).

- [ ] Homey-native Settings nav: today the Settings tab lists `Limits & safety`,
      `Devices`, `Modes`, `Electricity prices`, `Price-aware devices`,
      `Simulation mode`, `Advanced` as individually-bordered chevron-only cards.
      Homey's own settings group these into a single list with internal dividers
      and pair each row with a flat outline icon (cf. Living Room / Kitchen
      icons in Homey's app nav). Migrate to a single dividerised list and add a
      flat outline icon per row. Files: Settings tab markup under
      `packages/settings-ui/src/ui/views/`, list/divider rules in
      `packages/settings-ui/public/style.css`.

- [ ] Architectural debt — saturated semantics drift under Homey's invert.
      Amber warn pills become pink/magenta and `Missed` / `Succeeded` chips
      drift inconsistently when Homey's dark-mode `filter: invert(1)
      hue-rotate(180deg)` lands on PELS. Not fixable from PELS alone: needs
      either a Homey-side theme signal we can read at runtime, or source values
      whose post-invert form preserves the same role tone. Park until Homey
      ships a signal or until we move to a theme-handshake protocol.

## P3 Future and Exploratory Work

- [ ] Add Playwright assertion that the segmented short/full labels never co-render.
      PR 3.2 introduced a dual-label pattern on `.segmented__option-label--full` /
      `--short` toggled by `@media (max-width: 360px)`. If a future CSS regression
      breaks the toggle, both spans could render concurrently. A 480 px probe
      asserting `--short` width is 0, and a 320 px probe asserting `--full` width
      is 0, would catch the dual-render regression.
      Files: `packages/settings-ui/tests/e2e/`, `packages/settings-ui/public/style.css`.

- [x] Watch `position: fixed` behavior under the prior counter-filter
      (`:root { filter }` containing-block risk flagged in PR #827 gemini review).
      *(closed: the counter-filter is gone. PELS no longer applies a CSS filter on
      `:root` — `.toast`, `.overlay`, `.slide-panel`, `.deadline-page-close` now
      live under the normal initial containing block in both Homey themes.
      Superseded by the light-canvas redesign documented at
      `notes/desktop-light-mobile-dark.md`.)*

- [ ] Overview device-name trailing whitespace. Live-walk 2026-05-16:
      `aria-label="Open device details for Termostat gang "` and several others
      ("Synne ", "vaskerom ", "kontor ", "bad tredje ", "hovedsoverom "). Likely
      user-entered in Homey itself, but a `String#trimEnd` on display would be
      polite and avoid screen-reader pauses.
      Files: `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx` (device
      name rendering), `packages/shared-domain/src/...` (any per-device label
      helper).

- [ ] Resolve `resolveHeroTone` name collision between `usageHero.ts` and `deadlinePlanHero.ts`.
      Two distinct exports share the same name with different signatures
      (`PaceContext → 'ok'|'warn'|'alert'` vs `DeferredObjectiveActivePlanStatusV1 →
      DeadlinePlanHeroTone`). Not a runtime issue today (Vitest/TS scope them per module) but
      a future global rename or IDE auto-import could pick the wrong symbol. Rename one — e.g.
      the deadline helper to `resolveDeadlineHeroTone` or the usage helper to
      `resolveUsagePaceTone`.
      Files: `packages/settings-ui/src/ui/usageHero.ts`,
      `packages/settings-ui/src/ui/deadlinePlanHero.ts`.
- [ ] Split chip label for `at_risk` plans vs `cannot_meet` plans.
      `deadlinePlan.ts:365` folds `at_risk` into `cannotMeet`, and `deadlineLabels.ts:212/290`
      labels the resulting chip "Cannot finish" — but `at_risk` is a recoverable shortfall, not
      an impossibility. The PR that added the hero-tone split now visually distinguishes the
      two (amber rim vs red rim), but the chip text still reads the same. Consider either a
      separate `atRiskChipLabel` ("At risk") or stop folding `at_risk` into `cannotMeet` at the
      payload-build layer.
      Files: `packages/settings-ui/src/ui/deadlinePlan.ts`,
      `packages/shared-domain/src/deadlineLabels.ts`,
      `packages/settings-ui/src/ui/deadlinePlanHero.ts`.
- [ ] Always show observed coverage on smart-task history cards. Today
      `formatPlanHistoryObservedCoverage` returns nothing when no charging was observed,
      hiding the case where the planner thought a device was active but it drew no power.
      Flip to always show "Observed N of M planned hours" — N=0 is the actionable case.
      Files: `packages/shared-domain/src/deferredPlanHistory.ts`,
      `packages/settings-ui/src/ui/views/DeadlinePlanHistory.tsx`,
      `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`.
- [ ] Cross-kind copy sharing in `deadlineLabels.ts` — revisit when first kind-specific
      divergence lands. Temperature and EV share byte-identical `cannotMeetShortfall` and
      `cannotMeetFallback` strings (only `cannotMeetDailyBudgetExhausted` differs by the noun).
      When the first kind-specific branch arrives — likely the unplugged-EV copy from the P1
      "objective_invalid_session" entry — audit whether the shared helpers still make sense or
      if the kinds should split fully. No action until the first divergence.
      Files: `packages/shared-domain/src/deadlineLabels.ts`.
- [ ] Document recurring smart-task usage in `set_*_deadline` flow card hints. The action
      auto-disables the objective after deadline passes (correct, prevents silent replans), but
      the user-facing card hint doesn't explain that users need a daily trigger (e.g.
      "when EV plugged in") to re-arm. One sentence in the JSON `hint` field.
      Files: `.homeycompose/flow/actions/set_ev_charge_deadline.json`,
      `.homeycompose/flow/actions/set_temperature_deadline.json`.
- [ ] Add DST fall-back ambiguity regression test for deadline resolution.
      `lib/plan/deferredObjectives/deadline.ts:112-146` handles DST rigorously (probes timezone
      at ±36h, ±12h, 0h to find valid UTC candidates matching local HH:mm), but the fall-back
      ambiguous hour (e.g. 2:30 AM existing twice) currently selects earliest-future without an
      explicit test. Add the regression.
      Files: `lib/plan/deferredObjectives/deadline.ts`,
      `test/deferredObjectiveDeadline*.test.ts` or similar.
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
- [ ] Retire the legacy-tag sidebar filter in `scripts/sidebarFilter.mjs` once it is dead code.
      Multi-level nesting and the "first nested child swallows the section" case are covered
      by `test/sidebarFilter.test.ts`. Residual fragility is narrower: `//` or `/*` comments
      and template literals inside the rewritten `sidebar.mts` are not modelled. None of these
      occur in the current `docs/.vitepress/sidebar.mts`, and once a release tag ships with
      that file every future live build takes the verbatim-restore path and the filter is
      never invoked. At that point prefer deleting `scripts/sidebarFilter.mjs` and the legacy
      branch in `prepareDocsSource` outright.
      Files: `scripts/sidebarFilter.mjs`, `scripts/build-docs-channels.mjs`,
      `test/sidebarFilter.test.ts`.
- [ ] Compose a `notification_text` token on the `deadline_ended` flow trigger for
      `outcome = missed` only. `notes/smart-task-flow-cards/README.md` deliberately rejected
      a composed `notification_text` based on Homey-app conventions (other apps emit thin
      tokens for lifecycle events). The convention argument is sound for symmetric lifecycle
      events but weaker for the asymmetric-cost case of a missed deadline: a user holding
      "Smart task missed for Connected 300" is mid-shower with no hot water and would
      strongly benefit from a one-sentence reason in the notification itself, instead of
      tapping into the Settings UI to find out. Sourced from the same postmortem resolver
      the history detail uses (`packages/shared-domain/src/deferredPlanHistory.ts`); flow-only
      addition, no new diagnostic data needed.
      Why P3: revisits a deliberate-rejection design decision; small but should be debated
      with the flow-card slice in `notes/smart-task-flow-cards/README.md` before landing.
      Related: `notes/smart-task-ui/README.md` Q2.
      Files: `.homeycompose/flow/triggers/deadline_ended.json`,
      `flowCards/smartTaskTokens.ts`, `notes/smart-task-flow-cards/README.md` (update).
- [ ] Replace the live → completed → history hard-cut with an in-place transition.
      When a deadline passes, `DeadlinePlan.tsx` short-circuits to a thin "Smart task
      finished — See History" card and the user is bounced. Live-Homey walk noted this is
      jarring after watching a plan progress for hours. The cleaner shape: the same URL,
      same page, transitioning state — chart series fade from "planned + measured" to
      "planned vs delivered", hero re-shapes from "what's next" to "what happened", URL
      adds `historyId=…` once the history entry is persisted. The page *becomes* the
      history-detail rather than redirecting. Requires the live-page route to recognize
      a completed-but-not-yet-history transient state.
      Why P3: design-shaped polish; the current short-circuit is functional but unloved.
      Related: `notes/smart-task-ui/README.md` §4.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/src/ui/deadlinePlan.ts` (load-state mapping),
      `lib/plan/deferredObjectives/planHistory.ts` (transient handoff to in-page route).
- [ ] Add a banner to the *active* task hero showing "Last [kind] task missed: {short
      reason}" for ~24 h after a finalized miss. The user lands on the active task when
      they open the app worried about the same deadline pattern; the breadcrumb avoids the
      Smart tasks → past row → detail dance. Sourced from the same postmortem resolver as
      the history detail and the missed-notification text.
      Why P3: notification → app breadcrumb; meaningful for the panic-visitor persona but
      lower-effort variants (the postmortem on history detail, the missed-deadline
      notification text) cover the same ground at lower cost.
      Related: `notes/smart-task-ui/README.md` Q2.
      Files: `packages/settings-ui/src/ui/deadlinePlanHero.ts`,
      `packages/settings-ui/src/ui/deadlinePlan.ts` (recent-miss query against
      `DeferredObjectivePlanHistoryEntry`).
- [ ] Extract the shared `start` / `start:local` / `install-app` shell preamble into a
      single wrapper script (e.g. `scripts/run-with-logging.mjs`) so `log_dir`, `branch`,
      and `homey_id` derivation lives in one place instead of three near-identical zsh
      one-liners in `package.json`. Surfaced by gemini-code-assist on PR #818; deferred
      because three occurrences is still on the right side of premature abstraction and
      the wrapper would need to preserve `tee`-to-both-streams behavior and zsh-only
      parameter expansion (`${PWD:t}`).
      Files: `package.json` (scripts: `start`, `install-app`, `start:local`),
      `scripts/resolve-homey-id.mjs`.
- [ ] Add an explicit cap on `DeferredObjectivePlanHistoryEntry.revisions[]` length.
      Surfaced by adversarial-review on v2.7.2 PR 1 (schema v3→v4). The in-memory
      `InProgressRecord.revisions` array is rebuilt with `[...existing, newEntry]` on every
      cycle that observes a new revision (`appendRevisionLogIfNew` in
      `lib/plan/deferredObjectives/planHistoryV4Helpers.ts`). Realistic runs see 5-10
      entries due to the active-plan recorder's per-cycle dedupe, so the persisted size is
      bounded in practice. A pathological replan loop (prices oscillate, `rate_refined`
      keeps firing) could push the array large; the rebuild path is O(n²) over the run.
      Add `MAX_REVISIONS_PER_ENTRY = 64` with drop-oldest semantics mirroring
      `PROGRESS_SAMPLES_PER_ENTRY_CAP`, or switch the recorder to a `push`-based mutation
      pattern guarded by a single dirty flag.
      Why P3: speculative future-proofing; no observed pathological trigger today.
      Files: `lib/plan/deferredObjectives/planHistoryV4Helpers.ts`,
      `lib/plan/deferredObjectives/planHistory.ts` (`InProgressRecord.revisions`).
- [ ] Split `lib/plan/deferredObjectives/planHistory.ts` so the file drops back under the
      500-LOC ESLint ceiling without an override.
      Surfaced by adversarial-review on v2.7.2 PR 1. PR 1 added a `planHistoryV4Helpers.ts`
      split but the recorder still sits at ~512 effective lines, requiring an override in
      `eslint.config.mjs` (`max-lines: 520`). A second split — most natural is moving
      `synthesizeBackfillEntry` + `DeferredObjectiveBackfillConfig` + the related
      `backfillFromConfig` body into `planHistoryBackfill.ts` — would free ~40 effective
      lines and let the override come back out.
      Why P3: maintenance hygiene; the override is already documented with a target
      ceiling comment.
      Files: `lib/plan/deferredObjectives/planHistory.ts`,
      `lib/plan/deferredObjectives/planHistoryBackfill.ts` (new),
      `eslint.config.mjs` (remove override once the split lands).
- [ ] Consider single-pass `resolveLiveCostAndDelivery` in `packages/settings-ui/src/ui/deadlinePlan.ts`.
      Surfaced by gemini-code-assist on v2.7.2 PR 2 as Medium. Current implementation iterates
      `hours` twice (once in `resolveLiveCostAndDelivery`, once in `buildTimeline`'s
      `resolveActualDeviceKwh` per-hour) and divides per-hour rather than accumulating raw and
      dividing once. Gemini's proposed shape: cache `deviceBuckets` lookup once, accumulate raw
      totals, single division at end, optionally fold `allocatedKWh` into the same loop.
      Deferred because: (a) horizon is ≤24 hours so the ~24 extra hash lookups + Date conversions
      are negligible; (b) the two passes today separate the chart data path from the cost summary
      path, and merging them tangles two concerns that read cleanly as-is; (c) PR 2's own
      adversarial-review pre-emptively assessed and skipped this exact change with the same
      reasoning. If a future PR adds expensive work inside the hour loop (e.g. PR 4's hourly
      delivered overlay), revisit then.
      Why P3: micro-optimization on a bounded loop; no observed performance issue.
      Files: `packages/settings-ui/src/ui/deadlinePlan.ts` (`resolveLiveCostAndDelivery`,
      `buildTimeline`).
- [ ] Split `packages/shared-domain/src/deadlineLabels.ts` so the file drops back under the
      500-LOC ESLint ceiling without an override.
      Added a `/* eslint-disable max-lines */` header on v2.7.2 PR 2.5 (pending-hero headlineReason
      + recourse). Natural split: pull the smart-task list status helpers
      (`SMART_TASK_LIST_STATUS_LABELS`, `SMART_TASK_LIST_STATUS_CHIP_VARIANT`,
      `resolveSmartTaskListReadyByTone`, `resolveSmartTaskListStatus`) into
      `smartTaskListStatus.ts`, and/or the EV-card state-line helpers
      (`resolveEvCardStateLine`) into `evCardState.ts`. Both groups have stable callers and read
      independently from the kind-aware copy bundle.
      Why P3: maintenance hygiene; the override is documented with the colocation rationale
      (`feedback_ui_text_shared_with_logs` keeps runtime logging + UI reading the same strings).
      Files: `packages/shared-domain/src/deadlineLabels.ts`,
      `packages/shared-domain/src/smartTaskListStatus.ts` (new), `packages/shared-domain/src/evCardState.ts` (new).
- [ ] Move v2.7.2/PR4 chart strings into a shared-domain `historyDetailChartLabels(kind)` helper.
      Surfaced by pels-copy-and-terminology on v2.7.2 PR 4 as P1 (deferred to a follow-up to
      keep PR 4 focused). PR 4 introduced seven new user-visible chart strings inlined in
      `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`: `PLANNED_SERIES_NAME`
      ('Planned trajectory'), `PLANNED_REVISED_SERIES_NAME` ('Revised trajectory'),
      `TARGET_SERIES_NAME` ('Target'), `MET_MARK_NAME` ('Reached target'), card titles
      ('Progress vs schedule' / 'Scheduled vs observed'), legacy fallback note
      ('Schedule only — observations not recorded for this run.'), toggle copy ('View
      schedule' / 'Hide schedule'), tooltip absence suffix (`${observedSeriesName} — not
      recorded`), aria-label (`Progress trajectory for ${deviceName}`).
      Move into a `historyDetailChartLabels(kind)` helper in
      `packages/shared-domain/src/deferredPlanHistoryChartData.ts` (the natural home — same
      file as the chart data producer). Per `feedback_ui_text_shared_with_logs`, runtime log
      breadcrumbs need to read the same strings the user saw.
      Why P2 (downgraded from P1 since strings render correctly today): architecture-level
      consistency. Strings are correct as-is; this is logger-parity hygiene.
      Files: `packages/shared-domain/src/deferredPlanHistoryChartData.ts`,
      `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`.
- [ ] markPoint tone-aware for the "Reached target" dot on the history-detail chart.
      Surfaced by pels-m3-critic on v2.7.2 PR 4 as P2. The `metAtMs` markPoint uses
      `palette.observed` (green) fill regardless of hero tone. In practice the marker only
      renders when `outcome === 'met'` → hero tone is always `good` (green gradient) and
      contrast is fine. Defensive design: if a future variant ever attaches `metAtMs` to a
      warn-tone shape (e.g. `met-with-overshoot` if it gets re-classified), green-on-warn
      would be low-contrast. Either pin the marker to neutral tokens (`--pels-status-on-good`
      fill + `--pels-text-primary` stroke), or thread hero tone into
      `buildHistoryDetailTrajectoryOption` so the marker style branches.
      Why P3: today the marker only renders on `good` heroes; the contrast concern is
      defensive against a hypothetical future variant.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`.
- [ ] Test history-detail chart legend wrap at 320 px and bump `grid.top` if needed.
      Surfaced by pels-m3-critic on v2.7.2 PR 4 as P2. Trajectory legend has 4 entries
      ('Planned trajectory' / 'Revised trajectory' / 'Measured Heating' / 'Target') and may
      wrap to two rows at 320 px, crowding the chart top edge. Static `grid.top: 44` reserves
      single-line height. Either dynamic grid-top calculation or bump to 60 unconditionally;
      mirror PR 1's `containLabel: true` pattern. Add a 320 px Playwright snapshot to
      regression-protect.
      Why P3: cosmetic at narrow width; chart still renders correctly.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      `packages/settings-ui/tests/e2e/charts-layout.spec.ts`.
- [ ] Hoist the `useEchartsMount` helper from `DeadlinePlanHistoryDetail.tsx` to a shared
      module in `echartsRegistry.ts`. PR 4 introduced the helper file-locally, but the
      same init/dispose/resize pattern exists in `powerWeekChartEcharts.ts`,
      `usageStatsChartsEcharts.ts`, `budgetRedesignChart.ts`, `usageDayChartEcharts.ts`,
      `DeadlinePlan.tsx`. Hoisting to `mountEcharts(container, buildOption, deps)` is the
      actual primitive-consolidation win that PR 4 claimed; as-is it remains a parallel
      pattern. Surfaced by pels-m3-critic as P3.
      Why P3: maintenance hygiene; current pattern works but doesn't dedupe across charts.
      Files: `packages/settings-ui/src/ui/echartsRegistry.ts`,
      `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      `packages/settings-ui/src/ui/powerWeekChartEcharts.ts`,
      `packages/settings-ui/src/ui/usageStatsChartsEcharts.ts`,
      `packages/settings-ui/src/ui/budgetRedesignChart.ts`,
      `packages/settings-ui/src/ui/usageDayChartEcharts.ts`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`.
