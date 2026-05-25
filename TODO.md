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

*(none open — recent closures shipped on the v2.9 train via PRs #975,
#977, #978, #980, #982, #983; surviving follow-ups demoted to P1/P2.)*

## P1 Correctness, Data Integrity, and Supported UX

*v2.9.0 closeout and v2.8.x release-review follow-ups. These are safe for
patch releases, not release blockers; each item carries its own source/date.
(The v2.8.0 card-title rename landed in PR #934.)*


- [ ] Refresh the `ws` / `socket.io-client` dependency advisory now that
      upstream has a non-breaking 6.x path. Current lock:
      `socket.io-client@4.8.3` -> `engine.io-client@6.6.4` ->
      `ws@~8.18.3`, leaving GHSA-58qx-3vcg-4xpx open. npm registry check on
      2026-05-21 shows `engine.io-client@6.6.5` (which depends on
      `ws@~8.20.1`) is inside `socket.io-client`'s `~6.6.1` transitive
      range. Acceptance: prefer a non-breaking lockfile refresh
      (`npm update engine.io-client` or equivalent) that keeps
      `socket.io-client@4.8.3`; rerun `npm audit`; do not use
      `npm audit fix --force` or downgrade `socket.io-client`.
      Files: `package-lock.json`, `package.json` only if an override becomes
      necessary.
      Source: v2.8.0 release-review leftovers, 2026-05-21.

*v2.7.1 release-review findings (2026-05-17). Six items below from the
six-agent fan-out pass on `v2.7.0..HEAD`; safe for the next patch
release, not v2.7.1 merge-blockers.*


*Pro Homey runtime-log audit (2026-05-17, log
`/tmp/pels/start.main.0a4464c3.stdout.log`, 2h40m window).*

- [x] Align user-visible Homey labels, Flow cards, and public docs with the redesigned Settings UI
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
      Shipped: pre-existing commits `bc80cc94`, `4540dcac`, `4b261603`, `31b174fc`, `7490b208`
      already landed the capability/flow/doc rewrites. Final drift caught in batch9: the
      `pels_hourly_limit_kw` locale override in `locales/en.json` still said
      `Current hourly limit` while the capability JSON had moved to `Current safe pace`; the
      locale wins at runtime via `homey.__()`, so users saw the stale string. Locale realigned
      to `Current safe pace` so capability + locale + UI all agree. Per PR #1013, README.md
      and `.homeycompose/app.json` keywords stay as-is (pre-onboarding marketing copy).
      Token id `name: "shortfall"` on the `deadline_ended` trigger is preserved as a stable
      contract identifier (visible label is `Gap to target`).
- [x] Make the browser Homey stub reliable enough for future screenshot UI audits.
      Shipped: 16/16 declared API routes handled (was 10), `deferredObjectiveActivePlans`
      seeded on both bootstrap surfaces, typed `BootstrapAuditScenario` builder with six
      scenarios (normal, pressure, over-budget, missing-price, empty-history, dense-device)
      at the Homey SDK boundary, `__stub.applyAuditScenario(name)` plus
      `__PELS_HOMEY_STUB__ = { scenario: '...' }` boot-time entry point, parity test
      enforces helper/browser stub names stay in sync. See `notes/browser-stub.md`.
      Files: `packages/settings-ui/tests/e2e/fixtures/homey.stub.js`,
      `packages/settings-ui/test/helpers/homeyApiMock.ts`,
      `packages/settings-ui/test/helpers/auditScenarios.ts`,
      `packages/settings-ui/test/auditScenarios.test.ts`,
      `notes/browser-stub.md`.
- [x] Add loading skeletons across the five panels.
      Loading state today is a plain `<p class="muted">Awaiting data…</p>` in all panels —
      identical wording, identical styling, no M3 shimmer / skeleton. First-paint after the
      Configure dialog opens shows a flat grey wall until the bootstrap fetch resolves.
      Standardize on a single M3 skeleton primitive (one shape per panel: hero placeholder +
      card placeholders) and use it everywhere.
      Files: `packages/settings-ui/src/ui/views/*.tsx`,
      `packages/settings-ui/public/style.css`.
      Shipped: Budget panel (HTML skeleton in `#budget-redesign-surface`), Usage panel
      (HTML skeleton overlay + `data-loading` toggle, dropped by `renderPowerStats`),
      Smart tasks past list (`DeadlinesHistoryList` `loading` state), Smart task plan SPA
      route (`DeadlinePlan` `loading` state + initial HTML in `#deadline-plan-root`). Overview
      panel already shipped its skeleton at v2.7.3; Settings panel is static navigation
      with no async load and intentionally has no skeleton.
- [ ] Consolidate the remaining duplicated card / button / segmented-control /
      ripple / elevation primitives across every settings-UI surface.
      The hero + section-label rebind phase of the original "unify the hero primitive" P1
      now ships in full — Overview hero, Budget header, Usage header, Smart tasks header,
      Settings header, Advanced header, AND the deadline-plan hero all render through the
      shared `.plan-hero` / `.pels-hero` primitive with the canonical `.eyebrow` +
      `.plan-hero__headline` cascade and the same `data-tone="good|warn|alert|info"`
      bindings. Regression coverage at `packages/settings-ui/test/heroPrimitiveRebind.test.ts`
      pins every surface to the canonical shell + eyebrow + headline shape so a future
      refactor can't silently revert.
      The chip primitive rebind phase also ships now (batch 9, this PR): the
      legacy `.chip` shell with `chip--ok` / `chip--boost` / `chip--neutral` /
      `chip--alert` tonal variants is retired, and the two remaining consumers
      (device-list state chip in `deviceListPresentation.ts`, mode-row
      `.priority-badge` companion class) rebind onto the canonical `.plan-chip`
      primitive (or drop the redundant class entirely, in the priority-badge
      case where the pill fully overrides every chip style). `.plan-chip` now
      carries both the BEM tonal modifiers (`--good|--warn|--alert|--info|
      --muted|--limited`) AND the canonical `data-tone="…"` attribute API used
      by `.plan-hero` — both resolve onto the same tonal style so new consumers
      pick the data-attribute form without forcing a mass migration. Regression
      coverage at `packages/settings-ui/test/chipPrimitiveRebind.test.ts` pins
      the no-legacy-`.chip` invariant + canonical-shell-on-every-surface
      contract. Dead-but-styled selectors (`.plan-row__chip`,
      `.price-row .chip.price-normal`) are gone.
      What remains: nothing — once the card sweep PR (MM) lands the
      remaining card-consumer rebind (`.plan-card` / `.deadline-list-card`
      / `.detail-diagnostics-card` / `.plan-history-card` onto the
      canonical `.pels-surface-card`) ships in the same 2026-05-24 batch
      11 train as segmented / ripple / elevation (phases 4-6 below). The
      one carve-out is `.settings-form-card`, a cross-container shared
      form panel with its own override cascade — routed to a follow-up
      sub-PR (see the Card-phase bullet below).
      Acceptance: one shared CSS class / JSX wrapper per primitive type, every consumer
      rebound, no inline overrides beyond data-attribute state. Implementation may use the
      existing custom primitives or `@material/web` — that choice stays with the P2 entry
      below.
      Why P1 (demoted from P0 in release-review pass): refactor-for-coherence — the surfaces
      render today, just with subtle per-page differences. No user-visible incorrectness, so
      does not gate the release.
      *Remaining primitive-type phases (one PR each, lowest blast first):*
      - **Button — native primitive consolidated (2026-05-24 batch 10 PR).** The
        per-page `.plan-hero__recourse-button` (scoped + doubled-class hack
        under `#deadline-plan-panel`) was retired in favour of a canonical
        `.pels-button` native-button class shared by all three native recourse
        CTAs (DeadlinePlan ready hero, DeadlinePlan pending hero, history-
        detail hero). Canonical choice was Option A: keep MD Web wrappers
        (`<md-text-button>`, `<md-filled-button>`, `<md-outlined-button>`) as
        the source of truth for MD Web buttons -- they already ship M3-correct
        focus rings, state-layer ripples, ARIA, and the 48 px touch-target
        floor; `.pels-button` only exists for the small set of CTAs that need
        a real `<button>` (event delegation, no shadow DOM). Regression
        coverage at `packages/settings-ui/test/buttonPrimitiveRebind.test.ts`
        pins the no-legacy-`.plan-hero__recourse-button` invariant + canonical
        shell + 48 px floor + focus ring + disabled state contract.
        *Still open for follow-up sub-PRs:*
        - **`.plan-history-detail__chart-toggle` ghost button — done
          (2026-05-24 batch 12 PR).** The trajectory-chart toggle now
          chains the canonical `.pels-button` primitive with a
          `.plan-history-detail__chart-toggle` decorator that keeps
          the page-local ghost-button visual (transparent background,
          narrower padding, lighter hover/focus tint, font-weight
          inherit). Going filled would have visually competed with the
          H2 chart-card title it sits beside, so the decorator wins.
          The e2e at
          `packages/settings-ui/tests/e2e/deadline-recorder-to-history.spec.ts`
          was rebound onto `button.pels-button.plan-history-detail__chart-toggle`
          and the rebind regression at
          `packages/settings-ui/test/buttonPrimitiveRebind.test.ts` now
          pins both ends of the chain (primitive + decorator) plus the
          doubled-class cascade that beats the panel-scoped `.pels-button`
          fill.
        - **Per-page MD Web layout helpers** (`.budget-context-action`,
          `.budget-page-header__action`, `.dry-run-banner__action`) stay --
          they're legit positioning / MD-Web-custom-property overrides on top
          of the MD Web button, not duplicate primitive shells.
      - **Card — primitive consolidated (2026-05-24 batch 11 PR).** The joint
        `.plan-card, .pels-surface-card { … }` rule was split: the canonical
        primitive `.pels-surface-card` now owns the surface contract
        (padding / gap / border / radius / bg / overflow / isolation / M3
        elevation) on its own, and `.plan-card` keeps only the device-row-
        specific add-ons (chip-border padding offset, min-height rhythm,
        `--dim` modifier, `data-state-kind` aliases that resolve onto the
        same `--color-state-*-bg/-border` tokens). The canonical primitive
        gained two new attribute APIs that mirror the chip / hero patterns:
        `data-tone="good|warn|alert|info|muted"` for tonal surface and
        `data-interactive` for the M3 hover-elevation + focus-outline
        contract clickable cards opt into.
        Per-page forked surface rules retired in the rebind: `.plan-history-
        card` (was forking surface-tier + radius), `.deadline-list-card`
        (was forking padding + radius + box-shadow), `.detail-diagnostics-
        card` (was forking surface + bypassing the token system with a
        hardcoded `10px` radius + `12px` padding). Each now walks the
        canonical surface and keeps only its layout / hover / link-anchor
        decorator on top.
        Rebound markup sites (7 total):
        - `.plan-card`: three JSX consumers (PlanDeviceCards binary +
          temperature variants, PlanSteppedCard) and one imperative
          (`devices.ts` device-group card, already chained) now all chain
          `pels-surface-card` on the host.
        - `.plan-history-card`: `DeadlinePlanHistory` past-plan card chains
          `pels-surface-card` + `data-interactive` so the link variant
          inherits the canonical hover-elevation + focus-outline.
        - `.deadline-list-card`: `DeadlinesList` smart-task card same.
        - `.detail-diagnostics-card`: two imperative hosts in
          `deviceDetail/diagnostics.ts` (per-window summary + starvation
          detail) chain `pels-surface-card`.
        Kept as legitimate decorators on the canonical (no rebind needed —
        already paired in markup): `.budget-redesign-card`, `.budget-chart-
        card`, `.budget-confidence-card`, `.deadline-horizon-card`,
        `.usage-card`, `.pels-device-card`. Kept separate (distinct
        primitive shape, NOT a card-surface fork): `.settings-nav-card`
        (MD-list-item internals), `.settings-form-card` (cross-container
        shared form panel — its own audit, route below).
        Dead-but-styled selectors gone: `.usage-summary`, `.summary-card`,
        `.summary-label`, `.summary-value` (v1 layout, never emitted in
        current markup); the live `.summary-value--empty` marker that
        `power.ts` + `usageDayView.ts` still toggle survives.
        Regression coverage at `packages/settings-ui/test/
        cardPrimitiveRebind.test.ts` pins the canonical-shell-on-every-
        surface contract + no-forked-base-rule invariant + dead-rule
        cleanup + per-surface rebind shape so a future refactor can't
        silently revert.
        *Still open for follow-up sub-PRs:*
        - **`.settings-form-card` cross-container audit.** The base rule
          (line ~979 of `style.css`) and the `:where(#limits-panel,
          #simulation-panel, #electricity-prices-panel, #price-aware-
          devices-panel) .settings-form-card` override (line ~6806) declare
          two different visual contracts for the same class, depending on
          which panel the host renders inside. The settings-current-mode
          section (`#settings-panel`) hits the base; everything else hits
          the override. The override paints a near-canonical surface
          (border + radius + surface-2 + shadow-sm). Decide whether to
          collapse onto `.pels-surface-card` or accept the two-tier
          contract as legit "form-panel sub-variant" — separate PR to
          keep this batch focused on the visual surface primitive.
      - **Segmented control — landed (2026-05-24 batch 11 PR, phase 4).** `.segmented`
        + `.segmented__option` are the single canonical shell across every consumer
        (Plan/Adjust toggle, day-toggle, Progress/Hourly plan, 7d/14d,
        All/Weekday/Weekend, Current/History plan, device-detail When-limiting).
        Leaky `.segmented--power-limiting` per-page modifier was retired; the
        narrow-viewport rule now scopes to `#device-detail-panel .segmented` under
        the existing `@media (max-width: 430px)` gate so the primitive itself
        carries no panel-specific variant. Both renderers (imperative
        `createToggleGroup` in `components.ts` and preact `ToggleGroup` in
        `BudgetOverview.tsx`) build the same DOM shape. Regression coverage at
        `packages/settings-ui/test/narrowPrimitiveRebind.test.ts` (phase 4 section)
        pins the canonical shell + bans `.segmented--…` modifiers + verifies
        both renderers produce identical DOM.
      - **Ripple — landed (2026-05-24 batch 11 PR, phase 5).** `<md-ripple>` (via
        `MdRipple` JSX wrapper from `materialWebJSX.tsx` or the raw element in
        `index.html`) is the single source of truth for the state-layer ripple.
        Every consumer mounts it with the canonical
        `<MdRipple aria-hidden="true" />` shape — no `attached` prop, no custom
        colour override, no event handlers. The ripple-tint tokens
        (`--md-ripple-hover-color`, `--md-ripple-pressed-color`) live on the
        shared `.plan-card` / `.pels-surface-card` cascade. No custom `.ripple`
        / `.has-ripple` shell exists. Regression coverage at the same test file
        (phase 5 section).
      - **Elevation — landed (2026-05-24 batch 11 PR, phase 6).** `<md-elevation>`
        (via `MdElevation` JSX wrapper or raw element in `index.html`) is the
        single source of truth for card surface lift. Every consumer mounts it
        with the canonical `<MdElevation aria-hidden="true" />` shape. The
        elevation cascade (resting `--md-elevation-level: 1`, hover/focus `3`,
        active `2`) lives on `.plan-card` + `.pels-surface-card` so every card
        surface picks the same lift from the same source. Every `box-shadow`
        declaration in `style.css` either resolves to a shared `var(--shadow-*)`
        token, an explicit `none` reset, a 1 px inset hairline, a 1-3 px
        contrast/focus outline, or the chart-tone glow — no raw card
        elevation. Regression coverage at the same test file (phase 6 section).
      *Reference — sub-bullets from the original M3 visual pass that are now closed:*
      - **Overview hero side landed (hero-rework PR):** headline tone no longer flips to
        warning/critical, the redundant `"X kW above hard cap"` subline was dropped, the
        power bar now renders segmented [managed][background] blocks on a single track,
        and the section labels reuse the shared `.eyebrow` primitive.
      - **Budget / Usage / Settings / Advanced headers rebound (2026-05-23 batch 7
        partial PR):** all four now render via `.plan-hero` / `.pels-hero` with the
        shared `.eyebrow` + `.plan-hero__headline` cascade; the per-surface
        `.budget-page-header__title` one-off was dropped.
      - **Tonal-gradient mobile-media-query duplicates folded (same partial PR):**
        the four `data-tone="good|warn|alert|info"` overrides previously declared
        twice — once in the main `.plan-hero[data-tone="…"]` block and once in a
        mobile media query — now consolidate to a single declaration site.
      - **Deadline-plan hero rebound (2026-05-23 batch 8 follow-up PR):** both the
        ready (`DeadlineHero`) and pending (`PendingHero`) variants now render the
        eyebrow as `<p class="eyebrow plan-hero__section-label">` and the headline
        as `<h2 class="plan-hero__headline">`, matching the four sibling panels.
        Tonal cascade (good/warn/alert/info) flows through `data-tone` on the shared
        primitive; no per-surface tonal CSS remains.
      - **Chip primitive rebind landed (2026-05-24 batch 9 PR):** `.plan-chip` is
        the single canonical chip shell; legacy `.chip` + `chip--{ok|boost|neutral|
        alert}` retired; `data-tone="…"` API added alongside the BEM modifiers for
        consistency with `.plan-hero`; per-page chip wrappers
        (`.device-row__state-chip`, `.plan-history-detail__outcome-chip`,
        `.plan-history-detail__cost-narrative-chip`, `.plan-history-detail__
        shortfall-chip`, `.pels-device-card__count-chip`,
        `.hourly-strip__legend-item`, `.budget-page-header__chips`) stay as
        localized layout / typography overrides on top of the canonical shell —
        they don't fork the tonal vocabulary so they don't violate the "one
        chip family" invariant.
      - **Info as a role is sparse on Overview** — only the Smart-task chip and the
        info-tinted histogram on Budget/Usage tabs. That's M3-appropriate (info is for
        neutral explanation), but worth confirming during chip/card consolidation that
        we're not artificially restraining it; if there's a natural "Price low / Price
        high" hint for the hero meta-row, use info there.
      Files: `packages/settings-ui/public/index.html`,
      `packages/settings-ui/public/style.css`, `packages/settings-ui/src/ui/views/PlanHero.tsx`,
      `packages/settings-ui/src/ui/views/BudgetOverview.tsx`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/src/ui/power.ts`, generated `settings/`, screenshot suite under
      `packages/settings-ui/tests/e2e/`.

## P2 Product, Observability, and Maintainability

- [ ] **Add `pending_binary_command_cleared` structured event.** After chip
      4.1c, `getPendingBinaryCommand` (lib/plan/planBinaryControlHelpers.ts)
      silently deletes a stale pending entry it encounters on-demand. The
      sister site `syncPendingBinaryCommands` still emits
      `buildPendingBinaryTimeoutLogMessage` at lib/plan/planBinaryControl.ts:~419,
      so timeouts remain observable in the per-cycle sync sweep. But
      `getPendingBinaryCommand` runs on every shed/restore attempt and was
      the *first* place a stuck pending would surface — losing this site
      narrows the diagnostic window when a stale pending is cleared between
      sync sweeps. Add a structured event
      `pending_binary_command_cleared{reason:'stale_age', ageMs, timeoutMs, capabilityId}`
      via the topic-gated emitter. Source: `pels-layering-guardian` +
      `pels-runtime-reality` P2 on chip 4.1c, 2026-05-24.

- [ ] **Carry EV snapshot fields on `binary_command_skipped` for evchargers.**
      Chip 4.1c removed `logMissingBinaryControlPlan` /
      `logNonSetableBinaryControl`, which previously printed `formatEvSnapshot()`
      fields (`currentOn=`, `evState=`, `available=`, `canSet=`, `powerKw=`,
      `expectedPowerKw=`) for EV chargers specifically. The replacement
      `binary_command_skipped` event carries `reasonCode` + `capabilityId` +
      `hasTargets`, but no EV-specific snapshot fields — exactly the data
      needed to diagnose why EV shedding stalls (canSet flapping,
      evState=disconnected, powerKw mismatch). Extend the event with an
      `evSnapshot?: {…}` subobject when `snapshot.deviceClass === 'evcharger'`,
      mirroring `formatEvSnapshot()`. Source: `pels-runtime-reality` P2 on
      chip 4.1c, 2026-05-24.

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

- [ ] **Move `delete state.pendingBinaryCommands[deviceId]` to try/finally
      in `executeBinaryCommand`.** Today the failure branch (catch) deletes
      the pending entry. If a newer command for the same device is issued
      while the first is in-flight and that older request fails, the catch
      could delete the newer pending entry that already replaced it.
      Restructure with a per-request token gate (the success path leaves
      the pending entry alive for `syncPendingBinaryCommands` to confirm —
      not a simple `finally`). Source: `gemini-code-assist` medium on PR
      #1037 (lib/plan/planBinaryControl.ts:~191), 2026-05-24.

- [ ] **Pass `snapshot` to `executeBinaryCommand` instead of re-fetching via
      `deviceManager.getSnapshot().find()`.** The EV-action success branch
      currently does `formatEvSnapshot(deviceManager.getSnapshot().find((entry) => entry.id === deviceId))`
      to log post-actuation state. This is O(N) per call and the caller
      already has the original snapshot (pre-actuation). Either accept losing
      post-actuation freshness (use the original snapshot) or have
      DeviceManager expose `getSnapshotByDeviceId(id)`. Source:
      `gemini-code-assist` medium on PR #1037
      (lib/plan/planBinaryControl.ts:~259), 2026-05-24.

- [x] **Guardrail `getLogger` against runtime-interpolated module names.** Today
      `getLogger(module)` in `lib/logging/logger.ts` caches one proxy per
      distinct `module` string. Module-scope `const logger = getLogger('plan/x')`
      is safe and bounded; a future caller writing `getLogger(\`device-\${id}\`)`
      per cycle would grow the cache unboundedly (one proxy per device id ever
      seen) and emit fragmented bindings. Add either (a) a lint rule requiring
      the argument to be a string literal, or (b) a runtime warn-once if the
      cache exceeds N entries. Source: `pels-runtime-reality` P2 on the
      `getLogger` foundation chip, 2026-05-24. Shipped option (b):
      `MAX_LOGGER_CACHE_SIZE = 64` (≈68% headroom over the 38 current static
      callsites) with a module-scoped `cacheGrowthWarningEmitted` flag so a
      single `logger_cache_growth_exceeded` warn fires the first time the
      cache outgrows the cap (via `rootLogger.warn` tagged `module:
      'logging/cache'`).

- [ ] **Extend Slice 2 floor promotion beyond priority 1.** (Demoted from the v2.9 train P0
      closeout.) Slice 2 (PR #983) gates floor promotion on
      `device.priority === 1 && both rescue permissions === 'always'`
      because the reserved-headroom forecast (`hardCap − uncontrolled`)
      implicitly assumes every controlled concurrent watt is displaceable,
      which only holds at the absolute top. To safely promote non-top-
      priority fully-reserved tasks, the producer needs a richer headroom
      forecast that subtracts higher-priority controlled load
      (`hardCap − uncontrolled − higherPriorityControlled`). Then the gate
      can broaden to "highest priority present on this Homey." Defer until
      prod evidence after Slice 2 deployment shows a long-tail
      `cannot_meet` rate on non-top-priority tasks that warrants the
      additional plumbing. Files:
      `lib/plan/deferredObjectives/policyHorizon.ts`,
      `lib/plan/deferredObjectives/rescueReplan.ts`,
      `lib/dailyBudget/dailyBudgetBreakdown.ts` (forecast input).
      Source: `pels-runtime-reality` P1 on PR #983, 2026-05-23.

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

- [x] Postmortem copy for `unknown`-with-plan doesn't bridge to the "View
      details" chart affordance. The fallback sentence "PELS could not
      determine how this smart task finished." reads coherently when the
      hero is one-sentence (the `unknown`-no-plan branch). With a plan
      recorded (now showing the collapsed chart card after PR #1074), the
      user sees the sentence + the toggle and may wonder "if you don't
      know, what details?" The expand reveals the plan, which is honest
      evidence — but the copy doesn't preview it. Consider a copy variant
      for the `hasRecordedPlan` branch like "PELS made a plan for this
      smart task but couldn't observe how it finished."
      Files: `packages/shared-domain/src/deferredPlanHistory.ts:776-778`.
      Source: `pels-ux-fit`, PR #1074 follow-up, 2026-05-24.
      *Done 2026-05-24:* `formatPlanHistoryPostmortem` now discriminates on
      `originalPlan/finalPlan` presence and emits "PELS made a plan for
      this smart task but couldn't observe how it finished." when a plan
      was recorded; the no-plan branch keeps the original wording byte-
      identically. Tests assert both branches.

- [x] Comment about Abandoned + RevisionsCard interaction is stale. The
      block at `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx:1219-1220`
      claims "Abandoned entries default collapsed and the card follows
      the same 'log when asked for' rhythm" — but Abandoned has
      `quietAbandoned: true` so the toggle never renders,
      `chartCollapsed` never flips, and `RevisionsCard` is never shown
      for Abandoned. Pre-existing drift; PR #1074's `unknown`-with-plan
      is the first case where the described rhythm actually holds.
      Update the comment to match (e.g. "Unknown-with-plan entries
      default collapsed; the card opens on demand").
      Files: `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`.
      Source: `pels-ux-fit`, PR #1074 follow-up, 2026-05-24.
      *Done 2026-05-24:* comment rewritten to name Unknown-with-plan as
      the actual default-collapsed/opens-on-demand case and call out that
      Abandoned/Replaced stay quiet (`quietAbandoned: true` → no toggle,
      `RevisionsCard` never shows).

- [x] Notes table summary in `notes/v2-7-2/postmortem-chart-policy.md:19`
      could disambiguate `chartCollapsedByDefault` vs `quietAbandoned`.
      The producer-flag summary reads `Unknown=true` but doesn't make
      explicit that this is the `chartCollapsedByDefault` value;
      `quietAbandoned` is what actually toggles per `hasRecordedPlan`.
      The prose at lines 27-32 covers it, but the table-style summary
      could be misread to suggest unknown ALWAYS gets a collapsed card.
      Tighten the phrasing in a future docs sweep.
      Files: `notes/v2-7-2/postmortem-chart-policy.md`.
      Source: `pels-ux-fit`, PR #1074 follow-up, 2026-05-24.
      Resolved: producer-flag summary now annotates the values as
      `chartCollapsedByDefault` only and points to the `quietAbandoned`
      discriminator that flips per `hasRecordedPlan` for Unknown.

- [x] Rename `resolvePlanGenericReasonText` to a name that describes the
      actual function (e.g. `resolveStillReportingAfterPauseText` or
      `resolveReportedLoadAfterPauseText`). Shipped per task spec in
      PR #1075 but the name doesn't describe what the function does —
      it only computes the "Still reporting … after pause" sentence,
      not a generic plan reason. Also: the
      `(dev.reason as { detail?: unknown } | undefined)?.detail` cast at
      the call site is preserved verbatim from the pre-extraction code;
      it's now a published contract between settings-ui and the
      shared-domain helper, so the weak typing is more visible than
      before. A typed `DeviceReason` narrowing helper would be the
      cleaner fix.
      Files: `packages/shared-domain/src/planReasonFormatting.ts`,
      `packages/shared-domain/src/planReasonSemantics.ts`,
      `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx`.
      Source: PR #1075 self-review, 2026-05-24.
      Resolved: renamed to `resolveReportedLoadAfterPauseText`; added
      typed `readDeviceReasonDetail(reason: unknown): unknown` narrowing
      helper alongside (re-exported via `planReasonSemantics.ts`) and the
      call site in `PlanDeviceCards.tsx` now uses both — no `as` cast.

*v2.9.0 retrospective P2 cleanup and docs follow-ups (2026-05-23).*

- [x] `.deadline-list-card:hover` still hardcodes `background:
      var(--color-surface-3)` (style.css:~6224-6229) even though
      `.pels-surface-card[data-interactive]:hover` now provides M3
      elevation lift. Once the elevation-only hover visual is validated
      against the existing baseline on real hardware, delete the
      manual surface-tier swap so the M3 elevation contract is the
      single source of truth.
      Files: `packages/settings-ui/public/style.css`.
      Source: `pels-m3-critic`, PR #1040 follow-up, 2026-05-24.
      Done 2026-05-24 in CSS micro-fix bundle: dropped the
      `background: var(--color-surface-3)` line from the
      `.deadline-list-card:hover, :focus-visible` rule so only the
      accent border swap remains; the canonical `.pels-surface-card
      [data-interactive]:hover` `--md-elevation-level: 3` lift owns
      the surface-tier change. Pinned by a new
      `cardPrimitiveRebind.test.ts` regression that asserts the
      hover/focus rule body carries no `background:` declaration.

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

- [x] Comment hygiene on the `.pels-surface-card` primitive block.
      `packages/settings-ui/public/style.css:2464-2479` and three other
      comment blocks repeat the same "canonical / decorator" preamble.
      Consolidate into one block above `.pels-surface-card` and
      shorten the per-rule comments so future readers see the rule of
      thumb in one place.
      Files: `packages/settings-ui/public/style.css`.
      Source: `pels-m3-critic`, PR #1040 follow-up, 2026-05-24.
      Done 2026-05-24 in CSS micro-fix bundle: added one
      "Canonical primitives — rule of thumb" preamble block above
      `.pels-surface-card` documenting the canonical / decorator
      contract, the doubled-class and panel-scope cascade idioms,
      and the shared `data-tone` tonal API. Per-decorator comment
      blocks on `.plan-history-card`, `.plan-history-card--link`,
      `.detail-diagnostics-card`, and `.deadline-list-card`
      shortened to a one-line pointer to the preamble plus any
      decorator-specific contract notes.

- [x] Budget chip-rail toggle `margin-left: auto` causes a cosmetic
      asymmetry when it wraps. PR #1016 routes the Budget header through
      the shared `.plan-hero` primitive with a `.plan-hero__chips` row
      carrying the price-level chip and the Plan/Adjust toggle. The
      toggle uses `margin-left: auto` (style.css:4643) to sit flush
      right when no chip is shown; when the row narrows below the
      combined width the toggle wraps to its own flex line and the
      `auto` margin pushes it to the right edge while the chip sits at
      the left — readable but cosmetically asymmetric against the
      headline below. Either drop the `margin-left: auto` (let the
      parent's `justify-content` handle alignment) or align both edges
      intentionally on wrap. Cosmetic; bounded one-rule fix.
      Files: `packages/settings-ui/public/style.css`.
      Source: `pels-m3-critic`, PR #1016 follow-up, 2026-05-23.
      Done 2026-05-23 in commit d229c480 (v2.9 retrospective P2
      cleanups): dropped `margin-left: auto` from
      `.budget-page-header__action` so the parent
      `.plan-hero__headline-row`'s `justify-content: space-between`
      (no-chip path) and the chip-rail's `flex: 1 1 auto` (chip path)
      handle trailing alignment. Inline comment block above the rule
      records the rationale. Closed from the CSS micro-fix bundle on
      2026-05-24 after confirming the diff already landed; no further
      CSS edit required.

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

- [x] Harden the rescue-only replan-reason routing against partial /
      combined toggle scenarios. The PR-998 regression suite covers
      "no rescue → some rescue" and "both → none", plus the negative
      cases (target-change wins, neither changes). Two scenarios should
      also be pinned so a future refactor can't silently invert the
      cascade: (a) a single-permission toggle
      (`exemptFromBudget: never → always` with
      `limitLowerPriorityDevices` unchanged at a non-null value) — drives
      the `key === ...` ternary in `withRescuePermission` end-to-end to
      the recorder; (b) a rescue toggle simultaneous with a
      `planStatus` drift on identical hours, asserting that
      `flow_permission_changed` still wins because `baseChanged = false`
      while `rescueChanged = true` (and the metadata-only drift would
      have routed to `schedule_revised` on its own).
      Files: `test/deferredObjectiveActivePlan.test.ts`,
      `flowCards/smartTaskRescueCard.ts`,
      `lib/plan/deferredObjectives/replanReason.ts`.
      Source: `pels-runtime-reality`, PR #998 follow-up, 2026-05-23.
      Resolved: added `emits flow_permission_changed on a
      single-permission toggle when the other rescue permission stays
      granted` and `emits flow_permission_changed when a rescue toggle
      and a planStatus drift land in the same cycle` to
      `test/deferredObjectiveActivePlan.test.ts`'s
      `rescue-permission-only replan routing` describe block.

- [x] Smart-task extra-permissions row wraps mid-word at 320 px under
      worst-case payload. `.deadline-list-card__when-row dd` uses
      `overflow-wrap: anywhere`, so the longest composed value (both
      permissions granted, `at_risk` mode) can split words like
      "lower-prio | rity". No overflow risk; just visual noise at the
      narrowest viewport. Consider a soft-break-friendly wrap (break on
      separator / hyphen) or a line-clamp + tooltip for the worst case.
      Files: `packages/settings-ui/public/style.css`,
      `packages/settings-ui/src/ui/views/DeadlinesList.tsx`.
      Source: `pels-ux-fit`, PR #992 follow-up, 2026-05-23.
      Fixed in `fix/p2-ux-micro-bundle`: swapped `overflow-wrap: anywhere`
      → `overflow-wrap: break-word` on `.deadline-list-card__when-row dd`
      (list page) and `.plan-inputs__row-value` (detail page, same
      `extraPermissionsValue` payload) so the browser prefers word-boundary
      breaks (spaces / `·` separator) and only splits mid-word as a last
      resort. Detail-page parity added inline after `pels-ux-fit` P1 flag.

- [x] Smart-task detail pending branch renders `<PendingHero />` +
      `<PriorRunsHistory />` as a `<>` fragment without an outer
      `pels-surface-card`, while sibling states (`loading`, `error`,
      `completed`, `history-missing`) all wrap their content in a card.
      The history then sits flush against the panel background instead of
      a card. Visually defensible (the history list owns its own card
      stack) but inconsistent rhythm worth a follow-up to either wrap or
      explicitly document why pending is the odd one out.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`.
      Source: `pels-ux-fit`, PR #992 follow-up, 2026-05-23.
      Documented in `fix/p2-ux-micro-bundle` (no code change): the pending
      branch mirrors the `ready` branch (`.pels-hero` + sibling cards as a
      fragment). `.pels-hero` is itself a card-shaped surface (border,
      radius, surface tier) and `PriorRunsHistory` rows own their own
      `.pels-surface-card` stack — wrapping would double-card the hero and
      nest history rows inside an extra container. Added an explanatory
      comment above the fragment in `DeadlinePlanRoot`.

- [x] Finish the Budget hero copy-locality pass alongside
      `dailyBudgetHeroStrings.ts`. The v2.9 Rule-4 cleanup pulled the
      finish-of-day decision sentences and the `resolveHeadroomLine` template
      onto shared-domain, but the rest of the hero copy chain is still
      inlined in settings-ui: `HEADLINE_LABEL_BY_VIEW` (`Yesterday's total` /
      `Projected today` / `Planned for tomorrow`), the disabled-state
      sentences `'Waiting for daily budget data'` / `'Daily budget off'`, and
      the today-tone lines in `resolveTodayLine` /
      `resolveChartSubtitle` (`'Projected to finish over budget.'` etc.).
      Move them into `dailyBudgetHeroStrings.ts` so runtime logs and
      screenshots quote one canonical source.
      Files: `packages/settings-ui/src/ui/budgetRedesign.ts`,
      `packages/shared-domain/src/dailyBudgetHeroStrings.ts`.
      Source: `pels-copy-and-terminology`, v2.9 Rule-4 cleanup follow-up,
      2026-05-23. Done 2026-05-24 (bundled with the Headroom-helper rename):
      added `DAILY_BUDGET_HEADLINE_LABEL_BY_VIEW`,
      `DAILY_BUDGET_DISABLED_WAITING`, `DAILY_BUDGET_DISABLED_OFF`,
      `resolveTodayLine(status, cause)`, and
      `resolveChartSubtitle({ view, mode, status, priceReliable, priceShapingEnabled })`
      as shared-domain exports; `budgetRedesign.ts` now imports those and
      keeps only the local payload→discriminant glue.

- [x] Rename the new `dailyBudgetHeroStrings.ts` helper API to drop the
      `Headroom` jargon. `composeHeadroomOverBudgetUsed`,
      `composeHeadroomLeftToday`, and `composeHeadroomLineWithEstimate` are
      new shared-domain symbols introduced by the v2.9 Rule-4 cleanup; the
      visible strings already use "left in today's budget" / "over budget
      already used" (no jargon), but the symbol names leak the banned term
      per `notes/ui-terminology.md` Rule 1. Rename to `composeBudgetUsedOver`
      / `composeBudgetRemainingToday` / `composeBudgetRemainingLineWithEstimate`
      or similar. Also resolve the `est.` abbreviation in the template — Rule 3
      bans abbreviations in visible labels; widen to `estimated` when the
      pre-existing wording is reworked.
      Files: `packages/shared-domain/src/dailyBudgetHeroStrings.ts`,
      `packages/settings-ui/src/ui/budgetRedesign.ts`.
      Source: `pels-copy-and-terminology`, v2.9 Rule-4 cleanup follow-up,
      2026-05-23. Done 2026-05-24: renamed to `composeBudgetUsedOver` /
      `composeBudgetRemainingToday` /
      `composeBudgetRemainingLineWithEstimate`; the estimate-suffix template
      now spells `estimated` in full ("· estimated 6.50 kr today" instead of
      "· est. 6.50 kr today"). All callsites in `budgetRedesign.ts` updated;
      no other importers existed.

- [x] Route test/doc anchors through the shared-domain copy constants.
      `test/deviceOverview.test.ts:147`, `test/planReasonUserFacing.test.ts:57`,
      `packages/settings-ui/test/budgetRedesign.test.ts:155-156`, and
      `docs/plan-states.md:35,55` hardcode `Limited by the hard cap` /
      `Limited by today's daily budget` / `Yesterday finished …` strings
      verbatim. Importing `PLAN_STATE_HELD_FALLBACK_STATUS` /
      `PLAN_STATE_DAILY_BUDGET_STATUS` (and the dailyBudget hero constants)
      would let a future rename trip the tests instead of silently diverging.
      Files: those above; constants in
      `packages/shared-domain/src/planStateLabels.ts` and
      `packages/shared-domain/src/dailyBudgetHeroStrings.ts`.
      Source: `pels-copy-and-terminology`, v2.9 Rule-4 cleanup follow-up,
      2026-05-23; reworded 2026-05-24 after the undersell walk-back
      (961904f8) standardised the "Limited by …" wording across helpers.
      Done 2026-05-24 (bundled with the `headroomLine`/`resolveHeadroomLine`
      symbol rename): `test/deviceOverview.test.ts` now imports
      `PLAN_STATE_HELD_FALLBACK_STATUS` from
      `packages/shared-domain/src/planStateLabels`; `test/planReasonUserFacing.test.ts`
      imports `PLAN_STATE_HELD_FALLBACK_STATUS` (line 57),
      `PLAN_STATE_DAILY_BUDGET_STATUS` (line 62), and
      `PLAN_STATE_HOURLY_BUDGET_STATUS` (line 67 — opportunistic pin while in
      the same expected-cases table); `packages/settings-ui/test/budgetRedesign.test.ts`
      imports `YESTERDAY_FINISHED_OVER_BUDGET` / `YESTERDAY_FINISHED_WITHIN_BUDGET`
      from `packages/shared-domain/src/dailyBudgetHeroStrings` for the
      yesterday decision-line assertions. `docs/plan-states.md` lookup tables
      stay verbatim because markdown can't import; the doc is human reference
      and the literal strings are the pedagogical value.

- [x] Finish the `Headroom` Rule-1 sweep in settings-ui. After PR #1049
      purged `Headroom` from `dailyBudgetHeroStrings.ts`, two internal
      settings-ui symbols still carry the banned term:
      `BudgetHeroData.headroomLine` (field at
      `packages/settings-ui/src/ui/views/BudgetOverview.tsx:42`) and
      `resolveHeadroomLine` (function at
      `packages/settings-ui/src/ui/budgetRedesign.ts:265`). Neither
      reaches the user or runtime logs — these are TypeScript identifier
      names only — but the field name now contradicts the visible
      vocabulary it carries (the produced string says "left in today's
      budget" / "over budget already used", never "headroom"). Rename
      to `budgetRemainingLine` / `resolveBudgetRemainingLine` (or
      similar) and update the `BudgetHeroData` shape, the `BudgetOverview`
      consumer, and any test snapshots that anchor on the field name.
      Files: `packages/settings-ui/src/ui/views/BudgetOverview.tsx`,
      `packages/settings-ui/src/ui/budgetRedesign.ts`,
      `packages/settings-ui/test/budgetRedesign.test.ts`.
      Source: `pels-copy-and-terminology`, PR #1049 follow-up, 2026-05-24.
      Done 2026-05-24 (bundled with the test/doc anchor pivot above):
      renamed `BudgetHeroData.headroomLine` → `budgetRemainingLine` and
      `resolveHeadroomLine` → `resolveBudgetRemainingLine`; updated every
      importer in `packages/settings-ui/src/ui/views/BudgetOverview.tsx`,
      `packages/settings-ui/src/ui/budgetRedesign.ts`,
      `packages/settings-ui/test/budgetRedesign.test.ts`,
      `packages/settings-ui/test/heroPrimitiveRebind.test.ts`, and
      `packages/settings-ui/test/chipPrimitiveRebind.test.ts`. No visible
      string changed; the produced subline still reads
      "… left in today's budget" / "… over budget already used".

- [x] Lift the remaining inlined visible strings in
      `packages/settings-ui/src/ui/budgetRedesign.ts` into
      `packages/shared-domain/src/dailyBudgetHeroStrings.ts` per Rule 4.
      PR #1049 covered the hero headline/disabled/today/chart-subtitle set
      but several adjacent strings still live in settings-ui only and
      cannot be reused by runtime log statements:
      ~~`Close to budget` / `On budget` / `Over by … kWh`
      (lines 190-194)~~, ~~`Using cheaper hours` /
      `Using cheaper hours (price data unavailable)` (line 262)~~, ~~the
      five-line `resolveNoPlanLine` block (282-290)~~,
      ~~`resolveTomorrowLine` strings (293-295)~~, ~~the
      `Managed … · Background …` split-line template (236)~~,
      ~~`Hourly plan` / `Progress` chart titles (391)~~, the
      ~~`High` / `Medium` / `Low` confidence-band labels (405-407)~~, the
      ~~`Showing tomorrow's plan…` / `Showing today's plan…` comparison
      labels (487, 494)~~, and the ~~`Adjust budget` button label at
      `packages/settings-ui/src/ui/views/BudgetOverview.tsx:229`~~. Lift
      each into a shared-domain helper or constant that runtime logging
      can reach for parity. Bundle in batches by section (hero subtitle,
      chart subtitle, no-plan sentences, etc.) rather than one giant move.
      Files: `packages/settings-ui/src/ui/budgetRedesign.ts`,
      `packages/settings-ui/src/ui/views/BudgetOverview.tsx`,
      `packages/shared-domain/src/dailyBudgetHeroStrings.ts`.
      Source: `pels-copy-and-terminology`, PR #1049 follow-up, 2026-05-24.
      *First wave done (2026-05-25):* hero subtitle batch lifted —
      `Close to budget` (`BUDGET_HERO_CLOSE_TO_BUDGET`), `On budget`
      (`BUDGET_HERO_ON_BUDGET`), the `Over by N.N kWh` pill template
      (`composeBudgetHeroOverBy`), `Using cheaper hours` /
      `Using cheaper hours (price data unavailable)`
      (`BUDGET_HERO_USING_CHEAPER_HOURS` /
      `BUDGET_HERO_USING_CHEAPER_HOURS_NO_PRICES`), and the
      `Managed N.N kWh · Background M.M kWh` split-line
      (`composeManagedBackgroundLine`) all moved into
      `packages/shared-domain/src/dailyBudgetHeroStrings.ts` with their
      kWh formatting; `budgetRedesignResolvers.ts` consumes them and
      computes nothing locally.
      *Second wave done (2026-05-25):* chart titles + confidence labels +
      comparison labels + adjust-button batch lifted —
      `Hourly plan` / `Progress` chart titles
      (`BUDGET_CHART_TITLE_HOURLY_PLAN` / `BUDGET_CHART_TITLE_PROGRESS`,
      consumed by both `resolveChartData` and the `ToggleGroup` in
      `BudgetOverview.tsx` so the heading and the toggle option labels
      share one source), `High` / `Medium` / `Low` confidence-band labels
      (`BUDGET_CONFIDENCE_LABEL_HIGH` / `BUDGET_CONFIDENCE_LABEL_MEDIUM` /
      `BUDGET_CONFIDENCE_LABEL_LOW`, with a new `BudgetConfidenceLabel`
      type narrowing `BudgetConfidenceData['label']` to those constants),
      `Showing tomorrow's plan — tomorrow's prices are in.` /
      `Showing today's plan — tomorrow's prices not yet available.`
      comparison labels (`BUDGET_COMPARISON_SHOWING_TOMORROW` /
      `BUDGET_COMPARISON_SHOWING_TODAY`), and the `Adjust budget` button
      label (`BUDGET_ADJUST_BUDGET_BUTTON`). All visible wording preserved
      byte-for-byte.
      *Third / final wave done (2026-05-25):* `resolveNoPlanLine` block
      and `resolveTomorrowLine` strings lifted —
      `Tomorrow's plan is not available yet. Check electricity prices if it does not appear shortly.`
      (`BUDGET_NO_PLAN_TOMORROW_WAITING`),
      `Yesterday history is not available yet.`
      (`BUDGET_NO_PLAN_YESTERDAY_WAITING`),
      `PELS is preparing the daily plan. Check again shortly.`
      (`BUDGET_NO_PLAN_TODAY_PREPARING`),
      `Enable daily budget to plan tomorrow.`
      (`BUDGET_NO_PLAN_ENABLE_FOR_TOMORROW`),
      `Enable daily budget to build a daily plan.`
      (`BUDGET_NO_PLAN_ENABLE_FOR_TODAY`),
      `Most planned use is shifted toward cheaper hours.`
      (`BUDGET_TOMORROW_PRICE_SHAPED`), and
      `Tomorrow's budget plan is ready.`
      (`BUDGET_TOMORROW_PLAN_READY`). The router functions themselves
      also moved: `resolveNoPlanLine(view, budgetEnabled)` and
      `resolveTomorrowLine(priceShapingActive)` now live in
      `dailyBudgetHeroStrings.ts`; the consumer in
      `budgetRedesignResolvers.ts` is a one-line call site (the tomorrow
      wrapper only narrows the payload to the boolean discriminant the
      producer expects). Multi-wave lift complete.

- [ ] Document the lossy-restart gap in the postmortem strip UI. The
      lossy-restart contract at
      `lib/plan/deferredObjectives/planHistory.ts:141-148` notes that
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
      (rendering), `lib/plan/deferredObjectives/planHistory.ts:141-148`
      (data signal so the renderer can identify the gap).
      Source: `pels-runtime-reality`, PR #990 follow-up, 2026-05-23.

*Confidence-model Step-2 follow-ups (2026-05-23). Step 2 of Cause #1
(`resolveBandedProfileConfidence` + `applyBandedConfidence`) shipped — the
overall `kwhPerUnit.confidence` now reflects the pooled within-band residual,
so a converged multi-step device can escape `low` (the standing v2.9 P0 signal
seen 985/985 in prod). These are `pels-runtime-reality` follow-ups that didn't
block merge.*

- [x] Threshold validation for *mildly* multi-step devices. The 0.35 / 0.75
      RSD thresholds were calibrated for raw per-sample CV; pooled within-band
      variance is structurally smaller, so a profile with only modest
      between-band variance reduction could in principle reach `high` based
      on a small lift. The smoking-gun test covers a tight-noise case; add a
      mildly-different-band test (e.g. means 0.25/0.30, looser within-band m2)
      and confirm the model correctly returns `medium`, not `high`. If it
      over-promotes, tighten the high threshold for the banded path
      (e.g. 0.20). Files: `test/objectiveProfileBandedConfidence.test.ts`,
      `lib/objectives/stats.ts`. **Done 2026-05-24:** banded high threshold
      tightened 0.35 → 0.20 in `resolveBandedProfileConfidence`
      (`lib/objectives/stats.ts`). New fixture (means 0.25/0.30, m2=0.07,
      RSD≈0.321) pins the `medium` verdict; existing five fixtures
      (tight-noise high, medium, low, buffer-drift, weighted-mean-fallback)
      all unaffected. Raw-CV path (`resolveProfileConfidence`) intentionally
      unchanged.
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
      `lib/plan/deferredObjectives/profileEnergyResolution.ts`,
      `packages/contracts/src/objectiveProfileTypes.ts`,
      `lib/objectives/profiles.ts`.
- [x] Log parity / doc drift. The structured-log field `energyConfidence`
      (`objective_profile_sample_recorded`) now silently shifts semantics
      (band-aware when bands exist), so old/new log dumps are no longer
      directly comparable for the same device after bands fit. Add a sibling
      `globalEnergyConfidence` that always carries the raw-CV value, or rename.
      Same shift applies to the comment at
      `packages/shared-domain/src/deadlineLabels.ts:1126` describing
      `provenance.confidence` as the "legacy raw-CV stat" — update to reflect
      band-aware semantics.
      Done (PR pending) — added `globalEnergyConfidence` sibling field on
      `objective_profile_sample_recorded` (recomputes raw-CV via
      `resolveProfileConfidence({sampleCount, mean, m2})` on the post-update
      `kwhPerUnit` stat, before `applyBandedConfidence` overrides
      `kwhPerUnit.confidence`). Rephrased the `provenance.confidence` comment in
      `deadlineLabels.ts` and the matching contract comment in
      `deferredObjectiveActivePlans.ts` to "band-aware when bands have fit,
      falls back to raw-CV otherwise."

*v2.8.0 → origin/main release-review findings (2026-05-22). From the
five-agent fan-out pass on `refs/tags/v2.8.0..origin/main`.*

- [x] Miss attribution compares delivered energy against the *buffered*
      `plannedKWh`, not the mean. When the SE buffer is large (cold-start)
      `plannedKWh` is inflated, so a run can be labelled
      `capacity_shortfall` when the real cause was the conservative buffer.
      Diagnostics/history-explanation only — never affects control or the
      met/missed verdict; subsumed by the standing feasibility P0. Sibling
      of the live-chip buffered-basis question in the variance-buffer group
      below; fix by comparing delivered against `energyExpectedKWh` (the
      mean) before this telemetry tunes feasibility.
      Files: `packages/shared-domain/src/deferredPlanHistoryAttribution.ts:115-121`.
      Source: `pels-runtime-reality`, v2.8.0→origin/main release-review pass.
      DONE (2026-05-24, `fix/p2-miss-attribution-mean`): threaded mean from the
      live revision through `InProgressRecord.energyExpectedKWhAtFinalize` →
      `pushEntry` → `buildFinalizedAttributionEvent` →
      `resolveDeferredPlanHistoryMissAttribution(entry, energyExpectedKWh?)`.
      Falls back to buffered `plannedKWh` when the mean is absent (UI render,
      backfill, restart-recovered finalize) so UI attribution is no-worse-than-
      before. Met/missed verdict (`classifyOutcome` / `wasTargetReached`) is
      untouched. Test: `does not label a wide-buffer high-confidence run
      delivering the mean as capacity_shortfall` in
      `test/deferredPlanHistoryAttribution.test.ts`.
      AMENDMENT (2026-05-24, same PR): `pels-runtime-reality` flagged a P1 on
      the original PR — the runtime log emitted `missCause` with the mean-aware
      comparison but the UI render path (which has no live hint) fell back to
      the buffered comparison, so the same finalized entry could resolve two
      different causes. Persist `energyExpectedKWh?: number` on
      `DeferredObjectivePlanHistoryRevisionSnapshot` (optional, finite > 0) and
      promote `InProgressRecord.energyExpectedKWhAtFinalize` onto the snapshot
      via `attachEnergyExpectedKWh` in `finalizeRecord`. Snapshot wins over the
      optional argument inside `resolveDeferredPlanHistoryMissAttribution` so
      runtime and UI now resolve identical causes; old entries (no persisted
      field) still fall back to the buffered comparison. Validator extended in
      `lib/plan/deferredObjectives/planHistorySettings.ts` to reject
      non-positive / NaN tampered writes. Regression test: `persists the mean
      energy on the snapshot so the UI render path resolves the same missCause
      as the runtime log` in `test/deferredObjectivePlanHistory.test.ts`.

- [ ] Muted meta lines on the warn/alert tonal hero sit ~3.6:1 (below
      WCAG AA 4.5:1) at the top gradient stop. Established device-card
      muted-on-tonal treatment (not a regression); the gradient recovers to
      ~4.4:1 lower down and primary text is ~13:1. Fold into a system-wide
      muted-token contrast bump.
      Files: `packages/settings-ui/public/style.css`
      (`.plan-hero[data-tone="warn"]`), `settings/tokens.css`.
      Source: `pels-m3-critic`, v2.8.0→origin/main release-review pass.

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
      `lib/plan/deferredObjectives/settings.ts`,
      `lib/plan/admission/deferredObjective.ts`,
      `lib/plan/deferredObjectives/activePlanRecorder.ts`,
      `lib/plan/deferredObjectives/replanReason.ts`.
      Source: v2.9.0 release-review refresh, 2026-05-22.

*Variance-buffer follow-ups (2026-05-22, PR #965 — `mean + k·SE` planning buffer).*

- [ ] Verdict basis: `at_risk` / `cannot_meet` and the shortfall text in
      `statusTransitions.ts` evaluate the *buffered* `energyNeededKWh`, so a
      still-learning device can show a slightly more pessimistic chip than the
      measured mean justifies. Current behaviour is intentional (reserve *and*
      judge against the buffer so an optimistic `on_track` can't silently miss);
      product question is whether the chip should instead judge against
      `energyExpectedKWh` while the planner keeps reserving the buffer.
      Decision can now be made: the expected…planned range UI + cold-start
      chip have shipped (PR #970, commit `969395c6`), so the range exists
      to back a "judge against expected" change. Compose with the Cause #1
      Step 3 margin design (`feasibility-confidence.md`) — there should be
      ONE margin definition shared between sizing (B's `k·SE`) and verdict
      (within-margin shortfall → `at_risk`), not two parallel notions.
      Source: `pels-runtime-reality` review of PR #965.

- [ ] Multi-band aggregate cap: the 2× `MAX_BUFFER_MULTIPLIER` clamp is applied
      per band/slice inside `integrateBands`, then summed, so a profile with
      several high-SE bands can total up to ~2× the mean-expected figure across
      the whole interval. That is the intended ceiling, but confirm the
      aggregate is acceptable for multi-band EV profiles (interacts with the
      conservative-high EV bootstrap constant). Source: `pels-runtime-reality`
      review of PR #965.

- [x] Band fitter does not split textbook bimodal data with 6 samples (3 per
      cluster, ~67 % mean separation). Multi-band SHS probe 2026-05-23 (PELS
      v2.9.0) drove the Mill v2 mock through two consecutive regimes designed
      to produce two clearly separated `kwhPerUnit` clusters: 4 walks at
      1500 W (≈0.30 kWh/°C) in the 19–21 °C input range, then 4 walks at
      2500 W (≈0.50 kWh/°C) in the 21–23 °C range. After the run,
      `power_tracker_state.objectiveProfiles[device].bands` was empty despite
      `bufferedSamples: 6`, `kwhPerUnit.mean: 0.40182`, `min: 0.3005`,
      `max: 0.5007`, `confidence: medium`.
      **Analysis (2026-05-25, see `test/objectiveProfileBandsShsReplay.test.ts`):**
      `MIN_SSE_REDUCTION_FRACTION` is NOT the active constraint. The natural
      bimodal split at idx 3 yields a 99.94% SSE reduction — two orders of
      magnitude above the 10% floor. The active blocker is the entry-level
      gate `samples.length >= OBJECTIVE_PROFILE_MIN_BAND_SAMPLES * 2 = 16`;
      the buffer held 6, so `fitBandsFromSamples` returns `undefined` at the
      guard before any SSE math runs. Even bypassing the entry gate, the
      per-band 8-sample floor (`firstSplit = start + 8`, `lastSplit = end - 8`)
      would skip every candidate split (largest cluster on either side = 3).
      **Decision: accept current behaviour.** The 8-per-band minimum is a
      deliberate noise-floor protection documented in
      `notes/objective-profile-bands.md`; lowering it to 3 to admit this case
      would risk one outlier dominating any short bimodal sequence. The prod
      run was undersized for band fitting (needs ≥16 buffered samples with
      ≥8 per cluster). Rationale added to constant comments in
      `lib/objectives/bands.ts`. Replay regression test pins the gate decision.
      Source: SHS multi-band live-walk 2026-05-23. Artifacts:
      `/tmp/thermal-multiband-live-20260523-132901/pels.settings.after.json`.

- [ ] Calm-list discoverability of "what PELS has learned" (PR #970). Gating the
      confidence chip to cold-start + silencing it on `on_track` is correct for
      the list mission ("on track?"), but it removes the chip that
      `notes/smart-task-ui/README.md` treated as the doorway into the learned-rate
      explanation. Healthy tasks now expose that only via the detail page. Consider
      a non-chip affordance if users expect to discover learned-rate info from a
      calm list. Source: `pels-ux-fit` review of PR #970.

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

- [ ] Plan-rebuild latency / Homey CPU warnings. `/tmp/pels` perf trace
      2026-05-22: startup `planRebuild` up to 6.2 s (apply 4.95 s),
      steady-state `planBuild` avg ~1.07 s, triggering `homey cpuwarn`.
      Heap healthy (~20–28 MB / 70 limit), no `planRebuildFailed`. Slow
      rebuilds can delay shed/restore reactions to power changes.
      Profile `planBuild` cost (it dominates rebuild time) and reduce it.
      Source: `/tmp/pels` `[perf]` cpuwarn context, 2026-05-22.

- [ ] Smart-task "met early then cooled" history row reads as a
      contradiction. Live prod walk: `Tue 12 May 06:00 · Succeeded · 64.0
      → 39.2 °C · target 65.0 °C · reached at 03:42` — the run met the
      06:00 deadline early (03:42) then the tank cooled to 39.2 °C by the
      window end, so `start → final` shows a *drop* below target on a
      Succeeded row. The data is internally consistent (deadline label +
      `metAtMs`), but the `64.0 → 39.2` arrow next to "Succeeded · target
      65" reads as wrong. Consider showing the peak/`metAtMs` value rather
      than the end-of-window final on met runs, or annotating "met at
      03:42, cooled afterwards". P3-ish polish, not a data bug.
      Files: `packages/shared-domain/src/deferredPlanHistory.ts`.
      Source: live prod UI walk, 2026-05-22.

- [x] Docs vocabulary sweep: "capacity step" still appears in
      `docs/smart-tasks.md` and the `docs/cost-saving-functions.md`
      neighbourhood. Index and Getting Started were reframed to "hourly
      limit / power-based tariff" in PR #931; remaining occurrences
      should be reconciled so the docs are internally consistent.
      Source: `pels-copy-and-terminology` agent, PR #931 review.
      Resolution: case-insensitive `capacity step` / `capacity-step`
      grep across `docs/` returned a single literal occurrence at
      `docs/smart-tasks.md:115` (`Power limiting protects the capacity
      step.`), replaced with `Power limiting protects the hard cap.`
      to match the canonical "hard cap" phrasing used elsewhere in the
      same file (e.g. line 66) and the index. `docs/cost-saving-functions.md`
      only contained the already-established "capacity tariff step"
      vocabulary (line 31), which mirrors `docs/index.md:58` and the
      water-heater use case, so no rewrite was needed.
      Files touched: `docs/smart-tasks.md`.

- [x] Verify structured-debug back-pressure on the `power_calibration` topic.
      Verification only — the destination is already bounded.
      Traced `createCalibrationSnapshotMutationHook` in
      `lib/device/devicePowerCalibrationStore.ts:522-553` (renamed from the
      old `appPowerCalibrationWiring.ts` location) through
      `app.ts#getStructuredDebugEmitter` (no-op when topic off) →
      pino root logger → `lib/logging/homeyDestination.ts`. The Writable
      destination runs `_write` synchronously: parse the JSON line,
      forward to Homey SDK `this.log()` / `this.error()`, invoke
      `callback()` immediately. Node's internal stream buffer never
      accumulates because pino writes synchronously and the destination
      drains synchronously; the only retained state is a partial last
      line (single pending record) and the per-(device, step) 30 s
      debounce already caps the emit rate to ~2/min/device/step under
      steady load. Rotation is handled externally by the Homey
      supervisor (see `/tmp/pels/start.*.{stdout,stderr}.log`).
      Documented inline at the emit block; no code change beyond the
      verification comment.
      Files touched: `lib/device/devicePowerCalibrationStore.ts`.
      Source: `pels-runtime-reality` agent, v2.7.3 release-review pass.

- [x] Active-mode card heading hierarchy on the Settings landing page.
      Shipped via `fix/p2-active-mode-heading`: the `.settings-current-mode`
      label is now an `<h3 class="field__label settings-current-mode__heading"
      id="settings-active-mode-summary">Current mode</h3>` so the Settings
      landing page reads `h2 "Configure PELS" -> h3 "Current mode"` instead
      of jumping straight to the nav cards. Promotion approach chosen over
      re-introducing a separate heading to avoid redundant "Mode" + "Current
      mode" text; the surrounding `.settings-current-mode` section and the
      `#active-mode-select` both target the restored
      `settings-active-mode-summary` id via `aria-labelledby`. CSS neutralises
      browser `<h3>` defaults (margin / font-size / line-height) so the
      visual treatment matches the pre-v2.7.4 label.
      Files: `packages/settings-ui/public/index.html`,
      `packages/settings-ui/public/style.css`, `settings/index.html`,
      `settings/style.css`, `packages/settings-ui/test/settings.test.ts`,
      `packages/settings-ui/test/heroPrimitiveRebind.test.ts`,
      `packages/settings-ui/tests/e2e/settings-smoke.spec.ts`.
      Source: `pels-m3-critic` agent, v2.7.3 release-review pass.

- [x] Power-week chart height duplicated across JS and CSS.
      Done via `refactor/p2-chart-week-height-token`: promoted to
      `--pels-chart-week-height` (literal `240px` in
      `tokens/component.json` → regenerated to `settings/tokens.css`).
      `.power-week-chart` consumes `var(--pels-chart-week-height)` for
      both `height` and `min-height` in `packages/settings-ui/public/style.css`
      (synced to `settings/style.css`); `powerWeekChartEcharts.ts` now
      reads the token via `getComputedStyle().getPropertyValue(
      '--pels-chart-week-height')` in a new `resolveChartHeight` helper
      that feeds both the `initEcharts` constructor and the subsequent
      `chart.resize` call (fallback constant matches the token's literal
      source value). Pattern mirrors PR #1118 (`--pels-chart-cell-radius`)
      end-to-end. Regression locked by
      `packages/settings-ui/test/chartWeekHeightToken.test.ts` (4 cases:
      tokens.css declaration, public/style.css `height`+`min-height`
      consumption, runtime `getComputedStyle` read, fallback path).
      Files: `tokens/component.json`, `settings/tokens.css`,
      `packages/settings-ui/public/style.css`, `settings/style.css`,
      `packages/settings-ui/src/ui/powerWeekChartEcharts.ts`,
      `packages/settings-ui/test/chartWeekHeightToken.test.ts`.
      Source: `pels-m3-critic` agent, PR #1061 follow-up, 2026-05-24.

- [x] Heatmap `disposePowerWeekChart` inline-style cleanup.
      Done via `refactor/p2-heatmap-inline-style`: the `#power-list`
      container now carries `.power-week-chart`, which owns
      `height`/`min-height`/`-webkit-tap-highlight-color` (240 px
      literal, matching the existing physical-chart convention shared
      with `.deadline-horizon-chart`). `powerWeekChartEcharts.ts`'s
      `ensurePlot`/`disposePowerWeekChart` no longer mutate the
      container's inline style; `clearPlotInlineStyles` deleted.
      Tests pin the new contract by asserting the renderer never writes
      its three former inline-style properties (echarts itself still
      writes `position: relative` for its own layout, which is fine).
      Files: `packages/settings-ui/src/ui/powerWeekChartEcharts.ts`,
      `packages/settings-ui/public/style.css`,
      `packages/settings-ui/public/index.html`,
      `packages/settings-ui/test/power-ui.test.ts`.
      Source: `pels-m3-critic` agent, v2.7.3 release-review pass.

*Resolved review-finding (not a TODO; logged here so future audits don't
re-raise it): the v2.7.3 release-review flagged "guard activation
penalty against stale-meter inflation at window expiry" as a candidate
P1. PR #901 explicitly enshrines the opposite direction in
`test/activationBackoff.test.ts:543` — at window expiry with no clean
whole-home sample, **penalty must persist** ("no overshoot attribution
is not evidence of capacity compliance"). The "inflation" framing was
also incorrect: `recordActivationSetback` cannot run without a known
household total, so a stale window holds penalty at its current level
rather than walking it upward. Current PELS design = retain-on-stale;
the cautious admission stays cautious until a clean sample proves it.
No action.*

- [ ] Persist `currentHourOpening` / `lastKWhPerUnit` across PELS restarts.
      The v2.8.0 `recordHourlyDelivery` wiring tracks these on the in-memory
      `InProgressRecord` but does not write them to
      `DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING`. Homey runtime restarts
      (settings change, OOM, deploy) reset the hour anchor; any progress
      delivered between the pre-restart opening and the first post-restart
      observation is dropped from the postmortem strip. Contract is documented
      in `lib/plan/deferredObjectives/planHistory.ts:InProgressRecord` and the
      `restarts mid-run drop the in-flight hour anchor` regression test pins
      the observed behaviour. Persist alongside the rest of the in-progress
      record so the strip stays whole across restarts.
      Source: `pels-runtime-reality` agent, v2.8.0 PR1 review pass.
      Files: `lib/plan/deferredObjectives/planHistory.ts`,
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

- [x] Type the combined-prices `ctx` accessor in `lib/app/appInit.ts`.
      Done in `refactor/p2-ctx-prices-type` — `CombinedHourlyPrice` from
      `lib/price/priceTypes.ts` is the shared type surface. Callsites updated:
      `app.ts` (the `getCombinedHourlyPrices` field hook), `lib/app/appContext.ts`
      (`AppContext.getCombinedHourlyPrices`), `lib/app/appPriceLowestTrigger.ts`
      (`PriceLowestTriggerCheckerDeps`), `flowCards/registerFlowCards.ts`
      (`FlowCardDeps`), and `lib/price/priceCoordinator.ts` (explicit return
      type). The public `evaluateLowestPriceCard` /
      `resolveCurrentPriceFromCombined` parameters were also tightened from
      `unknown` to `readonly CombinedHourlyPrice[]`. No runtime change.
      Source: `pels-layering-guardian` agent, v2.8.0 PR1 review pass.

- [ ] Reduce `lib/plan/deferredObjectives/planHistory.ts` `max-lines`
      override (currently 720, was 620 pre-v2.8.0). Bumped to host the
      hour-rollover detector and finalize-time flush. Target: lower once the
      in-progress record + finalize paths split into their own module.
      Source: `pels-layering-guardian` agent, v2.8.0 PR1 review pass.

- [x] Reduce `lib/app/appInit.ts` `max-lines` override (was 520).
      Done in `cdf2d164` (`refactor(app): split appInit into
      deferredRecorders + calibrationViews`): the per-hour price resolver
      (`resolveHourPriceFromContext`) moved into
      `lib/app/appInit/deferredRecorders.ts` (244 LOC) alongside the
      deferred-objective recorder factories; calibration view helpers
      moved into `lib/app/appInit/calibrationViews.ts` (111 LOC).
      `appInit.ts` is now 324 LOC and the per-file `max-lines: 520`
      override was removed from `eslint.config.mjs`. (The shared-domain
      `resolvePostmortemTone` helper extraction had already landed.)

*v2.8.0 release-review findings (2026-05-19). Four items from the
five-agent fan-out pass on `v2.7.4..origin/main`.*

- [x] Stale-sample row in Smart task plan-inputs card needs a tone
      affordance. Done in `fix/p2-stale-sample-tone`:
      `KwhPerUnitProvenanceRow` now carries a `tone: 'warn' | null` slug
      that `formatLastSampleValue` resolves once at the producer (the
      stale branch returns `{ text, tone: 'warn' }`; fresh branches stay
      `null`). The `PlanInputsCard` view dispatches the slug to a new
      `.plan-inputs__row-value--warn` CSS modifier styled with
      `--pels-status-on-warning` + `--font-weight-semibold`, mirroring
      the existing `.deadline-list-card__when-row--warn` pattern.
      Source: `pels-ux-fit`, v2.8.0 release-review pass.

- [ ] Flatten the deferred-objective diagnostic to expose `currentValue`
      + `kWhPerUnit` so recorder/UI consumers stop branching on
      `objectiveKind`. `lib/plan/deferredObjectives/planHistory.ts`
      `applyHourlyDeliveryRollover` (~907-916) and
      `flushOpenHourAtFinalize` (~990-1000) repeatedly switch on
      `diag.objectiveKind === 'temperature' ? diag.kWhPerDegreeC :
      diag.kWhPerPercent` and `currentTemperatureC` vs `currentPercent`
      — exactly the resolution-in-consumer smell flagged in
      `feedback_layering_resolution_in_producer`. Pre-existing pattern,
      surfaced by the v2.8.0 review of `ec60f06f`.
      Acceptance: diagnostic exposes flat `currentValue: number | null`
      and `kWhPerUnit: number | null`; consumers read them without kind
      branches.
      Files: `lib/plan/deferredObjectives/diagnosticsBridge.ts`,
      `lib/plan/deferredObjectives/planHistory.ts`,
      `lib/plan/deferredObjectives/planHistoryV4Helpers.ts`,
      `packages/contracts/src/`.
      Source: `pels-runtime-reality`, v2.8.0 release-review pass.

- [x] Plan-inputs freshness string ticks once per minute while the
      Smart task detail page is open. `PlanInputsCard` now owns a
      component-local 60s `setInterval` (registered via `useEffect`,
      cleaned up on unmount via the returned teardown) that re-renders
      the freshness slot off `Date.now()`; producer keeps emitting a
      pre-formatted seed string for non-React consumers + cold first
      paint. Tick is gated on at least one provenance row carrying
      `freshnessOfMs`, so bootstrap-only / no-provenance plans never
      arm the timer.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/src/ui/deadlinePlanInputs.ts`,
      `packages/settings-ui/src/ui/deadlinePlanFormatters.ts`,
      `packages/shared-domain/src/deadlineLabels.ts`,
      `packages/settings-ui/test/deadlinePlanFreshnessTick.test.ts`.
      Source: `adversarial-review`, v2.8.0 release-review pass.

- [x] Smart tasks empty-state copy says `'Schedule a ready-by deadline'`
      while the eyebrow says `'Smart tasks'`. Per
      `feedback_terminology_plan_vs_deadline`, surface this with the
      consistent "smart task" / "ready-by" vocabulary — e.g. "Add your
      first smart task" or "Schedule a ready-by time".
      Files: `packages/settings-ui/src/ui/views/DeadlinesList.tsx`.
      Source: `pels-ux-fit`, v2.8.0 release-review pass.
      Resolved: empty-state headline now reads
      `'Add your first smart task'` (in
      `packages/shared-domain/src/deadlinesListHero.ts`); pairs naturally
      with the body stanza's "Add heating task" / "Add charging task"
      action language and keeps the "smart task" anchor consistent with
      the `Smart tasks` eyebrow.

- [x] Refresh stale smart-task UX notes that still mention "move deadline
      later" as a missed-task recourse. `notes/ui-terminology.md` now defines
      the canonical recourse pair as `Lower daily budget` / `Review device`;
      `notes/smart-task-ui/README.md` still has two older references around the
      recovering-from-mistake and history-detail CTA sketches. Deferred from
      the v2.7.4 lovability U3 copy review because the PR only changes active
      confidence/status chips.
      Shipped: both replacements were already landed in `eeb8e400` (docs:
      capture release-review follow-up cleanup, 2026-05-21) — this entry was
      created later and not crossed off at the time.
      - `notes/smart-task-ui/README.md:93-94`: `No CTA to lower the daily
        budget or move the deadline later.` → `No CTA to lower the daily
        budget or review the device settings that affected the missed run.`
        (recovering-from-mistake persona).
      - `notes/smart-task-ui/README.md:152`: `\`Lower daily budget\` / \`Move
        deadline later\` (composed from reason)` → `\`Lower daily budget\` /
        \`Review device\` (composed from reason)` (asymmetric-treatment
        Next-step CTA table cell).
      No other occurrences in `notes/smart-task-ui/README.md`; the only
      remaining "Move deadline later" mention in `notes/` is the canonical
      retirement explanation in `ui-terminology.md:185`, which is the source
      of truth and intentionally documents the prior copy.

- [ ] Add explicit backup-hour reservations for committed smart-task schedules.
      Day-zero committed schedules now keep the first full-horizon allocation
      stable and ignore later optimizer hour swaps. There is still no separate
      backup-hour model: if the device cannot deliver inside the committed
      hours, the plan degrades to `cannot_meet` rather than spilling into
      reserved backup capacity. Future work should model backup hours as
      distinct from committed delivery hours, surface the assumption in the
      plan detail, and decide how daily-budget capacity is reserved so backup
      hours do not silently steal energy from other tasks.
      Files: `lib/plan/deferredObjectives/horizonPlanner.ts`,
      `lib/plan/deferredObjectives/bucketAllocation.ts`,
      `lib/plan/deferredObjectives/diagnosticsBridge.ts`,
      `packages/contracts/src/deferredObjectiveActivePlans.ts`,
      `notes/deferred-load-objectives/`.

- [ ] Smart-task history receipt + chip helpers in
      `packages/shared-domain/src/deferredPlanHistoryReceipt.ts` still inline
      every user-facing string (Started, Ready, Largest planned hour, Delivered,
      Week, on average, etc.). gemini flagged this on PR #887: when a real
      localization story lands these need to route through a labels module
      similar to `deadlineLabels.ts` so runtime logging + UI consume the same
      vocabulary (see `feedback_ui_text_shared_with_logs`). Out of scope for any single release —
      full externalization is a separate sweep across all of
      `packages/shared-domain/src/**`.

- [x] Smart-task history-detail hero treats `unknown` outcomes as
      `quietAbandoned` (no chart card) alongside `abandoned`/`replaced`.
      copilot reviewer on PR #887 (`deadlinePlanHistoryDetailHero.ts:242`)
      noted the chart policy note only calls out Abandoned + Replaced as the
      no-chart shapes, and `unknown` entries may still want the comparison
      chart as evidence when a plan was recorded. Decide whether `unknown`
      should fall back to a collapsed-chart shape or stay quiet, and update
      `notes/v2-7-2/postmortem-chart-policy.md` to match the resolved policy.
      Resolved: `unknown` with a recorded plan (`originalPlan` or
      `finalPlan` present) now renders the chart card collapsed (same shape
      as Succeeded — "View details" toggle); `unknown` without a recorded
      plan stays quiet (same shape as Abandoned). Discriminator is plan
      presence, not outcome value. `abandoned`/`replaced` unchanged.
      Files: `packages/settings-ui/src/ui/deadlinePlanHistoryDetailHero.ts`,
      `notes/v2-7-2/postmortem-chart-policy.md`. Tests:
      `packages/settings-ui/test/deadlinePlanHistoryDetail.test.ts` —
      "Unknown shape with recorded plan" and "Unknown shape with no
      recorded plan".

- [ ] iOS Homey chrome inset may exceed 56 px (PWA + status bar + nav bar);
      confirm via screenshot from user, then split `--pels-homey-mobile-chrome` per
      pointer/platform if needed. Deferred from v2.7.2 PR7 fixup.

- [x] Extract a `resolvePlanGenericReasonText` helper alongside
      `resolveTemperatureReasonLine` so the `"Still reporting … after pause
      — …"` sentence currently duplicated across
      `planTemperatureCardText.ts` and `planSteppedCardText.ts` lives at
      one site. The parent "Overview device-card status copy is still
      partially duplicated" item closed in 961904f8 (the three sibling
      helpers — `planTemperatureCardText.ts`, `planSteppedCardText.ts`,
      `planReasonFormatting.ts` — now consume
      `PLAN_STATE_HELD_FALLBACK_STATUS` / `PLAN_STATE_DAILY_BUDGET_STATUS`
      / `PLAN_STATE_HOURLY_BUDGET_STATUS` from `planStateLabels.ts`);
      this is the still-open sentence-level residual.
      Files: `packages/shared-domain/src/planSteppedCardText.ts`,
      `packages/shared-domain/src/planTemperatureCardText.ts`,
      `packages/shared-domain/src/planReasonFormatting.ts`.
      Shipped: `resolvePlanGenericReasonText(params: { measuredPowerKw:
      number | undefined; detail: unknown })` now lives in
      `packages/shared-domain/src/planReasonFormatting.ts` (re-exported via
      `planReasonSemantics.ts`). On audit the sentence only ever lived in
      `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx`
      (`resolveReportedLoadReason`), not in either card-text helper — the
      TODO's "duplicated across temperature/stepped" description was stale.
      The single delegating call site is `PlanDeviceCards.tsx`
      `resolveReportedLoadReason`; covered by
      `test/planReasonUserFacing.test.ts`
      `describe('resolvePlanGenericReasonText')` including a
      character-for-character `referenceFormat` comparison against the
      pre-extraction inline formatter.

- [ ] Overview device-card stack still spans 128–163 px after the v2.7.2
      `min-height: calc(var(--spacing-8) * 4)` floor on `.plan-card` — the
      floor only raises the short cards; tall cards keep their natural
      height. If the audit re-flags rhythm, the next step is to convert the
      conditional rows (reason line, stepped controls, ev state) into a
      reserved-slot grid so card heights converge.
      Files: `packages/settings-ui/public/style.css`,
      `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx`.


*Smart-task history-detail trio below was demoted from P1 in the v2.7.1
release-review pass (2026-05-17). All three depend on the history schema
v3 → v4 migration, which is out of scope for v2.7.1; sequence them together
in v2.7.2+.*

*v2.7.1 release-review P2 batch (2026-05-17). Eight items from the
six-agent fan-out pass — non-blocking polish, drift, and follow-up.*

- [ ] **deadline-hero-speed-duration-split** — EV deadline detail hero today uses a single
      dot-separated meta line ("Needs 12.4 kWh · 3.2 kW · 3h 50m · Auto"). The earlier P1
      spec asked for split labeled rows ("Planning speed: 3.2 kW" / "Estimated time: 3h 50m").
      Function is identical, this is a copy/layout preference. Pick one direction and document
      in `notes/ev-ready-by/README.md`.

- [ ] Move smart-task rate and speed-mode display resolution to the producer.
      Supersedes the earlier `deadlinePlanInputs.ts:51-55` smell:
      `deadlinePlanInputs.ts` now has `resolveKwhPerUnitDisplayRate`, and
      `deadlinePlanHero.ts` has a sibling `resolveSpeedModeLabel`; both still
      ask the settings UI consumer to derive display fields from planner
      internals. Move the resolution into `activePlanRecorder.ts` and persist
      flat `rateMean: number | null` plus `speedMode: 'auto' | 'learning'` on
      `DeferredObjectiveActivePlanRevisionV1`; delete the settings-UI helpers
      and update the contract.
      Source: `pels-layering-guardian`, v2.9.0 retrospective, 2026-05-23.
      Files: `lib/plan/deferredObjectives/activePlanRecorder.ts`,
      `packages/contracts/src/deferredObjectiveActivePlans.ts`,
      `packages/settings-ui/src/ui/deadlinePlanInputs.ts`,
      `packages/settings-ui/src/ui/deadlinePlanHero.ts`.

- [x] Promote heatmap cell radius `2px` to a token. Added
      `--pels-chart-cell-radius` (aliased to `{radius.xs}` so the px value
      stays 2 px) and pointed both callsites at it: the
      `.usage-legend__swatch--unreliable` rule in `public/style.css`
      (synced to `settings/style.css`) and the
      `resolveCellRadius` reader in `powerWeekChartEcharts.ts`. The
      legend-vs-cell shape contract is now enforced at a single
      chart-scoped token rather than two parallel `--radius-xs` reads.
      Source: `pels-m3-critic` agent.
      Files: `tokens/component.json`, `settings/tokens.css` (regenerated),
      `packages/settings-ui/public/style.css`, `settings/style.css`,
      `packages/settings-ui/src/ui/powerWeekChartEcharts.ts`,
      `packages/settings-ui/test/chartCellRadiusToken.test.ts`.

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

- [x] Smart-task error banners + "plan" wording on smart-task surfaces.
      Lifted the six user-facing banner strings to shared-domain and dropped
      "plan" from the SR loading copy + panel aria-label so smart-task
      surfaces match `notes/ui-terminology.md § Plan vs deadline`:
      - `SMART_TASK_BANNER_LOAD_ERROR_PREFIX` = `"Smart task data could not
        be loaded: "` (composed with the transport cause in
        `deadlinePlanMount.ts`).
      - `SMART_TASK_BANNER_UNAVAILABLE_TITLE` = `"Smart task unavailable"`
        (was `"Smart task plan unavailable"` in user reports).
      - `SMART_TASK_BANNER_UNAVAILABLE_FOR_DEVICE` = `"Smart task data is
        not available for this device."` (was inlined in `deadlinePlan.ts`).
      - `SMART_TASK_BANNER_RECORD_NOT_FOUND_TITLE` /
        `SMART_TASK_BANNER_RECORD_NOT_FOUND_BODY` for the
        history-missing card.
      - `SMART_TASK_LOADING_LABEL` = `"Loading smart task…"` (was
        `"Loading smart task plan…"` in `public/index.html`).
      Also dropped "plan" from the two log-only strings in
      `deadlinePlanMount.ts` and the panel aria-label
      (`"Smart task plan"` → `"Smart task"`) so debugger and SR users
      see the same noun the user sees. Source:
      `pels-copy-and-terminology` agent.
      Files: `packages/shared-domain/src/deadlineLabels.ts`,
      `packages/settings-ui/src/ui/deadlinePlanMount.ts`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `packages/settings-ui/public/index.html`.

- [x] Pre-existing jargon in `packages/shared-domain/src/deviceOverview.ts:135-140,178,187`.
      Replaced raw Shed/Restore jargon with terminology-guide wording:
      - `"Shed (charging paused)"` → `"Charging paused"` (lines 135, 178)
      - `"Shed (lowered temperature)"` → `"Lowered"` (line 136)
      - `` `Shed to ${step}` `` → `` `Limited to ${step}` `` (line 138)
      - `"Shed (reduced step)"` → `"Limited"` (line 138)
      - `"Shed (powered off)"` → `"Turned off"` (line 140)
      - `"Restore requested"` → `"Resume requested"` (line 187)
      Source: `pels-copy-and-terminology` agent.
      Files: `packages/shared-domain/src/deviceOverview.ts`,
      `notes/ui-terminology.md`.

- [x] `activePlanRecorder.ts:584-594` sets explicit `undefined` on
      snapshot fields and relies on `JSON.stringify` dropping them. The
      comment is intentional, but the in-memory object exposes explicit
      `undefined` keys that violate `exactOptionalPropertyTypes`-style
      contracts elsewhere and risk inconsistent round-tripping if Homey
      ever serialises via a path that preserves `undefined`. Switch to
      conditional spread for the `objective_changed` reset path so the
      field is only set when defined.
      Source: `adversarial-review` skill.
      Files: `lib/plan/deferredObjectives/activePlanRecorder.ts:584-594`.
      Resolved: destructure-and-rest drops the snapshot fields from
      `...current`, then conditional spread re-adds them only when the
      resolved snapshot has a defined value. Same `JSON.stringify` output;
      no explicit `undefined` keys on the in-memory plan object.

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
      Files: `lib/power/tracker.ts` (`formatDateUtc` -> zone-aware),
      `packages/settings-ui/src/ui/powerStats.ts` (or carry the dual-key
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
      `lib/power/tracker.ts` (`processDayHourBuckets`).
- [ ] `processDayHourBuckets` in `lib/power/tracker.ts` over-counts the
      day count for boundary days that have their hours moved into
      `hourlyAverages` across multiple prune runs. Each prune that moves at
      least one hour of a given day calls the helper for that day, which
      increments count by 1 for all 24 weekday-hour slots. A day whose hours
      cross the threshold across two prune ticks therefore contributes count
      +2 instead of +1, biasing the typical-day averages slightly low.
      Files: `lib/power/tracker.ts` (`aggregateAndPruneHistory`).

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

- [x] Settings → Advanced page H2 "Device diagnostics" doesn't describe the page.
      Live-walk 2026-05-16 (`/tmp/pels-live-walk/05-settings-advanced-480-1.png`):
      the page header reads "Device diagnostics" but the page contains Debug logging
      categories + Daily-budget tuning + Data management + Device cleanup + Device
      log. Renamed to "Diagnostics & maintenance" so users can predict what
      they'll find under the entry. Literal H2 lives in
      `packages/settings-ui/public/index.html:518` (synced to
      `settings/index.html` via `npm run build:settings`).

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

- [x] Smart-task active detail repeats "Cannot finish" 3× (pill, headline, body).
      Live-walk 2026-05-16 (`/tmp/pels-live-walk/04-smart-task-active-detail-480.png`).
      Reads as alarm spam rather than information. Keep the pill + one explanatory
      line; drop the duplicate copies. Resolution: the headline was already
      suppressed on the alert branch (prior PR 1078 work). Dropped the third
      restatement — the `· won't reach by HH:MM` tail on the delivered-so-far
      line — in `formatDeadlineDeliveredSoFarLine`; the cannot-meet branch now
      renders only the magnitude (`Delivered X of Y kWh · still {curr} of
      {target}`) so the alert chip + meta-line shortfall sentence remain the
      sole verdict surfaces. Files: `packages/shared-domain/src/deadlineLabels.ts`,
      `packages/settings-ui/src/ui/deadlinePlanHero.ts`,
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`.

*Eight Overview-surface P2 polish items from the 2026-05-16 live-walk audit
(TV-stue missing temp line, chip-primitive consolidation, Smart-task aria,
hero warning emoji, projected-marker alignment, safe-pace subline visibility,
device-card vertical rhythm floor, em-dash punctuation drift) shipped in
v2.7.3 — see commit `chore(v2.7.3): Overview card-rhythm + chip-primitive
consolidation + a11y polish (8 P2)`.*

- [x] Usage heatmap week-navigation chevrons have no visible chrome + use the
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
      Done: a11y audit confirmed the chevrons already carry real `aria-label`
      attributes (`Previous week` / `Next week`) — no `data-aria-label` typo
      remained in the tree. Visible-chrome fix added a `.heatmap-nav-chevron`
      decorator class on the canonical `<md-text-button>` primitive (keeps M3
      focus-ring, ripple, ARIA, 48 px touch-target floor); doubled-class
      cascade with `--pels-surface-container-high` ground, `--pels-surface-outline`
      border, `--radius-md`, `min-width: var(--pels-touch-target-min)` to square
      the hit-box, and `--md-sys-color-primary: var(--text)` so the chevron icon
      reads ~12:1 on the dark ground (WCAG AAA) instead of competing with the
      heatmap-cell accent palette.

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
- [x] Make the browser Homey stub follow the injected SDK handoff more closely.
      After assigning `window.Homey`, call `window.onHomeyReady?.(Homey)` so full-browser audits
      exercise the same delivery path as Homey's injected settings SDK. Keep the existing global
      fallback covered for compatibility.
      Files: `packages/settings-ui/tests/e2e/fixtures/homey.stub.js`,
      settings UI boot tests.
- [x] Update the Settings UI Homey API mock to stop serving devices from
      `target_devices_snapshot`. Production now serves `/ui_devices` and `/ui_refresh_devices`
      from runtime app state, so the mock should model live device data explicitly and avoid
      masking runtime-backed device API regressions.
      Shape: `createHomeyMock({ uiState: { devices: TargetDeviceSnapshot[] } })` powers the
      `/ui_devices` and `/ui_refresh_devices` handlers; a deprecated fallback still reads the
      `target_devices_snapshot` setting when `uiState.devices` is undefined, so legacy callers
      keep working until they migrate.
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
- [x] Add `objective_missing_capacity` user-facing copy for thermal smart tasks. A new water
      heater (or any thermal device without `measure_power`) never builds a `kWhPerUnit`
      profile, so the diagnostics bridge emits `objective_missing_capacity` and the task sits
      "Waiting" indefinitely with no explanation. Thermal objectives intentionally have no
      bootstrap rate (thermal mass varies orders of magnitude across devices), so the only fix
      is to tell the user. One-line copy fix on the pending-reason path: "Learning energy use
      — needs power readings from this device."
      NOTE (2026-05-23): the user-visible `pendingReason: 'missing_capacity'` has TWO upstream
      paths — `objective_missing_capacity` (no profile yet, this entry) AND
      `objective_missing_charge_rate` (`resolveObjectiveSteps` returning `[]` on
      non-stepped thermal devices). The second path is now closed by a
      `measuredPowerKw` → `expectedPowerKw` → `powerKw` thermal fallback in
      `resolveObjectiveSteps`; this copy entry only addresses the first path (no-profile
      cold-start).
      DONE (2026-05-24): exported `PENDING_REASON_MISSING_CAPACITY_COPY` in
      `packages/shared-domain/src/deadlineLabels.ts` as the canonical user-facing
      one-liner; the thermal `missing_capacity` pending-hero resolver derives its
      headline + metaLine from the constant (split on the em-dash, body
      re-capitalised) so headline + body combined read as the one-line copy.
      `headlineReason` is suppressed to keep the hero a single coherent sentence.
      Files: `packages/settings-ui/src/ui/deadlinePlan.ts`,
      `packages/shared-domain/src/deadlineLabels.ts`,
      `packages/contracts/src/deferredObjectiveActivePlans.ts` (if a new pending-reason value is
      needed).
- [x] Reassess `isLegacyNoneStatusMatch` in `flowCards/deadlineObjectiveCards.ts:167-175`.
      DONE (2026-05-24): chose Option A (keep the compat layer + tighten the
      comment). Git-history audit of `.homeycompose/flow/conditions/deadline_status_is.json`
      shows the dropdown shipped `'cannot_meet'` and `'none'` only between
      `3ba281d7` (2026-05-10) and `d67e0d97` (2026-05-12); the first version
      to publish the card was v2.7.0 on 2026-05-16 (commit `155ad896`), so no
      public release ever carried `'none'` or `'cannot_meet'` in the
      dropdown. The other three legacy ids (`pending_prices`, `cannot_finish`,
      `done`) were never in a shipped dropdown at all. The compat layer is
      kept because (a) pre-release test installs in that 2-day window may
      persist `'none'` in flow args and (b) advanced users can hand-edit the
      flow card JSON in Homey, so a flow may carry an id outside the shipped
      set; the runtime cost is a string compare on a path that already needs
      the settings read it consumes. Tightened the inline comment block on
      `isLegacyNoneStatusMatch` to cite the actual commit history (not a
      vague "users who created flows during that window" claim that implied a
      public release shipped with `'none'`) and pointed at
      `normalizeSmartTaskStatusArg` for the other four legacy aliases. Tests
      already cover all five legacy ids (`test/deadlineObjectiveCards.test.ts`
      lines 511, 538, 547, 563, 577); only the regression-test docstring was
      updated to match the new wording.
      Files: `flowCards/deadlineObjectiveCards.ts`, `test/deadlineObjectiveCards.test.ts`.
- [x] Add PELS-side unit tests for EV kWhPerUnit learning. Cover: a plan with no learned profile
      uses the bootstrap estimate; an accepted SoC rise records a `kWhPerUnit` sample; subsequent
      plans switch from bootstrap to the learned estimate; and rejection reasons fire as expected
      for no-progress samples, duplicate samples, and SoC rises below the minimum-delta threshold.
      Shipped `test/evKwhPerUnitLearning.test.ts` (2026-05-24) with six cases tied to the real
      production constants (`BOOTSTRAP_EV_SOC_KWH_PER_PERCENT`, `OBJECTIVE_PROFILE_MIN_INTERVAL_MS`,
      and a local mirror of the unexported `MIN_SOC_RISE_PERCENT` from
      `lib/objectives/profiles.ts`):
        - "uses BOOTSTRAP_EV_SOC_KWH_PER_PERCENT when no profile has been learned yet"
        - "records a kWhPerUnit sample equal to delivered energy / SoC delta"
        - "switches `resolveProfileEnergy` from bootstrap to learned after the first accepted
          sample"
        - "rejects a no-progress SoC sample with `rise_too_small` (zero delta, non-negative)"
        - "rejects a duplicate-timestamp SoC sample with `non_monotonic_time`"
        - "rejects an SoC rise below MIN_SOC_RISE_PERCENT with `rise_too_small`"
      Files: `test/evKwhPerUnitLearning.test.ts`.
- [x] Hide duplicate responsive tab controls from the accessibility tree. Audit (2026-05-24)
      found a single `md-tabs#shell-nav` surface in `packages/settings-ui/public/index.html` and
      no dynamically rendered second nav; a CDP `Accessibility.getFullAXTree` snapshot in both
      Chromium and Firefox at 320 px and 480 px reported exactly one `role=tab` node per
      destination (Overview / Budget / Usage / Smart tasks / Settings) — the suspected duplicate
      surface does not exist. Locked the invariant in with a regression test
      (`layout-regressions.spec.ts` › "exposes each top-nav destination exactly once in the
      a11y tree at 320px / 480px") so a future bottom-nav redesign that forgets to hide the
      inactive surface fails CI.
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
- [x] Add missing swap lifecycle coverage from the pre-release review. Cover completed stepped
      swap cleanup with a stepped target and requested step, assert approved stepped swaps persist
      the stale-cleanup timestamp, and add an `applyRestorePlan()` integration test for orphan
      measurement deferral before a fresh power sample.
      Files: `test/swapLifecycle.test.ts`
      (`completed cleanup clears a stepped target only after its requested step is reached`),
      `test/planRestoreBackoff.test.ts`
      (`persists a stale-cleanup timestamp on an approved stepped swap that survives a state roundtrip`,
      `defers a swap restore for orphan-measurement metadata until a fresh power sample arrives`).
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
- [ ] Split `DeviceManager` into `lib/device/transport/` (SDK seam + per-control-model wiring
      + parse pipeline, produces normalized snapshots and admit-or-suppressed events) and
      `lib/observer/` (state store, freshness, pending, settle, realtime fanout). Executor
      calls `transport.write(...)` directly; observer subscribes to transport events.
      Plan stops importing `lib/device/**` entirely — binary-control writes at
      `lib/plan/planBinaryControl.ts:217` and the `deviceManager.getSnapshot()` calls at
      `:257` / `lib/plan/planBinaryControlHelpers.ts:107` move to executor / observer reads.
      Promotes `todo-narrow-plan-device-dep` (`.dependency-cruiser.cjs:146-151`) to error and
      adds a new error rule binding executor away from `lib/device/**`. Settle suppression
      runs in transport's parse pipeline via a `pendingPredicate` callback injected by
      `lib/app/` and backed by observer.
      Sequencing: (1a) `getSnapshotByDeviceId` helper + `DeviceObservation` read interface
      — shipped in PR #1095; (1b) restructure plan to return binary control decisions, move
      dispatch to executor, promote cruiser rules — shipped in PR #1102; (2) move read-side
      files into transport, DeviceManager becomes a facade — shipped in PR #1107; (3) rename
      DeviceManager → DeviceTransport (file `manager.ts` → `deviceTransport.ts`) and kill the
      facade — shipped in PR #3 of the train; (4) move pending/settle into observer and wire
      the injected predicate; (5) three-way realtime split — translation in transport, drift
      detection in executor, reapply trigger in wiring.
      Design: `notes/state-management/observer-transport-split.md`.
      Files: `lib/device/**`, `lib/observer/**`, `lib/executor/**`, `lib/plan/planBinaryControl*.ts`,
      `lib/app/appDeviceControlSteppedState.ts`, `.dependency-cruiser.cjs`,
      `notes/state-management/README.md`, `docs/architecture.md`.
- [x] Sweep remaining test files with ad-hoc `{ getSnapshot: vi.fn() }` mocks typed as
      `DeviceManager` and migrate them to `test/utils/deviceObservationMock.ts`'s
      `withGetSnapshotByDeviceId` helper. Tests pass today because their code paths
      don't exercise the migrated reads, but later PRs in the observer/transport
      split will migrate more sites and may surface silent `undefined` returns from
      these stubs. Known sites include `test/appDebugHelpers.test.ts`,
      `test/shed_restore.test.ts`, `test/deferredObjectiveAdmission.test.ts`, and
      ~13 others (run `grep -rln "as DeviceManager\|: DeviceManager" test/` for
      the full list). Source: `pels-layering-guardian` P2-2 on PR #1095,
      2026-05-24. Migrated 2 files (13 mock construction sites total:
      `test/appDebugHelpers.test.ts` `buildDeviceManager` factory +
      `test/app.test.ts` 12 inline sites). Left 2 sites on the old pattern
      because they don't define `getSnapshot` at all — the helper requires it
      and these tests only exercise `getDevicesForDebug`
      (`test/app.test.ts:2793` flow-backed-device autocomplete cache test,
      `test/appDebugHelpers.test.ts:49` debug device fetch failure routing
      test). The other TODO-listed files (`test/shed_restore.test.ts`,
      `test/deferredObjectiveAdmission.test.ts`) turned out not to construct
      ad-hoc DeviceManager mocks; the `~13 others` count from the original
      grep over-counted by including async `getSnapshot` mocks that belong to
      `App`/`PelsApp` flow-snapshot sources, not `DeviceObservation`.
- [ ] Move pending-binary-command bookkeeping fully into observer as part of
      the PR #4 step of the observer/transport split. Today PR #1b leaves
      `state.pendingBinaryCommands[deviceId]` writes inside plan
      (`decideBinaryControl` records) and deletes inside executor
      (`dispatchBinaryControlDecision` clears on failure). The split is
      acknowledged transitional — see the doc comment on
      `dispatchBinaryControlDecision`. Cleaner shape post-#4: dispatcher
      returns a discriminated result (`{ok: false, reason: 'dispatch_failed'} |
      {ok: true}`) and a sync helper in observer consumes the failure to clear
      pending, so writes and deletes are both observer-owned. Source:
      `pels-layering-guardian` P2-1 on PR #1b draft, 2026-05-24.
- [x] Re-home `lib/device/stateOfCharge.ts`. PR #2 of the observer/transport
      split left it at `lib/device/stateOfCharge.ts`; PR #3 took the cheap
      path and moved it into `lib/device/transport/stateOfCharge.ts`. Every
      current consumer is transport-side
      (`transport/managerObservation.ts`, `transport/managerRealtimeHandlers.ts`,
      `transport/managerParseDevice.ts`, `transport/managerFreshness.ts`)
      or part of `lib/device/deviceTransport.ts` (the renamed
      `DeviceTransport` class) / `managerRuntime.ts` (both fine as
      cross-folder imports). The move converts the previous
      `transport/managerObservation → ../stateOfCharge →
      transport/flowReportedCapabilities` back-edge into a clean
      intra-transport import. The deeper path (extracting pure SoC math to
      `lib/utils/` or `packages/shared-domain/src/` with the structural
      `DeviceCapabilityMap` / `FlowReportedCapabilities*` type deps) was
      deferred — no consumer pressure yet. Source: PR #2 secondary cleanup
      + `pels-layering-guardian` P2-1 on PR #1107, 2026-05-24. Done in
      PR #3.
- [ ] Sweep file renames + logger tags + structured-event identifiers that still
      carry the `manager`/`DeviceManager`/`device_manager` name post-rename
      (PR #3 of the observer/transport split, #1140). Three buckets, each
      operator-visible:
      (a) **Filenames**: `lib/device/managerRuntime.ts`,
          `lib/device/managerNativeEv.ts`, `lib/device/managerNativeSteppedCommand.ts`,
          `lib/device/managerControl.ts`, `lib/device/managerBinarySettle.ts`,
          `lib/device/managerMeasuredPower.ts`, `lib/device/managerEnergy.ts`,
          `lib/device/managerFlowSupport.ts`, plus everything under
          `lib/device/transport/manager*.ts`
          (`managerObservation`, `managerParse*`, `managerFreshness`,
          `managerRealtimeHandlers`, `managerRealtimeSupport`, `managerFetch`,
          `managerHomeyApi`, `managerManagedFilter`, `managerHelpers`).
          Rename to drop the `manager` prefix (or `transport` prefix as
          appropriate) so the file tree matches the class rename.
      (b) **Logger tags**: `getLogger('device/manager-runtime')` and
          `getLogger('device/manager-fetch')` (and any others derived from the
          filenames above). Aligns operator log queries with the `DeviceTransport`
          identity. The matching `deviceTransport.ts` logger is already
          `device/transport`.
      (c) **Structured event identifiers**: `reasonCode: 'device_manager_write_failed'`
          (`lib/executor/binaryControlDispatch.ts`, `lib/executor/targetExecutor.ts`)
          and the `DeviceFetchSource = 'raw_manager_devices' | 'targeted_by_id'`
          union (`lib/device/transport/managerFetch.ts`). These are external grep
          targets for log dashboards / alerts — renaming is a breaking change for
          any tooling that pins them. Decide explicitly: rename + bump (and
          document migration), or keep verbatim with an in-code comment naming
          the back-compat constraint.
      Source: `pels-layering-guardian` P2 + `pels-runtime-reality` P2 on
      PR #1140, 2026-05-25.
      Files: `lib/device/**`, `lib/executor/binaryControlDispatch.ts`,
      `lib/executor/targetExecutor.ts`.
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
- [x] Remove redundant downstream `managed !== false` filters now that unmanaged devices are
      excluded from `latestTargetSnapshot` at parse time. Current sites:
      `lib/app/appSnapshotHelpers.ts:264`, `lib/app/appInit.ts:341`,
      `lib/plan/planEvBoost.ts:15`, `lib/plan/planTemperatureBoost.ts:22`, and
      `lib/plan/planDiagnostics.ts:130`.
      **Investigation 2026-05-25 — premise wrong; filters are load-bearing.** The
      parse-time exclusion in `lib/device/transport/managerManagedFilter.ts:24-39`
      is gated by `isManagedFilterActive` (`lib/app/appDeviceSupport.ts:42-44`),
      which only fires when at least one device has `managed === true`. On a
      fresh install — or in any state where devices have been explicitly marked
      `managed: false` without any `true` opt-in — the filter is **inactive**
      and devices flow through `parseDeviceList` into `latestTargetSnapshot`
      with `managed: false`. The downstream `managed !== false` filters
      drop them at that point. The comment block at
      `appDeviceSupport.ts:36-41` documents the intentional gate ("explicit
      `false` must NOT activate the filter on its own — otherwise a fresh-
      install user would flip from 'all devices visible' to 'only explicit-
      true visible' the moment the first unsupported device is auto-disabled").
      Verified by `test/plan.test.ts:1388-1403` (excludes unmanaged devices
      from the plan snapshot) and `test/app.test.ts` (stepped_feedback events
      under fresh-install setup) — both fail when the downstream filter is
      removed. To reframe: either close this TODO, or land a precondition
      that extends parse-time exclusion to also drop explicit-`false` devices
      regardless of filter-active status (which itself must reconcile with the
      fresh-install behaviour the gate intentionally protects). Marked done
      because the current state is correct as designed.
- [x] Deduplicate `applyDeviceDriverOverride` along the snapshot pipeline. Today the override is
      applied in `DeviceManager.refreshSnapshot`, again in the private `parseDeviceList`, and a
      third time inside `resolveParseDeviceIdentity`.
      Files: `lib/device/manager.ts`, `lib/device/managerParseDevice.ts`,
      `lib/device/managerParseIdentity.ts`.
      Resolution: `DeviceManager.refreshSnapshot` (snapshot pipeline) and the
      `parseDeviceListForTests` test entry are now the single application sites
      for the parse path; the realtime pipeline keeps its own single application
      inside `DeviceManager.handleRealtimeDeviceUpdate`. The wrapper
      `DeviceManager.parseDeviceList` (was site #2) now trusts already-effective
      input, and `resolveParseDeviceIdentity` (was site #3) no longer touches
      driver overrides or compatibility metadata. Regression covered by
      `test/deviceManager.test.ts` (`getDeviceDriverIdOverride` invoked once per
      device for both `parseDeviceListForTests` and `refreshSnapshot`).
- [x] Audit whether daily-budget confidence scoring materially changes control decisions. If it is
      purely informational, simplify it aggressively.
      Files: `lib/dailyBudget/dailyBudgetConfidence.ts`, daily budget service/plan paths.
      Audit result: every consumer is informational. The producer
      (`computeBacktestedConfidence` / `resolveConfidence`) feeds five sites:
      `DailyBudgetManager.update` (writes onto `budget.confidence`,
      `confidenceDebug`), `dailyBudgetManagerSnapshot.logBudgetSummaryIfNeeded`
      (single debug log line), `dailyBudgetService.applyOverallModelConfidence`
      (copies today's confidence to adjacent-day snapshots), `buildDailyBudgetSnapshot`
      (puts the values onto the `state` block of `DailyBudgetDayPayload`), and
      `budgetRedesignResolvers.resolveConfidenceData` /
      `views/BudgetOverview.BudgetConfidenceCard` (Plan-confidence card label,
      percent, and the four explainer rows). `grep` on `lib/plan/`, `lib/executor/`,
      `lib/device/`, `lib/power/`, `lib/observer/`, `lib/app/` confirms no planner /
      shed / restore / budget-gate branch reads either value. Aggressive
      simplification (e.g. collapsing to a 3-state band, dropping the bootstrap
      CI) is mechanically possible but would also have to reshape `ConfidenceDebug`
      in `packages/contracts/src/dailyBudgetTypes.ts` and the four debug-row
      labels the UI renders, plus ~900 lines of tests, so this PR documents the
      scope at the top of `lib/dailyBudget/dailyBudgetConfidence.ts` and closes
      the audit. Future simplification is a follow-up if the explainer card
      changes.
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
      Files: `lib/plan/planBuilder.ts`, `lib/plan/admission/deferredObjective.ts`,
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
- [x] Quiet repeated `stale_device_observation_refresh` log entries that never resolve.
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
      *(landed: per-device `staleRefreshLogLastEmitMsById` map gates
      `stale_device_observation_refresh` info emits to at most one per 15-minute window
      per device — matching the planner's other 15-min repeat-event windows — so the
      stream is bounded instead of growing with uptime. Recovery (device becomes fresh)
      clears that device's backoff so a later stall re-emits. The `'unknown'`
      never-observed case already short-circuits at `isDeviceObservationStaleByAge`,
      which excludes `'unknown'` from the refresh-loop filter entirely, so the loop
      never runs for those devices and no extra logic was needed — documented as a
      comment in `refreshStaleDeviceObservations`. Counter accuracy preserved:
      `stillStaleAfterRefreshDevices` still reflects the true count; only the log
      emit is gated, and the new `loggedStillStaleDevices` field surfaces the gated
      subset. In-memory only per `feedback_homey_sdk_unreliable`. Locked by two new
      `appSnapshotHelpers.test.ts` cases for the 100-cycle bound and the
      reset-on-recovery contract.)*
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
- [x] Animate the "Building plan…" chip so users can tell planning is alive. *(landed via
      Option B: new `data-pulse="true"` attribute on the canonical `.plan-chip` primitive,
      bound to a low-key opacity loop (1 → 0.6 → 1) in `packages/settings-ui/public/style.css`
      routed through the existing `--pels-motion-pulse-duration` token. Discriminator path:
      list surface — `StatusChip` in `DeadlinesList.tsx` emits `data-pulse="true"` when
      `statusId === 'building_plan'`; pending hero — `buildPendingHero` in
      `deadlinePlanPending.ts` sets `pulse: true` on the liveStateChip when
      `liveState === 'building_plan'` (the `DeadlinePlanChip` type gained an optional
      `pulse?: boolean` field which both `DeadlineHero` and `PendingHero` forward onto
      `data-pulse`). `prefers-reduced-motion: reduce` disables the animation; the
      `prefers-reduced-motion: no-preference` gate keeps the pulse off for users who opted
      out of motion. Locked by `buildingPlanChipPulse.test.ts` (CSS keyframe + reduced-motion
      contract) and per-surface DOM assertions in `deadlinesListRender.test.ts` /
      `deadlinePlanRender.test.ts`.)*
- [x] Reconcile chip tone between the Smart tasks list and the plan detail.
      For the same `Building plan…` state the list card uses `muted` tone but the plan-detail
      pending hero uses `info` tone. Pick one and apply uniformly. *(landed: shared-domain
      `resolveBuildingPlanChipTone()` → `'info'` in `packages/shared-domain/src/deadlineLabels.ts`;
      `SMART_TASK_LIST_STATUS_CHIP_VARIANT.building_plan` and `pendingChipTone` both call it,
      and the paired `resolvePausedUnpluggedChipTone()` → `'warn'` covers the EV paused
      state. List chip now reads `info` to make the state more discoverable.)*
- [x] Bring the pending-hero body copy up to action-text weight. *(landed via Option B: new
      `plan-hero__subline--action` modifier in `packages/settings-ui/public/style.css` mapped to
      `--pels-text-primary`. The pending hero's `metaLine` slot in `PendingHero`
      (`packages/settings-ui/src/ui/views/DeadlinePlan.tsx`) now binds to it, so the "why is
      this still building?" copy — `device_data_missing` ("PELS needs a current state of
      charge…"), `missing_capacity` ("Learning energy use — needs power readings from this
      device."), `awaiting_horizon_plan` ("Will start when the next-day price drop publishes."),
      `price_feature_disabled`, `invalid_session`, etc. — reads at primary on-surface contrast.
      The ready hero keeps `--muted` for its recap meta/cost/delivered-so-far lines; existing
      uses across BudgetOverview, the index.html helper text, and the ready-hero meta lines are
      untouched.)*
- [x] Highlight the correct tab when deep-linking into a smart-task plan from the Overview
      device card. *(Landed: `deadlinePlanRouter` now keeps the shell-nav visible while the
      plan-detail panel is up and lights the Smart tasks tab via a new `setActiveTabIndicator`
      helper extracted from `showTab`; the prior `setShellNavVisible(false)` hide is gone.
      A new `pels:tab-shown` listener resets the deep-link URL + unmounts when the user clicks
      any shell-nav tab while plan-detail is open, so reload stays coherent.)*
      Files: `packages/settings-ui/src/ui/deadlinePlanRouter.ts`,
      `packages/settings-ui/src/ui/realtime.ts`,
      `packages/settings-ui/tests/e2e/deadline-plan.spec.ts`.
- [~] Add a hero summary to the Electricity prices settings panel. *(partial, landed in
      `v2-7-3-budget-rhythm-and-polish`, 2026-05-18: one-sentence lede added under the panel
      `pels-hero` h2 so users know what the panel controls.)* Remaining for a later pass:
      a live "current tier / cheap / expensive / last-fetched" summary card. That requires
      a new wiring path from the price service into the settings UI and was out of scope.
      Files: `packages/settings-ui/src/ui/views/ElectricityPricesView.tsx` (done);
      `packages/settings-ui/public/index.html` (Electricity prices panel hero — pending);
      `packages/settings-ui/src/ui/electricityPrices.ts` (pending).
- [x] Consolidate the three near-identical pulse keyframe animations.
      `settings/style.css` defined three pulse animations at 1.4 s / 1.5 s / 1.6 s —
      imperceptibly different and not driven from a shared token. Promoted the median
      1.5 s cadence to `pels.motion.pulse-duration` in `tokens/component.json`, which
      generates `--pels-motion-pulse-duration` in `settings/tokens.css`. All three
      call sites (`.device-loading-notice`, `.plan-card__stepped-direction`,
      `.plan-card__stepped-seg[data-pulse="true"]`) now reference
      `var(--pels-motion-pulse-duration)`, keeping the `pulse`,
      `plan-stepped-direction-pulse(-down)`, and `plan-stepped-pulse` keyframes intact
      (their content encodes meaningfully different visual effects — transform
      translateY vs. opacity-only with distinct 0.6 / 0.45 floors). Regression locked
      by `packages/settings-ui/test/pulseDurationToken.test.ts`.
- [x] Audit `settings/style.css` for hardcoded px / rem values that should bind to tokens.
      Shipped: every cleanly-bindable single-value literal in
      `packages/settings-ui/public/style.css` now routes through the design
      tokens. Bindings:
      - `4px` → `--spacing-1` (`.card h2` / `.pels-hero h2` / `.device-detail-heading h2`
        margin; `.price-indicator` margin-right; `.plan-row__meta` / `.price-enable-text` /
        `.tabs` (480px breakpoint) / `.day-view-bars` / `.day-view-labels` gap; `.day-view-labels`
        padding-top; `.device-row.price-optimization-row .device-row__name`
        margin-bottom (360px breakpoint); `#shell-nav .tab` padding-inline (360px breakpoint));
      - `8px` → `--spacing-2` (`.plan-card__step-labels` margin-inline; `.inline-actions`
        gap + margin-top; `.detail-diagnostics-list` gap; `.detail-mode-row__header` gap;
        `.power-day-header` padding bottom-axis; `.device-row__state-chip` and
        `.price-now-badge` padding inline-axis);
      - `12px` → `--spacing-3` (`.price-summary` padding + margin-bottom; `.form__actions` /
        `.list__footer` / `.toggle-label` / `.price-row` / `.detail-diagnostics-grid` /
        `.detail-stepped-header` / `.detail-stepped-row` gap; `.list__footer` /
        `.hourly-nav` margin-bottom; `.detail-mode-row` gap row-axis; `.list__footer`
        margin-top; `.price-last-fetched` margin-top; `.settings-collapse .collapse-content h4`
        margin bottom-axis + `:first-child` margin-top);
      - `16px` → `--spacing-4` (`.price-info` margin-bottom; `.price-notice` padding
        block-axis; `.slide-panel__footer` / `.hourly-pattern__empty` padding;
        `.settings-collapse .collapse-content h4` margin top-axis; `.detail-mode-row`
        gap column-axis);
      - `24px` → `--spacing-6` (`.detail-section` margin-bottom);
      - `999px` → `--radius-full` (9 pill primitives: `.plan-card__load-track`,
        `.plan-card__load-fill`, `.plan-card__load-tick`, `.plan-card__metric-track`,
        `.plan-card__metric-fill`, `.plan-card__metric-tick`, `.day-view-marker /
        .daily-budget-dot`, `.day-view-legend__swatch--actual`, `.value-adjuster`);
      - `border-radius: 8px` → `--radius-md` in `.price-summary` (sibling-card
        normalization — `.price-notice-info` / `.price-notice-warning` already on
        `--radius-md`, 2 px corner-radius drift removed).
      New token introduced: `--font-size-xxs: 10px` in `tokens/base.json`
      (regenerated into `settings/tokens.css` via `npm run build:settings`),
      bound by `.plan-card__metric-scale` (was the lone `font-size: 0.62rem`
      literal; ≈9.92 px at the 16 px root).
      Intermediate values (`gap: 2px` / `3px` / `6px` / `10px` and similar small
      paddings) intentionally left as literals — the existing spacing scale
      (`--spacing-1` = 4 → `--spacing-2` = 8 → `--spacing-3` = 12 …) skips
      these increments and inventing `--spacing-0_5` / `--spacing-1_5` etc.
      would create awkward fractional tokens that fight the numeric
      convention. The `border-radius: 50%` (circular markers) and
      `border-radius: 0` (deliberate reset) cases are intentional geometric
      primitives, not px literals.
      Regression locked by `packages/settings-ui/test/styleCssTokenAudit.test.ts`
      (20 assertions: token declaration in `dist/tokens.css`, every catalogued
      call-site binding, defensive guards against re-introducing the bare
      literals, and a sweep that rejects any new bare
      `(gap|padding): {4,8,12,16,24,32}px` or `font-size: <px|rem>` declaration).
      Files: `packages/settings-ui/public/style.css`, `tokens/base.json`,
      `settings/tokens.css` + `settings/style.css` (regen),
      `packages/settings-ui/test/styleCssTokenAudit.test.ts`.
- [x] Investigate repeated stale managed-device refreshes that never become fresh.
      Finding: case (a) — refresh is a no-op by design. `lastFreshDataMs` is
      derived by `resolveLastFreshDataMs` (`lib/device/transport/managerParseSnapshot.ts`)
      from the highest Homey per-capability `lastUpdated`. Many Homey drivers
      (Z-Wave/Zigbee thermostats in particular) only advance `lastUpdated`
      when a capability genuinely reports a new value; a targeted refresh
      that re-fetches the snapshot does NOT bump `lastUpdated`, Homey serves
      the cached value with the same timestamp. The 40-min
      `STALE_DEVICE_OBSERVATION_MS` window is the backstop, and the
      `device_became_stale`/`device_became_fresh` per-device transitions in
      the same prod log confirm devices DO eventually re-emit fresh when
      telemetry changes (all stale entries in `/tmp/pels/start.main.0a4464c3.stdout.log`
      are `Termostat *`). Already documented in three places: comment in
      `mergeFresherCapabilityObservations` (lines 202-209 of
      `lib/device/transport/managerObservation.ts`), comment above
      `STALE_OBSERVATION_REFRESH_LOG_BACKOFF_MS` in
      `lib/app/appSnapshotHelpers.ts` (lines 19-26), and module doc in
      `lib/observer/observationFreshness.ts` (lines 7-14). Refresh failures
      would show up as `device_snapshot_refresh_failed` — none present in
      prod logs. Regression added in `test/appSnapshotHelpers.test.ts`,
      `refreshStaleDeviceObservations contract` describe block:
       - `counts a device as fresh once refresh produces a newer
         lastFreshDataMs and as still-stale when it does not` — pins the
         structured `stale_device_observation_refresh` counter split
         (`freshAfterRefreshDevices` vs `stillStaleAfterRefreshDevices`).
       - `emits device_became_stale with the last observation timestamp
         as the still-stale reason` — pins the per-device "could not
         refresh" reason, surfaced via `device_became_stale` carrying
         `deviceId`, `deviceName`, `ageMs`, `lastObservationAt`, `source`.
      Files: `test/appSnapshotHelpers.test.ts`, `TODO.md`.
- [x] Quiet duplicate-snapshot `objective_profile_non_monotonic_time` rejections.
      Shipped: `updateDeviceObjectiveProfile` (`lib/objectives/profiles.ts`) now
      silently returns the existing profile when the interval rejection reason is
      `objective_profile_non_monotonic_time` and `sample.value === previous.lastSample.value`,
      so neither the structured `objective_profile_sample_rejected` event nor the
      `rejectedSamples` counter increments. Covers both exact `(observedAtMs, value)`
      duplicates and `intervalMs ∈ {-2, -4}` cases where a capability ages out of the
      `Math.max` floor. Other interval-rejection reasons (`interval_too_short`,
      `interval_too_long`, `unit_changed`) and any non-monotonic sample whose value
      moved still flow through the normal emit+counter path. Regression tests added in
      `test/objectiveProfiles.test.ts` under the
      `non_monotonic_time suppression for unchanged-value duplicates` describe block:
      `suppresses non_monotonic_time rejection on exact (observedAtMs, value) duplicates`,
      `suppresses non_monotonic_time rejection when observedAtMs slips backwards but value is unchanged`,
      `still emits non_monotonic_time rejection when observedAtMs slips backwards and value changed`.
      Files: `lib/objectives/profiles.ts`, `test/objectiveProfiles.test.ts`.
      Source: Pro Homey runtime-log audit 2026-05-17 (`/tmp/pels/start.main.0a4464c3.stdout.log`).
- [x] Plan engine fires before the first device snapshot lands, producing a one-cycle
      `deferred_objective_unknown reasonCode:objective_missing_device` event on every
      restart.
      Shipped: new `SnapshotWarmupGate` (`lib/plan/snapshotWarmupGate.ts`) instantiated in
      `app.ts#initSnapshotWarmupGate` between `initPlanEngine` and `initPlanService` and
      consumed by `PlanService.rebuildPlanFromCache` — any rebuild attempted before the
      gate releases waits at the gate (held inside `rebuildPlanFromCache` before the
      operation queue, so the wait does not interact with steady-state queue ordering).
      The gate is released by `bootstrapSnapshotAndPlan` (`lib/app/appLifecycleHelpers.ts`)
      with reason `snapshot_ready` once the first `refreshTargetDevicesSnapshot()`
      resolves; if that throws or the snapshot fetch stalls past the
      `SNAPSHOT_WARMUP_TIMEOUT_MS` bound (5_000ms in prod, 0 in tests) it auto-releases
      with reason `timeout` so startup never deadlocks. `app.ts#onUninit` also releases
      the gate before `planRebuildScheduler.cancelAll('app_uninit')` so partial-startup
      shutdowns drain cleanly. Release emits a structured `snapshot_warmup_gate_released`
      event at info (snapshot_ready) or warn (timeout) for log-audit attribution, and a
      `plan_rebuild_warmup_waited_total` perf counter increments on each wait so we can
      track how many rebuilds hit the gate in production. Per `feedback_homey_sdk_unreliable`
      the gate never touches persisted state and the next periodic refresh retries.
      Wait shape: `await snapshotWarmupGate.wait()` inside `PlanService.rebuildPlanFromCache`
      (`lib/plan/planService.ts`). Bound: 5s in production, configurable via
      `SNAPSHOT_WARMUP_TIMEOUT_MS` constant; 0 in tests. Regression coverage in
      `test/snapshotWarmupGate.test.ts` describes:
      `SnapshotWarmupGate` (auto-release on bound, snapshot_ready release, immediate
      release with timeoutMs=0, idempotent release, timer-cancellation on early release),
      `bootstrapSnapshotAndPlan warmup gate integration` (releases on success, releases
      on `refreshTargetDevicesSnapshot` rejection so startup completes, post-warmup
      rebuilds are not blocked), and `PlanService.rebuildPlanFromCache warmup gate`
      (waits before the engine call when held; holds concurrent
      price/settings/flow-triggered rebuilds during the warmup window). The bus-publish
      half of the acceptance is met transitively: `statusBus.publish` is only reachable
      from inside a plan rebuild via `emitDeferredObjectiveStatusTransitions`
      (`lib/plan/planBuilder.ts:699`), so holding the rebuild also holds the publish.
      Files: `app.ts`, `lib/plan/snapshotWarmupGate.ts`, `lib/plan/planService.ts`,
      `lib/app/appContext.ts`, `lib/app/appInit.ts`, `lib/app/appLifecycleHelpers.ts`,
      `test/snapshotWarmupGate.test.ts`.
      Source: Pro Homey runtime-log audit 2026-05-17 (`/tmp/pels/start.main.0a4464c3.stdout.log`).
- [x] Energy training stuck at `bandsCount:0` for thermostats with no `crediblePowerW`.
      `lib/objectives/samples.ts:57-82` returns `kwhPerUnit:null` when neither
      `measuredPowerKw > 0` nor `reportedStep.planningPowerW > 0` is present at sample
      time. `lib/objectives/profiles.ts:436-438` then skips the band buffer update, so
      the device's adaptive band fitter (per `notes/objective-profile-bands.md`) never
      sees any input. `Termostat Synne` in this audit window had `acceptedSamples:67` but
      `bandsCount:0`, `rateConfidence:"low"`, `energyConfidence:"low"`. For thermostats
      without an inline meter and without a per-step planning-power configured, energy
      training is effectively disabled — no warning, no recourse surfaced to the user.
      Why P2: silent gap; user expectation is "the longer this runs the smarter it gets"
      and the reality is that some devices will not improve regardless of sample count.
      Resolution: approach (a) implemented in `lib/objectives/noPowerSourceDiagnostic.ts`.
      `buildAcceptedProfileSample` emits a one-shot `objective_profile_no_power_source`
      structured event per device per process lifetime, after
      `OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD = 20` consecutive accepted samples
      with unresolved `crediblePowerW`. The in-memory counter (no persisted state per
      `feedback_homey_sdk_unreliable`) resets on any valid power reading; the
      already-emitted flag persists so a flipping device doesn't spam. The diagnostic is
      informational — band-fitter behavior unchanged. Requirement now documented in
      `notes/objective-profile-bands.md` ("a credible power source must be available per
      accepted sample" + diagnostic semantics).
      Files: `lib/objectives/noPowerSourceDiagnostic.ts` (new),
      `lib/objectives/profiles.ts`, `notes/objective-profile-bands.md`,
      `test/objectiveProfiles.test.ts`.
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
- [x] Extend the snapshot-fallback pattern used by `writeFreshSetting` callers in
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
- [x] Sync `docs/plan-states.md` device-card secondary-text language with `notes/ui-terminology.md`.
      `docs/plan-states.md:26` still described the held-state secondary text as "Limited by PELS"
      while `notes/ui-terminology.md:100` and the live UI (post PR 4.4) now use `Lowered by PELS`
      / `Charging paused`. Updated the doc paragraph so the public docs site matches the shipped UI
      (`Limited by PELS` → `Lowered by PELS`; EV-charger `Charging paused` and `Turned off by PELS`
      wording was already correct).
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

*Bot-review findings carried forward from the v2.7.2 BOU train (PRs #881,
#882, #884), 2026-05-18.*

- [ ] Lift `budgetRedesign.ts` back under the 500-line `max-lines` cap.
      PR #884 raised the override to accommodate the new
      `BudgetPageHeader` + price-level-chip wiring. Extract the chip
      resolver + page-header builder into helper modules (or push the
      header builder back into `BudgetOverview.tsx` as a view-local
      component) so the central file shrinks. The exemption is intentional
      for the train batch, not the end state.
      Source: gemini-code-assist on PR #884, `eslint.config.mjs:514`.
      Files: `packages/settings-ui/src/ui/budgetRedesign.ts`,
      `eslint.config.mjs` (drop the override line once back under 500).

- [x] Restore an `<h2>` page heading on the Usage panel.
      PR #881 demoted "Energy history" from `<h2>` to `<p class="eyebrow">`
      as part of the hero double-capsule trim, leaving Usage without a
      heading at the panel level. Other panels (Overview, Budget, Smart
      tasks, Settings) all carry an `<h2>` as the panel landmark heading;
      Usage now skips that level which breaks the document outline for
      screen-reader users.
      Source: gemini-code-assist on PR #881 (medium) at
      `packages/settings-ui/public/index.html:178` and
      `settings/index.html:178`.
      Resolution: added a visually-hidden `<h2>Usage</h2>` as the first
      direct child of `#usage-panel` so the eyebrow ("Energy history")
      stays the only visible label while the document outline regains a
      stable topical landmark (anchor test in
      `packages/settings-ui/test/panelLoadingSkeletons.test.ts`).

- [x] Audit `settings/index.html` ↔ `packages/settings-ui/public/index.html`
      sync at PR-author time.
      PR #881's "Smart tasks eyebrow" change landed in `settings/index.html`
      (the built output) but not in `packages/settings-ui/public/index.html`
      (the source). A future `npm run build:settings` will regenerate
      `settings/index.html` from source and silently revert the eyebrow
      drop. Verify the source and re-sync (or document why the two
      diverged in the PR description).
      Source: gemini-code-assist on PR #881, `settings/index.html` (high).
      Files: both index.html files.
      Resolution: re-ran `npm run build:settings`; the index.html pair is
      byte-for-byte after rebuild. Discovered one stale `settings/style.css`
      copy (the `.plan-inputs__row-value--warn` warn-tone block from commit
      `99ad7631` had not been re-synced) and re-bundled it as part of the
      same commit so source and shipped bundle are now in lock-step.

- [x] Move PR #882's hardcoded user copy into shared-domain helpers.
      PR #882 introduced two inline strings the PR description acknowledged
      as exceptions (TV-stue temperature placeholder at
      `PlanDeviceCards.tsx:462`; projected-energy text at
      `PlanHero.tsx:556`). Both should be folded into
      `packages/shared-domain/**` helpers per
      `feedback_ui_text_shared_with_logs` so logging surfaces the same
      wording.
      Source: gemini-code-assist on PR #882 (2× medium).
      Files: `packages/settings-ui/src/ui/views/PlanDeviceCards.tsx`,
      `packages/settings-ui/src/ui/views/PlanHero.tsx`,
      `packages/shared-domain/src/deviceOverview.ts` (or new helper).
      Done: (1) the TV-stue "Temperature unavailable" placeholder was
      already replaced in PR #893 (`refactor(plan): plannedTarget is
      non-nullable on the temperature path`) — `resolveTemperatureLine`
      in `packages/shared-domain/src/planTemperatureCardText.ts` now
      emits `target N° · sensor unavailable` when the sensor reading is
      missing, and the inline placeholder in `PlanDeviceCards.tsx` is
      gone. (2) The projected-energy text moved to
      `formatProjectedEnergySubline` in
      `packages/shared-domain/src/planHeroSummary.ts`; `PlanHero.tsx`
      now imports the helper instead of the inline template. Producer
      owns the `toFixed(2)` formatting per
      `feedback_layering_resolution_in_producer`.

## P3 Future and Exploratory Work

- [ ] Drop the remaining `lib/price/priceService.ts` max-lines override.
      After the Norgespris usage helpers (`getCurrentMonthUsageKwh`,
      `getHourlyUsageEstimateKwh`) moved to `lib/price/priceServiceNorgespris.ts`,
      the orchestrator class sits at 509 effective LOC — 9 over the 500-line
      default. Extracting the two price-info formatters
      (`formatFlowPriceInfo`, `formatNorwayPriceInfo`) to a sibling would
      push it under the default and let the per-file `max-lines: 510`
      override go away.
      Files: `lib/price/priceService.ts`, `eslint.config.mjs`.

- [ ] Clean up low-severity v2.9 review-note drift. The implementation is
      correct, but contributor notes point at stale files or examples:
      `notes/smart-task-flow-cards/README.md` still names deleted
      `flowCards/deadlineEndedTokens.ts` in the implementation punch list
      even though the top of the same note says the code moved to
      `flowCards/smartTaskTokens.ts`; `notes/deferred-load-objectives/feasibility-confidence.md`
      and the matching TODO citation point at old `objectiveProfiles.ts`
      lines for energy-window math now living in
      `lib/objectives/energyAccumulator.ts`; and
      `notes/smart-task-ui/README.md` mentions a `Backup hours` history pill
      that is still future scope. Update or annotate the stale references so
      future reviewers do not chase missing surfaces.
      Files: `notes/smart-task-flow-cards/README.md`,
      `notes/deferred-load-objectives/feasibility-confidence.md`,
      `notes/smart-task-ui/README.md`, matching TODO citation if retained.
      Source: adversarial docs review, v2.9.0 closeout, 2026-05-23.

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
      Files: `lib/plan/deferredObjectives/planHistory.ts`,
      `lib/plan/deferredObjectives/planHistoryV4Helpers.ts`,
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
      Files: `lib/plan/deferredObjectives/horizonPlanner.ts:resolveStatus`,
      possibly `activePlanSchedule.ts` for emit gating.

- [ ] Surface mode-target misconfiguration to the user. When a managed temperature
      device has no target set for the active operating mode, the planner falls back
      to the device's current `target_temperature` capability value and logs
      `missing_mode_target` (topic `plan`). When both are missing, the planner emits
      `missing_mode_target_and_current_target` and either drops the device for the
      cycle or — if a deferred (deadline) objective is active — uses the deadline
      target as the rescue seed and keeps planning. The settings UI should warn the
      user (e.g. in the device detail page or on the operating-mode page) so they
      can configure the missing target instead of relying on whatever the thermostat
      happens to be set to or on the deadline rescue path.
      Files: `lib/plan/planDevices.ts` (`resolveTemperatureSeed`,
      `resolvePlannedTarget`), settings UI device detail / operating-mode views.

- [ ] Add abandon-grace to the mode-target-missing skip path. Today a single transient
      Homey SDK miss on `getPrimaryTargetCapability(dev.targets)?.value` drops the
      device from the plan for that cycle (and re-runs every plan cycle while the miss
      persists). Per `feedback_homey_sdk_unreliable`, capability reads can transiently
      fail during cold-start, re-pair, or zone reload. Track consecutive missed-read
      cycles per device in `PlanEngineState` and only skip after a grace window
      (e.g. 3–5 cycles); within grace, reuse the last successfully resolved target.
      Files: `lib/plan/planDevices.ts`, `lib/plan/planEngineState.ts`.

- [ ] Throttle `missing_mode_target` / `missing_mode_target_and_current_target` events
      per device. The emitter is already gated by the `plan` debug topic (off by
      default), so production volume is bounded — but when users enable the topic,
      a stuck misconfigured device fires every plan cycle (10 s in `homey_energy`
      mode = ~8,640/day). Per-device emit-on-transition + N-minute heartbeat would
      keep the signal useful without flooding the log buffer (RSS headroom is ~30 MB
      per `project_homey_rss_limit`). Files: `lib/plan/planDevices.ts`.

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

- [ ] Wire deferred-objective step intent into cascade control (future feature).
      Today `lib/plan/deferredObjectives/horizonPlanner.ts:158,188` computes a
      `requestedMinimumStepId` per planned bucket and emits it via
      `lib/plan/admission/deferredObjective.ts:53-57` on the `DeferredAdmissionDecision`,
      but no consumer reads it for control — it reaches diagnostics, log payloads,
      and flow tokens only. Smart tasks today are admission-only ("may this device
      run?"); they do not steer step level. The cascade picks step independently
      from device priority, soft-cap pressure, and its own step-down policy.
      Future capability: opt-in path where the cascade consults the horizon's
      requested step as a step-down hint during soft overshoot. Likely gated on
      `enforcement === 'hard'` so soft objectives stay advisory per the
      `lib/plan/admission/deferredObjective.ts:72-77` design comment ("soft
      objectives should not bypass restore admission, cooldowns, or daily-budget
      logic"). Pairs naturally with the P2 about `enforcement: 'hard'` having no
      behavioral effect on EV deadlines.
      Why P3: speculative future feature, not a defect. Current behavior is the
      documented soft-objective contract. The audit-window symptom (Connected 300
      cap-on water heater emitting `requestedMinimumStepId:"low"` over 80/80
      horizon plans with no executor effect, while the cascade shed thermostats
      to absorb soft overshoot) is intentional.
      Files: `lib/plan/admission/deferredObjective.ts`,
      `lib/plan/deferredObjectives/horizonPlanner.ts`,
      `lib/plan/shedding/selection.ts`, `lib/plan/shedding/candidates.ts`,
      `notes/deferred-load-objectives/` (design doc when picked up).
      Source: investigation 2026-05-18 (`/tmp/pels/start.main.0a4464c3.stdout.log`).

- [x] Add Playwright assertion that the segmented short/full labels never co-render.
      PR 3.2 introduced a dual-label pattern on `.segmented__option-label--full` /
      `--short` toggled by `@media (max-width: 360px)`. If a future CSS regression
      breaks the toggle, both spans could render concurrently. A 480 px probe
      asserting `--short` width is 0, and a 320 px probe asserting `--full` width
      is 0, would catch the dual-render regression.
      Files: `packages/settings-ui/tests/e2e/`, `packages/settings-ui/public/style.css`.
      Done: `packages/settings-ui/tests/e2e/segmented-short-full-labels.spec.ts`
      ("segmented dual-label exclusivity" — 480 px and 320 px probes on the
      Budget day picker; CSS hides via `display: none`, so `toBeHidden()` /
      `toBeVisible()` match the runtime behavior).

- [x] Overview device-name trailing whitespace. Live-walk 2026-05-16:
      `aria-label="Open device details for Termostat gang "` and several others
      ("Synne ", "vaskerom ", "kontor ", "bad tredje ", "hovedsoverom "). Likely
      user-entered in Homey itself, but a `String#trimEnd` on display would be
      polite and avoid screen-reader pauses.
      Helper: `packages/shared-domain/src/displayDeviceName.ts`
      (`formatDisplayDeviceName`). Display-only — persisted state stays
      verbatim. Callsites: `views/PlanDeviceCards.tsx` (generic + temperature
      cards, DeadlineChip), `views/PlanSteppedCard.tsx`,
      `views/PriceAwareDevicesView.tsx`, `views/DeadlinesList.tsx`,
      `views/DeadlinesHistoryList.tsx`, `views/DeadlinePlanHistory.tsx`,
      `views/DeadlinePlanHistoryDetail.tsx`, `ui/modes.ts`, `ui/devices.ts`,
      `ui/deviceDetail/index.ts`, `ui/advanced.ts`, `ui/deadlinePlan.ts`,
      `ui/deadlinePlanHero.ts`.

- [x] Resolve `resolveHeroTone` name collision between `usageHero.ts` and `deadlinePlanHero.ts`.
      Done: renamed the deadline-plan helper to `resolveDeadlineHeroTone` and left
      `usageHero.ts:resolveHeroTone` untouched — fewer callsite churn (2 callers updated:
      `deadlinePlan.ts` production + the `resolveDeadlineHeroTone` describe block in
      `packages/settings-ui/test/deadlinePlan.test.ts`). A doc comment in
      `deadlinePlanHero.ts` now points back to the usage-side sibling so the distinction
      stays auditable.
- [x] Split chip label for `at_risk` plans vs `cannot_meet` plans.
      Done at the chip-label layer (already shipped in `Align smart task confidence chips`
      on 2026-05-19 — `atRiskChipLabel: SMART_TASK_LIST_STATUS_LABELS.at_risk` = "At risk",
      `cannotMeetChipLabel: 'Cannot finish'`; `resolveHeroStatusChip` routes them with
      `warn` vs `alert` tones). This pass pins the split with a regression test in
      `test/smartTaskListLabels.test.ts` (`at_risk vs cannot_meet chip labels`) so a future
      collapse can't re-merge them. The `cannotMeet` boolean fold at
      `deadlinePlan.ts:500` is intentionally left — the partial-schedule budget-bound
      at_risk regression at `deadlinePlan.test.ts:1448` already pins the desired body-copy
      reuse (budget cause sentence + Open Budget recourse on at_risk + budget), and
      removing the fold would invert that intentional design.
- [x] Always show observed coverage on smart-task history cards. v2.9.x —
      `formatPlanHistoryObservedCoverage` was time-based ("Brief gap (Xm)" / "Not observed
      for Yh") and silently collapsed to null whenever ≥99 % of the [start, deadline]
      window carried a diagnostic stream, hiding the planner-vs-reality mismatch where the
      planner allocated hours but the device drew no power. Rewrote the helper to count
      planned hour buckets (M = `plannedKWh > 0` buckets in finalPlan / originalPlan) and
      buckets touched by `observedIntervals` (N), emitting `"Observed N of M planned
      hours"` whenever M > 0 so the N=0-of-M=5 case surfaces as visible signal. Backfill
      branch and the no-plan/no-active-buckets null branch unchanged. Re-enabled
      `coverageLine` on the history-detail hero for Succeeded / Missed / unknown-with-plan
      shapes (still suppressed on quiet abandoned/replaced). Test:
      `test/deferredPlanHistoryObservedCoverage.test.ts` (`formatPlanHistoryObservedCoverage`
      → 9 cases, including the canonical "Observed 0 of 5 planned hours" actionable
      assertion).
      Files: `packages/shared-domain/src/deferredPlanHistory.ts`,
      `packages/settings-ui/src/ui/deadlinePlanHistoryDetailHero.ts`,
      `packages/settings-ui/test/deadlinePlanHistory.test.ts`,
      `test/deferredPlanHistoryObservedCoverage.test.ts`.
- [ ] Cross-kind copy sharing in `deadlineLabels.ts` — revisit when first kind-specific
      divergence lands. Temperature and EV share byte-identical `cannotMeetShortfall` and
      `cannotMeetFallback` strings (only `cannotMeetDailyBudgetExhausted` differs by the noun).
      When the first kind-specific branch arrives — likely the unplugged-EV copy from the P1
      "objective_invalid_session" entry — audit whether the shared helpers still make sense or
      if the kinds should split fully. No action until the first divergence.
      Files: `packages/shared-domain/src/deadlineLabels.ts`.
- [x] Document recurring smart-task usage in `set_*_deadline` flow card hints. The action
      auto-disables the objective after deadline passes (correct, prevents silent replans), but
      the user-facing card hint didn't explain that users need a daily trigger (e.g.
      "when EV plugged in") to re-arm. Appended one sentence to each card's `hint` field
      (English-only — no other flow card carries Norwegian copy):
      - `set_ev_charge_deadline`: "The smart task auto-disables once the deadline passes;
        run this card from a recurring Flow (e.g. when the EV is plugged in) to re-arm it
        for the next session."
      - `set_temperature_deadline`: "The smart task auto-disables once the deadline passes;
        run this card from a recurring Flow (e.g. on a daily schedule) to re-arm it for
        the next run."
      Files: `.homeycompose/flow/actions/set_ev_charge_deadline.json`,
      `.homeycompose/flow/actions/set_temperature_deadline.json`, regenerated `app.json`.
- [x] Add DST fall-back ambiguity regression test for deadline resolution.
      `lib/plan/deferredObjectives/deadline.ts:112-146` handles DST rigorously (probes timezone
      at ±36h, ±12h, 0h to find valid UTC candidates matching local HH:mm), but the fall-back
      ambiguous hour (e.g. 2:30 AM existing twice) currently selects earliest-future without an
      explicit test. Add the regression. Pinned by
      `test/deferredObjectiveDiagnostics.test.ts` →
      `resolveDeferredObjectiveDeadline > selects the earliest valid UTC candidate for an
      ambiguous fall-back hour` (Europe/Oslo, 2026-10-25 fall-back, deadline 02:30).
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
- [x] Distinguish "missed by an unknown amount" from "missed by exactly 0 kWh" on the
      `deadline_ended` flow trigger (the only trigger that surfaces a missed deadline today;
      the old `deadline_missed` name in this note pre-dates the v2.x rename). The Homey SDK
      rejects `null` for `number`-typed tokens (see `homey-apps-sdk-v3/lib/FlowCardTrigger.js`),
      so `shortfall` falls back to `0` when the device-side delta is unobservable.
      Added a `shortfall_known: boolean` token (true when `outcome === 'succeeded'`, or when
      both the target and final-progress samples are finite for the active `objectiveKind`;
      false when one is null and the numeric token had to fall back to 0). Existing
      `shortfall` semantics unchanged.
      Files: `flowCards/smartTaskTokens.ts` (`computeShortfall` now returns
      `{ value, known }`), `.homeycompose/flow/triggers/deadline_ended.json`, regenerated
      `app.json`, `test/deadlineObjectiveCards.test.ts`.
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
      `sessionStartedAtMs` boundary in `lib/device/stateOfCharge.ts` that materializes the
      defaults into a `DeferredObjectiveSettingsV1` entry through the same upsert path the flow
      card uses. Persistence must align with the shared `PersistedSettingsState<T>` helper from
      `notes/persisted-settings-state.md`.
      Why P3: stand-alone polish; removes the per-session friction of firing
      `set_ev_charge_deadline` manually, but the v1 flow-card path is workable without it.
      Design: `notes/ev-ready-by/README.md`.
      Files: new `packages/contracts/src/evChargerDefaults.ts`,
      new `lib/app/evChargerDefaultsWiring.ts`, `lib/device/stateOfCharge.ts`,
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
      `lib/plan/deferredObjectives/planHistory.ts` (transient handoff to in-page route).
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
- [ ] Extract the shared `start` / `start:local` / `install-app` shell preamble into a
      single wrapper script (e.g. `scripts/run-with-logging.mjs`) so `log_dir`, `branch`,
      and `homey_id` derivation lives in one place instead of three near-identical zsh
      one-liners in `package.json`. Surfaced by gemini-code-assist on PR #818; deferred
      because three occurrences is still on the right side of premature abstraction and
      the wrapper would need to preserve `tee`-to-both-streams behavior and zsh-only
      parameter expansion (`${PWD:t}`).
      Files: `package.json` (scripts: `start`, `install-app`, `start:local`),
      `scripts/resolve-homey-id.mjs`.
- [x] Add an explicit cap on `DeferredObjectivePlanHistoryEntry.revisions[]` length.
      Surfaced by adversarial-review on v2.7.2 PR 1 (schema v3→v4). The in-memory
      `InProgressRecord.revisions` array is rebuilt with `[...existing, newEntry]` on every
      cycle that observes a new revision (`appendRevisionLogIfNew` in
      `lib/plan/deferredObjectives/planHistoryV4Helpers.ts`). Realistic runs see 5-10
      entries due to the active-plan recorder's per-cycle dedupe, so the persisted size is
      bounded in practice. A pathological replan loop (prices oscillate, `rate_refined`
      keeps firing) could push the array large; the rebuild path is O(n²) over the run.
      Shipped `MAX_REVISIONS_PER_ENTRY = 64` with a drop-oldest `.slice(-cap)` in the
      append path, mirroring `PROGRESS_SAMPLES_PER_ENTRY_CAP`. In-memory only — existing
      persisted entries with `<= 64` revisions load identically; no schema change.
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
- [x] markPoint tone-aware for the "Reached target" dot on the history-detail chart.
      Pinned the markPoint to neutral tokens (`--pels-status-on-good` fill +
      `--pels-text-primary` stroke via the existing `palette.text` field) so the marker
      stays legible if a future variant ever attaches `metAtMs` to a non-`good` hero tone.
      Threaded a new `statusOnGood` field through `Palette` / `resolvePalette` and applied
      it on both the original and revised-overlay `markPoint` configs.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      `packages/settings-ui/test/deadlinePlanHistoryDetail.test.ts`.
- [x] Test history-detail chart legend wrap at 320 px and bump `grid.top` if needed.
      Bumped `grid.top` from 44 → 60 px on both `buildHistoryDetailChartOption` (legacy)
      and `buildHistoryDetailTrajectoryOption`, mirroring PR 1's `containLabel: true`
      pattern. Added a 320 px Playwright probe in `charts-layout.spec.ts` that mounts a
      trajectory-mode entry (4-entry legend) and asserts the legend's bottom edge sits
      above the chart's first y-axis tick. Added unit tests pinning the new value on
      both option builders.
      Files: `packages/settings-ui/src/ui/views/DeadlinePlanHistoryDetail.tsx`,
      `packages/settings-ui/tests/e2e/charts-layout.spec.ts`,
      `packages/settings-ui/test/deadlinePlanHistoryDetail.test.ts`.
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
- [ ] v2.7.2/PR10 audit: `.deadline-page-close` (icon-only fixed X on the
      full-page deadline overlay) and `.settings-back-button` (M3 text button
      labelled "Back to devices" inside the slide-panel header) already consume
      the shared global tokens `--pels-touch-target-min` (touch target) and
      `--color-focus-ring` (focus ring) — no token consolidation was needed.
      The remaining differences (icon-only circular fixed-position chrome vs
      labeled in-flow text button) are intentional visual contracts. If a third
      close/back affordance is introduced and starts duplicating per-element
      `min-height` / `padding` / `border-radius` literals, revisit and extract
      a scoped `--pels-page-close-*` or `--pels-overlay-close-*` token group
      then. Source: PR10 owner-walk follow-up.
      Why P3: no defect; documented so a future reviewer doesn't re-open the
      consolidation question.
      Files: `packages/settings-ui/public/style.css`.

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
      - **Move `add_budget_exemption`'s thrown error string to shared-domain** (per
        `feedback_ui_text_shared_with_logs`) — pre-existing convention gap.
        `flowCards/deviceSettingsCards.ts` builds the message from a dynamic `label`
        (`` `${label} device must be provided` ``), so externalizing it needs a small
        formatter rather than a constant. (The `allow_smart_task_rescue` card's four
        thrown strings were moved to `packages/shared-domain/src/smartTaskRescueStrings.ts`.)
      - **Tests:** spy `rebuildPlan` to pin the idempotent no-op (no rebuild on an
        unchanged mode).
