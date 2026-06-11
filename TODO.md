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

### P1 — targeted refactors (deferred)

*Concrete, bounded changes to specific named surfaces (not structural re-splits — those stay P2).
The flow-reported / pendingBinaryCommands / stepped-restore-wrapper / stepped-swap-completion /
deviceOverview entries shipped in the 2026-06-03 train; the two below remain deferred.*

- [ ] **Tighten the device-state snapshots to discriminated types.** `TargetDeviceSnapshot`,
      `DevicePlanDevice`, and `PlanInputDevice` carry binary/temperature/stepped/EV/freshness/power
      fields as one nullable bag; discriminate by control kind so the compiler enforces per-variant
      field presence (removes a class of nullable-field bugs). Files: `packages/contracts/src/types.ts`,
      `lib/plan/planTypes.ts`, `lib/plan/planBuilder.ts`, settings UI contract tests.
      **Slice 1 (control-kind TYPE GUARDS) landed:** added narrowed helper types
      `SteppedLoadKind` / `SteppedPlanDevice` / `SteppedPlanInputDevice` in `lib/plan/planTypes.ts`
      and converted `isSteppedLoadDevice` (`lib/plan/planSteppedLoad.ts`) into a real type guard
      (overloads narrow the two flat plan device types to their `Stepped*` slices, plus a generic
      overload for `Pick`-typed callers). Migrated the ~11 plan/executor sites that already branch on
      the stepped discriminant so they read `steppedLoadProfile` without `?.`/null-assert. **No fields
      were moved off the base types** — the flat types keep every field optional; narrowing happens
      only at the guard. The field-level variant discrimination that actually forbids cross-kind
      field reads (temperature ~21 files, stepped ~34, EV ~26) and the `TargetDeviceSnapshot`
      discrimination (~119 importers) remain as follow-up slices. Temperature/EV kind guards were NOT
      added in slice 1 — no plan/executor site branches on `controlModel === 'temperature_target'`
      (or the EV capability) and then reads kind-specific fields un-narrowed, so a guard would be
      dead code; add those alongside the field-move slices that create real consumers.
      **EV-observed guard landed (slice 1 of the observer-snapshot EV discrimination):** added
      `isEvObserved(snapshot): snapshot is EvObservedSnapshot` + `EvObservedSnapshot` (=
      `TargetDeviceSnapshot & { evChargingState: EvChargingState }`) in `lib/device/evObservedState.ts`
      — the observer-snapshot twin of `isEvPlanDevice`. `getEvRestoreBlockReason`
      (`lib/device/deviceActionProjection.ts`) now narrows through it (behaviour-preserving: EV + no
      resolved state → `state_unknown`, as before). **No field moved off `ObservedDeviceState`** —
      `evChargingState` stays optional on the base; narrowing happens only at the guard. NEXT slices
      (the part that enforces "never read `evChargingState` without narrowing"): move the EV observed
      fields off the base `ObservedDeviceState` onto `EvObservedSnapshot` and migrate the ~15 transport
      owner-reads + remaining consumers — the same deferred-hard `TargetDeviceSnapshot` discrimination
      above (transport builds snapshots uniformly across kinds), ideally done across temperature/stepped/EV
      together.
      **EV-vocabulary de-couple landed (2026-06-07, PRs #1528/#1531/#1540/#1544/#1554/#1561/#1568/#1570/#1571):**
      every consumer in `lib/plan`/`lib/objectives`/`lib/executor`/settings-UI now reads producer-resolved
      bits / shared-domain predicates (`isEvDevice`, `resolveEvBlockReasonForDevice`,
      `isEvSessionInactiveForDevice`, `resolveEvBoostBlockReason`) instead of raw plug-state, and
      `scripts/check-ev-vocab.mjs` (in `ci:checks`) forbids `plugged_*` literals in those three layers.
      **EV field-move landed (2026-06-07): `evChargingState` removed from `EvPlanInputKind` /
      `DevicePlanDevice` (`EvKind`) / `ObjectiveDeviceInput`.** The producer
      (`setup/appInit/toPlanDevice.ts`) now resolves the observed plug-state ONCE into a flat
      `evCommandability: EvCommandabilityResolution` (`{ blockReason, sessionInactive, chargerNotResumable }`,
      new type in `@pels/contracts`) via `resolveEvCommandability` (shared-domain); it is threaded through
      the `planDevices`/`planReconcileState` carriers and the `withEvDiscriminant` regrouper. The device-shaped
      resolvers (`isEvSessionInactiveForDevice` / `isEvChargerNotResumableForDevice` /
      `resolveEvBlockReasonForDevice` / `isEvBoostBlockedByPlugState`) dual-read it (prefer materialized, fall
      back to raw `evChargingState` for snapshot-shaped callers), mirroring `isCommandableNow`. Architectural
      correction surfaced in review: the settings-UI read model used to read `evChargingState` off the plan
      device — but the **observer** is its canonical owner (`ObservedDeviceState.evChargingState`), so
      `settingsOverviewReadModel` now sources it via a `getObservedEvChargingState` planService dep wired to
      `ctx.getObservedState(id)`. `evChargingState` stays on `TargetDeviceSnapshot`/`ObservedDeviceState`
      (transport + observer + settings-UI display) as designed. Fixed in passing: `isEvPhysicallyUnplugged`
      read the raw string directly (would have silently no-op'd on plan devices after the move) — now dual-reads.
      **`evChargingState` typed as the `EvChargingState` union (closed enum) — foundation landed.** Field +
      every consumer type now use `EvChargingState` (no `string`, no `null`); the producer
      (`getEvChargingState` + the two realtime seams) normalises any vendor value outside the capability enum
      to `undefined` (uncommandable / `state_unknown`), and the verbose "unknown charging state 'X'" diagnostic
      was dropped (unknown is ignored, not surfaced). **NEXT — EV-observed-interface slice (hypothesis:**
      `undefined` still leaks to all readers because `evChargingState` is a flat optional field on the generic
      `ObservedDeviceState`; **why:** the observer-snapshot twin of the plan-layer `EvKind`/`isEvPlanDevice`
      pattern is missing; **persona:** runtime maintainer): move EV observed fields onto an `EvObservedFields`
      interface with a required `evChargingState: EvChargingState`, gated by an `isEvObserved(s)` type guard, so
      non-EV code structurally cannot reach it and present values are never `undefined`. Mirrors `isEvPlanDevice`.
      **Temperature de-kind slice T1 landed (2026-06-07): planner branches on modality, not device kind.**
      Moved the starvation device-class set and the `deviceType === 'temperature'` checks out of
      `lib/plan/planDiagnostics.ts` into browser-safe shared-domain predicates (`isTemperatureControlDevice`,
      `isStarvationSupportedDeviceClass` in `packages/shared-domain/src/temperatureDeviceKind.ts`), mirroring
      `isEvDevice`. Added `scripts/check-device-kind-vocab.mjs` (in `ci:checks`) — an AST guard forbidding
      deviceClass family-name literals and `deviceType`/`deviceClass` literal comparisons in `lib/plan` +
      `lib/executor` (executor was already clean). Value-level only; no `TargetDeviceSnapshot` touch.
      **Objectives de-kind slice T2a landed (2026-06-08): `lib/objectives` consumes shared predicates.**
      Swapped the `deviceClass === 'evcharger'` / `deviceType === 'temperature'` power-estimation
      fallbacks in `samples.ts` / `objectiveSteps.ts` / `planningSpeed.ts` to `isEvDevice` /
      `isTemperatureControlDevice`. The EV swap intentionally widens to the canonical EV identity
      (`isEvDevice` also matches the `evcharger_charging` capability, not just `deviceClass`), aligning
      objectives with how every other layer identifies EV chargers; genuine `objectiveKind === 'temperature'`
      branches (`admission.ts`, `coldStartRelease.ts`) are objective-kind, not device-kind, and stay.
      `lib/objectives` is now in `check-device-kind-vocab.mjs`'s `consumerDirs`, so the guard enforces all
      three consumer layers.
      Remaining under this item:
      - **type discrimination:** the temperature (~21) / stepped (~34) field-level discrimination and the
        `TargetDeviceSnapshot` discrimination (~119 importers) — the type-tightening half, independent of the
        value-level de-kinding above.

## P2 Product, Observability, and Maintainability

*v2.11.0..HEAD release-review findings (2026-06-02). Non-blocking follow-ups.*

- [ ] **Give the armed budget-discard state a visible "keep changes" path.** The Budget header's
      two-step confirm shows only the destructive option ("Click again to discard"); the save path
      (Preview changes → Apply) is a sticky CTA further down, and the explanatory text lives in a
      hover-only `title` that touch users never see. Surface a one-line inline hint near the armed
      button (or render the armed moment as a Keep editing / Discard pair). Persona: returning
      tweaker (persona 4); hypothesis: a user who tapped Done absent-mindedly reads only "discard",
      assumes their edits are already lost, and re-enters them from scratch. Source: pels-ux-fit on
      the budget-settings-access PR, 2026-06-10.

- [ ] **Settings-referred Adjust session lacks the sibling "← Settings" back affordance.** Every
      Settings sub-page (Limits & safety, Devices, …) opens with a leading back chip; the Daily
      budget row instead lands on the Budget tab where the way back is a trailing "Done" whose
      destination is only in a hover `title`. When `adjustReturnTarget === 'settings'`, render the
      shared `.settings-back-button` affordance above the Budget header (it can coexist with Done).
      Persona: settings-first owner (persona 1); hypothesis: without the visible back affordance the
      tab-indicator jump (Settings → Budget) reads as "I got teleported", not "this is a sub-page of
      what I was doing". Source: pels-ux-fit, 2026-06-10.

- [ ] **Move the daily-budget breakdown chart toggle from Advanced to the Budget chart card.** After
      the tuning-selects retirement, Advanced ("Diagnostics, cleanup, logs, experiments") hosts a
      lone display preference — a scent mismatch on both ends. Put the toggle on the chart it
      controls (overflow or inline on the Budget chart card) and let Advanced be purely diagnostics.
      Persona: chart-curious optimiser (persona 4); hypothesis: nobody looking at the budget chart
      thinks to open Advanced to change how the chart renders. Source: pels-ux-fit + pels-m3-critic,
      2026-06-10.

- [ ] **Busy-gate the Budget header toggle (inherited apply race).** `onToggleClick` ignores
      `adjust.busy`: confirming a discard while an apply is in flight yields a post-navigation
      "Daily budget updated." toast and a lingering dirty status (workingDraft = pre-apply values vs
      newly-applied active). Pre-existing behavior (old single-click Done had the same race; the
      two-step confirm only adds friction), so not fixed in the access PR. Fix: disable the toggle
      while `busy`, or honor the `draftRevision` guard in `applyBudgetAdjust`'s success path the way
      preview already does. Persona: impatient tweaker; hypothesis: rapid preview→apply→Done
      sequences on slow Homey bridges leave the Adjust view claiming unsaved changes that were in
      fact applied. Source: adversarial correctness lens, 2026-06-10.

- [ ] **Sweep the two-step confirm family from "Click again…" to "Tap again…".** All four armed
      confirm labels (reset usage history, device cleanup ×2, budget discard) say "Click" inside a
      touch-first WebView. Sweep them together so the idiom doesn't fork. Persona: phone-only owner;
      hypothesis: "click" is desktop vocabulary that subtly signals the UI wasn't built for the
      device in their hand. Source: pels-copy-and-terminology + pels-ux-fit, 2026-06-10.

*Chart-overhaul train review follow-ups (2026-06-11, PRs #1677–#1681). Non-blocking.*

- [ ] **Grace the plan-history recorder's boot load against transient-empty reads.** The
      `DeferredObjectivePlanHistoryRecorder` constructor does a single un-graced `deps.load()`
      (`lib/objectives/deferredObjectives/planHistory.ts:196`); per
      `feedback_homey_sdk_unreliable`, a transient-empty boot read followed by a finalization
      flush silently drops up to 30 persisted history entries. Give it the trustworthy-read
      grace the backfill key-list path already has (`objectiveStore.ts` treats an empty
      `getKeys()` as untrusted and retries instead of committing). Source: pels-runtime-reality
      on PR #1678, 2026-06-11.

- [ ] **Split `packages/shared-domain/src/deferredPlanHistoryReceipt.ts`.** The eslint
      `max-lines` waiver has been ratcheted twice (540→555→560 in `eslint.config.mjs`) and the
      waiver comment itself names the file a split-out target. The producer composes six
      asymmetric surfaces with natural seams (succeeded timeline / miss chips / abandoned
      details / ISO-week archive / 7-day strip); split along them so the next surface doesn't
      ratchet again. Source: pels-layering-guardian on PR #1681, 2026-06-11.

- [ ] **Give the smart-task live schedule chart's encodings an on-chart decode path.** The
      schedule card's three encodings (price-tone colour, opacity = scheduled, changed-hour dot)
      have no legend; disclosure is scrub-readout-only. Hypothesis: a 4-word caption legend
      closes the first-read gap; persona: the first-time/skeptic visitor who hasn't discovered
      scrubbing. Flagged for owner walk in the PR body. Files:
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx` (schedule card caption). Source:
      #1679 reviews, 2026-06-11.

- [ ] **Compose a real cause for the plain-miss history hero's "Why" line.** The fallback branch
      renders "Why: Didn't reach the target before the deadline." — circular (it restates the
      Missed outcome it annotates). Compose an actual cause the way the revised/refined miss
      paths already do (e.g. from delivered-vs-needed or the final plan snapshot). Persona:
      recovering-from-mistake owner (#5). Files: `packages/shared-domain/src/deferredPlanHistory.ts`
      (`formatPlanHistoryMissedReason` final fallback, ~line 402), rendered via
      `packages/settings-ui/src/ui/deadlinePlanHistoryDetailHero.ts`. Source: pels-ux-fit on
      PR #1681, 2026-06-11.

- [ ] **Hoist the active-plan shape guard into shared-domain so the UI and runtime can't drift.**
      The settings-UI `coerceDeferredObjectiveActivePlans`
      (`packages/settings-ui/src/ui/deferredObjectiveActivePlans.ts`) is a leaner duplicate of the
      runtime `normalizeDeferredObjectiveActivePlans`
      (`lib/objectives/deferredObjectives/activePlanSettings.ts`): it hard-codes `version: 1`, skips
      the version check, and does no per-device `isActivePlan` filtering. Benign today (every consumer
      optional-chains each leaf, so a malformed entry degrades to "no state line"), but on a future
      `DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION` bump the runtime normaliser would reject the old blob
      while the UI guard forces `version: 1` onto a v2-shaped payload and renders stale/foreign fields.
      Fix per the resolution-in-producer rule: extract one browser-safe `coerce`/`normalize` into
      `packages/shared-domain/src/` (precedent: `deferredObjectiveValues.ts` already exports value normalisers
      there) and delegate the top-level shape/version check from BOTH `activePlanSettings.ts` and the
      settings-UI module — single source of truth, `settings-ui ↛ lib` boundary intact. **Trigger:
      do this before/with the next active-plans schema-version bump.** Source: pels-layering-guardian
      on PR #1517, 2026-06-05.

- [ ] **Retire the `observed ?? device` boot-window fallback in `toPlanDevice` once freshness leaves
      the descriptor surface.** Stage 4b wired the first projection reader: `toPlanDevice`
      (`setup/appInit/toPlanDevice.ts`, fallback at ~line 25) resolves `observationStale` from
      `ctx.getObservedState(id)`, falling back to the snapshot only until the first observation lands.
      The fallback is correct *today* solely because
      `TargetDeviceSnapshot = DeviceDescriptor & ObservedDeviceState` so the snapshot still physically
      carries `lastFreshDataMs`/`lastLocalWriteMs`. Once a later stage strips those freshness fields off
      the descriptor surface, the `?? device` arm reads `undefined` and silently flips `unknown` → non-stale.
      Remove the fallback (or re-point it) in lockstep with that strip, so the "identical anyway" boot-window
      assumption doesn't outlive its invariant. Persona: contributor; hypothesis: a stale fallback that
      reads a removed field is a silent correctness trap for the next stage. Source: pels-layering-guardian
      P3 on the stage-4b PR, 2026-06-06. Files: `setup/appInit/toPlanDevice.ts`, `packages/contracts/src/types.ts`.
      (The three stage-4b *prerequisites* — seq-epoch co-creation, freeze-on-store, and the
      device-update-lag dispatch — shipped with the stage-4b reader PR.)

*v2.10.0..HEAD release-review findings (2026-05-29, six-agent fan-out:
`pels-runtime-reality` + `pels-layering-guardian` + `pels-copy-and-terminology` +
`pels-m3-critic` + `pels-ux-fit`). No P0 blockers; the past-tasks hit-rate
reorder and the remaining widget-copy hoist shipped as their own follow-up
PRs. Items below are later polish.*

*v2.9.1 RC release-review carry-forward (re-added on `v2.9.1..main`
release-review pass, 2026-05-26 — the original entry committed as
`6dea64be` on the v2.9.1 release branch never propagated to main).*

*Session P2 deferrals from batch 21 reviews (2026-05-24).*

*v2.9.0 retrospective P2 cleanup and docs follow-ups (2026-05-23).*

*Confidence-model Step-2 follow-ups (2026-05-23). Step 2 of Cause #1
(`resolveBandedProfileConfidence` + `applyBandedConfidence`) shipped — the
overall `kwhPerUnit.confidence` now reflects the pooled within-band residual,
so a converged multi-step device can escape `low` (the standing v2.9 P0 signal
seen 985/985 in prod). These are `pels-runtime-reality` follow-ups that didn't
block merge.*

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
- [ ] Split app lifecycle context into initialized vs initializing phases so services that are
      required after startup are not exposed forever as optional fields.
      Files: `lib/app/appContext.ts`, `app.ts`, app init/service tests.
- [ ] Split planner state from render-only explanation data so keep/shed/inactive decisions no
      longer depend on UI-facing `reason` objects.
      Files: `lib/plan/restore/index.ts` (returns `{ plannedState, reason }` bundled),
      `lib/plan/planReasons.ts` (mixes reason normalization with shed-temperature hold decisions),
      plan/executor/rendering boundaries.
- [ ] Split the larger Bucket-B god-files toward <=500 when next touched (named here so the ceilings in
      `eslint.config.mjs` are accountable, not permanent): `lib/device/deviceTransport.ts` (~2578, peel off a
      transport subsystem on a clear boundary), `lib/plan/restore/index.ts` (~1414, swap-flow vs per-device
      restore gating), `flowCards/registerFlowCards.ts` (~1258, only if registration gains per-card behavior),
      `lib/plan/planBuilder.ts` (~1257, overshoot/meta builders), `lib/device/transport/managerObservation.ts`
      (~1082, retained-observation accounting), `lib/plan/planReasons.ts` (~1124, reason-normalization vs hold
      decisions), `lib/plan/planService.ts` (~936, reconcile vs rebuild), `lib/executor/steppedLoadExecutor.ts`
      (~845), `lib/objectives/deferredObjectives/activePlanRecorder.ts` (~1208, replay split) and
      `diagnosticsBridge.ts` (~1028, per-concern payload builders), `setup/appDebugHelpers.ts` (~779, comparison
      serializer). Persona: contributor. Large structural splits — out of scope for the exemption sweep.
      Files: as listed.
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

## P3 Future and Exploratory Work

*Entry bar: each item states a **hypothesis**, **why it's needed**, and the **persona**
(`notes/personas.md`) it serves. Items that can't name all three are maintainability/
cosmetic chores — do them in passing or drop them; don't park them here.*

- [ ] **Persist the device Activity-log so it survives a restart.**
      *Persona:* curious tinkerer (`notes/personas.md`) — wants to debug their own setup over time.
      *Hypothesis:* the Activity-log recorder (`lib/plan/deviceOverviewLog.ts`, served via
      `/ui_device_log`) is session-only, so the log is empty after a restart; a persisted ring buffer
      would let the tinkerer review what happened overnight.
      *Why it's needed:* the one surface that reconstructs per-device history is wiped on every boot.
      Needs the Homey-SDK transient-read grace pattern before persisting. A later cross-device "recent
      activity" feed on Overview is a possible follow-on if the per-device view proves used.
- [ ] **Restore non-stepped control-mode granularity to the device-overview change signature.**
      *Persona:* Homey owner (`notes/personas.md`) watching the device-overview/activity-log refresh.
      *Hypothesis:* now that the planner no longer carries `controlModel`, the overview/log seam
      (`PlanService.recordOverviewChange`) restores only the STEPPED value (`isSteppedLoadDevice`), so
      `buildDeviceOverviewTransitionSignature` no longer distinguishes a non-stepped `temperature_target` ↔
      `binary_power` flip (both collapse to `undefined`). A device that changes deviceType with no other planner
      change could leave an open settings-UI card stale until the next plan change.
      *Why it's needed:* full restoration needs the producer `deviceType` (a `deviceManager.getSnapshot()` call),
      but the overview loop runs INSIDE the plan/apply cycle where re-entering the device manager breaks the
      SDK-boundary shed e2es — so the cheap fix isn't safe. A real fix needs a cycle-safe `deviceType` source
      (e.g. caching the map at plan-build time, or carrying a producer-resolved control-mode kind on the plan
      device). Very low urgency: a runtime deviceType flip is a rare device-capability change and self-heals on
      the next plan change. Source: Codex review on PR #1594.
- [ ] **Retire the raw-`evChargingState` arm of the `EvStateConsumerInput` dual-read.**
      *Persona:* maintainer (`notes/personas.md`) reasoning about the EV resolvers.
      *Hypothesis:* now that the planner types carry only `evCommandability`, the dual-read in
      `packages/shared-domain/src/commandableNow.ts` (`isEvSessionInactiveForDevice` /
      `isEvChargerNotResumableForDevice` / `resolveEvBlockReasonForDevice` / `isEvBoostBlockedByPlugState`)
      only needs its raw-`evChargingState` fallback for the remaining snapshot-shaped callers
      (`TargetDeviceSnapshot`, executor restore helpers). Once those migrate to a materialized form, the
      resolvers can drop the second input shape and stop carrying two paths.
      *Why it's needed:* a single input shape removes a latent footgun — e.g. `resolveEvBlockReasonForDevice`
      currently short-circuits on `evCommandability` *before* its `isEvDevice` gate, which is safe only because
      `resolveEvCommandability` never produces a value for a non-EV device; a future hand-constructed input could
      bypass the gate. Until then the dual-read is correct and commented.
- [ ] **Close the boot-window EV-state-chip gap in the settings-UI read model.**
      *Persona:* Homey owner (`notes/personas.md`) glancing at the device overview right after an app restart.
      *Hypothesis:* the read model now sources `evChargingState` from the observer
      (`getObservedEvChargingState` → `ctx.getObservedState`), which is event-driven and empty until the first
      observation for a device lands, so the EV state chip can show generic copy ("Inactive" instead of "Car
      unplugged") for the first cold-start cycle. A naive `ctx.latestTargetSnapshot` fallback is NOT the answer —
      that getter re-decorates the whole snapshot per access (O(n²), re-entrant-unsafe; it broke the shed e2es).
      *Why it's needed:* a brief generic chip on restart is a minor first-impression wobble on the EV surface the
      owner cares about. A safe fix needs a cheap by-id observed/snapshot accessor (e.g. a memoized per-serialize
      map, or seeding the observed projection at boot) rather than the live re-decorating getter. Low urgency
      (single cycle, cosmetic; runtime control is unaffected — it reads the materialized `evCommandability`).
- [ ] **Fold the same-file `capacityNote` literal onto `STARVATION_WAITING_FOR_POWER_COPY`.**
      *Persona:* maintainer / support (`notes/personas.md`) reading log/UI copy parity.
      *Hypothesis:* `capacityNote: 'Waiting for available power.'` in `planStarvation.ts` re-types the
      same phrase the new `STARVATION_WAITING_FOR_POWER_COPY` constant owns (differs only by a trailing
      period), so the two can silently diverge from the overview/row-subtext wording.
      *Why it's needed:* completing the same-file dedup removes the last in-file copy of this literal.
      Deferred from the dedup PR because `capacityNote` is bundled into the `starvation_rescue` widget,
      so the change regenerates `widgets/starvation_rescue/*` — a build-artifact churn out of scope for a
      string-sourcing chore. Fix: `` capacityNote: `${STARVATION_WAITING_FOR_POWER_COPY}.` `` and commit
      the regenerated widget bundles. Source: pels-copy-and-terminology on PR #1535, 2026-06-06.

- [ ] **Create-screen `Extra permissions` opt-out is additive-only.**
      *Persona:* skeptical optimiser / curious tinkerer (`notes/personas.md` #4/#3) who expects
      the compose screen to reflect the standing permissions already granted for the device.
      *Hypothesis:* because `createDeferredObjective` preserves existing smart-task permissions,
      a user can read the compose screen as authoritative while it only shows additive opt-ins.
      *Why it's needed:* surfacing current standing permission state would make the create flow
      honest when permissions came from Flow cards or the Held-back devices lane.
      Files: `widgets/create_smart_task/src/public/render.ts`,
      `widgets/create_smart_task/src/api.ts`, `packages/shared-domain/src/deadlineLabels.ts`.
      *Design (learned 2026-06-04, PR #1473 closed without merging — branch
      `feat/create-screen-standing-permissions` preserved):* a first attempt that surfaced standing
      grants as read-only and suppressed each already-standing toggle, which hit four review rounds of
      **`at_risk`-mode** edges. Resume by realigning the whole feature on **`always`-strength**,
      not "a grant exists": (1) suppress a permission's opt-in toggle ONLY when it already stands as
      `always` (can't be strengthened); (2) show an `at_risk` standing grant's toggle as an *upgrade*
      affordance (the standing line's ` (if at risk)` suffix differentiates it from the unconditional
      toggle); (3) gate `limitLowerPriorityDevices` on **effective-`always`** budget — an `at_risk`
      standing budget must NOT satisfy it (matches the app's keep-limit-only-when-`always` gate);
      (4) `buildEffectiveRescue` must take the **stronger** mode when standing and requested differ.
      Already-correct pieces on the branch worth keeping: the producer-side expired/history filter on
      `getDeviceStandingRescue` (gate on `hasDeferredObjectiveForDevice`), the standing-and-toggles merge
      into BOTH preview and create candidates, and the route-agnostic `Already allowed:` copy.

*Smart-task failure-investigation & live UX — the underserved panic / skeptical
visitors (`notes/personas.md` #4–6).*

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
      Files: `lib/objectives/deferredObjectives/activePlanRecorder.ts`, `setup/settingsUiApi.ts`,
      `packages/settings-ui/src/ui/deadlinePlan.ts`, `.../deadlinePlanResolvers.ts`.
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
- [ ] **Fold the revision-history panel into "What PELS has learned" at 320 px.**
      *Persona:* curious tinkerer (#3) — expands cards to debug their own setup.
      *Hypothesis:* at 320 px the standalone collapsed panel costs ~80–96 px of chrome before
      any content; nesting "…and what changed since the plan was first written" inside the
      existing `PlanInputsCard` recovers that space and groups related debug info.
      *Why it's needed:* on the 320 px-min webview the extra card shell pushes the actual
      revision content below the fold, weakening the one surface this persona uses to
      reconstruct what changed. Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `PlanInputsCard`. Source: pels-m3-critic/ux-fit on PR #1197 (batches 1–3 shipped).
*EV charging — the skeptical optimiser / EV commuter (`notes/personas.md` #4).*

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

*Demoted from P2 (2026-06-03 scrutiny pass) — real product / future-capability work with a
persona but no current support-cost pressure; reframed to the P3 bar.*

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
