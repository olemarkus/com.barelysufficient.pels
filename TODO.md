# TODO

Only unresolved work belongs here. Completed items live in git history and tests, not in this
file.

## Entry Bar

**Every entry must be actionable.** An entry earns its place only if someone picking it up cold
could start today and know when it is finished. Every entry names three things:

1. **Where** — the file, function, or user-visible surface that is wrong.
2. **What changes** — the change to make, or the choice to rule on with its options written out.
3. **When it is done** — the observable result that closes the line.

P3 additionally states a **hypothesis**, **why it is needed**, and the **persona**
(`notes/personas.md`) it serves. An item that cannot name all three is a maintainability or
cosmetic chore: do it in passing or drop it.

These are not actionable. Resolve it now or delete it — do not park it here:

- **Open questions.** "Why did X happen?" is an investigation, not work. Investigate it and record
  the finding (in `notes/`, or as an entry that names the fix), or drop it.
- **Work waiting on outside evidence.** If it cannot start until production logs, a measurement, a
  vendor answer, or a user report arrives, the entry waits with the work. "Blocked on X" belongs in
  a PR description or a conversation. Waiting on *another entry here*, or on a code shape this repo
  controls, is different — that is sequenced work and it stays.
- **Undecided product calls.** "Decide whether X" is not work. Rule on it, then write the entry for
  what the ruling implies — or let it go.
- **Manual spot-checks.** "Verify it at 320 px", "check it on a real phone" — do the check, then
  file what it found. An unperformed look is not a backlog item.
- **Bare observations.** A design smell or a preference with no proposed change has no
  done-condition, and it will read later as a decided plan.
- **Speculative capability.** A feature whose shape is still a guess is a hypothetical plan.
- **Guards for problems that do not exist yet.** "No current bug", "benign today", "unreachable
  today" — if nothing is wrong now, the entry is a constraint on some future change, not work.
  Say so where that change will happen. An entry that argues the current shape is *sound* has
  already answered itself.
- **Completed work.** Delete it; git history and tests are the audit trail. Never leave `- [x]`.

Guidance that is genuinely durable — a constraint the next contributor must respect rather than a
change someone will make — belongs in the `AGENTS.md` or the code it governs, not here.

*Phantom-design items removed (2026-05-31 m3-critic merit pass): the
"Electricity-prices two-select contrast" and "inconsistent active-vs-history chart
styling" items were written against UI that no longer exists — there are zero
`md-outlined-select` in shipped markup (every select is the token-bound dark-themed
`md-filled-select`, and migrating would break `segmentedControl.ts`), and both
smart-task charts already share the palette tokens and are deliberately different
chart types, not two languages for one chart. Do not re-raise from the stale
live-walk screenshots.*

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

## Shed and restore control

## Smart tasks



- [ ] **Latch `currentHourClaim` for the hour instead of recomputing it through the whole `:58`
      window.** `isPastHourSettleMark` is true from `:58:00` to `:59:59`, so the fresh allocator,
      and with it the claim, runs on every cycle in that window
      (`taskEvaluationCoordinator.ts`; ~12 cycles under `homey_energy`, more and irregular under
      `power_source = flow`). The recorder writes the hour's plan at most once
      (`activePlanRecorder.ts`), so for those two minutes the plan it saved and the claim the
      device follows can differ. Neither direction is damped: a lifecycle release starts no restore
      back-off (`currentHourClaim.ts`, `shedReleaseActuation.ts`). Mid-hour price deferral moving
      the claim every cycle is by design (`trajectoryMilestone.ts`) and stays. **What changes:** the
      recorder takes the hour's slot on its first fresh pass at or after the mark, whether or not it
      writes, and exposes it through `TaskEvaluationSource`; the rest of the window follows that
      slot instead of `isPastHourSettleMark(nowMs)`. This reverses the recorder comment that
      recomputes through the window, and a change that lands late in the window waits for the next
      `:58`. **Done when** a claim resolved at `:58:00` is the one served at `:59:50`, pinned in
      `test/e2e/smartTaskHourBoundarySdkE2E.test.ts`. Source: pels-runtime-reality on PR #2059. [P2]

