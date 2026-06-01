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

- [ ] **Available power (`headroom`) not loveable.** Re-check hierarchy, the price
      chip's visual weight, and at-limit/over-cap tone in the harness
      (`headroom-480`, `-at_pace`, `-over_cap`).

- [ ] **Budget and Price (`plan_budget`) not loveable.** The projected summary can
      dominate the chart and still truncates status on real device widths
      (`plan_budget-480`).

- [ ] **Held-back devices (`starvation_rescue`) confirm-sheet polish.** Remaining
      non-blocking work: inherit the create widget's plan-graph chart, show a
      canonical read-only `Extra permissions` summary on the confirm sheet, and
      add a real at-cap honesty signal for cases where the in-isolation preview
      overstates what can run.

- [ ] **P3: create-screen `Extra permissions` opt-out is additive-only.**
      `createDeferredObjective` uses the `preserve` rescue policy, and the compose
      screen still does not reflect a device's existing standing permission set
      via Flow / the rescue lane. Surface the current standing permission in the
      compose view when the screen should read as authoritative.

*v2.9.1 RC release-review carry-forward (re-added on `v2.9.1..main`
release-review pass, 2026-05-26 — the original entry committed as
`6dea64be` on the v2.9.1 release branch never propagated to main).*

*Status (2026-05-28 release-review): the rescue-lane stuck-at-peak bullet
was resolved by commit `61807892 fix(admission): generalise smart-task
lifecycle-end release beyond EV` + new integration coverage at
`test/lifecycleEndReleaseNonEv.integration.test.ts`. The fix generalised
`shouldEmitSatisfiedPause` → `shouldEmitTerminalRelease` so non-EV cap-off
devices (thermostats, water heaters) now receive a `shed_release` intent
on lifecycle end and the executor routes it through `getShedBehavior`
(`set_temperature` for thermostats, binary off otherwise). The later residual
gap for stepped-only devices without `onoff`/`evcharger_charging` was closed in
the 2026-05-31 release-review cleanup by issuing a direct lifecycle-clock
`set_step` shed command and gating disarm until the stepped target is observed.*

*v2.9.1..main release-review findings (2026-05-26, six-agent fan-out:
`pels-runtime-reality` + `pels-layering-guardian` + `pels-copy-and-terminology` +
`pels-m3-critic` + `pels-ux-fit` + inline scope-cutter).*

*Widget-polish train shipped across PRs #1313–#1317 (lint enforcement #1305; see
`notes/widget-review.md` § Shipped). Remaining widget follow-ups, deferred / low urgency:*

  - [ ] **No CI guard that committed widget bundles match source** — generated
        `widgets/*/public/index.css` (and `index.js`) are committed but nothing fails CI if they
        drift from `src/`. Add a post-`build:widgets` `git diff --exit-code widgets/*/public`
        check so a stale generated artifact (or a hand-edit of a generated file) is caught. Source:
        adversarial-review (low), widget token-strategy train 2026-05-31.
  - [ ] **`settings.test.ts` full-suite flake** — "renders devices with target
        temperature capabilities" fails intermittently under full-suite load (`test:ui`
        / `test:ui:unit`) but passes in isolation; cost three pre-push retries during
        the widget train. Stabilize (likely shared-DOM/async teardown bleed between
        tests). Source: widget-polish train, 2026-05-30.
  - [ ] **`headroom` over_cap overage figure** — the over-cap meta line now omits the
        misleading clamped "0 kW available" and shows only the paused count, but it
        doesn't yet surface the *actual* overage ("X kW over hard cap"). That needs the
        payload builder to expose the hard-cap overage (current − cap) on the headroom
        payload so the renderer can show how far over the physical ceiling we are.
        Files: `widgets/headroom/src/headroomWidgetPayload.ts` (add overage field) +
        `widgets/headroom/src/public/render.ts` + `headroomWidgetCopy.ts` (copy helper).
        Source: widget-polish round 2, 2026-05-30.

- [ ] Insights mode picker — throttle / coalesce `refreshModeOptions` so a
      bulk priority edit doesn't issue one `setCapabilityOptions` per
      setting write. A 10-device priority reorder currently fires 10
      sequential SDK roundtrips. Coalesce on the `settings.on('set', ...)`
      callback with a `setImmediate` (or microtask) flush; only re-run when
      the effective mode-options set differs. Files:
      `drivers/pels_insights/device.ts:140-152`. Source: release-review
      pels-runtime-reality, 2026-05-26.

## P2 Product, Observability, and Maintainability

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

- [ ] **Smart-tasks widget — `at_risk` dark-theme contrast.** The `data-tone="warn"` row paints a 12%-mixed warning
      wash (`widgets/smart_tasks/public/index.css:72-74`, eta recolor
      `:104-112`); over the dark Homey host theme that wash is very
      low-contrast, so the "at risk" signal leans almost entirely on the status
      chip. Audit the warn fill against the dark host palette and bump it to a
      legible state-layer. The cannot-meet recourse copy half of this finding was
      fixed in the 2026-05-31 release-review cleanup by softening the non-clickable
      instruction into a cause-oriented line. Source: release-review pels-ux-fit +
      pels-m3-critic, 2026-05-29.

- [ ] **Non-divisible per-task headroom share for single-step devices.**
      `lib/objectives/deferredObjectives/policyHorizon.ts:313`
      `resolveReservedHeadroomKw` divides `(hardCapKw − backgroundKWh/duration)`
      equally across concurrent fully-reserved tasks. Works correctly for
      stepped thermostats / water heaters where the device can throttle to
      sub-kW resolution, but single-step devices (EV chargers) draw either 0
      or `activeSteps[0].usefulPowerKw`. With PR #1214's per-hour headroom
      cap now active, a 7.4 kW EV sharing the hour with a thermostat gets a
      ~2.5 kW share → commitment under-promises (planner says 2.5 kWh; EV
      actually runs 7.4 kW for ~24 min or full hour subject to capacity
      guard). Conservative under-promising is correct for `hard cap is
      physical`, but the optimum is to give single-step devices their full
      step capacity as their share and other tasks the remainder.
      Touching points: `policyHorizon.resolveReservedHeadroomKw` (introduce a
      non-divisible share variant aware of `activeSteps[]` granularity),
      `concurrentEligibleTasks.ts` (per-bucket eligibility already exists,
      may need per-device step granularity). Source: pels-runtime-reality
      review of PR #1214, 2026-05-28.

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

- [ ] **Weather-conditioned learned thermostat deadband.** The current EMA
      (0.7 old / 0.3 new) collapses every met/stalled observation onto a
      single per-device value. Real deadband behaviour is mildly
      weather-dependent — a sensor reading lags more on a cold-start session
      than a mid-day mild session. If the rate-confidence stays low after
      several met/stalled samples, the planner could split learning by
      outdoor-temperature bucket (or recent-trajectory slope) the same way
      `lib/dailyBudget/dailyBudgetLearning.ts` keys per-day buckets. Not
      worth implementing until the simple single-value EMA shows measurable
      bias in production. Source: kontor smart-task forensics conversation,
      2026-05-26.

