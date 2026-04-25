# Overview redesign — continuation plan

Work is happening on worktree branch for a ground-up redesign of the settings
Overview panel. The original design plan lives at
`/home/olemarkus/.claude/plans/the-ui-is-very-indexed-sketch.md` — read it first
for context, goals, terminology map, and verification steps. This file tracks
what's **done**, what's **pending**, and the concrete order of operations to
finish the work.

## Invariants (do not violate)

1. **UI-text/log parity.** Every user-facing string lives in
   `packages/shared-domain/**` and is consumed by both the settings UI and
   runtime logging sites. See `notes/logging/README.md` and the per-module
   CLAUDE.md files. When you rename a chip label, the matching log line
   changes too — that's the point.
2. **Android/Material only.** No iOS/Apple interaction patterns. Max viewport
   480px; must still render at 320px. Dark theme, accent `#7fd1ae`,
   Space Grotesk font.
3. **Architecture boundaries.** `shared-domain` must stay browser-safe (no
   Homey SDK imports). `packages/settings-ui/**` cannot import `lib/**`
   directly — it goes through `packages/contracts` and `packages/shared-domain`.
4. **Starvation orthogonality.** Starvation is diagnostics metadata. It must
   *never* feed back into planner decisions. Only surface, never act.
5. **No free-text reasons.** Reasons come from `PLAN_REASON_CODES` and
   `formatOverviewStatus`, not ad-hoc strings.

## Status snapshot

### Done
- `packages/shared-domain/src/planStateLabels.ts` — `PlanStateKind`,
  `PLAN_STATE_LABEL`, `PLAN_STATE_TONE`, `resolvePlanStateKind`. Tests in
  `test/planStateLabels.test.ts` (passing).
- `packages/shared-domain/src/planHeroSummary.ts` — `formatHeroHeadline`,
  `formatFreshnessChip`. Tests in `test/planHeroSummary.test.ts` (passing).
  **Caveat:** still contains `"Holding load below the cap"` — needs the
  "cap" → "limit" sweep.
- `packages/shared-domain/src/planHourStrip.ts` — `formatHourStripLabel`.
  Tests in `test/planHourStrip.test.ts` (passing).
- `packages/shared-domain/src/planFormatUtils.ts` — `formatRelativeTime`
  moved out of `planMeta.ts`.
- `lib/plan/planService.ts` — overview events now emit `stateKind` and
  `stateTone`. **Issue:** `decoratePlanForOverview` is
  called on the plan passed to `applyPlanActions`, polluting actuation path.
  Breaks `test/planService.test.ts:3363`. Fix: only decorate at log/snapshot
  emit sites.
- `packages/settings-ui/src/ui/devices.ts` — `getDeviceClassMap()` exported.
- `packages/settings-ui/src/ui/dom.ts` — replaced `planList`/`planMeta`
  handles with `planHero`, `planHourStrip`, `planCards`.
- `settings/index.html` + `packages/settings-ui/public/index.html` — SVG
  icon sprite (5 symbols) + new overview skeleton.
- `settings/style.css` + `packages/settings-ui/public/style.css` — +356
  lines of new rules for hero/hour-strip/device cards.
- `packages/settings-ui/src/ui/plan.ts` — first-cut integration (571 LOC,
  over 500-LOC lint cap). Still contains the old 5-line-per-device helpers
  inline; needs split.

### Known breakage
- `test/planService.test.ts:3363` — `expect.objectContaining(steppedPlan)`
  fails because `decoratePlanForOverview` injects UI-only fields into the
  plan before `applyPlanActions` sees it.
- ESLint on `plan.ts`: file >500 LOC; `renderPlanHero` >30 stmts;
  `buildPlanCard` >30 stmts; one 123-char line; nested ternary; one
  `no-param-reassign`. Pre-commit hook fails.

## Order of operations

Work top-down. Each step leaves the tree in a buildable, test-passing state.

### Phase 1 — Stabilize (unblock pre-commit)

