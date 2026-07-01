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

- [ ] **Overview simulation-mode status copy states actuations as fact.** With simulation on,
      device cards read "Turned off by PELS" while the hero says "1 device would be limited if
      simulation mode were off" — the card copy claims an actuation that never happened. Status
      copy should read "Would be turned off (simulation)" (or equivalent per
      `notes/ui-terminology.md`) whenever simulation is on. Source: PR #1807 review gates
      (2026-07-01).

### P1 — targeted refactors (deferred)

*Concrete, bounded changes to specific named surfaces (not structural re-splits — those stay P2).
The flow-reported / pendingBinaryCommands / stepped-restore-wrapper / stepped-swap-completion /
deviceOverview entries shipped in the 2026-06-03 train; the one item below (a multi-slice
program) remains deferred.*

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
      `TargetDeviceSnapshot & { evChargingState: EvChargingState }`) — the observer-snapshot twin of
      `isEvPlanDevice` (since relocated to `packages/shared-domain/src/evObservedState.ts` by the
      field-move slice below). `getEvRestoreBlockReason` (`lib/device/deviceActionProjection.ts`)
      narrows through it (behaviour-preserving: EV + no resolved state → `state_unknown`, as before).
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
      `resolveEvBlockReasonForDevice` / `isEvBoostBlockedByPlugState`) read the materialized flat bits only —
      the raw-`evChargingState` consumer arm was retired once every caller passed materialized fields; the sole
      reader of the raw plug-state is the producer `resolveCommandableNow`. Architectural
      correction surfaced in review: the settings-UI read model used to read `evChargingState` off the plan
      device — but the **observer** is its canonical owner (`ObservedDeviceState.evChargingState`), so
      `settingsOverviewReadModel` now sources it via a `getObservedEvChargingState` planService dep wired to
      `ctx.getObservedState(id)`. `evChargingState` stays on `TargetDeviceSnapshot`/`ObservedDeviceState`
      (transport + observer + settings-UI display) as designed. Fixed in passing: `isEvPhysicallyUnplugged`
      read the raw string directly (would have silently no-op'd on plan devices after the move) — now reads the
      materialized `evSessionInactive` bit.
      **`evChargingState` typed as the `EvChargingState` union (closed enum) — foundation landed.** Field +
      every consumer type now use `EvChargingState` (no `string`, no `null`); the producer
      (`getEvChargingState` + the two realtime seams) normalises any vendor value outside the capability enum
      to `undefined` (uncommandable / `state_unknown`), and the verbose "unknown charging state 'X'" diagnostic
      was dropped (unknown is ignored, not surfaced).
      **EV-observed field-move landed (2026-06-12): `evChargingState` is OFF the base
      `ObservedDeviceState`/`TargetDeviceSnapshot`.** An un-narrowed `snapshot.evChargingState` read is now a
      hard TS2339; consumers narrow through `isEvObserved` (moved to
      `packages/shared-domain/src/evObservedState.ts`, browser-safe, generic over the carrier so settings-UI
      narrows the same way — first UI consumer: the EV-boost status in `deviceDetail/evBoost.ts`). New contracts
      types: `EvObservedFields` (required `evChargingState`, the narrowed cluster) + `EvObservedProbe` (the
      optional "might be EV-observed" loose shape). OWNER seams keep physical custody via probe-widened types:
      `TransportDeviceSnapshot` (`lib/device/transportDeviceSnapshot.ts`) for transport's stored/mutated
      snapshots (the transport halves swapped wholesale — they never leak outside `lib/device`), and
      `readObservedEvChargingState` (`lib/observer/observedDeviceStateProjection.ts`) as the one sanctioned raw
      accessor feeding the read-model's flat DTO field. `toPlanDevice` widens its param with the probe (it
      resolves + strips, as before). Type-level only — zero runtime behavior change. NOT moved, deliberately:
      `stateOfCharge` (independent presence semantics — SoC without plug-state is real, ~30 UI/widget/flowCard
      readers; needs its own slice with its own cluster shape) and `evCharging` (transport-internal only, zero
      outside readers).
      **Temperature-observed field-move landed (2026-06-13): `currentTemperature` is OFF the base
      `ObservedDeviceState`/`TargetDeviceSnapshot`.** An un-narrowed `snapshot.currentTemperature` read is now a
      hard TS2339; consumers narrow through `hasObservedTemperature` (`packages/shared-domain/src/temperatureObservedState.ts`,
      browser-safe, generic over the carrier). New contracts types: `TemperatureObservedFields` (required
      `currentTemperature`) + `TemperatureObservedProbe` (optional owner-side widening); `TransportDeviceSnapshot`
      now intersects both EV and temperature probes. Consumers migrated: `lib/objectives/samples.ts`
      (`isFreshTemperatureDevice` composes `isTemperatureControlDevice && hasObservedTemperature`), the
      settings-UI deadline progress readers (`deadlinesList.ts`, `deadlinePlanResolvers.ts`), the smart-tasks
      widget payload, and the `appDebugHelpers` dump. **Deliberate divergence from `isEvObserved`: the guard is
      PRESENCE-ONLY, not kind+presence.** `currentTemperature` comes from the `measure_temperature` capability,
      which a non-temperature `deviceType` device can carry (deviceType is keyed on target caps), so a kind gate
      would reject a *present* reading (a present-but-rejected gap EV does not have). Callers wanting the kind
      compose it explicitly. **Fallbacks removed at source:** present implies finite (all three producer seams —
      `getCurrentTemperature` at parse, `applyMeasuredTemperatureObservation` at snapshot-refresh, and the
      `measure_temperature` branch of `applyFreshnessOnlyCapabilityUpdate` at realtime — write only finite
      values), so the scattered `Number.isFinite`/`isFiniteNumber` re-checks at consumers are gone. Type-level
      only — zero runtime behavior change.
      **State-of-charge-observed field-move landed (2026-06-13): `stateOfCharge` is OFF the base
      `ObservedDeviceState`/`TargetDeviceSnapshot`.** An un-narrowed `snapshot.stateOfCharge` read is now a hard
      TS2339; consumers narrow through `hasObservedStateOfCharge`
      (`packages/shared-domain/src/stateOfChargeObservedState.ts`, browser-safe, generic over the carrier). New
      contracts types: `StateOfChargeObservedFields` (required `stateOfCharge`) + `StateOfChargeObservedProbe`
      (optional owner-side widening); `TransportDeviceSnapshot` now intersects EV, temperature, and SoC probes.
      **Presence-only, like the temperature guard:** it proves the `stateOfCharge` snapshot *object* is present,
      NOT `status === 'fresh'` — that bag keeps its own `status`, so consumers retain their freshness/`status`
      gates after narrowing (the guard only removes the outer `?.`/`if (!soc)`). The one spot that differs from
      the scalar slices: `freezeObserved` (`lib/observer/observedDeviceStateProjection.ts`) still deep-freezes the
      nested SoC bag. Consumers migrated: `lib/objectives/samples.ts` (EV-SoC sample composes `isEvDevice &&
      hasObservedStateOfCharge && status === 'fresh'`), the EV-SoC freshness/boost seams in `app.ts` +
      `flowCards/registerFlowCards.ts` (probe-widened owner reads), the settings-UI device-list + deadline readers,
      and the smart-tasks widget payload. `percent` finiteness was already a producer guarantee
      (`normalizeStateOfChargePercent`), so this is pure type-tightening — zero runtime behavior change.
      **Boundary-finiteness sweep landed (2026-06-13): `measure_power` realtime seam was the last ungated one.**
      A read-only audit (map + adversarial-verify) confirmed the producer layer validates finiteness everywhere
      EXCEPT the `measure_power` branch of `applyFreshnessOnlyCapabilityUpdate` (`lib/device/transport/managerFreshness.ts`),
      which gated only on `typeof === 'number'` — so a realtime `NaN`/`Infinity` power event was stored on
      `measuredPowerKw` (the sibling of the temperature P1; it also rendered "NaN kW" via the unguarded
      `planSteppedCardText` reader and falsely advanced the freshness clock). Fixed drop-at-source
      (`&& Number.isFinite(value)` → no write, no freshness bump). Swept the same class in the load-setting
      reads too: `getLoadSettingWatts` (`devicePowerEstimate.ts`) and `getSnapshotLoad`/`getApiLoad`
      (`lib/device/load.ts`) now drop a non-finite settings/snapshot `load` instead of propagating an infinite
      estimate. An exhaustive boundary unit test (`test/unit/managerFreshness.test.ts`) seals the freshness seam.
      With this, "validate-and-drop at the Homey boundary; present-implies-finite" holds for every numeric
      capability write seam and load-setting read — the invariant the observed-field clusters rely on.
      **Measured-power-observed field-move landed (2026-06-13): `measuredPowerKw`/`measuredPowerObservedAtMs`
      are OFF the base `ObservedDeviceState`/`TargetDeviceSnapshot`.** An un-narrowed `snapshot.measuredPowerKw`
      read is now a hard TS2339; consumers narrow through `hasObservedMeasuredPower`
      (`packages/shared-domain/src/measuredPowerObservedState.ts`, browser-safe, generic over the carrier). New
      contracts types: `MeasuredPowerObservedFields` (required `measuredPowerKw` + optional
      `measuredPowerObservedAtMs` — the two travel together) + `MeasuredPowerObservedProbe` (optional
      owner-widening); `TransportDeviceSnapshot` now intersects all four observed probes. Power-measurement
      absence is the legitimate common case, so the guard draws the present/absent line and "present implies a
      finite, non-negative kW" is the producer invariant (the write seams store only finite values); the
      staleness-sensitive `sampleIngest` still checks `measuredPowerObservedAtMs` independently. Consumers
      migrated: objectives `resolveCredibleDevicePower`, `sampleIngest`, `executablePlanProjection`, the
      transport calibration-store seams, and the settings-UI device-list/view carriers; the rest read off
      local types (`PlanInputDevice`, etc.) that keep their own `measuredPowerKw?` and are unaffected.
      **Retired the two NaN-blind `?? 0` restore-gap reads** (`planSteppedRestorePending`, `restore/accounting`)
      into named helpers `resolveObservedDrawKw` / `resolveObservedDrawKwWithNameplate`
      (`lib/plan/restore/observedDraw.ts`) — `isFiniteNumber`-gated, so a non-finite `powerKw` nameplate can no
      longer propagate through `??` (the old `measuredPowerKw ?? powerKw ?? 0` was NaN-blind). Type-level +
      one defensive-correctness improvement; no intended behavior change given the producer invariant.
      **Stepped-descriptor field-move landed (2026-06-13): `steppedLoadProfile`/`targetPowerConfig` are OFF the
      base `DeviceDescriptor` and `reportedStepId` is OFF the base `ObservedDeviceState` — the FINAL slice of
      this P1.** An un-narrowed `snapshot.steppedLoadProfile`/`targetPowerConfig`/`reportedStepId` read is now a
      hard TS2339. Two new browser-safe guards in `packages/shared-domain/src/steppedLoadObservedState.ts`:
      `isSteppedLoadSnapshot` (narrows `SteppedLoadDescriptorFields`; checks `steppedLoadProfile?.model ===
      'stepped_load'` — the snapshot-shaped twin of `lib/plan`'s `isSteppedLoadDevice`, so `steppedLoadProfile`
      IS the kind discriminant) and the presence-only `hasObservedReportedStep` (narrows
      `ReportedStepObservedFields`). New contracts types: `SteppedLoadDescriptorFields` (required
      `steppedLoadProfile` + optional `targetPowerConfig`, which rides the cluster) + `SteppedLoadDescriptorProbe`
      (optional owner-widening), and `ReportedStepObservedFields`/`ReportedStepObservedProbe`. `TransportDeviceSnapshot`
      and `DecoratedDeviceSnapshot` now intersect both new probes (the transport produces and the app-layer
      decorator re-resolves + writes these onto the carrier). `suggestedSteppedLoadProfile` STAYS on the base
      (it is a CONFIGURE hint for non-stepped devices, not part of the stepped cluster). Consumers migrated:
      objectives `resolveCredibleDevicePower`, the flow-card stepped-load + EV-phase paths, `app.ts`
      `deviceSupportsLimitLowerPriority`, and the settings-UI device-detail carrier + smart-tasks widget payload;
      owner/producer seams (transport parse/calibration-store/native-EV/debug-snapshot) probe-widen instead.
      `targetPowerConfig` reads stay owner-probe reads (a continuous EV preset carries it without a full stepped
      profile), not `isSteppedLoadSnapshot` narrows. Type-level only — zero runtime behavior change.
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
      - **type discrimination (snapshot side): COMPLETE.** All observed clusters (EV / temperature / SoC /
        measured-power) AND the stepped clusters (descriptor `steppedLoadProfile`/`targetPowerConfig` off
        `DeviceDescriptor`; observed `reportedStepId` off `ObservedDeviceState`) have moved off the base
        snapshot types onto orthogonal `*Fields` clusters with `*Probe` owner-widening and shared-domain guards.
        An un-narrowed read of any of these on a base-typed value is a hard TS2339. What is left is the
        plan-layer discrimination still tracked under "Slice 1" above — converting the flat `DevicePlanDevice` /
        `PlanInputDevice` bags to discriminated unions (`SteppedLoadKind`/temperature/EV kinds) — a separate
        partition from the now-finished `TargetDeviceSnapshot`/`ObservedDeviceState`/`DeviceDescriptor` move.
      - **binary on/off discrimination (plan side): `currentOn` slice landed (2026-06-14).** The on/off truth
        is now a strict-boolean `currentOn` on the binary plan kinds (`BinaryPlanInputKind`/`BinaryControlKind`),
        resolved once by the producer (`resolveCurrentOn` — binary axis AND stepped-off fold, no staleness gate)
        and stamped at `toPlanDevice`/`planDevices`. The kind-agnostic `isObservedOff`/`isObservedOn` wrappers
        were DELETED; all consumers narrow via `isBinaryPlanDevice` and read `currentOn` directly (list sites
        partitioned by kind), so on/off is unaskable on a non-binary device and the four-valued `currentState`
        survives only as a UI/reason label. Behaviour change (intended): on/off is the latched last value with no
        staleness gate (stale-off = trusted-off, stale-on = trusted-on, active step = on).
        **`binaryControl` drop landed:** `binaryControl` is OFF the consumer plan kinds
        (`BinaryControlKind`/`BinaryPlanInputKind` carry only `currentOn`); `withBinaryDiscriminant` emits
        `currentOn` and strips the raw axis. `toPlanDevice` now also resolves `currentState` so the plan path and
        reconcile trust the producer instead of re-resolving from `binaryControl`; `observedPower`,
        `planExecutionDrift` (via `observedBinaryState`, which prefers `currentOn`), `planHeadroomDevice`, restore
        accounting, and the deferred-objective terminal release all read `currentOn`. Reconcile recombines
        `currentOn` with the merged stepped profile (no raw axis). Transport/observer/shared-domain and the
        executable-from-snapshot projection keep `binaryControl` as the observed binary axis.
        **`observationStale` removal landed:** the field is OFF the plan kinds — the plan trusts
        producer-resolved control state (no plan-side distrust gate), `resolveObservedCurrentState` resolves a
        concrete latched label (never `unknown` from staleness), and the idle/overview/starvation freshness gates
        source staleness from the observer (`getObservationStale` dep, `isDeviceObservationStale` over the
        projection). With this the plan-side binary-discrimination program is complete (open P2/P3 below).
        *Step-only stepper on/off resolved on the step axis (2026-06-14): a stepped device without `onoff` reads
        off/on from its step; restore/usage/overshoot/reconcile/activation/swap-completion + the executor all fixed.*
        Open follow-ups (P2/P3, deferred):
        - *planSteppedLoad masking is emergent (P3).* The `planSteppedLoad.ts` direct-`currentOn` sites (L161/266/299)
          are masked-safe for a step-only stepper ONLY because the lowest step is the single off step at sorted index
          0, so "next higher from off" == "restore step". **Hypothesis:** a profile with multiple zero-power sub-steps
          below the first active step would make those unequal, silently regressing the restore target. **Persona:**
          an installer with a multi-step `target_power` heater. Add a `getSteppedLoadNextRestoreStep` regression test
          pinning a step-only device on a `[off(0), idle(0), low(>0), …]` profile; not a code change now.
        - *Fixture `currentOn` precedence (deferred, P2, test-only).* `resolveFixtureCurrentOn`
          (`test/utils/planTestUtils.ts`) lets an explicit `currentState` label win over structural
          (binary+stepped) resolution, diverging from production `currentOn` stamping (production never consults the
          label). Reordering to resolve structurally first is more faithful but cascades: ~31 stepped fixtures
          express off-ness via `currentState` alone without a structural `binaryControl: { on: false }` signal and
          flip `currentOn` under the reorder. **Hypothesis:** those underspecified fixtures can mask a planner/
          executor regression where production resolves `currentOn` differently than the fixture asserts.
          **Persona:** a maintainer touching stepped shed/restore. Do it as a focused PR: reorder the helper, then
          add explicit `binaryControl` to each fixture that intends "off". (CodeRabbit #1728.)
        - *Activation-seam end-to-end coverage.* The realtime snapshot-refresh (`appSnapshotHelpers`) and Flow
          headroom card now stamp `currentOn` onto raw snapshots (the Flow card stamps the whole `devices` array)
          before the activation in/active reads, and a step-only stepper carries `steppedLoadProfile`/`selectedStepId`
          to the same reads. Unit-covered via `resolveCurrentOn`/the predicates, but not driven end-to-end (the
          appSnapshotHelpers test mocks `syncHeadroomCardState`). **Hypothesis:** a future change could drop the seam
          stamp/propagation and silently degrade activation-attempt close/active detection. **Persona:** a maintainer
          refactoring the headroom/snapshot wiring. Add an integration test driving the real
          `syncHeadroomCardState`/`evaluateHeadroomForDevice` with (a) a raw-snapshot binary device and (b) a
          step-only stepper parked at its off step, asserting the attempt closes as inactive.
        - *Step-axis stale-trust is undocumented (P2).* `resolveRestoreObservedState` (and the new step-axis
          predicates) read `selectedStepId` + profile with NO `observationStale` gate, so a stale step-only stepper
          at its off step resolves authoritatively to off — sound (`selectedStepId` is PELS's latched last-commanded
          step) and consistent with the documented "stale observation is trusted" invariant, but it extends
          stale-trust from the binary axis to the step axis without a dedicated note or test. **Hypothesis:** a future
          change to step latching could silently flip stale step-only restore eligibility. **Persona:** an installer
          with a `target_power` load. Add a one-line note in `lib/observer/AGENTS.md` + an integration test pinning a
          stale step-only stepper's restore/shed classification.

## P2 Product, Observability, and Maintainability

*v2.11.0..HEAD release-review findings (2026-06-02). Non-blocking follow-ups. The solar gross/net
split follow-ups from this batch are fixed by the solar-accounting follow-up; remaining open items continue below.*

*The runtime test tree is now typechecked: `tsconfig.tests.json` + the `tsc:tests` `ci:checks` lane
landed 2026-06-13, after a one-off cleanup of all ~1,555 masked errors (field-move fixture drift via
the discriminant regroupers + pre-existing mock-shape debt). Test-fixture type drift is now a hard
CI failure, so future field-move slices can't silently grow the debt.*

- [ ] **Solar export price — finish the remaining increments.** The export (feed-in) price model
      shipped off by default (`export_price_enabled`): a per-hour `exportPrice` computed as VAT-grossed
      spot × `export_spot_factor` + `export_fixed`, alongside a negative-safe price-level threshold fix.
      Export pricing is now applied scheme-independently (decoupled from the import scheme): the Norway
      scheme links to its isolatable spot, while the flow/Homey schemes (e.g. NL) get the fixed feed-in
      tariff (a spot-linked config yields no export price there, since no spot is isolatable). The derived
      `budgetPrice` ships and the planning consumers now read it (`budgetPrice ?? total`): daily-budget
      shaping/allocation, smart-task horizons, price levels (live + persisted flags), and cheapest-hours —
      while money/receipt surfaces (`buckets.price`, Budget-chart cost lines, postmortem `priceValue`,
      price-info strings) stay on `total`. Snapshot freshness is handled by the PV-forecast-refresh
      completion hook (`PvForecastController.setOnRefreshed` → `updateCombinedPrices`, registered after
      `wireBudgetPrice`). Remaining: the settings-UI export section +
      contracts `settingsKeys` mirror + "Grid price" / "Export price" / "Planning price" labels + a
      Budget-tab export subline. Also fold in the smart-task *preview* price reader, which still sources
      `buckets.price` (total-based) from the daily-budget snapshot pending the preview migration, so the
      preview curve/cost can disagree with the planning-price allocation for prosumers.
      *Persona:* prosumer (Norwegian plusskunde, or NL post-saldering) self-consuming solar.
      *P2:* planning consumers ship; the user-facing labels/controls are the remaining work.

- [ ] **Planning price — three deliberate exclusions to revisit.** (1) The `price_lowest_before` /
      `price_lowest_today` flow cards and their 30 s trigger checker
      (`lib/price/priceLowestFlowEvaluator.ts`) deliberately stay on the Grid price `total`: their
      `current_price` token is money the user compares against their bill, and ranking the trigger by
      the planning price would emit a token that no longer matches the price that picked the hour.
      Decide separately whether to migrate (planning-ranked hour + total-money token, or a second
      planning-price token). (2) Capacity-limit staleness window: `CAPACITY_LIMIT_KW` sits in
      `DEDUPED_CAPACITY_KEYS`, not `DEDUPED_PRICE_KEYS` (`lib/utils/settingsHandlers.ts`), so changing
      the capacity limit (the budgetPrice blend denominator) updates live cheap/expensive classification
      immediately (computed on read) while the persisted `combined_prices` flags/budgetPrice wait for the
      next natural refresh or PV-forecast hook (≤3 h). Harmless drift window; wire `CAPACITY_LIMIT_KW`
      into a combined-prices recompute if it ever matters. (3) Consumer re-read cadence after the
      PV-forecast hook: the hook only rewrites `combined_prices` (parity with every existing price
      refresh) — the daily-budget snapshot and smart-task horizon pick the new planning price up on
      their own next cycle (power sample / clock tick / :58 settle), which in a flow-source home with
      sparse samples can lag. If dogfood shows it mattering, fire the planner's existing `signal`
      rebuild intent on `onCombinedPricesUpdated('changed')` rather than a bespoke nudge.
      *Persona:* prosumer with export pricing configured who tunes their main-fuse capacity limit.
      *Hypothesis:* the ≤3 h persisted-flag drift is invisible in practice; the flow-card token split is
      the one a user could notice (trigger fires on a "cheap" surplus hour whose money token looks high).

- [ ] **Split-pair label order differs by surface — pick one convention app-wide.** The Budget hero
      split bar labels Managed→Background (matching its left-to-right bar segment order), while the
      Usage chart and Budget hourly-plan chart legends read Background→Managed (matching bottom-to-top
      stack order). Both are internally consistent but the pair flips between adjacent surfaces.
      Decide one canonical order (likely legend = stack order everywhere, or reading-priority order
      everywhere) and align `BudgetHeroSplit`, `buildLegendData` (usageDayChartEcharts.ts), and
      `ChartLegend` (BudgetOverview.tsx).
      *From PR #1806 review (managed/background split visibility).*

- [ ] **Unattributed usage remainder is visible ink but unnamed in the tapped readout.** The Usage
      stack renders measured energy the split does not attribute as a neutral third segment
      (`--pels-chart-unattributed`, off-legend by design). The tapped readout shows Measured +
      Managed + Background, so the user can subtract — but the segment itself has no name anywhere.
      Needs a `notes/ui-terminology.md` decision (candidate words: "unattributed", "other") before
      naming it in the readout or legend; do not invent the word ad hoc in a view.
      *From PR #1806 review.*

- [ ] **Extract the duplicated ECharts select-style identity object.** The on-surface select border
      (`select: { itemStyle: { borderColor: palette.text, borderWidth: 2 } }`) is copy-pasted at ~5
      sites (usageDayChartEcharts.ts `shared`, budgetRedesignChartOptions.ts `barSelect`, plus the
      smart-task/stats charts). One shared helper (chartReadout.ts or chartTooltipFormat.ts
      neighborhood) keeps the selection identity visually identical across charts by construction.
      *From PR #1806 review.*

- [ ] **Hoist `resolveUsageDayStackSegments` into the bucket producer (`usageDayView.ts`).** Today the
      chart resolves per-hour stack segments while `buildUsageDayBucketReadout` independently feeds the
      readout from the same bucket fields — the two reconcile because they share inputs plus the shared
      `SPLIT_KWH_EPSILON` predicates, not because there is one resolved value. Producing one resolved
      per-hour structure (segments + a single beforeSolar flag) in the bucket builder and passing it to
      both consumers would make the reconciliation structural (resolution-in-producer).
      *From PR #1806 review.*

- [ ] **Post-release docs updates for the managed/background split colours.** `docs/daily-budget.md`
      (Figure 2 caption, ~line 40) still describes the hourly-plan stack as blue/orange; the stack now
      renders slate/mint. Retake `docs/screenshots/daily-budget/hourly-plan.png` and
      `docs/screenshots/daily-budget/plan-progress.png` (the Budget hero now shows the split bar), and
      `docs/public/screenshots/landing-usage.png` (the Usage chart is now stacked), then fix the caption
      wording. Deliberately deferred out of PR #1806, which commits no PNGs.

- [ ] **Disambiguate PV clamp-suspect hours with the battery signal (battery-observe train).** The PV-gain
      net evidence (`classifyHourNetEvidence`, `packages/shared-domain/src/solar/pvGenerationHistory.ts`)
      deliberately conflates zero-export clamp / battery absorb / balanced load into one 'suspect' class —
      a charging home battery absorbs surplus, so a battery home's bright hours read suspect and only thin
      the unclamped training pool. Once battery devices are observed (managed & !controllable train), join
      the battery charge signal into the evidence producer so battery-absorb hours with real grid headroom
      classify unclamped again. *Persona:* prosumer with PV + home battery. *Hypothesis:* battery homes sit
      in the clamp-aware quantile mode (forced-low confidence) longer than their data warrants.

- [ ] **Decide confidence attenuation for the PV forecast at the surplus seam (curtailment-lane PR).** The
      clamp-aware quantile fit deliberately forces `confidence: 'low'`, but that signal is erased before it
      reaches consumers: `wireBudgetPrice`'s surplus provider reads `forecast()`, which emits kWh only
      (`setup/appServiceWiring.ts` → `PvForecastService.forecast`). For the TRUE zero-export home the P90
      potential IS the design intent (the forecast must claim the surplus the clamp hides, or the home never
      shifts load to uncover it). Decide in the curtailment-lane PR whether low-confidence forecasts should
      carry a discount before feeding surplus/budget-price consumers (the design's 0.9/0.8 dogfood-tunable
      factors), rather than baking a discount into the fit. *Persona:* prosumer whose budgetPrice consumers
      (live since #1808) plan against the forecast. *Hypothesis:* an undiscounted P90 forecast on a
      low-confidence fit occasionally overstates surplus and schedules load into hours the sun doesn't
      cover; the cost asymmetry (mild import vs staying curtailed) decides the factor.

- [ ] **Give the `pv_forecast_state` boot read an abandon-grace window.** `createPvForecastStore.read()`
      runs once in the PvForecastController constructor; a single transient-failed/empty settings read
      starts the service empty and the 5-minute persist timer then overwrites up to 90 days of recorded
      generation history. Pre-existing gap (the history was always re-learnable), but stakes are higher
      now: net-evidence accrual restarts too and every hour re-classifies from 'unknown', so a wipe drops
      a zero-export home back into the legacy median underestimate until evidence re-accrues. Follow
      `notes/persisted-settings-state.md`: treat an empty boot read as suspect for a grace window (or
      require a confirming read) before the first destructive persist. *Persona:* prosumer on a Homey Pro
      that restarts under memory pressure. *Hypothesis:* transient settings-read failures are common enough
      on the Homey SDK that a 90-day history will eventually be lost to a boot race.

- [ ] **Generation-guard the rescue-gate state commit in `loadStarvationRescuableDevices`.** `overviewRescueGate`
      now guards the *repaint* after a gate refresh, but the controller's
      `state.starvationRescuableDeviceIds = new Set(ids)` (`packages/settings-ui/src/ui/starvationRescue.ts`) still
      commits whichever overlapping `/ui_starvation_rescue_devices` response lands last. Two `plan_updated` events
      while Overview is visible can let an older response overwrite the set after a newer one, so a later live/power
      tick repaints the latest plan against a stale global set — briefly hiding a valid "Let it run now" chip or
      showing one that should have gone. Fix: a monotonic generation token captured before the await, committed only
      if still latest (mirror the repaint guard). Persona: Optimiser watching a budget-held device on Overview;
      hypothesis: a chip that flickers on/off across plan updates reads as a bug. P2 edge (needs overlapping gate
      loads; self-corrects on the next refresh). Same family: the chip's on-arm preview response
      (`BudgetExemptChip` in `PlanDeviceCards.tsx`) can also land late and overwrite cleared/re-armed state, so a
      stale `deadlineAtMs`/label could be shown or reused on a later confirm — guard it the same way. Source: codex +
      coderabbit on #1736, 2026-06-17.

- [ ] **Extract the settings-UI starvation-rescue handlers out of `setup/settingsUiApi.ts`.** The `get`/`preview`/
      `create` rescue handlers were added to the already multi-purpose `settingsUiApi.ts`; a dedicated rescue-wiring
      module would lower coupling and future churn. Pure refactor (no behaviour change). Persona: maintainer;
      hypothesis: the rescue surface will keep growing and is easier to evolve isolated. P2 maintainability. Source:
      coderabbit on #1736, 2026-06-17.

- [ ] **Gate the device-detail Price-response + Solar-surplus sections on `canManageDevice`, not just `resolveManagedState`.**
      Both sections (and the Price/Surplus Control toggles) gate visibility/enable on `resolveManagedState`
      (`deviceDetail/priceOpt.ts`, `deviceDetail/solarSurplus.ts`), but a device can be `managed` while
      `resolveDeviceDetailControlState().canManageDevice` is false (it still needs built-in device control activation).
      In that state the sections stay visible with editable deltas even though the action can't take effect. Persona: an
      owner mid-setup on a not-yet-controllable device; hypothesis: an editable control that silently does nothing reads
      as broken. P2 (pre-existing price-opt behaviour the surplus section mirrors; fix both together for consistency).
      Source: Codex on the surplus-absorb UI PR #1759, 2026-06-25.

- [ ] **Surplus-absorb: release the setpoint lift early when surplus is unambiguously gone, not only after a passing-cloud
      dip.** The eligibility gate (`lib/plan/admission/surplusAbsorb.ts`) holds a raised setpoint for the full
      `SURPLUS_ABSORB_MIN_DWELL_MS` (5 min) after engage even when whole-home power has gone stale/unknown
      (`!powerOk` → `underlyingSurplus = -Infinity`) or swung to sustained import — so a willing thermostat can import
      grid power for up to 5 min honouring the lift (the capacity layer still sheds it, but with headroom it draws). The
      dwell is the right guard for the genuine passing-cloud case (surplus dipped but still present); it over-holds the
      "sun set / meter stale" case. Fix: short-circuit the dwell floor on a hard-off condition (`!powerOk`, or import
      sustained past the settle window), keeping the dwell only when surplus is still positive but dipped. Persona:
      cost-conscious self-consumer on a fast-moving cloud day; hypothesis: a +2 °C water-tank lift held 5 min after the
      sun is gone reads as wasteful. P2 (bounded + capacity-subordinate; tune the semantics on real dogfood data).
      Source: pels-runtime-reality + adversarial review on the surplus-absorb backend PR, 2026-06-25.

- [ ] **Consolidate the per-device price-opt + surplus-absorb blob shape into one contract.** The
      `{ enabled, cheapDelta, expensiveDelta, surplusWilling?, surplusDelta? }` shape is now tracked independently in
      `lib/price/priceOptimizer.ts` (`PriceOptimizationSettings`), the inline copies in `planEngine.ts`/`planBuilder.ts`,
      the new `PriceOptDeviceConfig` in `lib/plan/planSurplusAbsorb.ts`, and the validator literal in
      `setup/priceOptimizationSettingsAdapter.ts`. The optional fields mean tsc won't catch a *missing* propagation when
      the blob next grows. Persona: engineer extending the price-opt/surplus blob; hypothesis: a future field-add
      silently desyncs one copy (the validator or a plan-side literal). P3 (pattern predates this PR; revisit once the
      surplus UI lands and the lib/plan ↛ lib/price local-copy convention can be re-evaluated). Source:
      pels-layering-guardian on the surplus-absorb backend PR, 2026-06-25.

- [ ] **Weather collector: transient miss of `weather_advisor_settings` silently halts sampling
      until the next restart or settings write.** `WeatherCollector.start()` registers no timers
      when the config blob reads absent/malformed, and nothing re-checks later (the hourly
      re-read in `sampleOnce` never runs because no timer exists). Persona: the Orchestrator running
      the hidden weather feature; hypothesis: one transient SDK read miss at boot costs a full
      day of temperature samples (unreconstructable for the live path) and the gap is only
      visible as a `partialTemp` day much later. Candidate fix: distinguish "blob present and
      disabled" (no timers, correct) from "blob unreadable" (schedule a bounded re-check).
      Source: pels-runtime-reality on the weather-collection PR, 2026-06-11.

- [ ] **MET fetch flattens 403/429 to a generic `failed` (no status-aware back-off).**
      `fetchMetForecast` maps every non-200 (and timeout) to `{outcome:'failed'}`, so a 403
      (banned User-Agent) and a 429 (rate-limited, possibly with `Retry-After`) are
      indistinguishable and get the same throttled-warn + keep-cache treatment. Persona: n/a
      (operational / MET ToS); hypothesis: harmless at today's ≤hourly Expires-gated cadence (a
      429 just keeps the cache and the next attempt is ≥1h out anyway), but a future faster cadence
      or a sustained 403 would benefit from distinct handling (surface a 403 as a louder "fix your
      User-Agent/contact" signal; honor `Retry-After` on 429). Candidate fix: carry the HTTP status
      on the `failed` outcome and branch the warn/back-off. Source: CodeRabbit on the MET PR,
      2026-06-14.

- [ ] **`normalizeMetForecast` trusts a persisted `fullDayCoverage` independent of `hourCount`.**
      Now that `fullDayCoverage` GATES the auto-apply active-day budget, a corrupted persisted cache
      claiming `fullDayCoverage:true` with a low `hourCount` (or vice-versa) would mis-gate. We only
      ever WRITE consistent pairs, so this is corruption-defense, not a live bug. Persona: n/a
      (robustness); hypothesis: negligible (the store is app-written), but cheap to harden a
      load-bearing flag. Candidate fix: on load, force `fullDayCoverage` false unless `hourCount`
      also clears the threshold (and the day includes its midnight hour), keeping the persisted flag
      consistent with its evidence. Source: CodeRabbit on the MET PR, 2026-06-14.

- [ ] **Weather: share the in-flight MET refresh with a near-simultaneous rollup.** When the app
      starts within seconds of the midnight rollup, the rollup's `refreshMetForecast` is skipped by
      the single-flight guard (same generation as the boot refresh already in flight) and may roll up
      on a not-yet-refreshed cache → the day falls to the `recent_days` persistence fallback. Bounded
      (one day), self-healing (the next refresh fixes it), and inert while auto-apply is off. Persona:
      an Orchestrator restarting the app near midnight; hypothesis: rare, and it self-heals at the next
      refresh, so the cost is at most one day on a recent-days budget instead of MET. Candidate fix:
      have an in-flight `refreshMetForecast` return/await the shared in-flight promise rather than
      skip, so the rollup observes the freshly-refreshed cache. Source: Codex on the MET PR, 2026-06-14.

- [ ] **Weather sub-page → Budget cross-link is a one-way trip.** The Weather insight sub-page's
      "See tomorrow's outlook in Budget" link opens the Budget weather detail view, but its Done
      button returns to the Budget plan view, not back to the sub-page the user came from —
      `openBudgetWeatherView()` sets no return target (unlike `budget-adjust`, which threads
      `adjustReturnTarget`). Persona: an owner exploring config who taps the cross-link; hypothesis:
      landing two surfaces from where they started mildly frays the "config here / payoff in Budget"
      bridge, though it's defensible since they explicitly chose Budget. Candidate fix: thread a
      referrer into `openBudgetWeatherView()` so Done returns to the Weather sub-page when that's the
      origin (Budget Tomorrow-card entry still returns to plan). Source: pels-ux-fit on the
      sub-page PR, 2026-06-13.

- [ ] **Auto-apply "Last applied" line uses an absolute date with no anchor to now.** The Weather
      sub-page shows `Last applied: 44 kWh on 12 Jun.` (`composeLastAutoApply`). Persona: an owner
      who turned auto-apply on and later checks it's healthy; hypothesis: for a feature that acts
      *every* day, a one-day-old absolute date can read as "did it stall?", and a genuinely stalled
      apply (device went unreadable for a week) looks identical to a fresh one. Candidate fix: resolve
      a relative cue in the producer (today / yesterday / N days ago) so a stalled auto-apply is
      spottable. When budget is OFF but a prior apply exists, consider annotating the line
      "— paused while the daily budget is off" so the inert hint + last-applied read as one story.
      Source: pels-ux-fit + pels-m3-critic on the auto-apply PR, 2026-06-13.

- [ ] **Weather confidence honesty: kill the chip gradation, show a prediction band, give the
      Tomorrow card three distinct exits, and let auto-apply abstain on low-trust days.** Today the
      confidence enum (`learning`/`low`/`medium`/`high`) drives a chip via
      `resolveWeatherConfidenceChip` that maps `low→Estimating`, `medium→Refining`, and — the bug —
      both `learning` AND `high` to `null`, so the *most* and *least* trustworthy states look
      identical (no chip), and the gradations in between aren't actionable to a user. Meanwhile the
      Tomorrow card shows the same confident number + verdict shape whether the fit is solid or thin,
      and auto-apply pushes the suggestion every day regardless of that day's trust. Personas: the
      Optimiser (a confident kW number on thin data destroys trust the moment they sanity-check it) and
      the Failing-scenario (recovering) visitor (a low-trust auto-apply can over-tighten the budget). Design direction
      (from the 2026-06-13 chip/correlation think): (a) drop the Estimating/Refining gradation; keep
      only a single reason-bearing "Rough estimate" chip when the fit is genuinely weak; (b) on the
      scatter, render the prediction as two dashed clamped rails (a band), coverage-flared at the
      sparse tails — NOT per-column background shading (correlation is a global property, not
      per-temperature) and NOT a filled cloud (the spec already bans fill as "mud at 320px"); (c)
      give the Tomorrow card three exits — Supported (clean number), Rough (number + range + the
      reason it's rough), and Can't-predict-yet (SUPPRESS the number and the verdict entirely;
      distinct from the S5 uncorrelated state); (d) have auto-apply abstain (keep current budget,
      annotate why) on a day whose forecast falls in a low-coverage temperature region. **Mock
      first** per the redesign rule — current-vs-proposed PNGs of the rails on the real noisy prod
      cloud + the three card states, signed off before code. Source: user chip/correlation think +
      low-R² investigation, 2026-06-13.

- [ ] **Temperature backfill cascade re-runs the whole kWh chain even when the records are
      unchanged.** On a completed temperature pass, `maybeStartBackfill` unconditionally strips
      `meterKwhBackfillDone` + `controlledBackfillVersion` (the `markDone` marker-strip destructure
      in `weatherCollector.ts`) so the meter and controlled-split backfills re-run — correct when a
      new device or a widened stitch
      actually changed the record set, but a temperature `TEMP_BACKFILL_VERSION` bump that produces
      byte-identical records still forces a full REST sweep of every managed device's meter Insights.
      Persona: the Orchestrator on an upgrade boot; hypothesis: bounded (the backfills are idempotent and
      validated, so the result is identical) but it's a redundant multi-device Insights sweep on every
      temp-version bump, and on a flaky-network boot each re-run is another chance to transiently
      fail. Candidate fix: cascade the marker strip only when `upsertBackfillRecords` reports the
      record set actually changed (diff the upsert, or hash the kWh-relevant fields), leaving the
      kWh markers latched when the re-stitch was a no-op. Source: self-review of the refit-once
      backfill change, 2026-06-13.

- [ ] **Give the armed budget-discard state a visible "keep changes" path.** The Budget header's
      two-step confirm shows only the destructive option ("Click again to discard"); the save path
      (Preview changes → Apply) is a sticky CTA further down, and the explanatory text lives in a
      hover-only `title` that touch users never see. Surface a one-line inline hint near the armed
      button (or render the armed moment as a Keep editing / Discard pair). Persona: returning
      Optimiser; hypothesis: a user who tapped Done absent-mindedly reads only "discard",
      assumes their edits are already lost, and re-enters them from scratch. Source: pels-ux-fit on
      the budget-settings-access PR, 2026-06-10.

- [ ] **Settings-referred Adjust session lacks the sibling "← Settings" back affordance.** Every
      Settings sub-page (Limits & safety, Devices, …) opens with a leading back chip; the Daily
      budget row instead lands on the Budget tab where the way back is a trailing "Done" whose
      destination is only in a hover `title`. When `adjustReturnTarget === 'settings'`, render the
      shared `.settings-back-button` affordance above the Budget header (it can coexist with Done).
      Persona: Set-and-forget owner; hypothesis: without the visible back affordance the
      tab-indicator jump (Settings → Budget) reads as "I got teleported", not "this is a sub-page of
      what I was doing". Source: pels-ux-fit, 2026-06-10.

- [ ] **Move the daily-budget breakdown chart toggle from Advanced to the Budget chart card.** After
      the tuning-selects retirement, Advanced ("Diagnostics, cleanup, logs, experiments") hosts a
      lone display preference — a scent mismatch on both ends. Put the toggle on the chart it
      controls (overflow or inline on the Budget chart card) and let Advanced be purely diagnostics.
      Persona: Optimiser; hypothesis: nobody looking at the budget chart
      thinks to open Advanced to change how the chart renders. Source: pels-ux-fit + pels-m3-critic,
      2026-06-10.

- [ ] **Hysteresis on `resolveSoftLimitSource` so the starvation rescue affordance doesn't flicker at the
      daily≈capacity crossover.** `lib/plan/planBuilder.ts:resolveSoftLimitSource` picks `daily` vs `capacity`
      from a per-cycle `Math.abs(daily - capacity) <= SOFT_LIMIT_EPSILON` comparison with no hysteresis and no
      `both` state. When the daily pace and capacity soft limit hover within epsilon, `softLimitSource`
      oscillates cycle-to-cycle; since the starvation cause now folds through it (`reattributeHeadroomShortfallCause`),
      a held device's overview bucket — and thus the "Let it run now" rescue button — can flicker budget↔capacity
      at that boundary. Persona: Optimiser running a tight daily budget near their capacity pace; hypothesis: a
      rescue button that appears and vanishes every few seconds reads as a bug and erodes trust. Candidate fix:
      add hysteresis (or a `both`-leaning-to-budget tiebreak) to `resolveSoftLimitSource`. Out of scope for the
      cause-classification fix (#1735) because it also moves the hero "Safe pace now" source label. Source:
      pels-runtime-reality on #1735, 2026-06-16.

- [ ] **Busy-gate the Budget header toggle (inherited apply race).** `onToggleClick` ignores
      `adjust.busy`: confirming a discard while an apply is in flight yields a post-navigation
      "Daily budget updated." toast and a lingering dirty status (workingDraft = pre-apply values vs
      newly-applied active). Pre-existing behavior (old single-click Done had the same race; the
      two-step confirm only adds friction), so not fixed in the access PR. Fix: disable the toggle
      while `busy`, or honor the `draftRevision` guard in `applyBudgetAdjust`'s success path the way
      preview already does. Persona: impatient Optimiser; hypothesis: rapid preview→apply→Done
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

- [ ] **Give the smart-task live schedule chart's encodings an on-chart decode path.** The
      schedule card's three encodings (price-tone colour, opacity = scheduled, changed-hour dot)
      have no legend; disclosure is scrub-readout-only. Hypothesis: a 4-word caption legend
      closes the first-read gap; persona: the Onboarding / Optimiser visitor who hasn't discovered
      scrubbing. Flagged for owner walk in the PR body. Files:
      `packages/settings-ui/src/ui/views/DeadlinePlan.tsx` (schedule card caption). Source:
      #1679 reviews, 2026-06-11.

- [ ] **Compose a real cause for the plain-miss history hero's "Why" line.** The fallback branch
      renders "Why: Didn't reach the target before the deadline." — circular (it restates the
      Missed outcome it annotates). Compose an actual cause the way the revised/refined miss
      paths already do (e.g. from delivered-vs-needed or the final plan snapshot). Persona:
      Failing scenario (recovering). Files: `packages/shared-domain/src/deferredPlanHistory.ts`
      (`formatPlanHistoryMissedReason` final fallback, ~line 402), rendered via
      `packages/settings-ui/src/ui/deadlinePlanHistoryDetailHero.ts`. Source: pels-ux-fit on
      PR #1681, 2026-06-11.

- [ ] **Add the "pause lower-priority devices" toggle to the create-smart-task widget.** The
      `pauseLowerPriorityDevices` rescue permission ships with a Flow entry (`allow_smart_task_rescue`)
      and full runtime behaviour (`lib/plan/shedding/pauseHold.ts`), but the create-smart-task widget
      (`widgets/create_smart_task/src/public/render.ts` + `src/api.ts`) still offers only the budget +
      limit toggles, so it can't be set at creation time from the widget. Add the third (ungated)
      toggle for parity, mapping to `'always'` like the others. Persona: Orchestrator. Needs
      pels-ux-fit + pels-m3-critic + a Playwright screenshot pass (mobile 480 px). Source:
      pause-lower-priority feature, 2026-07-01.

- [ ] **Damp the pause-hold re-shed with a recent-restore / hysteresis guard.** `resolvePauseHold`
      (`lib/plan/shedding/pauseHold.ts`) unions held ids straight into `sheddingPlan.shedSet` after
      `buildSheddingPlan`, so a re-shed skips the normal `recentlyRestored` /
      `RECENT_RESTORE_SHED_GRACE_MS` grace (`lib/plan/shedding/candidates.ts`). The shipped
      release-threshold (observed draw ≥ ~lowest step) removes the main flap driver, but a reserved
      device whose measured draw genuinely oscillates around the threshold could still churn ON→OFF
      on a just-restored lower-priority device (relay/compressor wear). Add a shed-side recent-restore
      guard so the hold honors the same grace the normal shed path applies. Source:
      pels-runtime-reality on the pause-lower-priority feature, 2026-07-01.

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
- [ ] **Split the `PelsApp` class so `app.ts` reaches <=500** — the last Bucket-B god-file still
      carrying a `max-lines` override (lowered 1907→1110 by the eslint-cleanup train, not deleted).
      Every other Bucket-B god-file was decomposed under 500 and its override deleted (the
      eslint-cleanup train, PRs #1786–#1796: deviceTransport 2261→491, restore/index 1340→379,
      registerFlowCards 1148→148, deviceDiagnosticsService 1200→320, plus planBuilder / planReasons /
      planService / planExecutor / steppedLoadExecutor / managerObservation / planDevices /
      activePlanRecorder / diagnosticsBridge / deferredPlanHistory(+Receipt) / powerDriven /
      appDebugHelpers). Remaining: `app.ts` is the `Homey.App` composition root (~40 service fields +
      the `implements AppContext` delegator surface + the smart-task widget API); reaching <500 needs
      splitting `PelsApp` into sub-controllers — a large entrypoint restructure, out of scope for the
      behavior-neutral exemption sweep. The `import-x/max-dependencies` overrides on `app.ts` (50) and
      `setup/appServiceWiring.ts` (30) — the two composition roots — are accountable here too.
      Persona: contributor.
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

- [ ] **Release spot-check: smart-task detail deep-link on a real phone.** PR #1807 removed the
      `.deadline-plan-panel` mobile-chrome top inset (vestigial since ce3357cf put the panel
      in-flow below the always-visible tab bar). Repo evidence says the back button clears
      Homey's app chrome; after this ships, open `?page=deadline-plan` on a real phone once to
      confirm and close the loop. Source: PR #1807 review gates (2026-07-01).

- [ ] **Device-detail hero: add a one-line live status under the device name.** The hero now hugs
      its content (PR #1807) but carries only eyebrow + name — an identity card. Add one line of
      live status (state + current draw, the same producer-resolved data the Overview card
      renders) to turn it into a confidence card ("is PELS seeing this device right now?").
      Source: PR #1807 review gates (2026-07-01).

- [ ] **Playwright stub: seeded smart-task data is internally inconsistent.** The
      `dev_connected300` fixture claims "Needs 12.0 kWh" and an on-track verdict, but the seeded
      learned rate (0.75 kW) × 6 picked hours cannot deliver 12 kWh. Fix the fixture so
      screenshot-gated reviews of the smart-task detail page are trustworthy — a reviewer
      reconciling the numbers today would flag a phantom bug (or miss a real one). Source:
      PR #1807 review gates (2026-07-01).

## P3 Future and Exploratory Work

*Entry bar: each item states a **hypothesis**, **why it's needed**, and the **persona**
(`notes/personas.md`) it serves. Items that can't name all three are maintainability/
cosmetic chores — do them in passing or drop them; don't park them here.*

- [ ] **Give pause-held devices their own shed reason instead of defaulting to `capacity`.**
      *Hypothesis:* a lower-priority device held off for a smart task surfaces on Overview / in logs as
      capacity-limited ("Above safe pace") because `resolvePauseHold` adds it to `shedSet` with no
      `shedReasons` entry, and `normalizeShedReasons` (`lib/plan/planReasons.ts`) defaults a
      reason-less shed to `{ code: capacity }`. *Why it's needed:* the cause is user-initiated (a
      paused-for-task hold), not raw capacity pressure, so the current label misattributes intent and
      confuses "why is this device off?". Add a producer-side pause reason code and route the copy
      through pels-copy-and-terminology (no "shed" / no "held back" — that's reserved for the budget
      widget). *Persona:* Set-and-forget owner / Orchestrator. Source: pels-runtime-reality on the
      pause-lower-priority feature, 2026-07-01.

- [ ] **Observe-only device wiring: extract it out of the recurring-ceiling god-files (`app.ts`, `deviceTransport.ts`).**
      *Persona:* Contributor (`notes/personas.md`) extending the observe-only-device family (battery, solar,
      and any future tracked-but-uncontrolled role) without re-tripping the `max-lines` ceilings.
      *Hypothesis:* the managed-observe-only feature spreads thin wiring across two Bucket-B god-files — the
      deviceId-only `isObserveOnlyRoleDevice`/`resolveManagedState`/`isCapacityControlEnabled` resolution in
      `app.ts`, and the producer fields + `observeBatteryStateFromList` + `note*Device` realtime top-ups in
      `lib/device/deviceTransport.ts`. Each new observe-only role nudges both ceilings up again (battery:
      app.ts 1900→1906, deviceTransport 2234→2250; solar: 1906→1907, 2250→2261), so the bumps are a smell, not
      a fix.
      *Why it's needed:* a small `ObserveOnlyDeviceRegistry` (owning the per-role producers + the membership-set
      resolution) would let app.ts/deviceTransport delegate instead of grow, and make the next role a localized
      add. Update: `deviceTransport.ts` was since decomposed to 491 lines with its `max-lines` override DELETED
      (eslint-cleanup train), so the deviceTransport-ceiling motivation no longer applies; this is now a cohesion
      improvement (and helps the remaining `app.ts` class-split above). Source: PR-D runtime-reality review, 2026-06-27.

- [ ] **Home battery: distinguish a real home battery from a controllable load mislabeled with the `homeBattery` energy role.**
      *Persona:* Orchestrator (`notes/personas.md`) running a third-party driver that sets
      `energy.homeBattery` on a device that is actually a controllable load.
      *Hypothesis:* `resolveDeviceClassKey` normalizes ANY device declaring the `homeBattery`
      energy role (or `class:'battery'`) to the `'battery'` class-key and forces it managed
      observe-only, so a misconfigured/mislabeled driver would make PELS silently stop controlling
      a load the owner expected it to manage.
      *Why it's needed:* the role/class signal is the only evidence today; an inferred edge with no
      known real instance, but if it occurs the failure is silent (no shed/restore, no warning). A
      guard could require a battery-specific capability (`measure_battery`) alongside the role before
      forcing observe-only, or surface a diagnostic when a `homeBattery`-flagged device also has a
      control capability. Source: PR-C flow-card-leak review, 2026-06-27.

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
      MET UI-cleanup scope decision, 2026-06-14.

- [ ] **Persist the device Activity-log so it survives a restart.**
      *Persona:* Orchestrator (`notes/personas.md`) — wants to debug their own setup over time.
      *Hypothesis:* the Activity-log recorder (`lib/plan/deviceOverviewLog.ts`, served via
      `/ui_device_log`) is session-only, so the log is empty after a restart; a persisted ring buffer
      would let the Orchestrator review what happened overnight.
      *Why it's needed:* the one surface that reconstructs per-device history is wiped on every boot.
      Needs the Homey-SDK transient-read grace pattern before persisting. A later cross-device "recent
      activity" feed on Overview is a possible follow-on if the per-device view proves used.
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
      *Persona:* Optimiser / Orchestrator (`notes/personas.md`) who expects
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

*Smart-task failure-investigation & live UX — the underserved Optimiser and the
Failing-scenario (acute/recovering) visitors (`notes/personas.md`).*

- [ ] **Deadline-hero "Need X kWh" shows the original requirement, not live remaining.**
      *Persona:* Optimiser (watches the plan progress and expects the number to tick
      down, and cross-checks remaining vs delivered).
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
      *Persona:* Failing scenario (acute) — reopens the app worried about a
      repeating deadline pattern, and lands on the *active* task, not history.
      *Hypothesis:* a 24 h breadcrumb sourced from the same postmortem resolver as history
      detail gives the prior-failure context on the surface they actually land on, without the
      Smart tasks → past row → detail navigation dance.
      *Why it's needed:* the persona most likely to reopen under stress is shown only current
      state today; the breadcrumb earns the visit. Related: `notes/smart-task-ui/README.md` Q2.
      Files: `packages/settings-ui/src/ui/deadlinePlanHero.ts`, `.../deadlinePlan.ts`
      (recent-miss query against `DeferredObjectivePlanHistoryEntry`).
- [ ] **Fold the revision-history panel into "What PELS has learned" at 320 px.**
      *Persona:* Orchestrator — expands cards to debug their own setup.
      *Hypothesis:* at 320 px the standalone collapsed panel costs ~80–96 px of chrome before
      any content; nesting "…and what changed since the plan was first written" inside the
      existing `PlanInputsCard` recovers that space and groups related debug info.
      *Why it's needed:* on the 320 px-min webview the extra card shell pushes the actual
      revision content below the fold, weakening the one surface this persona uses to
      reconstruct what changed. Files: `packages/settings-ui/src/ui/views/DeadlinePlan.tsx`,
      `PlanInputsCard`. Source: pels-m3-critic/ux-fit on PR #1197 (batches 1–3 shipped).
*EV charging — the Optimiser / EV commuter (`notes/personas.md`).*

- [ ] **EV deadline polish: manual override actions + imminent-deadline urgency rule.**
      *Persona:* Failing scenario (acute) with EV-commuter / Optimiser overlap —
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

*Usage & budget — the Orchestrator and Set-and-forget owner (`notes/personas.md`).*

- [ ] **Per-device usage history page with step-change context.**
      *Persona:* Orchestrator ("what did this device cost last week?") and Optimiser
      (per-device kWh/cost, did it run in cheap hours).
      *Hypothesis:* users debugging their own setup want measured kWh over time per device,
      and the number is uninterpretable without knowing which step/mode was active during each
      period — so the page needs step-change context to be trustworthy.
      *Why it's needed:* both personas' Usage rows in `notes/personas.md` ask for per-device
      drill-down PELS doesn't render today. Build the page and the 30-day hourly-retention
      per-device step-change tracker that feeds it together — the tracker is not shippable on
      its own. Files: future device-level step-change tracker; per-device usage-history route + chart.
*Planner accuracy for multi-device homes — the Optimiser (`notes/personas.md`).
Both are data-gated: act only when prod evidence shows the gap, else leave alone.*

- [ ] **Promote committed-task floor reservations beyond priority 1.**
      *Persona:* Optimiser with several managed devices — a deadline-committed device
      that isn't the single top-priority one.
      *Hypothesis:* floor promotion is gated on `priority === 1 && both rescue permissions ===
      'always'` because the reserved-headroom forecast (`hardCap − uncontrolled`) assumes every
      controlled watt is displaceable — true only at the very top. A richer forecast that also
      subtracts higher-priority controlled load (`hardCap − uncontrolled − higherPriorityControlled`)
      would let the gate broaden to "highest priority present on this Homey", so a default-priority
      committed device's rescue stops being budget-exemption-only and can claim a guaranteed floor.
      *Why it's needed:* today a non-top committed device can still `cannot_meet` while its rescue
      grant sits inert; the Optimiser with a mixed-priority home is the one who hits it. *Validate
      first:* pick up only if post-Slice-2 prod logs show a long-tail `cannot_meet` rate on
      non-top-priority tasks (user-confirmed the design is safe — it only sheds strictly
      lower-priority devices than the rescued one; the success flash stays honest meanwhile).
      Files: `lib/objectives/deferredObjectives/policyHorizon.ts`, `.../rescueReplan.ts`,
      `lib/dailyBudget/dailyBudgetBreakdown.ts`. Source: pels-runtime-reality on PR #983 / #1373.

*Demoted from P2 (2026-06-03 scrutiny pass) — real product / future-capability work with a
persona but no current support-cost pressure; reframed to the P3 bar.*

- [ ] **Miss-streak rollup on Overview.**
      *Persona:* Failing scenario (recovering) — reaches Overview from a notification, not via
      Smart-tasks.
      *Hypothesis:* `formatMissStreakAggregateLine` already renders on the Smart-tasks list but never
      reaches the Failing-scenario (recovering) visitor on Overview; a per-device miss chip/rail on Overview answers "is this the same
      task failing again?" on the surface they actually land on.
      *Why:* the highest-intensity persona lands where the data isn't. Needs a new Overview API field
      (history isn't fetched there today). Files: `packages/contracts/src/settingsUiApi.ts`,
      `packages/settings-ui/src/ui/views/PlanOverview.tsx`.
- [ ] **Per-device kWh + money column on Usage.**
      *Persona:* Optimiser.
      *Hypothesis:* Usage emits total kWh only while the smart-task hero and Budget already show kr, so
      the Optimiser can't answer "what did this device cost last week?"; a per-device kr column
      (`Σ priceValue × deviceKwh`, derivable today) closes it.
      *Why:* money visibility is exactly this persona's question; Usage is the one surface that withholds
      it. Needs a per-device kWh API field. Files: `packages/contracts/src/settingsUiApi.ts`,
      `packages/settings-ui/src/ui/usageHero.ts`, `.../usageStatsChartsEcharts.ts`.
- [ ] **Sticky/debounced `at_risk` smart-task rescue (phase 2).**
      *Persona:* Optimiser whose plan churns around the satisfied↔at_risk boundary.
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
      *Update (2026-07-01):* the unactionable-shortfall rebuild storm that had turned this ~1.4 s build
      cost into a `cpuwarn` crash-loop (background load over a low hard cap with nothing left to shed) is
      fixed by the rebuild-scheduler unactionable throttle. What remains here is the raw build latency
      (reactivity), not crash survival — memoize per-device `getPriorityForDevice`/`getShedBehavior` within
      a build and skip deferred-objective decoration when no objectives are enabled.
- [ ] **Add a CPU-pressure circuit breaker that throttles plan rebuilds before Homey's watchdog fires.**
      *Persona:* every persona — the app surviving CPU pressure instead of crash-looping.
      *Hypothesis:* Homey's `cpuwarn` signal (`lib/diagnostics/resourceWarnings.ts`) is logged but never
      feeds back into scheduling; wiring it via an injected sink into an escalating rebuild backoff would
      make the app self-throttle its most expensive periodic work for *any* future CPU-runaway cause, not
      just the unactionable-shortfall trigger already fixed. Keep actionable `hardCap` intents exempt so a
      genuine shed is never starved.
      *Why:* defense-in-depth backstop; the specific 2026-07-01 crash-loop trigger is fixed by the
      unactionable rebuild throttle, but no general guard exists. Files: `lib/diagnostics/resourceWarnings.ts`,
      `lib/plan/rebuildScheduler/`, `setup/backgroundTasksController.ts`, `app.ts`.
- [ ] **Tighten shortfall entry/clear detection during the unactionable rebuild throttle.**
      *Persona:* every persona watching the "limited" state settle after load changes.
      *Hypothesis:* while the unactionable throttle is active the throttled skip no longer drives
      `checkShortfall` at all (it used to, but that entered shortfall without a rebuild and could deadlock
      the unrecoverable-shortfall skip), so both shortfall *entry* and *clear* detection now ride the 30 s
      max-interval rebuild. A skip-path `checkShortfall` that only *progresses* state when already
      `isInShortfall` (never enters shortfall) would restore per-sample cadence without reintroducing the
      deadlock.
      *Why:* minor recovery-latency polish; bounded to the 30 s max-interval and inside the 60–300 s
      restore cooldown, so not a correctness issue. Files: `lib/plan/rebuildScheduler/powerDriven.ts`,
      `lib/power/capacityGuard.ts`.
- [ ] **Tighten shedding of newly-returned load during an unactionable throttle without reviving the storm.**
      *Persona:* every persona — the app reacting promptly when a managed device starts drawing again.
      *Hypothesis:* the 15 s execution floor is deliberately independent of the `measurePowerBecameSignificantlyPositive`
      invalidation latch (so a device flickering across the 5 W threshold under a hard-cap breach can't re-arm
      the one-shot latch each sample and revive the rebuild-storm). The cost is that a genuine device-return
      re-check can be delayed ≤15 s, and because the power-sample loop awaits the scheduled rebuild,
      `capacityGuard` updates pause for that window. A bounded mitigation (e.g. a capped consecutive-latch-bypass
      allowance, or making the sample loop not block on a deferred rebuild) would restore reactivity while
      keeping storm-safety.
      *Why:* bounded (≤15 s, inside the 60 s re-shed cooldown) and only in a state where nothing was sheddable
      anyway, so accepted for now; a cleaner reactivity/storm-safety balance is the follow-up. Files:
      `lib/plan/rebuildScheduler/powerDrivenScheduling.ts`, `lib/plan/rebuildScheduler/powerDriven.ts`,
      `setup/powerSamplePipeline.ts`, `lib/power/sampleIngest.ts`.
- [ ] **Model backup-hour reservations for committed smart-task schedules.**
      *Persona:* Optimiser with a tight deadline.
      *Hypothesis:* day-zero committed schedules degrade straight to `cannot_meet` with no backup-hour
      spill; modeling backup hours distinct from committed delivery hours (and reserving budget for them)
      would let a task that can't deliver in its committed hours use reserved capacity instead of failing.
      *Why:* future capability; `cannot_meet` is correct-but-blunt today. Files:
      `lib/objectives/deferredObjectives/horizonPlanner.ts`, `.../bucketAllocation.ts`,
      `notes/deferred-load-objectives/`.
- [ ] **Finish the starvation rollout beyond detection.**
      *Persona:* Orchestrator building their own automations.
      *Hypothesis:* starvation detection + the user-initiated rescue widget shipped, but there are no
      per-episode/duration flow triggers or insights coverage, so an Orchestrator can't react to starvation
      in their own Flows.
      *Why:* future product rollout against `notes/starvation/README.md`; the feature works without it.
      Files: `flowCards/**`, `drivers/pels_insights/**`, plan snapshot/contract wiring.
- [ ] **Rework device detail into focused Behavior / Setup / Diagnostics sections.**
      *Persona:* Orchestrator configuring a device, and support reading diagnostics.
      *Hypothesis:* device detail is one long mixed scroll (modes, deadline, price, limiting, stepped,
      boost, setup, control model, native wiring, SoC, diagnostics); a focused IA keeps common controls
      reachable and moves the dense read-only diagnostics surface off the primary path.
      *Why:* important setup controls feel hidden and the diagnostics surface is a dense support read at
      the bottom of operational controls — functional but unloved. Files:
      `packages/settings-ui/src/ui/deviceDetail/**`, device-detail e2e/screenshots.
- [ ] **Define the binary operating precondition for temperature-lowered devices.**
      *Persona:* Optimiser with a device that is both temperature- and binary-controllable.
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
- [ ] **Gate the budget chart money (kr) view on actual/projection cost, not just budget pace.**
      *Persona:* Optimiser on a partially-priced day looking at the Budget chart's kr view.
      *Hypothesis:* `resolveBudgetCostViewAvailable` checks only `budgetPaceCostCumMinor`; the producer
      nulls the three cost series independently from different increment arrays (`paceInc` vs
      `actualInc`/`projInc`), so a bucket with near-zero pace increment but un-priceable actual/projected
      energy can leave the pace series finite while nulling actual/projection — the kr view then renders
      with the actual or projection line silently missing.
      *Why:* degrades gracefully (a dropped line, never a wrong number) and needs partial intra-day
      pricing, which the dominant whole-day-priced Nordpool scheme never produces — hence P3, surfaced by
      PR-C adversarial review. *Validate first:* construct a partial-pricing fixture; a view-aware gate
      must still allow the legitimately-null projection on yesterday/tomorrow views. Files:
      `packages/settings-ui/src/ui/budgetRedesignChartData.ts` (`resolveBudgetCostViewAvailable`),
      `lib/dailyBudget/dailyBudgetProjection.ts`.
- [ ] **Re-document or retire `capped_idle`: its canonical device (Høiax Connected 300) is not actually cap-cycling.**
      *Persona:* Contributor (`notes/personas.md`) maintaining the idle classifier against the design-of-record.
      *Hypothesis:* `capped_idle` was designed around the Connected 300 as a device "cycling at a ~60 °C internal
      cap" (`notes/idle-classification.md` capped_idle row + "Why 20 min", and the `lib/observer/idleDetector.ts`
      docblock). Field logs show the device has **no** cap (it reaches ~90 °C) and a **fixed 6 °C hysteresis**, so
      it holds a *flat* 0 W (it does not cycle) down to ~setpoint−6 — which is exactly why the cycling-required
      `capped_idle` never fired and it fell to `unresponsive`. With the near-target band now widened to 6 °C
      (this PR) that device classifies as `near_target_idle`, so the documented canonical `capped_idle` example
      is false and the state's cycling trigger may have no known real instance.
      *Why it's needed:* the design-of-record now contradicts observed behaviour; either name a real device that
      genuinely cycles below target at an internal cap (and keep `capped_idle`), or retire the state. Not urgent —
      the band widening already routes the real device to the correct benign `near_target_idle`. Source: idle
      log-review + hysteresis investigation, 2026-06-29. Files: `notes/idle-classification.md`,
      `lib/observer/idleDetector.ts`, `packages/shared-domain/src/idleClassificationCopy.ts`.