- [ ] **UI surface for `learned_thermostat_deadband_c`.** The per-device
      learned deadband is invisible today — it lives only in the persisted
      settings map and feeds the commanded setpoint silently. Two product
      improvements once the EMA proves useful: (1) display the learned value
      on the temperature device detail page as a small diagnostic ("PELS
      adds +0.2 °C to your target so the device satisfies at-target"), (2)
      offer a `Reset learned deadband` button for devices the user
      reconfigures or replaces. Defer until a user reports confusion or
      until we want to expose the value in the smart-task postmortem. Source:
      kontor smart-task forensics conversation, 2026-05-26.

- [ ] **Stall-aware shed/restore ordering across devices.** When the
      household overshoots, shed/restore today uses pure `sortByPriorityAsc`.
      A device with an active soft smart task and remaining energy needed
      before its deadline should yield more reluctantly to shed and recover
      faster on restore than an equal-priority device with no commitment.
      Hook in the cycle-layer restore loop (`lib/plan/restore/devices.ts`
      `getOnDevices`/`getOffDevices`) by adding a deadline-urgency secondary
      sort key derived from the deferred-objective diagnostic. Out of scope
      for the deadband/stall PR because it touches the cycle-layer restore
      ordering and the deferred-objective bridge into restore, not the
      finalize-time learning. Source: kontor smart-task forensics
      conversation, 2026-05-26.

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

*Prod walk persona expansions, 2026-05-27. Personas 4–6 in
`notes/personas.md` are the highest-emotional-intensity visitors and the
least served across PELS surfaces today. Both items below are product
surface expansions (not defect fixes) and need an API field added before
the renderer can land.*

- [ ] **Miss-streak rollup on Overview (persona 5 — recovering-from-
      mistake).** `packages/shared-domain/src/deferredPlanHistory.ts:213`
      already exports `formatMissStreakAggregateLine`, used today only on
      the Smart-tasks list (`DeadlinesHistoryList.tsx`) as e.g.
      "Connected 300 — 2 of last 4 runs missed". Persona-5 owners reach
      Overview from notifications, not via Smart-tasks. Surface the same
      data as a single chip / rail on Overview ("3 misses this week" or
      a per-device chip cluster). Needs an Overview API field carrying
      the per-device aggregate strings — `PlanOverview` doesn't fetch
      smart-task history today. Files:
      `packages/contracts/src/settingsUiApi.ts` (new field),
      `lib/app/**` (populate from history store),
      `packages/settings-ui/src/ui/views/PlanOverview.tsx`,
      `packages/settings-ui/src/ui/views/PlanHero.tsx` (decide
      placement: above the device list vs hero chip rail). Source:
      2026-05-27 prod walk persona-5 gap.

- [ ] **Per-device kWh + money column on Usage (persona 4 — skeptical
      optimiser).** `packages/settings-ui/src/ui/usageHero.ts` and
      `packages/settings-ui/src/ui/usageStatsChartsEcharts.ts` emit
      total kWh only. The live smart-task hero (`Cost ≈ 0.79 kr`) and
      Budget projection (`57.22 kr today`) already render kr — Usage
      is the gap that prevents persona 4 from answering "what did this
      device cost last week?". Add a per-device kWh field to the Usage
      API and a per-day kr column / annotation on the daily chart
      (`Σ priceValue × deviceKwh` is derivable today). Files:
      `packages/contracts/src/settingsUiApi.ts` (new field),
      `lib/app/**` (populate from per-device kWh store),
      `packages/settings-ui/src/ui/usageHero.ts`,
      `packages/settings-ui/src/ui/usageStatsChartsEcharts.ts`,
      `packages/settings-ui/src/ui/usageDayChartEcharts.ts`. Source:
      2026-05-27 prod walk persona-4 gap.

*v2.9.1..main release-review findings (2026-05-26, six-agent fan-out:
`pels-runtime-reality` + `pels-layering-guardian` + `pels-copy-and-terminology` +
`pels-m3-critic` + `pels-ux-fit` + inline scope-cutter).*

- [ ] **Headroom widget — collapse top row to single-column when the price
      chip is hidden, or always render the chip with a `normal` tone.** The
      hidden chip on `normal`/`unknown` leaves an empty right-third on the
      most common state; the headline slides left and the supporting line
      looks orphaned. Files: `widgets/headroom/public/index.css:~13`,
      `widgets/headroom/src/public/render.ts:39`. Source: release-review
      pels-ux-fit, 2026-05-26.

- [ ] **Smart-tasks widget — detail-panel polish follow-ups (interactive-widget
      PR P2/P3).** Carry the lower-priority findings from the four review
      subagents on the interactive widget:
      (1) `formatDeadlineLong` weekday window (`dayDiff -6..6`) can label a
      6-day-out deadline with a bare weekday that collides with today's
      weekday name — tighten the window to the remaining days of the current
      week or update the comment (`widgets/smart_tasks/src/smartTasksWidgetPayload.ts`,
      pels-ux-fit P3).
      (2) `rehydrateView` collapses an open detail to the list on a single
      payload where the device is transiently absent/satisfied mid-cycle —
      consider a one-cycle grace mirroring the load-failure grace window
      (`widgets/smart_tasks/src/public/widgetApp.ts`, pels-runtime-reality P2).
      (3) Low-contrast 6% hover tint on `.row__btn` / `.back-btn` is near-
      invisible under Homey's desktop invert — non-essential on touch
      (`widgets/smart_tasks/public/index.css`, pels-m3-critic P3).
      Source: review subagents on the interactive smart_tasks widget,
      2026-05-28.

- [ ] **Learned-deadband store — soft cap or GC entries for devices not
      seen in N days.** The persisted map has no per-device cap and no GC
      of stale device IDs. A user who churns through device IDs (re-pair,
      driver swap, test devices) accumulates dead keys forever. Bounded in
      practice by Homey device counts (low tens), but `planHistory.ts`
      `HISTORY_ENTRY_CAP = 30` sets a precedent. Files:
      `lib/utils/learnedThermostatDeadbandStore.ts`. Source: release-review
      pels-runtime-reality, 2026-05-26.

- [ ] **Debug-logging hint copy — rename `"Keeping custom legacy topics: …"`
      to `"Also keeping these advanced topics: …"`.** Today the hint uses
      internal jargon ("legacy topics") and surfaces raw topic IDs to a
      user on the Debug logging page. Files:
      `packages/settings-ui/src/ui/debugLoggingHint.ts:14-15`. Source:
      release-review pels-copy-and-terminology + pels-ux-fit, 2026-05-26.

- [ ] **Widget preview PNGs — replace mechanically-generated SVG-via-script
      exports with Figma-template exports before App Store publish.** The
      hand-rolled SVG mockups at
      `widgets/{headroom,smart_tasks}/scripts/preview-{light,dark}.html`
      are mechanically compliant stop-gaps per the original widget commit
      notes (7dbb7cef); App Store guidelines recommend Figma-template
      exports. Track palette parity with `--homey-color-*` when the
      replacement lands. Files:
      `widgets/{headroom,smart_tasks}/scripts/build-previews.mjs` and
      the SVG sources. Source: release-review pels-m3-critic + commit
      7dbb7cef notes, 2026-05-26.

- [ ] **Smart Tasks outcomes table — surface "abandoned is usually not a
      failure" inline on the row, not two paragraphs below.** The
      `docs/smart-tasks.md` Outcomes table defines `abandoned` matter-of-
      factly; the reassurance ("usually not a planning failure") sits two
      paragraphs later. A panicked user reading the table cell will skim
      past the reassurance. Files: `docs/smart-tasks.md:137-152`. Source:
      release-review pels-ux-fit, 2026-05-26.

- [ ] **Extract a shared widget runtime — trigger event reached.** The
      smart_tasks widget (added 2026-05-26) is now the 3rd verbatim copy of
      ~150 LOC of widget runtime: `WidgetWindow`/`WidgetHomey`/`WidgetController`
      types, the race-guarded `createWidgetController` (load-sequence + refresh
      loop + visibility handler + bootstrap/destroy), and `installWidget`.
      `widgets/plan_budget/src/public/widgetApp.ts`,
      `widgets/headroom/src/public/widgetApp.ts`, and
      `widgets/smart_tasks/src/public/widgetApp.ts` all carry the same code; a
      race or visibility fix in one will silently miss the others. **Must land
      before any 4th widget.** Extract to `widgets/_shared/widgetRuntime.ts`
      and teach `scripts/build-widgets.mjs` to bundle the shared module into
      each widget's `public/index.js` IIFE. Source: adversarial-review on the
      headroom widget PR (2026-05-25) and the smart_tasks widget PR
      (2026-05-26).

- [ ] **Restore per-topic debug gating in lib/logging.** Chips 4.1d+ migrated
      runtime modules to `getLogger(module)` and dropped the topic-gated
      `debugStructured` injection. Previously, a user could enable just the
      `binary_commands` debug topic and get only those events; now enabling
      debug raises pino's level for *every* module logger. The regression is
      dormant in production (root logger defaults to `info`, so
      `binary_command_skipped` etc. are filtered before serialization) but
      becomes a flood the moment anyone bumps the level. Add a topic registry
      to `lib/logging`: `enableTopic('binary_commands')` raises just the
      `plan/binary-*` module loggers to debug; everything else stays at info.
      Mapping topic → module-name-glob lives in lib/logging (not the call sites).
      Source: `chatgpt-codex-connector` P1 on PR #1037 (chip 4.1d), 2026-05-24.

- [ ] **P3** — Extend Slice 2 floor promotion beyond priority 1. (Demoted from the v2.9 train P0
      closeout.) Slice 2 (PR #983) gates floor promotion on
      `device.priority === 1 && both rescue permissions === 'always'`
      because the reserved-headroom forecast (`hardCap − uncontrolled`)
      implicitly assumes every controlled concurrent watt is displaceable,
      which only holds at the absolute top. To safely promote non-top-
      priority fully-reserved tasks, the producer needs a richer headroom
      forecast that subtracts higher-priority controlled load
      (`hardCap − uncontrolled − higherPriorityControlled`). Then the gate
      can broaden to "highest priority present on this Homey."
      Why P3 (deferred 2026-05-25): real new plumbing (richer headroom forecast across
      `policyHorizon` + `rescueReplan` + `dailyBudgetBreakdown`) gated on prod evidence
      after Slice 2 deployment showing a long-tail `cannot_meet` rate on non-top-priority
      tasks. Pick up if that signal emerges; otherwise leave alone.
      Files:
      `lib/objectives/deferredObjectives/policyHorizon.ts`,
      `lib/objectives/deferredObjectives/rescueReplan.ts`,
      `lib/dailyBudget/dailyBudgetBreakdown.ts` (forecast input).
      Source: `pels-runtime-reality` P1 on PR #983, 2026-05-23.
      Update (2026-05-31, PR #1373): the budget-exemption rescue now also GRANTS
      `limitLowerPriorityDevices: 'always'` to eligible (stepped-load) devices, but
      that grant is inert in the plan for non-priority-1 devices for the same
      `fullyReserved === 1` reason above — so a default-priority (e.g. 100) stepped
      device's rescue is effectively budget-exemption-only until this lands. User
      confirmed (2026-05-31) the right design is to let non-top devices use it too:
      it would still only shed devices STRICTLY lower-priority than the rescued one
      (exactly the `hardCap − uncontrolled − higherPriorityControlled` forecast),
      which is safe. Deferred for now by user decision; pick up with this item.
      The success flash already stays honest meanwhile (`runsCurrentHour` reflects
      the actual resolved plan, not the granted permission).

- [ ] **Validate the v2.9 train against retained prod logs.** (Carried forward from the v2.9 train P0
      closeout.) Confirm the live `cannot_meet`
      rate collapses across multi-day prod windows after the Cause #1 chain
      (Steps 1–3) and Cause #2 Slices 1–2 land. Specifically: (a) confirm a
      mature device reaches `medium`/`high` `displayConfidence` after Step
      2, OR that the margin stays tight enough at `low` for Step 3 to
      handle alone; (b) measure the post-Slice-2 ratio of true `cannot_meet`
      vs `at_risk` (`feasible_above_floor` / `estimate_uncertain` /
      `limited_by_daily_budget`); (c) capture a fresh from-`n=0` thermostat
      profile to confirm or disprove the early-learning swing. Logs are
      retained across restarts (PR #971, commit-stamped markers); the
      remaining gap is duration, not instrumentation. Source: data-gated
      follow-up extracted from the v2.9 train P0 closeout 2026-05-23.

*Session P2 deferrals from batch 21 reviews (2026-05-24).*

*v2.9.0 retrospective P2 cleanup and docs follow-ups (2026-05-23).*

- [ ] Docs screenshot drift after PR #1040 card consolidation. The
      diagnostics card radius went 10px → 14px (token violation fix);
      `.deadline-list-card` lost its rest-state `--shadow-md` in favour
      of M3 elevation level 1. Doc screenshots
      (`docs/screenshots/deadline-plan/{320,480}.png`,
      `docs/public/screenshots/device-detail/diagnostics-open.png`)
      will misrepresent the shipped UI until refreshed. Not a CI
      blocker — Playwright snapshot baselines don't gate this — but
      the docs site reads as stale. Regen on the next docs pass.
      Files: `docs/screenshots/**/*.png`,
      `docs/public/screenshots/**/*.png`.
      Source: `pels-m3-critic`, PR #1040 follow-up, 2026-05-24.

- [ ] UX-walk on real hardware: confirm cards read OK at rest under
      the new M3 elevation level 1 (vs the previous `--shadow-md`
      blur). The tint-overlay elevation model is weaker than a real
      blur shadow on dark backgrounds, so cards may read flatter at
      rest. The rest-vs-hover delta is intentional per the
      `data-interactive` contract, but worth a live-walk before the
      next release to confirm the at-rest treatment isn't too flat.
      Files: visual review only, no code.
      Source: `pels-m3-critic`, PR #1040 follow-up, 2026-05-24.

- [ ] Short-deadline smart-task runs can't benefit from `capped_idle`
      promotion. PR #1018's `capped_idle` discriminator requires a
      20-min observation window before classification can fire; a
      Connected 300 task with a 1-hour deadline gets at most one
      classification opportunity (window opens ~20 min in, deadline at
      60 min). If the cycling pattern hasn't established by then or
      only one half of the duty cycle has occurred, the run finalises
      as a real miss. Not a correctness bug — graceful degradation back
      to the existing classification — but the user experience for
      short-deadline runs is unchanged. Acceptance: either shorten the
      window for short-deadline runs (risk: more false positives) or
      document the limitation in `notes/idle-classification.md`.
      Files: `lib/observer/idleDetector.ts`,
      `notes/idle-classification.md`.
      Source: `pels-runtime-reality`, PR #1018 follow-up, 2026-05-23.

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

- [ ] Document the lossy-restart gap in the postmortem strip UI. The
      lossy-restart contract at
      `lib/objectives/deferredObjectives/planHistory.ts:141-148` notes that
      progress accumulated between the pre-restart opening anchor and the
      first post-restart observation lands in *neither* hour bucket — the
      kWh are dropped from `hourlyContributions`. The postmortem strip
      (`DeadlinePlanHistoryDetail`) currently renders such hours as
      empty, which reads as "the device wasn't doing anything" rather
      than "we lost the in-flight anchor". Mark restart-straddling hours
      explicitly (e.g. dashed/empty cell with a
      `data unavailable across restart` tooltip) so users can tell the
      difference between a genuinely quiet hour and a measurement gap.
      Detection: cross-reference the in-progress map rebuild timestamp
      against the per-revision hourly contribution coverage; the gap is
      always the hour the pre-restart opening was anchored in.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`
      (rendering), `lib/objectives/deferredObjectives/planHistory.ts:141-148`
      (data signal so the renderer can identify the gap).
      Source: `pels-runtime-reality`, PR #990 follow-up, 2026-05-23.

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
*v2.8.0 → origin/main release-review findings (2026-05-22). From the
five-agent fan-out pass on `refs/tags/v2.8.0..origin/main`.*

- [ ] Detail-hero density at 320px: the at-risk-with-partial-delivery worst
      case stacks up to 8 text rows + the recourse button (section label,
      headline, headline-reason, subline, meta, variance note,
      delivered-so-far, cost) above the price-horizon chart. Wraps rather
      than overflows, but pushes the chart far below the fold — verify on a
      live 320px walk.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx:203-233`.
      Source: `pels-ux-fit`, v2.8.0→origin/main release-review pass.

- [ ] Smart-task rescue phase 2: add sticky `at_risk` timing. The shipped
      Homey action exposes only `never` / `always`; the contract and runtime
      parser already accept `at_risk`, but it should stay unexposed until the
      producer semantics exist end-to-end. Add a comment beside
      `flowCards/smartTaskRescueCard.ts:resolveWhen` that the `at_risk` branch
      is phase-2 forward compatibility and is not exposed by the JSON dropdown
      today. At-risk rescue must be sticky/debounced: engage once the plan is
      at risk, then exit only after a plan that is solidly not at risk holds,
      otherwise the permission can remove its own trigger and flap as plans
      churn. The `flow_permission_changed` emission itself is tracked as a P1
      v2.9 closeout item above. If `/tmp/pels` logs show lower-priority
      limit/resume oscillation around the satisfied↔at_risk boundary, include
      status hysteresis or minimum forced-boost dwell in the same work.
      Files: `packages/contracts/src/deferredObjectiveSettings.ts`,
      `.homeycompose/flow/actions/allow_smart_task_rescue.json`,
      `packages/shared-domain/src/deadlineLabels.ts`,
      `lib/objectives/deferredObjectives/settings.ts`,
      `lib/plan/admission/deferredObjective.ts`,
      `lib/objectives/deferredObjectives/activePlanRecorder.ts`,
      `lib/objectives/deferredObjectives/replanReason.ts`.
      Source: v2.9.0 release-review refresh, 2026-05-22.

*Variance-buffer follow-ups (2026-05-22, PR #965 — `mean + k·SE` planning buffer).*

- [ ] Multi-band aggregate cap: the 2× `MAX_BUFFER_MULTIPLIER` clamp is applied
      per band/slice inside `integrateBands`, then summed, so a profile with
      several high-SE bands can total up to ~2× the mean-expected figure across
      the whole interval. That is the intended ceiling, but confirm the
      aggregate is acceptable for multi-band EV profiles (interacts with the
      conservative-high EV bootstrap constant). Source: `pels-runtime-reality`
      review of PR #965.

- [ ] `learning` floor vs volatile rates (PR #970). `MIN_LEARNED_SAMPLES_FOR_CONFIDENT_CHIP = 4`
      classifies a device with ≥4 samples as "learned", so a volatile low-confidence
      rate (the swing behind the open feasibility P0) shows `At risk` with no
      "Estimating" cue that the verdict rests on a shaky estimate. Defensible against
      nagging, but revisit alongside the feasibility-accuracy P0 — a variance-based
      (not just sample-count) cue may be warranted. Source: `pels-ux-fit` review of PR #970.

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

- [ ] Profile and reduce plan-rebuild CPU spikes / Homey `cpuwarn`. `/tmp/pels` perf
      traces: 2026-05-22 startup `planRebuild` up to 6.2 s (apply 4.95 s), steady-state
      `planBuild` avg ~1.07 s; 2026-05-13 run had 11 `cpuwarn` + ~80 `[perf] cpu spike`
      entries, rebuilds ~1.6 s median / 1.8 s p90 / 3.7 s max during `hard_cap_breach`.
      Heap healthy (~20–28 MB / 70 limit), no `planRebuildFailed`. Slow rebuilds delay
      shed/restore reactions to power changes. Use the existing perf counters to isolate
      hot paths in plan build (dominates rebuild time), status write, and apply work, then
      add a repeatable perf check/benchmark before changing planner code.
      Files: `lib/plan/planBuilder.ts`, `lib/plan/planService.ts`, `lib/diagnostics/perfLogging.ts`,
      perf tests. Source: `/tmp/pels` `[perf]` cpuwarn context, 2026-05-13 + 2026-05-22.

- [ ] Persist `currentHourOpening` / `lastKWhPerUnit` across PELS restarts.
      The v2.8.0 `recordHourlyDelivery` wiring tracks these on the in-memory
      `InProgressRecord` but does not write them to
      `DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING`. Homey runtime restarts
      (settings change, OOM, deploy) reset the hour anchor; any progress
      delivered between the pre-restart opening and the first post-restart
      observation is dropped from the postmortem strip. Contract is documented
      in `lib/objectives/deferredObjectives/planHistory.ts:InProgressRecord` and the
      `restarts mid-run drop the in-flight hour anchor` regression test pins
      the observed behaviour. Persist alongside the rest of the in-progress
      record so the strip stays whole across restarts.
      Source: `pels-runtime-reality` agent, v2.8.0 PR1 review pass.
      Files: `lib/objectives/deferredObjectives/planHistory.ts`,
      `packages/contracts/src/deferredObjectiveActivePlans.ts`.

- [ ] Prorate postmortem-strip delivery across unobserved multi-hour gaps
      under `power_source = flow`. The v2.8.0 hour-rollover detector
      attributes the full delta of an N-hour observation gap to the opening
      hour, leaving intermediate hours blank. Acceptable for
      `power_source = homey_energy` (10 s poll → gaps rare) but systematically
      mis-attributes cost for quiet flow-driven devices. Requires independent
      per-hour power telemetry to do correctly — out of scope for the initial
      wiring. Contract documented in `planHistoryV4Helpers.ts:detectHourRollover`.
      Source: `pels-runtime-reality` agent, v2.8.0 PR1 review pass.

- [ ] Add explicit backup-hour reservations for committed smart-task schedules.
      Day-zero committed schedules now keep the first full-horizon allocation
      stable and ignore later optimizer hour swaps. There is still no separate
      backup-hour model: if the device cannot deliver inside the committed
      hours, the plan degrades to `cannot_meet` rather than spilling into
      reserved backup capacity. Future work should model backup hours as
      distinct from committed delivery hours, surface the assumption in the
      plan detail, and decide how daily-budget capacity is reserved so backup
      hours do not silently steal energy from other tasks.
      Files: `lib/objectives/deferredObjectives/horizonPlanner.ts`,
      `lib/objectives/deferredObjectives/bucketAllocation.ts`,
      `lib/objectives/deferredObjectives/diagnosticsBridge.ts`,
      `packages/contracts/src/deferredObjectiveActivePlans.ts`,
      `notes/deferred-load-objectives/`.

- [ ] **Move BudgetOverview confidence strings to shared-domain.**
      PR #1211 renamed "Plan confidence" → "Budget confidence"
      inline in `packages/settings-ui/src/ui/views/BudgetOverview.tsx`,
      but the strings stay in the view rather than in
      `packages/shared-domain/**`. Per memory
      `feedback_ui_text_shared_with_logs`, UI text shared with logs
      should come from shared-domain helpers. These specific strings
      aren't currently logged so this is a P3 follow-up, not a parity
      bug; if budget-confidence logging is added later, promote to P2
      and land alongside the logger call. Files:
      `packages/settings-ui/src/ui/views/BudgetOverview.tsx`,
      new `packages/shared-domain/src/budgetConfidenceStrings.ts`.
      Source: 2026-05-27 prod walk, scoped out of PR-4.

*Smart-task history-detail trio below was demoted from P1 in the v2.7.1
release-review pass (2026-05-17). All three depend on the history schema
v3 → v4 migration, which is out of scope for v2.7.1; sequence them together
in v2.7.2+.*

*v2.7.1 release-review P2 batch (2026-05-17). Eight items from the
six-agent fan-out pass — non-blocking polish, drift, and follow-up.*

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
      Files: `lib/price/priceCoordinator.ts`, `test/plan.test.ts`, plan throttle tests.
- [ ] Finish the starvation rollout beyond the current diagnostics implementation: add
      per-episode / duration-threshold flow triggers, verify insights coverage, and close any
      remaining snapshot/UI contract gaps against `notes/starvation/README.md`.
      Files: `lib/diagnostics/**`, `flowCards/**`, `drivers/pels_insights/**`,
      plan snapshot/contracts/UI wiring.
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
      This rework also covers surfacing the effective limited step for stepped-load devices on the device-detail surface.
      Files: `packages/settings-ui/public/index.html`,
      `packages/settings-ui/src/ui/deviceDetail/**`, device-detail e2e tests/screenshots.
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
- [ ] Update public deadline documentation once the feature enters testing. Keep
      `docs/technical.md`, `docs/flow-cards.md`, and any deadline-plan docs aligned with the
      runtime semantics for EV and heater objectives: already-met targets are live `satisfied`
      states until the deadline, and a later below-target reading returns to tracking. Keep
      terminology aligned with `notes/ui-terminology.md`.
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
      Files: `lib/power/tracker.ts`, `packages/contracts/src/powerTrackerTypes.ts`,
      `lib/plan/planState.ts`, `lib/utils/appTypeGuards.ts`.
- [ ] Replace deeply partial flow-reported capability state with a normalized runtime
      representation at the boundary.
      Files: `lib/device/flowReportedCapabilities.ts`.
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
- [ ] (Optional follow-up to the observer/transport split.) Migrate the
      plan- and executor-side reads that consult
      `state.pendingBinaryCommands[id]` directly onto a
      `pendingBinaryCommandStore.peek(id)` / `.get(id)` API, so the
      `pendingBinaryCommands` field on `PlanEngineState` can be removed
      and observer becomes the single source of truth in both directions
      (read and write). Today the read API and the mutator agree on the
      same backing `Record` so behaviour is correct; this is a clarity
      cleanup, not a correctness fix. Read sites (plan): `planBuilder.ts:1069`,
      `planDevices.ts:146` and `:148`, `shedding/candidates.ts:186`, `:188`,
      `:363`, `:365`, `planStateHelpers.ts:16`,
      `planBinaryControlHelpers.ts:152` / `:153` / `:158` (the last one
      also drops the in-place eviction side-effect in `getPendingBinaryCommand`).
      Type references (executor): `planExecutor.ts:297`,
      `planExecutorPredicates.ts:17`. Source: post-merge cumulative
      review on 2026-05-25.
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
      `lib/objectives/deferredObjectives/diagnosticsBridge.ts`,
      `.homeycompose/flow/actions/set_ev_charge_deadline.json`, contract and bridge tests.
- [ ] Close the EV deadline observability loop: measured deviation and richer trigger tokens.
      Two connected items: (a) emit the `measured_deviation` revision reserved in
      `activePlanRecorder.ts:379-380` by comparing observed delivery (read from the calibration
      EMA via `getDeliveryPowerKw`) against the planned bucket allocation; (b) expand
      `buildTriggerTokens` (`flowCards/deadlineObjectiveCards.ts:161-179`) with
      `planned_start_local`, `planned_finish_local`, `required_kwh`, `planning_speed_kw`,
      `estimated_duration_text`, and `risk_reason`. The active-plan recorder already carries
      `energyNeededKWh`, `planStatus`, `kwhPerUnitSource`, and the bucket allocation needed.
      Design: `notes/ev-ready-by/README.md`.
      Files: `lib/objectives/deferredObjectives/activePlanRecorder.ts`,
      `flowCards/deadlineObjectiveCards.ts`,
      `.homeycompose/flow/triggers/deadline_status_changed.json`, related tests.
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
- [~] Add a hero summary to the Electricity prices settings panel. *(partial, landed in
      `v2-7-3-budget-rhythm-and-polish`, 2026-05-18: one-sentence lede added under the panel
      `pels-hero` h2 so users know what the panel controls.)* Remaining for a later pass:
      a live "current tier / cheap / expensive / last-fetched" summary card. That requires
      a new wiring path from the price service into the settings UI and was out of scope.
      Files: `packages/settings-ui/src/ui/views/ElectricityPricesView.tsx` (done);
      `packages/settings-ui/public/index.html` (Electricity prices panel hero — pending);
      `packages/settings-ui/src/ui/electricityPrices.ts` (pending).
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
- [ ] ~~Extract a shared `PersistedSettingsState<T>` helper.~~ **CUT (layering review,
      2026-05-31): do not do this.** The three stores share *vocabulary*
      (dirty/debounce/flush) but not *semantics* — `planHistory.ts`'s abandon-grace is
      objective-run-lifecycle logic (met/missed/abandoned finalization), not a generic
      persistence timer; calibration and the active-plan recorder each have their own
      finalize/grace policy. A generic `PersistedSettingsState<T>` would have to absorb
      three different policies, *increasing* coupling and indirection (shared-base-class
      trap) while removing little. Kept annotated so it isn't re-raised. Source:
      `pels-layering-guardian` merit pass.
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
*v2.10.0..main release-review findings (2026-05-28, six-agent fan-out:
`pels-runtime-reality` + `pels-layering-guardian` + `pels-copy-and-terminology` +
`pels-m3-critic` + `pels-ux-fit` + adversarial-review).*

- [ ] Idle classifier: surface a signal when a device has a temperature setpoint but no
      `currentTemperature` reading. `lib/observer/idleDetector.ts` allows `currentTemperature`
      to be absent — `gap` resolves to `undefined` and `classifyByGapAndDuration`
      short-circuits to `active`, so a sensor that stops reporting on a heater that should
      be heating produces no `unresponsive` signal. Files: `lib/observer/idleDetector.ts`,
      `lib/observer/idleClassifier.ts`. Source: v2.7.1 release-review.
      *(In flight on the v2.11 correctness train — removed by its fix PR.)*

- [ ] Fold `capabilities.includes('evcharger_charging')` into `isEvDevice`
      (`lib/device/deviceActionProjection.ts`). Post-detype refactor the
      predicate checks `deviceClass === 'evcharger'` or
      `controlCapabilityId === 'evcharger_charging'` only; if
      `controlCapabilityId` ever fails to resolve but caps include
      `evcharger_charging`, the device is mistakenly non-EV. Practical risk
      low because `managerParseSnapshot.ts` derives `controlCapabilityId`
      from caps directly, but the asymmetry with pre-refactor logic is real.
      Source: release-review adversarial-review, 2026-05-28.

*Bot-review audit follow-ups (2026-05-28). Items surfaced by
chatgpt-codex-connector / gemini-code-assist reviews on the v2.10
follow-up train that were missed at merge time; filed here for the next
wave.*

*Capacity-marker decomposition (2026-05-30, `fix/device-control-intent`).
Increment 1 of the converged `lastDeviceShedMs` split: introduced a
decision-time `shedDecidedMs` clock (planner-owned, edge-set at finalization
for every device entering `lastPlannedShedIds`, cleared on restore alongside
`lastDeviceShedMs`). The restore-eligibility readers — `isNonSteppedDevice
Recovering` (×2), stepped-restore blocking (`coordination.ts` / `helpers.ts`),
`resolveRestoreLogSource`, `hasStableUncontrolledRestoreActuation`, and the
uncontrolled binary-restore gate — now read it, so a device the planner
decided to shed but that was already off (executor write skipped) no longer
under-stamps and restores early. `lastDeviceShedMs` stays the actuation clock
for the 5 s throttle, cooldown-card countdown, reconcile window, and
recent-shed restore backoff. See
`notes/state-management/deferred-objective-lifecycle-carveout.md`.*

- [ ] P2: feed the recent-shed restore backoff off the decision-time clock.
      `restore/support.ts:67` (`RECENT_SHED_RESTORE_BACKOFF_MS`) still reads the
      actuation-time `lastDeviceShedMs`, so a decided-but-write-skipped shed is
      not backed off on the *very next* restore evaluation (the recovering /
      blocking gates already cover it; this is the residual timing-window edge).
      It is a true elapsed-time window, not an existence check, so it needs the
      `shedDecidedMs` timestamp threaded with the same care as the throttle —
      defer to the increment that introduces the explicit `shedActuatedMs`
      rename so the two clocks are named at the same time. Source:
      pels-runtime-reality decomposition matrix, 2026-05-30.

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

- [ ] P3 tidy: `setup/appInit/deferredObjectiveLifecycle.ts` reads `getActivePlansSnapshot()`
      twice per tick (verbatim from the pre-PR-C code) — collapse to one read. Source:
      pels-layering-guardian + pels-runtime-reality on `feat/smarttask-clock`, 2026-05-30.

- [ ] PR-E follow-ups (not blocking): (a) fully retire the *terminal*
      `deferredReleaseIntent` from the plan path so it isn't double-covered (the
      path stays for idle-bucket holds, Fork A); (b) the same "task disabled →
      cap-off device stranded" shape exists for a user/Flow disable mid-run, not
      just deadline-passed. Source: investigation + Codex review on PR-E,
      2026-05-30. Closed in the 2026-05-31 release-review cleanup: stepped-only
      `set_step` shed on a no-binary-handle device now issues a direct
      lifecycle-clock stepped command and waits for observed step posture before
      disarming.
      NOTE (2026-05-31): the distinct `set_temperature`-with-missing-target case (stale behavior or a
      target cap dropped from the snapshot → set_temperature command no-ops until grace, leaving the
      device running) is now FIXED — `resolveTerminalShedCommand` falls back to binary-off when there
      is no trusted primary target. This is NOT (a) (which is the no-binary-handle `set_step` niche).

- [x] **P2: dep-cruiser is type-edge-blind — `no-plan-to-smarttasks` is now `error` but only a
      value-edge guard.** DONE (option b): `.dependency-cruiser.cjs` runs post-compilation
      (`tsPreCompilationDeps` unset), so `import type` edges are invisible to every rule. The manual
      `grep -rn "from .*objectives" lib/plan/` audit is now an enforced check — `npm run arch:grep`
      (`scripts/check-plan-objectives-edge.mjs`), wired into `ci:checks` (so the pre-push hook and
      the CI checks job cover it — NOT the pre-commit hook, which only runs lint-staged +
      `scripts/pre-commit-extra-checks.mjs`) and an explicit workflow step. The scanner uses the
      TypeScript compiler API (AST walk over module specifiers), so it ignores comments and catches
      every import shape — value/type `import ... from`, `export ... from`, `import x = require(...)`,
      and `import(...)`/`require(...)` with string OR template-literal args — naming the offending
      file:line.
      Scoped to the boundary the rule comment names (`no-plan-to-smarttasks`); the
      `no-objectives-to-peer-except-power` gate was left out of scope as its comment documents no
      type-edge audit. Option (a) — flipping `tsPreCompilationDeps: true` — was deliberately NOT
      taken: it surfaces ~18 pre-existing type-only `no-circular` violations and doubles the cruised
      graph (out of scope). Source: pels-layering-guardian on `feat/smarttask-lifecycle-producer`,
      2026-05-30.

- [ ] P3: `ObjectiveDeviceInput.stepPowerCalibration` is narrowed to `{ deliveryPowerKw: number }`
      (`lib/objectives/types.ts`) — the one field the controller reads. It is the only field
      structurally narrowed rather than copied whole. If the controller ever takes on
      admission/feasibility sizing that needs `admissionPowerKw`, restore it here (the failure mode
      is a clean compile error at the read site, so it is self-announcing). Source:
      pels-layering-guardian, 2026-05-30.

- [ ] P3: pin `@pels/planner-types` as a strict leaf with a dedicated dep-cruiser rule
      (`planner-types-is-a-leaf`). Today `shared-packages-no-runtime` forbids `planner-types/src ->
      runtime` and `no-circular` covers cycles, which is adequate. But nothing forbids
      `packages/contracts/src -> packages/planner-types/src` (an upward edge from contracts into a
      sibling — a smell, though currently a type-only no-op under post-compilation cruising). Add the
      leaf rule when assembling the program's finish-line rule set so the package stays a sink.
      Source: pels-layering-guardian on PR-D1, 2026-05-30.

## P3 Future and Exploratory Work

*v2.10.0..HEAD release-review cleanup (2026-05-29).*

- [ ] **Chunk-6 detype dual-read removal + widget transition tokenization.**
      Now that the producer populates `commandableNow` / `residualKw` /
      `shedIntent` on `PlanInputDevice`, the transitional field-presence
      fallbacks can collapse to unconditional flat reads:
      `lib/device/deviceActionProjection.ts` (the `dev.field !== undefined`
      gates), `lib/plan/planRemainingSheddableLoad.ts:244`, and
      `lib/plan/restore/accounting.ts:52-66` (legacy fixture fallback). Both
      `pels-runtime-reality` and `pels-layering-guardian` flagged these as the
      only remaining structures that resemble consumer re-resolution; removing
      them retires the smell. Separately, the smart-tasks widget `.row__btn`
      hover uses a raw `transition: background-color 200ms ease-out`
      (`widgets/smart_tasks/public/index.css`) — bind it to a Homey host
      transition token if the host exposes one. Source: release-review
      pels-runtime-reality + pels-layering-guardian, 2026-05-29.

*Prod walk follow-ups, 2026-05-27. Two small UI items raised by the
prod walk that didn't warrant a P2 slot.*

- [ ] **Smart-task live detail energy-band reads as a typo at a glance.**
      Cold-start energy estimates render as a hyphenated range, e.g.
      `Needs 0.9–11 kWh` (visible in `smart-task-live-v2-480.png` from
      the 2026-05-27 prod walk). At a glance the en-dash looks like
      either a typo or a single weird number. Either render with the
      word `to` (`0.9 to 11 kWh`), spacing the dash, or fold the band
      into a single number once `displayConfidence !== 'low'`. Files:
      `packages/shared-domain/src/deadlineLabels.ts` (banded estimate
      formatter), `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`.
      Source: 2026-05-27 prod walk.

- [ ] Persistence-hardening backlog: normalize `power_tracker_state` at the
      Settings UI/API boundary. `lib/app/settingsUiApi.ts` still casts raw
      `homey.settings.get('power_tracker_state')` to `PowerTrackerState`; the
      newer objective-profile fields (`bands`, samples, pending energy, and
      sub-interval timing) therefore rely on caller discipline instead of a
      load-time schema. Pre-existing gap, not a v2.9 regression; add a
      normalizer when touching profile persistence again.
      Files: `lib/app/settingsUiApi.ts`, `lib/power/trackerTypes.ts`,
      `lib/objectives/profiles.ts`, `packages/contracts/src/powerTrackerTypes.ts`.
      Source: adversarial residual-risk review, v2.9.0 closeout, 2026-05-23.

- [ ] Keep `recordHourlyDelivery` single-authoritative before wiring any
      production caller. Today no production code calls the exported method,
      while the internal rollover path already appends hourly contributions
      and totals. If a future caller feeds the same hour through
      `recordHourlyDelivery` as well, `appendHourlyContribution` will sum it
      again and double-bill `deliveredKWh` / `totalCost`. Before adding a
      production caller, choose whether external pushes or internal rollover is
      authoritative for that hour and add a regression.
      Files: `lib/objectives/deferredObjectives/planHistory.ts`,
      `lib/objectives/deferredObjectives/planHistoryV4Helpers.ts`,
      `test/deferredObjectivePlanHistory.test.ts`.
      Source: adversarial residual-risk review, v2.9.0 closeout, 2026-05-23.

- [ ] Smart-task status oscillation at the cusp — quality-of-emit nit, not a
      bug. When a committed plan sits right at the boundary between the
      primary horizon and the deadline reserve hour, per-cycle re-solves can
      flip between `on_track`, `at_risk: planned_using_deadline_reserve`, and
      back as small inputs (current bucket clip, learned-rate jitter, partial
      kWh placed in the current hour) tip allocation across the reserve
      boundary. The verdicts are individually correct; the user-visible
      flutter is the issue. Possible mitigations: hysteresis on the `at_risk`
      → `on_track` transition, or smoothing the verdict over a small window.
      Defer until a real user complaint surfaces — prod walk 2026-05-23 logged
      this as a low-priority observation, not actionable yet.
      Files: `lib/objectives/deferredObjectives/horizonPlanner.ts:resolveStatus`,
      possibly `activePlanSchedule.ts` for emit gating.

- [ ] **P2 — `seed.kind === 'grace_fallback'` is a third branch consumers could read** (`lib/plan/planModeTargetGuard.ts`). Resolution-in-producer smell (`feedback_layering_resolution_in_producer`): consumers in `lib/plan/planDevices.ts` already branch on `kind`, so a future `pels-layering-guardian` pass should evaluate whether the producer should flatten kinds (e.g. emit a single `{ value, source }` shape and let the producer encode the no-actuation hint inline) before more consumers branch on this. No boundary violation yet — same module surface — but worth a sweep before the surface grows.

- [ ] Symmetric phantom-shed filter for the shed-side keep-invariant clamp.
      `lib/plan/planDevices.ts:isPhantomSetStepShed` mirrors the
      `lib/executor/executablePlanProjection.ts:isDroppedUnderspecifiedSetStepShed`
      filter at plan-build time, but omits the `!isHeldByRestoreAdmission`
      conjunct because plan reasons aren't computed at the pre-pass call site
      (top of `buildInitialPlanDevices`, before the `.map()`). Result: in the
      niche state where a stepped+`set_step` device is in `shedSet` AND held
      by restore admission AND its target step doesn't resolve (or equals
      selectedStepId), the plan-build mirror filters it from
      `effectiveShedSet` while the executor projection would keep it in
      posture. An unrelated stepped keep device that should have been clamped
      to lowestActive per docs/technical.md:222 then stays at its current
      step. Inverse-direction asymmetry vs. the codex P1 closed in PR #891.
      NOT a localized fix (investigated 2026-06-01): `isHeldByRestoreAdmission`
      derives from restore-admission reasons (`cooldownRestore`/`meterSettling`)
      that are produced only by the restore pass (`applyRestorePlanWithTiming`),
      which runs *after* this pre-pass — and that pass's `restoredOneThisCycle`
      admission depends on the devices this pre-pass builds. Genuine circular
      ordering, not a missing wire. Honest fix = compute `effectiveShedSet`
      post-restore and re-run the keep-invariant clamp (a scoped restore-pass
      reorder), not a one-line conjunct. Don't re-attempt as a quick win.
      Why P3: very narrow trigger; user-visible incident (Connected 300
      stuck at medium during overshoot) is fixed by the shipped clamp; no
      observed prod occurrence of this corner.
      Acceptance: either (a) two-pass build (compute reasons first, then
      re-derive `effectiveShedSet` from finished plan devices using the real
      `isHeldByRestoreAdmission` predicate), or (b) thread the restore-hold
      signal into `PlanInputDevice` so the pre-pass can read it without a
      second pass. Acceptance test: stepped device A on keep at medium,
      stepped device B with `set_step` shed action held by restore admission
      in `shedSet`, assert A's `desiredStepId` clamps to lowestActive.
      Files: `lib/plan/planDevices.ts`, `lib/plan/keepInvariantPosture.ts`,
      `lib/executor/executablePlanProjection.ts` (read-only reference),
      `test/planDevices.test.ts`.
      Source: adversarial-review on PR #891 (2026-05-18).

- [ ] Cross-kind copy sharing in `deadlineLabels.ts` — revisit when first kind-specific
      divergence lands. Temperature and EV share byte-identical `cannotMeetShortfall` and
      `cannotMeetFallback` strings (only `cannotMeetDailyBudgetExhausted` differs by the noun).
      When the first kind-specific branch arrives — likely the unplugged-EV copy from the P1
      "objective_invalid_session" entry — audit whether the shared helpers still make sense or
      if the kinds should split fully. No action until the first divergence.
      Files: `packages/shared-domain/src/deadlineLabels.ts`.
- [ ] Revisit deadline-hero "Need X kWh" staleness if users find the original-vs-remaining
      framing confusing. The active-plan recorder no longer persists `energyNeededKWh` /
      `plannedKWh` decrements within an unchanged schedule (to avoid Homey settings churn on
      every plan cycle), so the Settings UI hero reads the original starting energy until the
      schedule, plan status, kWh-per-unit source, or objective changes. If the UX needs the
      live remaining kWh, route it through a non-persisted live snapshot (e.g. include the
      current diagnostic's `energyNeededKWh` in the UI bootstrap payload) rather than re-
      enabling per-cycle persistence.
      Files: `lib/objectives/deferredObjectives/activePlanRecorder.ts`, `lib/app/settingsUiApi.ts`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`,
      `packages/settings-ui/src/ui/deadlinePlanResolvers.ts`.
- [ ] Track per-device step changes with the same 30-day hourly retention model, so measured
      usage history can explain which step or mode was active during each measured period.
      Files: future device-level step-change tracker; usage-history UI.
- [ ] Add a per-device usage history page showing measured kWh over time with step-change context.
      Files: future device-level usage-history route and chart.
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
- [ ] Add EV deadline automation: per-charger defaults and plug-in auto-trigger.
      Per-charger automation profile (enabled, target percent or kWh, ready-by time,
      enforcement, speed mode, optional manual kW and derating) plus a hook on the
      `sessionStartedAtMs` boundary in `lib/device/transport/stateOfCharge.ts` that materializes the
      defaults into a `DeferredObjectiveSettingsV1` entry through the same upsert path the flow
      card uses. Persistence must align with the shared `PersistedSettingsState<T>` helper from
      `notes/persisted-settings-state.md`.
      Why P3: stand-alone polish; removes the per-session friction of firing
      `set_ev_charge_deadline` manually, but the v1 flow-card path is workable without it.
      Design: `notes/ev-ready-by/README.md`.
      Files: new `packages/contracts/src/evChargerDefaults.ts`,
      new `lib/app/evChargerDefaultsWiring.ts`, `lib/device/transport/stateOfCharge.ts`,
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
      `lib/objectives/deferredObjectives/planHistory.ts` (transient handoff to in-page route).
- [ ] Add a banner to the *active* task hero showing "Last [kind] task missed: {short
      reason}" for ~24 h after a finalized miss. The user lands on the active task when
      they open the app worried about the same deadline pattern; the breadcrumb avoids the
      Smart tasks → past row → detail dance. Sourced from the same postmortem resolver as
      the history detail.
      Why P3: app breadcrumb on top of the existing postmortem on history detail; meaningful
      for the panic-visitor persona but lower-effort variants cover the same ground.
      Related: `notes/smart-task-ui/README.md` Q2.
      Files: `packages/settings-ui/src/ui/deadlinePlanHero.ts`,
      `packages/settings-ui/src/ui/deadlinePlan.ts` (recent-miss query against
      `DeferredObjectivePlanHistoryEntry`).
- [ ] Salvage from closed PR #883 (`v2.7.3/budget-usage-loveable`) — Budget half superseded by `dd92fa42`; Usage-half items remain undelivered: "Your typical Sunday runs X kWh" day-aware voice (`usageHero.ts` + `usageVoice.ts`), drop the 7d toggle in `power.ts` (keep 14d only), NBSP between number and `kr` in any Usage money copy, NOK money line on Usage (deferred). Small focused PR.

- [ ] `replanReason.ts`'s `resolveHorizonPriceWatermark`
      uses `max(plannedBuckets[].endMs)` as the price-horizon watermark, but
      buckets are clamped to `deadlineAtMs` in the runtime path
      (`policyHorizon.ts` / `bucketAllocation.ts`), so the value is typically
      just the deadline on every revision. `hasPriceHorizonAdvanced` therefore
      rarely (or never) flips true for real Nordpool publications — meaning
      real price advances get under-labeled as `schedule_revised` rather than
      `prices_revised`. The shipped fix (PR #890) is still strictly better
      than the catch-all `prices_revised` it replaced (no more misleading
      "Tomorrow's prices published" on internal replans), but it doesn't
      catch the inverse case yet. Proper fix: thread an actual price-horizon
      cutoff through `DeferredObjectiveHorizonPlan` (e.g. `pricesAvailableUpToMs`)
      from the price source down to the recorder. Filed as chatgpt-codex P2
      on PR #890 (thread `PRRT_kwDOQhCm-86CxCbo`).

- [ ] Smart-task rescue residual hygiene (from the exempt-from-budget PR
      `codex/smart-task-rescue-permissions-via-flow`):
      - **Forced-boost debug marker.** `temperature_boost_state_changed` /
        `ev_boost_state_changed` logs emit the device's own (often empty)
        threshold fields — add a forced-cause marker for field debugging only
        if rescue field logs prove ambiguous. (`planTemperatureBoost.ts`,
        `planEvBoost.ts`)
      - **Tests:** spy `rebuildPlan` to pin the idempotent no-op (no rebuild on an
        unchanged mode).

- [ ] Idle-classifier eligibility follow-ups (from the `shedAction → plannedState`
      fix):
      - ~~**Type-narrow `IdleClassifierDeviceInput.plannedState`.** Promote the
        `'shed' | 'keep' | 'inactive'` union to a shared `PlannedDeviceState`
        alias in `packages/contracts/src/types.ts`; producer
        (`DevicePlanDevice.plannedState`), consumer
        (`IdleClassifierDeviceInput.plannedState`), and test helpers all
        reference it.~~ Done — alias in `packages/contracts/src/types.ts`; test
        helpers inherit it via `Partial<DevicePlanDevice>` /
        `Partial<IdleClassifierDeviceInput>`.
      - **Decide whether `plannedState === 'inactive'` should also gate
        eligibility.** `inactive` is used in `lib/plan/planOffStateReason.ts` for
        devices PELS is no longer managing (capacity control off, manual mode,
        etc.). Today the classifier still ticks on them. Classifying an inactive
        device as `near_target_idle` is probably misleading — the smart-task
        history finalizer is the main consumer and an inactive device shouldn't
        have an active deferred objective anyway, but the diagnostic noise is
        worth eliminating. Low risk; add an `'inactive'` clause to the gate and a
        test alongside.
      - Files: `lib/observer/idleClassifier.ts`, `lib/observer/idleDetector.ts`,
        `packages/contracts/src/types.ts`, `test/idleClassifier.test.ts`.

- [ ] Smart-task revision-history panel — follow-ups from PR #1197 subagent
      review (UX / copy / vocabulary):
      - **Wire `RevisionReasonDisambiguation` through any future runtime
        log breadcrumb path for `schedule_revised` events** (P2, from
        pels-runtime-reality review of batch 2 / PR #1203). Today no
        runtime breadcrumb logs the reason at all, but if one lands and
        uses the bare `revisionReason()` 2-arg wrapper, support flow
        becomes "log says `Schedule revised`, screenshot says
        `Schedule revised — daily budget shifted`" for the same revision.
        Pass the disambiguation bag through so log/UI parity holds.
      - **`warnedFallbackRevisions` Set keying / eviction** (P3, from
        pels-runtime-reality + pels-layering-guardian reviews of batch 2 /
        PR #1203). Current key is `r${revision}@${timeLabel}` — fine for
        the current devtools-only use, but if the warning ever escalates
        to telemetry, (a) prefix with `${objectiveId}` so two panels with
        the same revision index in the same session don't dedup each
        other, and (b) cap the Set size or rotate on session boundary so
        long-lived settings UIs can't grow it unbounded. Files:
        `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`.
      - **Card chrome density.** At 320 px the panel adds a full card shell
        even when collapsed (~80–96 px). Consider folding inside
        `PlanInputsCard` ("What PELS has learned") — natural home for
        "...and what changed since the plan was first written".
      - Source: pels-m3-critic / pels-ux-fit / pels-runtime-reality reviews
        on PR #1197, 2026-05-27. Vocabulary subsection and recorder size
        comment shipped in the follow-up batch 1 train (notes/ui-terminology.md
        § Revision-log row vocabulary; activePlanRecorder.ts comment fix).
        Schedule-revised disambiguation + Plan refreshed fallback handling
        (incl. isFallback flag, hour-diff chip suppression, one-shot
        console.warn) shipped in batch 2 (PR #1203). Summary line replaces
        bare count, reason-based panel-visibility threshold, hour-diff chip
        aria-label / title, and `.plan-revision-row` CSS-grid layout
        (320 px wrap-safe) shipped in batch 3.

*v2.10.0..main release-review findings (2026-05-28, six-agent fan-out:
`pels-runtime-reality` + `pels-layering-guardian` + `pels-copy-and-terminology` +
`pels-m3-critic` + `pels-ux-fit` + adversarial-review).*

- [ ] **Retire the migration scaffolding once per-key has proven out.** Per-device-key
      storage shipped (objectives now live under `deferred_objective.<deviceId>`
      keys; `lib/plan/deferredObjectives/objectiveStore.ts`). The one-shot migration
      CONSUMES the legacy `DEFERRED_OBJECTIVES_SETTINGS` blob (unsets it after copy)
      so a marker-read flake can't resurrect a since-cleared task — but a
      genuinely-empty-but-present legacy blob is left untouched (abandon-grace on
      the blob read), so a stray empty blob key can linger. Once per-key has proven
      out in production, drop `migrateBlobToPerKeyIfNeeded` + the
      `deferred_objectives_perkey_migrated` marker, and add a tiny boot migration
      that unsets any lingering empty `deferred_objectives` key. Source:
      per-device-key cutover, 2026-05-30.

- [ ] **Run the startup back-fill after an in-session migration retry.** The
      one-shot `runStartupBackfill` is gated on the migration marker, so if a
      boot-time empty `getKeys()` flake deferred the migration, back-fill exits with
      the watermark untouched. The plan-cycle migration retry (in `appInit`'s
      `getDeferredObjectiveSettings`) later completes the migration in the SAME
      session, but back-fill is not re-run — so the first clean plan-history
      observation can advance the watermark to `now`, permanently skipping the
      offline window for migrated legacy tasks. Fix: trigger the back-fill when the
      in-session retry completes (marker unset→set), OR keep the observation
      watermark frozen until a back-fill has actually run that session. Narrow
      (boot-flake + timing; affects history completeness, not the live tasks).
      Source: codex (P2) on PR #1294, 2026-05-30.

- [ ] **Close the transitive widget WebView import hole.** The
      `no-widget-to-runtime-except-node-entries` arch rule catches only DIRECT
      `widgets/*/src/public/** -> lib|app|setup|...` edges. It does not catch the
      transitive `public/** -> *WidgetPayload.ts -> lib` path, because the
      `*WidgetPayload.ts` node builders are allowlisted to import lib and
      `public/render.ts` (headroom, smart_tasks) imports those builders for
      constants/types. Today every payload->lib edge is type-only (erased at
      build, so nothing bundles into the WebView), but a future VALUE import in a
      payload builder would silently ship runtime code into the browser bundle
      while `arch:check` stays green. Fix: split the browser-safe constants/types
      out of the node builders into a shared browser-safe module, then add a rule
      forbidding `widgets/*/src/public/** -> (api.ts|*WidgetPayload.ts)`. Source:
      codex review of PR #1286, 2026-05-29.

- [ ] **Fold the starvation-rescue deadline-horizon guard into the producer.**
      `widgets/starvation_rescue/src/api.ts` (create path) calls
      `App.hasDeferredObjectiveForDevice` to decide whether its now+3h horizon
      guard applies — a resolution-in-producer smell (the consumer reconstructs
      the merge policy "does the candidate deadline matter?"). Fold the horizon
      validation into `App.rescueDeviceWithBudgetExemption`, which already reads
      the existing entry and owns the merge: reject past deadlines always, apply
      the upper now+3h bound only on the fresh (no-existing-objective) branch,
      returning a stable reject reason. Then delete `App.hasDeferredObjectiveForDevice`
      and the widget's existence branch, and relocate `RESCUE_DEADLINE_HORIZON_MS`
      to a browser-safe shared-domain module (both the widget candidate-builder and
      the producer validator need it). The past-deadline correctness half is
      already fixed (codex P2 on #1288); this is the layering cleanup.
      Source: pels-layering-guardian + codex review of PR #1288, 2026-05-29.
