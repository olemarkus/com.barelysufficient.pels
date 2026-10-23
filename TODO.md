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

- [ ] **A `turn_off` stepped device whose profile has no zero-power step can never be fully turned
      off.** `getSteppedLoadOffStep` returns null for such a profile and
      `getSteppedLoadLowestStep` then answers the lowest ACTIVE step, so both the shed ladder
      (`buildSteppedShedDescentTargets`) and materialization
      (`resolveSteppedLoadDirectShedStepId`) bottom out at a step that still draws. If a stale
      measurement makes every active-step delta price at zero, the device is skipped entirely even
      though it exposes a writable `onoff` and turning it off would release its measured draw.
      Pre-existing — the pre-descent code reached the same outcome — and NOT fixed by routing to
      `buildPreparedSteppedBinaryOffCandidate`, whose precondition
      (`targetStep?.id === device.selectedStepId`) cannot hold while the device sits above its
      lowest step. The real fix is a binary-off terminal on the ladder for a `turn_off` device
      whose profile lacks an off step. Narrow: every profile PELS generates (native Høiax wiring,
      EV target-power) carries an explicit `off` step, so this needs a hand-configured profile.
      Source: Codex review of PR #1996, 2026-08-06. [P2]

- [ ] **Bound the startup reservation on time spent HOLDING, not wall-clock since first sighting.**
      `resolveCycleHeadroomReserves` runs at the top of `applyRestorePlan` (`lib/plan/restore/index.ts`),
      so `HEADROOM_RESERVE_MAX_MS` burns during every window in which the reserve enforces nothing:
      `guardInShortfall`, active overshoot, shed cooldown (60 s), restore
      cooldown (60–300 s), startup stabilization. *Hypothesis:* a capacity-tight hour with three
      shed/restore cycles can consume most of the 15 minutes without the reserve ever holding a
      device back; the home then calms, a real contiguous block appears, and the reserve has already
      lapsed — the exact out-competition the feature exists to stop. Worse in `power_source = flow`,
      where a 20-minute sample gap can consume the entire window in one go. Fix: advance the clock
      only on the `armed` outcome, or record held-cycles rather than a start timestamp. *Persona:*
      owner with an EV charger on a smart task in a busy home. Source: pels-runtime-reality on
      preemptive-power-reservation, 2026-08-01.
      **Includes the re-arm half.** A reservation that lapses mid-window can never re-arm even if
      the blocking load disappears, because only a genuine start clears the stamp in
      `resolveReserveForDevice`. Allow re-arm after a cool-off, or key the lapse to the planned
      bucket. Done when both the bound and the re-arm are covered. *P2*

## Smart tasks



- [ ] **Latch `currentHourClaim` for the hour instead of recomputing it through the whole `:58`
      window.** `isPastHourSettleMark` is true from `:58:00` to `:59:59`, so the fresh allocator —
      and with it the claim — runs on every cycle in that window (~12 in `homey_energy` mode, more
      and irregular under `power_source = flow`). The two-clock design says a control decision moves
      only at the settle; this is the one seam where it can move repeatedly within one. The
      asymmetry is what makes it worth closing: `released` fires a lifecycle release with no
      cooldown gate, while `claimed` can only re-admit through the 60-300 s restore cooldown, so
      an alternation is not symmetric churn. Resolve the claim once on the first fresh pass at/after
      the mark and reuse it for the rest of the window, the way `cheaperHourAhead` is stamped once
      at the booking revision. Also covers the no-commitment case, where no frozen fallback exists
      and the fresh path runs every cycle for the whole hour. Source: pels-runtime-reality on
      PR #2059. [P2]

- [ ] **Smart-task diagnostics: distinguish an active meter source from a missing device before its deadline.**
      *Persona:* owner who selects a device with an existing smart task as an electricity meter.
      *Hypothesis:* the source-filtered lifecycle device set omits the meter, so the still-enabled task
      reports `objective_missing_device` until deadline handling safely disarms it without a command.
      The reason-bearing durable-exclusion seam this asked for now exists —
      `ResolveObjectiveDeviceExclusion` (`lib/objectives/deferredObjectives/deviceExclusion.ts`), resolved
      by `resolveSmartTaskDeviceExclusion` (`setup/appInit/smartTaskHomeScope.ts`) and already carrying
      `sub_home` and `unmanaged`. What remains: add a `meter_source` arm with its own diagnostic code and
      copy, and answer it from that resolver, so status/history explain the task's real scope before it
      ends. Source: runtime-reality review of PR #1873, 2026-07-23.
      **Two new arms are required, not one.** A meter-source exclusion and an automatic
      power-capability demotion are independently observable states, so `ObjectiveDeviceExclusion`
      (today `'sub_home' | 'unmanaged'`) needs a member for each, with its own reason code and copy;
      otherwise the resolver cannot tell which explanation to show. The demoted case is
      `applyFalseOverrides` (`setup/appDeviceSupport.ts:92`) pointing the owner at a disabled Managed
      toggle. Done when both arms and both mappings exist. [P2]

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