1. **Decouple `decoratePlanForOverview` from the actuation path.**
   - `lib/plan/planService.ts`: remove the calls at the pre-actuation sites
     (the line that feeds `applyPlanActions`). Only call the decorator where
     we emit overview events / snapshots / log payloads — never on the
     `DevicePlan` that `applyPlanActions` operates on.
   - Run `npm run test:unit -- --testPathPattern=planService`. Target is
     green without touching the assertion.

2. **Split `plan.ts` into three files** (resolves the 500-LOC + function-length
   warnings and matches the original design):
   - `packages/settings-ui/src/ui/planHero.ts` — `renderPlanHero`,
     `updatePlanHeroBinding`, hero-only helpers.
   - `packages/settings-ui/src/ui/planDeviceCard.ts` — `buildDeviceCard`,
     icon resolver, chip builder, tone + fill-bar math.
   - `packages/settings-ui/src/ui/plan.ts` — thin orchestrator: merge
     `getDeviceClassMap`, iterate devices, wire live bindings.
   - Delete the inline `buildPlanTemperatureLine` / `buildPlanPowerLine` /
     `buildPlanStateLine` / `buildPlanUsageLine` / `buildPlanStatusLine`
     helpers. They're the "5 labelled rows" the redesign removes.

3. **Delete `packages/settings-ui/src/ui/planMeta.ts`.** No importers after
   step 2. This also retires the stray `"Limited by capacity cap"` string.

4. **Run `npm run ci:checks`.** Must be zero warnings.

### Phase 2 — Design improvements (the `/frontend-design` critique)

Each of these lives in `planHero.ts` or `planDeviceCard.ts` from phase 1.

1. **Segmented hero bar** — replace the single progress bar + prose pills
   with a stacked bar: `managed` (accent) + `other` (dim accent) + `free`
   (empty). Soft-limit tick at 100% of `softLimitKw`; hard-limit tick at
   `(softLimitKw + hardCapHeadroomKw) / softLimitKw * 100%`. Overflow
   segment turns red when measured > soft. Widths via `flex-basis: %`.
   No chart library.

2. **Freshness chip top-right of hero.** Reads `powerFreshnessState` from
   `SettingsUiPowerStatus` (already fetched by `realtime.ts` — pass it as
   a second arg to `renderPlanHero`). Label via `formatFreshnessChip`:
   `Live` / `Delayed` / `No data`. Tone maps to `--accent` / `--warn` /
   `--muted`.

3. **Device card redesign** — three rows, never five:
   - Row 1: `[sprite icon] [device name]  [state chip] [optional starved badge]`
   - Row 2: measured/expected load bar, tiny tick for `expectedKw`
   - Row 3: single reason line from `formatOverviewStatus` (the real one,
     not the e2e stub).
   Full-opacity when Held/Resuming/Active; 70% when Idle/Manual; dashed
   outline when Unavailable.

4. **Real reasons from `formatOverviewStatus`.** The e2e stub at
   `packages/settings-ui/tests/e2e/fixtures/homey.stub.js:157,170` is the
   only source of the "Cheap hour, preheating" / "Approaching capacity
   cap" strings the screenshot showed. Delete those from the stub (or
   replace with realistic countdown-style reasons) and confirm the card
   reads from `formatOverviewStatus` output.

5. **Icon mapping.** `deviceClass` (from `getDeviceClassMap()`) → sprite
   symbol, with `controlModel` as fallback. Unknown class → `#icon-generic`.

6. **Countdown ring around the chip** for `remainingSec` (shed cooldown,
   restore backoff). Use a thin CSS conic-gradient ring; no SVG required.
   Reads from the existing cooldown data on the overview snapshot.

### Phase 3 — Starvation surfacing

Runtime has the data (`lib/diagnostics/deviceDiagnosticsService.ts:198-202`,
`getCurrentStarvedDeviceCount()` at `:497`, `app.ts:955`) but there is
**no contract path to the UI**. Build that path.