- [ ] **Smart-task preview keeps a missing committed task reserved after the live grace expires.**
      *Persona:* owner previewing a lower-priority task after a higher task's device has stayed
      unavailable for more than an hour. *Hypothesis:* lifecycle and planner decoration own
      stateful `PriorityAllocationTracker`s and release the missing task after
      `ELIGIBILITY_ABANDON_GRACE_MS`, while preview calls the batch diagnostics without a tracker;
      its active-plan fallback therefore remains reservation-eligible until the commitment is
      otherwise cleared. The preview is conservative and cannot actuate, but can understate the
      candidate's feasible schedule after the live controller has moved on. Expose a read-only
      grace classification from a clock-owned in-memory roster (never persist the derived order),
      then add a post-grace preview-parity regression. Source: pels-runtime-reality review of
      the relative-priority PR, 2026-08-08. [P2]

- [ ] **"Power on the way" after a rescue ignores whether the house is at its power limit.**
      *Persona:* Optimiser (`notes/personas.md`) who taps `Let it run now` on a held-back device.
      *Hypothesis:* the confirmation picks "Power on the way" from whether the current hour is
      scheduled alone (`setup/settingsUiStarvationRescueApi.ts`,
      `widgets/starvation_rescue/src/api.ts`), and ignores `estimate.atPowerLimitNow`, which the
      preview already resolves (`planPreview.ts`). A device the rescue cannot start right now
      because the house is at its limit is promised power that does not come. The settings-UI
      confirm (`PlanDeviceCards.tsx`) also lacks the at-limit note the widget shows
      (`widgets/starvation_rescue/src/render.ts`). The grant itself is not empty: the budget
      exemption still matters if the budget binds during the three-hour window, and the gate lives in
      `lib/objectives/deferredObjectives/limitGrantGate.ts`. **What changes:** one shared-domain
      helper decides "runs now" as current hour scheduled AND not at the power limit, and both
      surfaces read it; at the limit they say "Running as soon as there's room", and the settings-UI
      confirm shows the at-limit note. **Done when** a rescue preview at the power limit flashes the
      waiting line on both surfaces, pinned in `test/integration/settingsUiStarvationRescueApi.test.ts`
      and `starvationRescueWidgetApi.test.ts`. Do it after PR #2911, which reworks the settings UI's
      rescue gate. Source: adversarial review, 2026-08-04. [P3]

- [ ] **Move the settings-UI edit lane and the create_smart_task widget onto lib-owned request lanes.**
      *Persona:* contributor changing how a smart task is previewed or saved.
      *Hypothesis:* the settings UI's create lane is decided in
      `lib/objectives/deferredObjectives/smartTaskCreateLane.ts` and `setup/` only binds its
      ports, but the edit lane (`previewSettingsUiSmartTask`, `updateSettingsUiSmartTask`,
      `gateEditableTask` in `setup/settingsUiSmartTaskApi.ts`) and the widget
      (`previewCreateSmartTask`, `createCreateSmartTask` in `widgets/create_smart_task/src/api.ts`)
      still run the parse, gate, scope, deadline and candidate sequence themselves, with SDK clock
      and settings reads in `setup/`. Three copies of one sequence drift. The candidate
      validation both creates share (`resolveValidatedObjectiveEntry` behind
      `createDeferredObjective` and `createNewDeferredObjective` in `setup/appSmartTaskApi.ts`)
      also lives in `setup/`.
      *Closing change:* lib lane functions for edit and widget create next to the create lane,
      taking the same ports; `setup/` and the widget's `api.ts` only bind ports and forward.
      Done when neither file reads `homey.clock`/`homey.settings` or classifies a request, and
      `appSmartTaskApi.ts` only forwards to an objectives-owned create.
      Source: layering review of the smart task creation PR, 2026-10-13. [P2]

## Multi-home and meter areas