- [ ] **A rescue on the lowest-priority device can grant nothing and still report success.**
      *Persona:* Optimiser (`notes/personas.md`) who taps `Let it run now` on a held-back device.
      *Hypothesis:* now that the rescue is offered on both axes, a device that is capacity-held AND
      bottom-priority AND binary can end up with an empty effective grant:
      `gateCandidateExtraPermissions` (`setup/appSmartTaskApi.ts`) drops `limitLowerPriorityDevices`
      for binary devices, `pauseLowerPriorityDevices` has nothing below it to pause, and
      `exemptFromBudget` is inert when the budget is not what binds. The user confirms, gets the
      `Power on the way` flash, nothing changes — and the device is now un-rescuable because it has a
      smart task.
      *Why it's needed:* a money-action confirm that provably cannot help is the one thing the rescue
      confirm sheet exists to prevent. Fix direction: compute the effective grant set server-side
      before the confirm and surface an honest "this will not free power for this device" state, or
      fall through to `rescueDoneQueued` framing. Source: adversarial review, 2026-08-04. [P3]

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

- [ ] **Area rules refuse on save instead of guiding in the editor — and a one-meter home can cycle
      between two of those refusals with no diagnosis.** The name-length cap, the reserved "Main
      home" name, the eight-area cap, and the whole-home-meter requirement are enforced at the
      `ui_homes_save` seam and surface as a toast after a round trip; only non-emptiness and
      uniqueness are pre-checked inline by `validateSubHomeDraft`. The editor should carry a
      `maxlength` on the name input, an inline error for the reserved name, a disabled "Add meter
      area" button at the cap, and an inline main-meter refusal from the `shouldPromptMainHomeMeter`
      predicate `homesSettings.ts` already evaluates for the notice. Held out of the enforcing PR
      because `SubHomeDraftError` and `HomesSettingsSection.tsx` were owned by a concurrent branch;
      the server rules were deliberately scoped to the entry being written so `validateDraftName`
      can absorb them unchanged (the two validators this shares a fix with).

      *The case the missing guidance leaves worst off:* an area needs its own meter and the Main home
      needs its own, so a home whose Homey Energy report lists a single meter cannot use meter areas
      at all. Today it discovers that by bouncing between two refusals — saving an area refuses with
      `main_meter_required`, and assigning that one meter to the Main home makes the area editor
      refuse inline with "'Main home' already uses this meter". Both rules are correct, so the fix is
      a diagnosis line, not a relaxation of either: detect "no report meter is assignable to the Main
      home" on the Multiple meters page and say so.

      Personas: owner who types a long or reserved name and only learns on save; owner with a single
      HAN meter who tries to add a rental. Source: multi-home finishing train, area-config invariants
      PR. [P2]

## Prices

- [ ] **The Power by the Hour source drops the export price it is handed.** The app's
      `/dap-prices` slots carry `exportPrice` beside `importPrice` (verified against 8.19.0 on SHS),
      and `resolveSlot` (`lib/price/powerhourPriceFetch.ts`) reads only the import half. A prosumer
      on this source therefore gets the weakest feed-in configuration on the page: the spot-share
      field is Norway-only (`hasSpotPrice` in `ElectricityPricesView.tsx`) and the **Where the price
      comes from** selector offers Homey Energy only (`export_price_source`), so they are left with
      a flat manual amount while the source they chose publishes the real number per period.
      Change: carry `exportPrice` through the adapter into the stored periods, add `power_by_the_hour`
      to `ExportPriceSourceSetting` (`packages/shared-domain/src/settings/exportPriceSource.ts`), and
      teach `applyExportPrices` to take a GIVEN per-period export price rather than always deriving
      one from spot — today every source derives it, which is why this is more than a field read.
      Done when a home on this source with export pricing on shows the app's own feed-in price on
      the Budget tab's "Export price now", and the planning price follows it. [P2]

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