1. **Contract change** — add to the per-device overview payload
   (`packages/contracts/src/` — find the existing overview-device type and
   extend it, don't create a new one):
   ```ts
   starvation?: {
     isStarved: boolean;
     accumulatedMs: number;
     cause: 'capacity' | 'budget' | 'manual' | 'external';
     startedAtMs: number | null;
   };
   ```
   Only populate for managed temperature devices (thermostats, water
   heaters) per `notes/starvation/CLAUDE.md`. Binary loads (EV, etc.)
   must have the field absent, not `isStarved: false`.

2. **Wire runtime → snapshot.** `lib/diagnostics/deviceDiagnosticsService.ts`
   already tracks `starvedAccumulatedMs`, `starvationEpisodeStartedAt`,
   `starvationCause`, `isStarved` per device. Add a serializer method
   returning the contract shape; call it from the overview snapshot
   builder in `lib/plan/planService.ts` next to where device payloads are
   assembled.

3. **Shared-domain helpers** —
   `packages/shared-domain/src/planStarvation.ts`:
   - `formatStarvationBadge(starvation)` →
     `{ label: 'Starved 23m', tone: 'warn'|'info'|'muted', tooltip }`.
     Tone from cause: `capacity`→warn, `budget`→info, `manual|external`→muted.
   - `formatStarvationReason(starvation)` →
     `'Waiting for room to reopen — 23 min below target'` (replaces the
     normal reason line when `isStarved && cause === 'capacity'`).
   - `summarizeStarvation(devices)` → `'1 device below target'` | `null`
     for the hero subline (count only capacity-caused starvation).
   Tests in `test/planStarvation.test.ts`.

4. **UI integration** —
   - `planDeviceCard.ts`: if `starvation?.isStarved`, append badge after
     the state chip; if `cause === 'capacity'`, also swap the reason line.
   - `planHero.ts`: when `summarizeStarvation(devices)` is non-null,
     append a muted chip under the headline.

5. **Logging sites.** Search for `device_starvation_started` etc. in
   `lib/diagnostics/` and `lib/logging/`. Where we already log a
   human-readable message, switch to `formatStarvationBadge(...).label`
   so logs and UI stay word-for-word identical.

### Phase 4 — Terminology sweep ("cap" → "capacity"/"limit")

User explicitly rejected "capacity cap". Hunt remaining instances:

- `packages/shared-domain/src/planHeroSummary.ts` —
  `'Holding load below the cap'` → `'Holding load below the limit'`.
- `packages/settings-ui/tests/e2e/fixtures/homey.stub.js` — fixture
  strings containing "cap" (only if they're visible on-screen).
- `git grep -n 'capacity cap'` and `git grep -n 'hard cap'` across
  `packages/**`, `settings/**`, `lib/**`, `test/**`. Each hit needs
  review: user-facing → rename; internal identifier → leave alone.
- Update test fixture assertions that depend on old wording.

### Phase 5 — Verification

Runs top-to-bottom per original plan's section 9:

1. `npm run ci:checks` — zero warnings.
2. `npm run test:unit` — coverage ≥80%; new shared-domain modules each
   have their own test file.
3. `npm run test:e2e` — 480px viewport; update selectors off the removed
   `#plan-meta` and new device-card structure.
4. Visual QA with `npm run watch:settings` in a 480px viewport: fresh +
   under budget; fresh + over soft; stale_hold; fail_closed; a device in
   each of Active/Idle/Held/Resuming/Manual/Unavailable; one starved
   device.
5. Log-parity spot check — trigger each state, grep Homey log, confirm
   log state words match the chip verbatim.
6. 320px narrow check — no horizontal scroll.
7. `TODO.md` scan — line 68 tracks `deviceOverview.ts` wording. Fold in
   or explicitly defer.
8. PR description — flag that plan-state log phrasing changed (e.g.
   "Shed" → "Held") for anyone parsing logs downstream.

## Handy references

- Design target layout: plan at `/home/olemarkus/.claude/plans/the-ui-is-very-indexed-sketch.md`
- Design system tokens: `settings/tokens.css` (auto-generated; don't edit)
- Starvation invariants: `notes/starvation/CLAUDE.md`
- Logging invariants: `notes/logging/README.md`
- Architecture boundaries: `docs/architecture.md` + `.dependency-cruiser.cjs`
- Reason taxonomy: `packages/shared-domain/src/planReasonSemantics.ts`