- [ ] **A silent meter AREA has no staleness indication: the no-readings banner speaks only for
      Main.** The banner (`packages/shared-domain/src/powerReadingsBanner.ts`, fed by the
      deliberately Main-only `getPowerReadModel` in `packages/settings-ui/src/ui/power.ts`) is the
      one staleness surface after the freshness chip's removal, and before that removal a silent
      area still surfaced through the scoped hero's chip. Past the shed timeout the scoped hero
      renders NOTHING for an unmeasured cycle (`PlanHero.tsx`, owner ruling: no computed figure is
      drawn), so a silent area shows only `Limited` cards under no banner and no hero. The per-area
      power read already carries that area's readings fact (`setup/settingsUiApi.ts`, read in
      `usagePowerRead.ts`). **What changes:** while an area is the active home scope, the banner
      reads that area's readings fact and names the area in its hint. **Done when** silencing an
      area's meter for >60 s shows the banner on that area's scope while Main stays fresh, pinned by
      a UI test. *Hypothesis:* an owner whose rental-unit meter drops out sees its devices held with
      no explanation and reads it as PELS being broken. *Persona:* the multi-home owner. [P2]

## Prices

- [ ] **Under `power_source = flow`, a price-level change waits for the next meter reading.** The
      `price_level` Flow trigger and the `pels_insights` level capability are written by
      `PlanStatusWriter.update`, which runs only on a plan rebuild. The first reading in each new
      planning period always rebuilds (`lib/plan/rebuildScheduler/policy.ts`), so under
      `homey_energy` the level publishes within one poll. Under `power_source = flow` readings
      arrive on the owner's Flow, so a level change waits for its next report, and a quiet Flow can
      delay it past a 15-minute period or skip that period's trigger altogether (the comments in
      `planStatusWriter.ts` and `lib/price/priceLevelUtils.ts` say so). **What changes:** give the
      level its own publication on the price-period clock that does not go through a plan rebuild;
      an extra rebuild purely to publish a level changed shed depth in
      `test/e2e/temperatureControlDisabledSteppedShedSdkE2E.test.ts` when tried. **Done when** a
      level change reaches the trigger and the insights capability on a flow-fed home without a
      reading in between, and that e2e's shed ladder is unchanged. *(Codex review on #2434,
      2026-09-17.)* [P2]

## Device observation and transport

- [ ] **The zone tree is refetched on every snapshot refresh — 538 Homey round-trips per 12 h for
      an answer that changed zero times.** `refreshZoneTreeCache` (`lib/device/transport/snapshotRefresh.ts`)
      fetches `manager/zones/zone` at the tail of every `refreshSnapshot`, roughly every 80 s. In the
      sampled production window every one of the 538 answers was `zonesTotal: 29,
      droppedEntries: 0`. A stale tree is mostly harmless now: a device that moves into a zone the
      tree lacks is held out of every home (`isDeviceZoneUnknown`, owner ruling 2026-10-24) and the
      move itself refetches the tree (`refreshZoneTreeIfUnknown`). Two readers still need a fresh tree
      before the fetch can move onto an interval: a zone re-parented with no device moving, which
      only the next fetch shows, and the Multiple meters editor, whose zone picker and save checks
      read the cached tree (`getDiagnostics().zoneTree` in `setup/settingsUiHomesApi.ts`), so a zone
      created in Homey just before opening the editor would be missing. **What changes:** fetch on
      an interval (and at boot) instead of every refresh, have the `ui_homes` read refetch the tree
      when the editor opens, and skip the fetch entirely while no meter area exists. **Done when**
      zone fetches per 12 h are down by at least an order of magnitude and a zone created just
      before opening the editor is offered in its picker. Source: Codex P1 on PR #2252, 2026-08-31.
      [P2]

## Settings UI surfaces and copy