## Daily budget and weather

- [ ] **A budget-axis restore rejection is attributed as capacity pressure when
      `softLimitSource` is 'capacity'.** With an off exempt device projecting, the binding source
      can read 'capacity' (`budgetPaceKw + projectedExempt > capacityPace`) while the per-axis
      ledger rejects a non-exempt candidate on the MEASURED budget axis
      (`budgetPaceKw + measuredExempt < capacityPace`). `budgetReleasableHeadroomHold` derives
      from the binding source, so the hold keeps the numeric headroom framing and the budget
      rescue is not offered even though the budget is the axis doing the work. Fix direction:
      re-key hold attribution per axis at the rejection site (the ledger knows which axis bound),
      not off the collapsed binding source — the same catch-up the reason fold got for exempt
      candidates. *Persona:* daily-budget home with an off exempt charger and held thermostats.
      *Hypothesis:* needs projected>measured AND the projection large enough to flip the argmin;
      display-only harm (wrong framing, missing rescue offer). Source: Codex review on PR #1956 +
      pels-layering-guardian corner (b), 2026-08-02.
      **Absorbed from the merged admission item, the same flag's opposite face.** It is also a false
      POSITIVE: where capacity sits between the budget pace and the candidate's restore need
      (capacity pace 5 kW, draw 4 kW, daily pace 4.5 kW, need 1.2 kW) the held-back widget offers
      "Let it run now" and the release still leaves the restore blocked, handing the owner a dead
      lever. Deriving attribution per axis at the rejection site closes both faces. [P2]

- [ ] **Weather: a location-aware hint when MET can't be reached for lack of geolocation.**
      *Persona:* Orchestrator (`notes/personas.md`) who turned the feature on but never set the
      hub's location, so the forecast silently runs on recent days.
      *Hypothesis:* the no-geolocation case is currently folded into the generic `recent_days` copy
      (`Forecast unavailable — showing what recent weather suggests.`), which doesn't name the one
      fix the owner controls — setting the Homey hub location — so a fixable miss reads as an
      unexplained fallback.
      *Why it's needed:* a no-location-specific source line (e.g. naming the Homey location setting)
      would turn a permanent silent fallback into a one-tap fix. Out of scope for the picker-removal
      PR (would need a producer-resolved no-geolocation `forecastStatus` arm + copy). Source: PR 2
      MET UI-cleanup scope decision, 2026-06-14. [P3]

## Device observation and transport

- [ ] **P2 — the one persisted actuation clock sits outside the abandon-grace regime.**
      `DEVICE_LAST_CONTROLLED_MS` is hydrated by `setup/appServiceWiring.ts` and
      `setup/homeRuntime/createHomeCapacityBundle.ts` as `isNumberMap(stored) ? { ...stored } : {}` and
      written back bare by `setup/homeRuntime/homeSignalWriters.ts`, so one transient SDK miss at
      boot lands as `{}` and the first shed or restore afterwards persists a one-device map over the
      stored history. The map gates the startup-window hold (`planReasonsHoldDecisions.ts`
      distinguishes "never controlled" from "controlled before") and the restore stabilization reads.
      Change: route the key through the written-before-marker/grace wrapper
      `notes/persisted-settings-state.md` prescribes for persisted history, with the hydration
      landing on `ActuationRecord.loadLastControlled`. Done when a spec whose boot `settings.get`
      answers `undefined` once with the marker set, followed by a shed, asserts the persisted map
      still holds the prior devices. Source: runtime review of the actuation-record state layer,
      2026-09-08.

- [ ] **The zone tree is refetched on every snapshot refresh — 538 Homey round-trips per 12 h for
      an answer that changed zero times — and the obvious fix (a refresh interval) is unsafe as
      written.** `refreshZoneTreeCache` (`lib/device/transport/snapshotRefresh.ts`) fetches
      `manager/zones/zone` at the tail of every `refreshSnapshot`, roughly every 80 s. In the
      sampled production window every one of the 538 answers was `zonesTotal: 29,
      droppedEntries: 0`.

      An interval alone reintroduces a correctness window, which is why the one added in PR #2252
      was taken back out. Once ANY tree has committed, the multi-home actuation fence is open, and
      `zoneAncestryPath` treats a zoneId missing from the cached tree the same as a broken parent
      chain: `resolveDeviceHome` answers `{ homeId: MAIN_HOME_ID, source: 'fallback' }`
      (`lib/home/membership.ts`, pinned by `test/unit/homeMembership.test.ts` "an unknown device
      zone resolves to main"). So a device moved into a zone the stale tree has never seen is
      planned and actuated by Main against the wrong meter for the length of the interval. Homey
      publishes no zone event to correct it — the SDK ships no zones manager, and the realtime
      feed subscribes only `homey:manager:devices` — so nothing shortens that window on its own.

      **Where:** `refreshZoneTreeCache` in `lib/device/transport/snapshotRefresh.ts`,
      `ZoneTreeCache` in `lib/device/transport/zoneTreeCache.ts`, and the fallback arm of
      `resolveDeviceHome` in `lib/home/membership.ts`.

      **What changes — rule on one of these:**
      (a) *Make staleness self-correcting, then add the interval.* Mark the cache due when a
      `device.update` reports a zoneId absent from the tree. `notifyDeviceZoneChangeContained`
      (`lib/device/transport/deviceUpdateHandling.ts`) already computes the zone delta and holds
      `ctx.zoneTreeCache`, so this needs no new plumbing and no `lib/device` → `lib/home` edge.
      Covers a device moving into a new zone; does NOT cover a zone reparented with no device
      moving, because no device's `zoneId` changes then.
      (b) *Make staleness harmless, then add the interval.* Hold an unknown-zone device out of
      actuation instead of falling back to Main. Removes the wrong-meter window by construction,
      at the cost of not actuating a device whose zone cannot be resolved — which is the posture
      already taken before the first commit, extended to a zone the tree does not know.
      (c) *Accept the cost.* Keep the fetch on every refresh and close this entry.

      **When it is done:** zone fetches per 12 h are down by at least an order of magnitude, and a
      test drives a device into a zone the cached tree has never seen and asserts it is never
      planned by the wrong home. Source: Codex P1 on PR #2252, 2026-08-31. [P2]

- [ ] **Three EV car-link membership gaps that keep the probe blind to a car.** All three leave a
      car unobserved rather than mis-observed, so they cap what the probe can measure without
      corrupting anything. (a) *Cars initially missing a readable plug state are never retained.* A class `car` device
      whose `ev_charging_state` is absent/malformed on the first authoritative fetch is not tracked
      at all, so it gets no realtime subscription and no place in targeted reads, and
      `noteCapabilityUpdate` only accepts already-tracked cars — a later valid value cannot recover
      it until a full refresh or restart. (b) *Targeted misses ignore `failedIds`.* A by-id read
      failure is classified separately by the fetch layer but that never reaches the probe's miss
      counter, so three flaky reads (post-actuation and stuck-command refreshes come in bursts)
      permanently forget a still-present car; it should use the same count-plus-wall-clock grace as
      `mergeTargetedRefreshSnapshot`. (c) *Cars created after startup are undiscoverable.* Periodic
      refreshes are targeted and the live-feed handler ignores `device.create`, so a car app
      installed later is invisible until a full refresh or restart. Persona: anyone installing a car
      app after PELS; hypothesis: "the probe logged nothing" reads as "detection failed" rather than
      "it never saw the device". Source: Codex round 9 on PR #1895. [P2]

- [ ] **Surface "your step flow is not answering" on the device detail.** *Persona:* flow-backed stepped-device
      owner (EV charger) whose `desired_stepped_load_changed` flow is missing, mistargeted, or not reporting back.
      *Hypothesis:* when a flow step command goes stale repeatedly (`stepCommandStatus:'stale'`,
      `stepCommandRetryCount` climbing), the UI shows only generic "Waiting to increase — Ns" cooldown copy —
      the prod 2026-07-05 deadlock was only diagnosable from raw logs. A device-detail status row (and/or
      settings hub chip) like "Step command not confirmed — check the flow that reports the step back" after
      N consecutive stale commands names the real remedy.
      *Why:* the failure mode is a *user wiring* gap with an actionable fix; today it presents as PELS
      mysteriously never resuming. Note the sibling trust cost: a flow that *confirms but lies* (reports the
      step without applying it) is bounded only by whole-home overshoot detection + the terminal direct
      `evcharger_charging=false` write, and that window stretches under `power_source = flow`'s irregular
      sampling. Files: `lib/plan/deviceStatusReadModel.ts` (the reason line),
      `lib/executor/deviceExecutionState.ts` (stepped command facts), `notes/ui-terminology.md`
      (new status copy). [P2]

## Settings UI surfaces and copy

- [ ] **Activity log: collapse resume/turn-off alternation bursts.**
      *Persona:* owner reading the log after a windy evening.
      *Hypothesis:* consecutive-identical entries now collapse, but an A/B/A/B resume-vs-turn-off
      alternation within minutes still renders as 2N cards that read as malfunction; a paired
      collapse ("Tried to resume 5× in 4 min — not enough power") would tell the story in one row.
      Source: 2026-08-08 walk, pels-ux-fit finding 11 (remainder). Files:
      `packages/settings-ui/src/ui/views/DeviceLogView.tsx`. [P2]

- [ ] **A price-adjusted target gets no reason line on the hero or card.**
      *Persona:* owner seeing hero "target 25 °C" above a Home-mode row saying 21 °C during a
      cheap hour.
      *Hypothesis:* the solar lift has its explaining line ("Raised to use your solar power",
      `planTemperatureCardText.ts`) but the cheap-hour boost / expensive-hour reduction has no
      sibling, so the owner must reconstruct hero = mode + price delta themselves. A symmetric
      line ("Raised for cheap hours" / "Lowered for expensive hours"), sourced from the plan's
      price-adjust fact whenever plannedTarget diverges from the active mode target, closes the
      gap. Source: 2026-08-09 post-merge review, pels-ux-fit. [P2]


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
      Advanced. Plus a boot.ts quick win: replace the `budget-adjust`/`budget-weather` virtual-
      target if-chains with a declarative map. One surface/primitive per PR, screenshot-gated on
      convergence. Persona: contributor velocity + Set-and-forget owner (visual coherence);
      hypothesis: three segmented impls / two device rows / per-file chip vocab is where per-page
      drift keeps re-entering. [P2]

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
      `setup/` factory, seed the current sites into `scripts/setup-stateless-allowlist.txt`, and
      exempt per-call locals. **Done when:** the guard fails on a new reassigned closure `let` in a
      `setup/` factory and the allowlist names each existing one. [P2]

- [ ] **No end-to-end cover for the start policy's actuation claim.** The feature's core
      assertion is that nothing new actuates — the executor's existing convergence writes a
      device whose observation disagrees with its plan, so an unplanned start is ordinary drift.
      `test/integration/startPolicyPlanBuild.test.ts` stops at `plannedState`/`reason` and never
      reaches a device write. **What changes:** an e2e driven through the Homey SDK boundary,
      modelled on `test/e2e/externalOffHold.e2e.test.ts` (the precedent for a standing hold):
      opt a binary device in, turn it on through the mock SDK, advance to the next meter
      reading, assert the off write. **Done when:** the spec fails if the hold stops producing
      an executable off intent. [P2]

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
      (`lib/store/userdataDatabase.ts`). These have not: `deferred_objective_active_plans`
      (`setup/appInit/deferredRecorders.ts`; the settings UI reads it live through a settings
      event, so its move replaces that with an `api.realtime` push) and `pv_forecast_state`
      (up to 90 days of generation history, `setup/pvForecastStateAdapter.ts`). The size is what
      matters, because the small live latches stay in settings by ruling and keep writing:
      measured on production on 2026-09-26, `device_last_controlled_ms` writes ~19 times an hour
      (every executor actuation batch, `setup/homeRuntime/homeSignalWriters.ts`) and
      `deferred_objective_observation_watermark` 12 (`setup/appInit/deferredRecorders.ts`).
      Change: one repository per family beside its domain, taking the
      open database (the tracker and weather stores are the pattern: rows or one JSON row per
      event, diffed writes, the legacy key imported once at boot through
      `lib/store/legacySettingsImport.ts` and unset, and the settings UI served through `api.js`).
      Done when none of the keys listed above is left in
      `GET /api/manager/apps/app/com.barelysufficient.pels/setting` on the production Homey, which
      leaves about 16 kB of configuration and live latches. Count writes by diffing successive reads of that endpoint, not with
      the `settings_set.*` perf counter, which covers only `capacity_in_shortfall`.

- [ ] **Three setup files still hold runtime state, above the boundaries `arch:check` enforces.**
      `setup/` constructs and connects and holds nothing (`setup/AGENTS.md` § "No state"), enforced
      by `scripts/check-setup-stateless.mjs`. Three files predate the rule and sit in
      `scripts/setup-stateless-allowlist.txt`, which budgets each a declaration count (10
      declarations; 21 files / 104 at the guard's introduction). **Two of the three files will never
      move** — `powerSamplePipeline.ts` and `appSnapshotHelpers.ts` are orchestrators whose imports
      close every domain destination. Their STATE can still move, so this entry's done-condition
      stands: `powerSamplePipeline.ts`'s state move is tracked as `` `schedulePlanRebuild` is still
      rebuilt per sample, because it closes over the request ``, and `appSnapshotHelpers.ts`'s state
      move is part of this umbrella and is not tracked separately anywhere. Each is a component in
      the wrong directory, and each migration is the same shape: move the state **and the rules that
      read it** into the domain module that owns the concept, as a leaf that takes flat injected getters for anything outside
      its own module (the `no-weather-to-peer` pattern — "a leaf collector fed flat getters from
      setup wiring"); setup keeps only the construction that binds them. The peer DAG is the
      constraint that decides each destination: `lib/home` is a declared pure leaf. The home
      membership service now takes a narrowed device snapshot and setup-owned event subscription;
      it has no device or observer imports. Lanes, in the order they should land:
      (a) power — DONE except `powerSamplePipeline.ts`, whose file stays in `setup/` but whose
      state does not (see `` `schedulePlanRebuild` is still rebuilt per sample, because it closes
      over the request ``);
      (b) solar — DONE;
      (c) device — `targetPowerProbeScheduler.ts` and `appFlowBacked.ts` are DONE (`lib/device/`).
      `appDeviceSupport.ts` is DONE: its module-level `Set` was the mode-target fill's record of
      what it filled, which now lives on the one `ModeDeviceTargetFill` the app builds
      (`lib/home/modeDeviceTargetFill.ts`). `appNativeWiring.ts` is DONE, as
      `lib/device/builtInControlFlowConflicts.ts`. `appSnapshotHelpers.ts` has no entry of its own:
      its state move is part of this umbrella and is not tracked separately;
      (d) home — `homeSampledMeterIdentity.ts` is DONE, as `lib/power/sampledMeterIdentity.ts`:
      the fact it holds is about the sample the TRACKER serves, and it imports nothing but the
      freshness constant its expiry derives from. Main-meter authority now lives in
      `lib/home/homeMainMeterAuthority.ts`, with its power-owned sampled identity supplied through
      `lib/ports/sampledMeterIdentity.ts`.
      `homeRuntime/homeModeOwnershipTransfer.ts` is DONE, as
      `lib/home/modeOwnershipTransfer.ts`. `HomeMembershipService`, its settings stores and
      activation reads, and Main-meter authority now live in `lib/home/`; device membership arrives
      as a narrowed snapshot and sampled-meter identity through a neutral port. The registry's
      state is DONE too, as `lib/home/homeRuntimeRegistry.ts`, with bundle construction and the
      power-source epoch fence injected as ports, so the home lane holds no setup state;
      (e) composition root and leftovers — DONE. `appServiceWiring.ts`'s late-bound service handles
      are `PelsApp` fields reached through getter/setter pairs, its
      membership teardown is a `TeardownRegistry` key, and the prepared-reconcile fence is
      created by the sample ingest queue in `lib/power`, which owns the revision it reads. The background teardown handles are an injected
      `TeardownRegistry` (`lib/utils/`), the dump counter is `lib/diagnostics/deviceDumpId.ts`, and
      the scheduler telemetry observer moved to `lib/plan/rebuildScheduler/` rather than
      `lib/logging/` as this entry used to say — it names `RebuildIntent` and
      `PowerSampleRebuildState`, so putting it in `lib/logging` would have made a foundation module
      depend on `lib/plan`. Each lane is behaviour-preserving: a move plus an injection change, with
      `npm run arch:check` as the gate on the destination. Done when
      `scripts/setup-stateless-allowlist.txt` no longer exists and `npm run setup:stateless` passes
      without it. Found 2026-08-29. [P2]

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