- [ ] **Limits & safety: converge the Main-home form onto the native `.pels-input` field language.**
      *Persona:* multi-home owner who switches the shell's home scope bar between the Main home and a meter
      area. *Hypothesis:* U3 added the per-home editor using native `.pels-input` + unit-in-label ("Hard cap
      (kW)"), which follows the canonical form-styling + ui-terminology rules and matches the U1 homes editor;
      the legacy Main-home static form (`#settings-limits-form`) still uses `md-filled-text-field` with an
      in-field `suffix-text="kW"`, so flipping the scope morphs the identical two inputs (filled↔outlined,
      unit relocates). Kept out of U3 to preserve byte-identical Main behavior. Migrate the Main form to the
      native primitive (the design-system-unification direction) so both scopes read as one control. Source:
      pels-m3-critic review of the U3 per-home Limits surface, 2026-07-20. [P2]

- [ ] **Settings-UI structural consolidation train (deferred by the 2026-07 coherence review).**
      A designed, not-yet-executed train that unwinds the two-rendering-paradigms mess within the
      approved map `notes/settings-ui-semantic-map.md`. Order: shared Preact primitives in
      `src/ui/views/components/` — `Chip` (absorb `views/chipModifier.ts`, `usageHero.ts`
      `CHIP_TONE_CLASSES`, `BudgetOverview.tsx` `deltaChipClass`; canonical tone set, migrate `ok`→
      `good`, then drop the CSS alias) → `SegmentedControl` (extract `ToggleGroup` from
      `BudgetOverview.tsx` + the roving-tabindex keyboard model from `segmentedControl.ts`) →
      `Card` (fix the `budget-redesign-card` misuse in `DeadlinePlan.tsx` and `WeatherInsight.tsx`) → `Hero` (the four Preact
      heroes; unblocks future hero-content work) → `DeviceRow` scaffold (from
      `PriceAwareDevicesView.tsx`) — then imperative→Preact migrations: Usage hero (kills the last
      static-HTML hero in `index.html`) → Usage day view (deletes `createToggleGroup`, segmented
      impl 2/3) → Devices list (converges `buildRedesignDeviceRow`, rides the toggle-ring-contrast
      P2) → device-detail overlay slice-by-slice (Power-limiting slice first: rehome the hidden
      `md-filled-select` state store in `deviceDetail/shedBehavior.ts` + `index.html`, deleting
      `segmentedControl.ts`, segmented impl 3/3) → Modes (Sortable.js needs an imperative island) →
      Advanced. One surface/primitive per PR, screenshot-gated on convergence. Done when
      `views/chipModifier.ts`, `segmentedControl.ts`, `createToggleGroup` and
      `buildRedesignDeviceRow` are deleted and the `ok` chip tone alias is gone. Persona:
      contributor velocity + Set-and-forget owner (visual coherence); hypothesis: three segmented
      impls / two device rows / per-file chip vocab is where per-page drift keeps re-entering. [P2]

## Standalone web app

Design-of-record: `notes/web-app.md`.

- [ ] **`/ui_starvation_rescue_devices` has no caller.** `api.ts`, `.homeycompose/app.json`,
      `setup/settingsUiStarvationRescueApi.ts`, `SETTINGS_UI_STARVATION_RESCUE_DEVICES_PATH` in
      `packages/contracts/src/settingsUiApi.ts`. The Overview's rescue gate rides the plan
      (`rescuableDeviceIds`), and the rescue widget reads the app directly. Kept so the release that
      moved the gate changed no route. **What changes:** the next release that changes `app.json`
      anyway removes the route, its handler, the path constant and the mocks' handlers.
      **Done when:** nothing in the repository names the route. [P2]

## Diagnostics, logging and alerts

- [ ] **The sustained hard-cap card's in-app hint omits the flow-source reporting requirement.**
      With `power_source = flow` and samples arriving less often than once a minute, every
      sustained run ends `evidence_stale` (`lib/power/capacityShortfallAlertDispatch.ts:374`, 60 s
      freshness bound), so thresholds of 120–600 s silently never fire during a genuine breach.
      docs/flow-cards.md documents the once-a-minute requirement; the card hint does not. Either
      add the caveat to the compose hint, or have the guard republish a heartbeat candidate while
      the condition stays evidenced with a fresh-by-flow-standards sample. Source: 2026-08-02
      release review, pels-runtime-reality + budget/alerts adversarial pass. [P2]

## Architecture and tooling debt

- [ ] **`npm run setup:stateless` does not catch state held in a `setup/` factory's closure.**
      `scripts/check-setup-stateless.mjs` counts module-level and class declarations, so a factory
      that reassigns a closure `let` holds runtime state the guard cannot see — the plan-shortfall
      gate did exactly that until it moved to `lib/power/capacityShortfallSideEffectGate.ts`. A scan
      on 2026-10-23 found 15 reassigned closure `let`s in 10 `setup/` files (at least one,
      `setup/homeRuntime/wireHomeMembership.ts`, is per-call state, not factory state). **What
      changes:** teach the guard to flag a closure `let` that a nested function reassigns inside a
      `setup/` factory, seed the current sites into `scripts/setup-stateless-allowlist.txt` (gone since
      the last stateful setup file migrated; the guard reads it again once it exists), and exempt
      per-call locals. **Done when:** the guard fails on a new reassigned closure `let` in a
      `setup/` factory and the allowlist names each existing one. [P2]

- [ ] **P1 — the remaining history keys still ride `homey.settings`, and every write of any key
      pays for all of them.** The SDK's `ManagerSettings.set` ships the ENTIRE settings object to
      core on every write of any key (`notes/settings-key-ownership.md` § "Which store"), so each
      write costs what the whole object weighs. The power tracker (`lib/power/trackerStore.ts`),
      the weather history (`lib/weather/weatherHistoryStore.ts`), the smart-task plan history
      (`lib/objectives/deferredObjectives/planHistoryStore.ts`), the device diagnostics
      (`lib/diagnostics/deviceDiagnosticsStateStore.ts`), the price caches
      (`lib/price/priceCacheStore.ts`), the daily budget's plan and learned profiles
      (`lib/dailyBudget/dailyBudgetStateStore.ts`), the per-step power calibration
      (`lib/device/devicePowerCalibrationStore.ts`), the EV car-link probe
      (`lib/device/evCarLinkStore.ts`) and the learned power peaks
      (`lib/device/learnedPowerPeakStore.ts`) moved to the userdata store
      (`lib/store/userdataDatabase.ts`). The learned solar forecast's generation history
      (`lib/solar/pvForecastStateStore.ts`) and when PELS last controlled each device
      (`lib/plan/lastControlledStore.ts`) followed. One has not: `deferred_objective_active_plans`
      (`setup/appInit/deferredRecorders.ts`; the settings UI reads it live through a settings
      event, so its move replaces that with an `api.realtime` push). The size is what
      matters, because the small live latches stay in settings by ruling and keep writing:
      measured on production on 2026-09-26, `deferred_objective_observation_watermark` writes 12
      times an hour (`setup/appInit/deferredRecorders.ts`).
      Change: one repository per family beside its domain, taking the
      open database (the tracker and weather stores are the pattern: rows or one JSON row per
      event, diffed writes, the legacy key imported once at boot through
      `lib/store/legacySettingsImport.ts` and unset, and the settings UI served through `api.js`).
      Done when that key is not left in
      `GET /api/manager/apps/app/com.barelysufficient.pels/setting` on the production Homey, which
      leaves about 16 kB of configuration and live latches. Count writes by diffing successive reads of that endpoint, not with
      the `settings_set.*` perf counter, which covers only `capacity_in_shortfall`.

- [ ] **Each power limit is a loose nullable, and readers re-derive which nulls mean "off".**
      The capacity, grid and daily axes and the binding limit travel as separate `number | null`
      fields: `PlanLimits` (`softLimit`, `softLimitSource`, `capacitySoftLimit`,
      `gridImportLimitKw`, `gridImportTargetKw`, `dailySoftLimit`, `budgetPaceKw`,
      `projectedExemptKw`; `lib/plan/planContext.ts`), `MeasuredPower` (`headroomKw`,
      `capacityHeadroomKw`, `gridHeadroomKw`, `budgetHeadroomKw`) and the plan meta
      (`PlanMetaBase`, `lib/plan/planTypes.ts`). The binding limit and its source are two fields
      that must agree, and about 90 branches in `lib/plan` re-ask the posture from these nulls
      (`grep -rnE '\?\? null|=== null|!== null' lib/plan | grep -iE 'limit|headroom|pace|threshold|target|source'`).
      **What changes:** resolve each limit once in `buildPlanLimits` as
      `{ kind: 'off' } | { kind: 'on', ... }` (capacity: pace and shortfall threshold; grid: limit
      and target; daily: pace composition) with one
      `binding: { kind: 'none' } | { kind: 'bound'; source; kw }` replacing `softLimit` +
      `softLimitSource`; derive `MeasuredPower`'s per-axis headroom from those objects, and
      project the meta and wire fields from them in `buildPlanMetaBase` only.
      **Done when:** `PlanLimits` and `MeasuredPower` carry no nullable limit or headroom field,
      the planner reads no `softLimitSource`, and the grep above finds no limit-posture null
      branch in `lib/plan` outside the meta projection. [P2]

## Closed trains and historical notes

*Prior P0 closures shipped on the v2.9 train via PRs #975, #977, #978, #980,
#982, #983; surviving follow-ups demoted to P1/P2.*

*The 2026-07-25 release-review cleanup closed the prior P0 set: it partitioned realtime reconcile
work by home, finite-gated saved meter-area limits, and corrected the Main-meter setup guide.
Remaining multi-meter work is tracked as P1/P2/P3 follow-up.*

*"Drift detection reads device state from the plan layer" closed 2026-08-21 across four PRs: the
plan-to-plan predicate was proved settle-only and sealed behind an AST guard; the commanded axis
and the device's rung attestation moved to `lib/executor` / `lib/observer`; drift now reads the
observation from the observer and the command state from the executor's own stores, qualified by
the observation revision the plan was built from; and `observedBinaryState` split into
`observedBinaryAxis` and `observedEffectiveOn`, one meaning each on every construction path.*

*v2.9.0 closeout and v2.8.x release-review follow-ups. These are safe for
patch releases, not release blockers; each item carries its own source/date.
(The v2.8.0 card-title rename landed in PR #934.)*

*The bulk of the P1 backlog shipped in the 2026-06-03 reconciliation train (PRs #1450–#1461):
insights mode-options coalescing, headroom over-cap overage, the history-detail title/link fixes,
deviceOverview canonical-string routing, the flow-reported / pendingBinaryCommands /
stepped-restore-wrapper / stepped-swap-completion refactors, the settings.test.ts flake, the
plan_budget truncation, the starvation confirm-sheet sub-parts, and the shared widget runtime.
(What that train left open is tracked in the theme sections.)*

*P1 targeted refactors (deferred): concrete, bounded changes to specific named surfaces — not
structural re-splits, which stay P2.*

*Hard-cap trajectory rekey follow-ups (2026-07-06 review findings; the rekey itself — "Above hard
cap" keyed to projected hourly energy instead of instantaneous kW — shipped with its P0/P1s fixed).*

*v2.11.0..HEAD release-review findings (2026-06-02). Non-blocking follow-ups. The solar gross/net
split follow-ups from this batch are fixed by the solar-accounting follow-up.*

*Chart-overhaul train review follow-ups (2026-06-11, PRs #1677–#1681). Non-blocking.*

*Smart-task controller extraction (2026-05-30 → PR-E #1338): COMPLETE. The planner knows nothing
about smart tasks — `no-plan-to-smarttasks` is `error` and green. Design of record:
`notes/state-management/deferred-objective-lifecycle-carveout.md`. Its remaining follow-ups are
non-blocking.*

*Persona grouping retained from the former P3 section: smart-task failure-investigation & live UX
serves the underserved Optimiser and the Failing-scenario (acute/recovering) visitors
(`notes/personas.md`).*

*Persona grouping retained from the former P3 section: EV charging serves the Optimiser / EV
commuter (`notes/personas.md`).*

*Demoted from P2 (2026-06-03 scrutiny pass) — real product / future-capability work with a
persona but no current support-cost pressure; reframed to the P3 bar.*
