# Snapshot Decomposition — finishing the observer/transport split

Design-of-record for the last leg of the observer/transport split. **Supersedes
the deferred PR2b "snapshot store → observer" bullet** (that was the wrong handle —
moving the store wholesale is a risky dual-store with no behavior change). This is
the right handle: **move the observation *contract* to the observer, decompose the
god-struct, and seal the raw snapshot inside transport.**

> Status: **design + in progress.** Shipped so far: `lastDesiredStepChangeAt`
> cull (PR-1), step-command/planning cluster re-home onto `SteppedLoadDecoration`
> (PR-2, #1502), `temperatureBoost`/`evBoost` removed from `TargetDeviceSnapshot`
> (PR-3), `DeviceDescriptor` + `ObservedDeviceState` read interfaces with
> `TargetDeviceSnapshot` re-expressed as their intersection (PR-4, stage 3), and
> the observer-owned `ObservedDeviceState` projection stood up + shadow-verified
> with **zero consumer switch** (PR-4a, stage 4a — split out of stage 4). Next is
> **stage 4b / 5** — route real readers (wiring-side first, then plan/executor)
> onto the projection. Read
> [`observer-transport-split.md`](./observer-transport-split.md) +
> the device-state invariants digest in [`lib/device/AGENTS.md`](../../lib/device/AGENTS.md) first.

## The smell (why this exists)

`DeviceObservation` (`lib/device/deviceObservation.ts`; deleted in stage 5, kept here
as the smell it was) — the read contract plan + executor depended on — was **named for
the observer, titled "view over the snapshot store," but defined in `lib/device/` and
implemented only by `DeviceTransport`.**
Its own docstring says it was extracted "so the transport half can move later." That
move is the deferred half of the split: the seam exists, ownership never transferred.
So transport owns "observation"; `lib/observer/` is a sidecar of interpretation
helpers. The observer was created but never handed the observation contract.

`TargetDeviceSnapshot` is a **~58-field god-struct** read wholesale via
`getSnapshot()`, conflating five concerns. The fix isn't "who stores it" — it's
**decompose by concern, give each surface its owner.**

## Three surfaces (discriminator: does fresher-wins merging apply?)

1. **`ObservedDeviceState` → the observer** (curated, ~13 fields). Everything with a
   realtime in-place write path (a Homey event can change it): `currentOn`,
   `evCharging`/`evChargingState` (the latter now type-gated off the base onto
   `EvObservedFields`, narrowed via `isEvObserved` — owner seams carry it through
   the `EvObservedProbe` widening; EV-observed slice of the discriminated-types
   refactor), `stateOfCharge` (now type-gated off the base onto
   `StateOfChargeObservedFields`, narrowed via the presence-only
   `hasObservedStateOfCharge` — presence proves the SoC bag object, NOT
   `status === 'fresh'`; the bag keeps its own `status`, so consumers retain their
   freshness gates after narrowing; owner seams carry it through the
   `StateOfChargeObservedProbe` widening), `temperature` (type-gated off the base
   as an atomic `{ currentTemperature, target }` facet on
   `TemperatureObservedFields`, narrowed via the presence-only
   `hasObservedTemperature`. Presence proves both the exact `target_temperature`
   and `measure_temperature` observations are finite; malformed or incomplete
   input omits the whole facet while independent binary/stepped facets remain.
   Owner seams carry the complete pair through the `TemperatureObservedProbe`
   widening),
   `measuredPowerKw`/`measuredPowerObservedAtMs` (now type-gated off the base onto
   `MeasuredPowerObservedFields`, narrowed via the presence-only
   `hasObservedMeasuredPower` — absence is the common case ON THE SNAPSHOT, so the
   guard draws the present/absent line and "present implies finite, non-negative kW"
   is the producer invariant; the two fields travel together and owner seams carry
   them through the `MeasuredPowerObservedProbe` widening. Absence stops here: the
   producer seams (`toPlanDevice`, `withHeadroomCurrentOn`,
   `buildResidualKwForPlanDevice`, `buildExecutableObservedDeviceStateFromSnapshot`)
   resolve it once into the REQUIRED `currentDrawKw` carried by the plan device, the
   executor's observed state, the objectives sample contract, and the settings-UI
   `DeviceOverviewSnapshot` — the meter's reading, or 0 — so no plan, executor,
   objectives or UI consumer ever decides what an absent draw means, or asks how the
   producer knew. **One consumer still reads the raw cluster, for PRESENCE only:**
   `lib/power/sampleIngest.ts` must EXCLUDE an unmetered device from the per-device
   energy buckets rather than book it at 0, because those buckets double as the Usage
   tab's per-device membership list and a 0 there is a claim about the device. It reads
   presence and nothing else — the per-capability age gate that used to sit beside it
   is retired (Homey reports on change, so an old `lastUpdated` means "nothing has
   happened")),
   `reportedStepId`/`reportedStepPowerW`/`reportedStepObservedAtMs` (now type-gated
   off the base onto `ReportedStepObservedFields`, narrowed via the presence-only
   `hasObservedReportedStep` — a non-stepped device never reports a step and a
   stepped one carries it only once a native/flow report lands; exact target-power
   evidence carries finite watts together with its observation timestamp; owner
   seams carry the cluster through the `ReportedStepObservedProbe` widening;
   stepped-observed slice of the discriminated-types refactor),
   `binaryControlObservation`, `available`,
   `lastFreshDataMs`/`lastLocalWriteMs`/
   `lastUpdated`, plus the observed `targets` value. This is the consolidated truth
   plan/executor decide on.
2. **`DeviceDescriptor` → a descriptor read (NOT observer)** (static-ish): identity +
   config + capabilities — `controlModel`, semantic binary-control availability, `controlAdapter`,
   `deviceClass`/`deviceType`/`zone`, `steppedLoadProfile`/`targetPowerConfig` (now
   type-gated OFF the base onto `SteppedLoadDescriptorFields`, narrowed via
   `isSteppedLoadSnapshot` — `steppedLoadProfile` IS the kind discriminant, and its
   PRESENCE is the whole test. The profile carries no tag at all: `model:
   'stepped_load'` was deleted 2026-08-12 because `DeviceControlProfile` is a union
   of one, so the tag discriminated nothing and every comparison against it on an
   already-typed value was a presence check in costume. The `unknown` parse boundary
   `normalizeSteppedLoadProfile` decides stepped-ness from the ladder shape alone,
   and that is where a second profile model would be discriminated.
   It is the single runtime definition of that
   discriminant: `lib/plan`'s `isSteppedLoadDevice` and the `withSteppedDiscriminant`
   regrouper both delegate to it and own only the plan-layer narrowing; `targetPowerConfig` rides the same cluster; owner seams and
   the decorator carry them through the `SteppedLoadDescriptorProbe` widening;
   stepped-descriptor slice of the discriminated-types refactor),
   `suggestedSteppedLoadProfile` (STAYS on the base — a CONFIGURE hint for non-stepped
   devices, not part of the stepped cluster), `nativeWriteCapabilities`, `flowConflict`,
   `capabilities`, `flowBacked*`, `canSetControl`,
   `powerCapable`, `controllable`/`managed`/`budgetExempt`/`priority`, the nameplate
   power hints (`expectedPowerKw`/`loadKw`/`expectedPowerSource` — `powerKw` was
   deleted as a duplicate of `expectedPowerKw`, and the surviving two are now
   REQUIRED). Consumed
   by settings-UI, native-wiring, `isRuntimePlannedDevice`. Never realtime-merged, so
   peeling it off de-risks the observer surface (UI re-renders can't race the merge).
3. **Planning projection → resolved in `toPlanDevice`/producer, off the snapshot
   entirely.** `planningPowerKw` is already off the snapshot (DEAD-SNAP); the
   observer surface carries **no** planning projection.

`toPlanDevice` (`setup/appInit/toPlanDevice.ts`) is the existing "snapshot → curated
projection" seam (builds `PlanInputDevice`). Post-split it takes
`(descriptor, observedState)` instead of one `TargetDeviceSnapshot`, and the
`...device` spread becomes explicit field copies.

## CORRECTION (Slice-1 implementation finding): there is a SECOND producer

The original audit checked only the **transport** parse/merge/realtime pipeline and
concluded the step-command/planning fields were dead. **That was wrong.** A second
producer writes them onto the snapshot *after* `getSnapshot()`:

`setup/appDeviceControlHelpers.ts`'s `decorateSnapshotWithDeviceControl`
returns a `TargetDeviceSnapshot` with `targetStepId`, `selectedStepId`,
`desiredStepId`, `previousStepId`, `planningPowerKw`, `lastStepCommandIssuedAt`,
`stepCommandRetryCount`, `nextStepCommandRetryAtMs`, `stepCommandPending`,
`stepCommandStatus`, `lastDesiredStepChangeAt` written on it for stepped-load devices.
`AppHostApi.latestTargetSnapshot` in `setup/appHostApi.ts` returns the **decorated** list; `getPlanDevices` →
`toPlanDevice`'s explicit stepped-field projection (`setup/appInit/toPlanDevice.ts`) carries those live values
into `PlanInputDevice` (which independently declares the same fields). And they ARE
read off the decorated snapshot by `setup/appInit/residualKwForPlanDevice.ts`
(`selectedStepId` and `planningPowerKw`) and `setup/appInit/calibrationViews.ts`
(`planningPowerKw`).

So these fields are **path-dependent**: *live* on the decorated planner path, *dead*
on the raw executor path (`buildObservedSteppedLoadState` reads `selectedStepId` off the
undecorated `getSnapshot()`, always undefined). A blind type-level cull is unsafe.

**Update (`refactor/stepped-intent-desired-only`):** the executable stepped intent is now
desired-only — the old `planningCurrentOn` / `planningCurrentStepId` current-state fields were
removed. Current state is producer-resolved: `resolveSteppedLoadCurrentFallback(planDevice)`
resolves the effective on/step once on the plan device and the dispatch loop passes it to the
projection, so the executor never re-derives a planning fallback off the (desired-only) intent.
Deliberately, the raw dispatch observed step is **left real-evidence-only** —
`observed.steppedLoad.stepId` stays undefined on the undecorated `getSnapshot()` path (NOT joined
from the effective `selectedStepId`). That keeps the stepped shed-release trusted-evidence gate a
no-op until a real SDK report arrives, instead of letting a planning-assumed step satisfy it. This
does NOT move `selectedStepId` off `TargetDeviceSnapshot` — the broader decoration rework below is
still the path-origin fix.

**Update (2026-07-25, flow reports admitted while off):** the *separate* suppression that dropped
non-off **flow** step reports while the binary axis read off is gone. It lived in two places —
`AppDeviceControlHelpers.reportSteppedLoadActualStep` (ingest) and `resolveReportedStepEvidence`
(decoration) — and it cost a prod incident: an Easee charger reverts its dynamic current to 32 A at
charging-session start and announces it over the flow card, but that announcement lands while PELS
still reads the binary axis as off (the on-echo trailed the write by 17-37 s on that device, so every
session-start report fell inside the window). The planner kept crediting a 6 A / 1.38 kW shed for a
charger drawing 7.36 kW, which produced a false hard-cap shortfall and a resume that breached the cap.
Flow reports are now admitted on the same terms as native ones, which were never suppressed.

This does **not** contradict the real-evidence-only paragraph above: a flow `report_stepped_load_power`
card IS a real report, and the thing that paragraph protects against is a *planning-assumed* step
satisfying the gate. The two also cannot collide, because they apply to disjoint device sets — the
suppression only ever fired for a device whose `binaryControl.on === false`, and `binaryControl` exists
iff the observer resolved a binary control axis, while stepped shed-release dispatch runs only for a
device without that semantic binary axis (`shedReleaseActuation.ts`).
Pinned by `test/integration/shedReleaseActuation.test.ts` ("never dispatches a stepped release for a
binary-capable device observed off at a non-off step"). **If that routing condition ever changes, the
admission needs its own "does PELS want this device on?" gate before the shed-release dispatch.**

The binary axis still owns the on/off fold (`resolveCurrentOn` is `!(binaryOff || steppedOff)`), so a
non-off observed step on an off device does not resurrect it, and restore sizing still reads the step
being restored *to* (`restore/accounting.ts`), never the observed step — an observed 32 A must not
inflate `neededKw` and deadlock the restore.

**This is the actual mess** (sharper than "god-struct"): `TargetDeviceSnapshot` is
doing double duty — transport's observed snapshot **and** the app-layer's
**decoration carrier** that launders step-command/planning state into the planner via
the spread. The fields aren't dead; they originate on the *wrong type*.

### Revised cull verdict
- **`lastDesiredStepChangeAt`** — written by the decorator (`appDeviceControlHelpers.ts:183`),
  read nowhere. The ONLY genuinely-dead field. Safe standalone delete (drop field + that write line).
- **Step-command/planning cluster** (`selectedStepId`, `planningPowerKw`, `targetStepId`,
  `desiredStepId`, `previousStepId`, `lastStepCommandIssuedAt`, `stepCommandRetryCount`,
  `nextStepCommandRetryAtMs`, `stepCommandPending`, `stepCommandStatus`) — NOT removable
  by cull. The fix is the **decoration rework**: make them originate on `PlanInputDevice`
  (or a dedicated decorated type), not on `TargetDeviceSnapshot`. This is a prerequisite
  of, not independent from, the surface split below.
- **`temperatureBoost`, `evBoost`** — DONE (PR-3): removed from `TargetDeviceSnapshot`.
  The backend never populates them on the snapshot — the planner sources boost via
  `toPlanDevice`'s explicit `ctx.get*BoostConfig` onto `PlanInputDevice` (which carries its
  own canonical `TemperatureBoostConfig`/`EvBoostConfig` fields), and the decorator/transport
  never set them. The only consumers were settings-UI: (a) the carrier's indexed-access types
  in `settingsUiApi.ts`, repointed straight to the canonical config types, and (b) the
  device-detail boost handlers (`deviceDetail/{evBoost,temperatureBoost}.ts`), which keep an
  **optimistic mirror** of boost config on the live device object (authoritative source is
  `state.{ev,temperature}BoostSettings`). That mirror now lives on a settings-UI-local
  `SettingsUiDeviceView = DecoratedDeviceSnapshot & { temperatureBoost?; evBoost? }` (in
  `state.ts`), not on the shared snapshot contract. tsc-clean (root + settings-UI), no behavior
  change.
- **`devicePowerCalibrationStore.ts:432`** (`stepCommandPending`) is a **latent
  always-false guard on the undecorated path** — flag, do not silently fix.

**Implication for sequencing:** there is no independent "Slice 1 dead-field cull." The
real first substantive slice is the **decoration rework** (below, was Slice 6) —
re-home the planner-carrier fields off `TargetDeviceSnapshot`. Only `lastDesiredStepChangeAt`
can be deleted standalone.

## Pushed-projection is safer than the dual-store (constraint assessment)

The merge stays in transport; observer can't import transport; observer is fed by the
injected `observedStateDispatcher` push. So the curated read is a **maintained
projection, not a pull** — and that's *safer* than the rejected dual full-snapshot
store, because:
- The dispatcher pushes **per-field deltas** (`{deviceId, capabilityId, changes[],
  observedAtMs, observationSeq?}`), not a whole-array copy — no parallel array to
  silently diverge/roll back.
- The projection is **narrow + derived**: ~13 fields that already fire dispatcher
  events; the observer only **records what transport's fresher-wins already decided**,
  never re-runs the merge, so it can't disagree — only lag by one event (tolerated by
  the existing reapply cadence).
- Residual risk is **ordering**, not divergence: apply events in `observationSeq`/
  `observedAtMs` order, ignore out-of-order/dupes. Gate the observer-move slice on
  sequenced idempotent apply + a replay-out-of-order regression test.

## Staged migration (low → high risk)

1. **Cull `lastDesiredStepChangeAt`** (zero everything). Trivial first slice.
2. **Remove the DEAD-SNAP cluster** from `TargetDeviceSnapshot` (neutralize the 3
   always-undefined snap reads behavior-preservingly; flag the 2 latent guards).
   ~20% struct shrink, no behavior change.
3. **Introduce `DeviceDescriptor` + `ObservedDeviceState` read interfaces** — DONE (PR-4).
   Both defined in `packages/contracts/src/types.ts`; `TargetDeviceSnapshot` is now their
   intersection (`DeviceDescriptor & ObservedDeviceState`), so the god-struct can't drift
   from the partition — adding a field forces a descriptor-vs-observation decision. `id`/`name`
   live on both as the join key. Transport keeps producing the full snapshot; `DeviceObservation`
   / `getSnapshot()` unchanged (still the transitional read seam).
   **Reader repointing was deliberately scoped to one seam** — `lib/observer/observationFreshness.ts`
   narrowed its input to `Pick<ObservedDeviceState, 'lastFreshDataMs' | 'lastLocalWriteMs'>`.
   *(That module is gone as of 2026-08-29: timeout-based device staleness was removed
   outright — `lib/observer/AGENTS.md`. The narrowing precedent it set still stands.)*
   The other named seams were inspected and intentionally deferred: `isRuntimePlannedDevice`
   (`setup/appDeviceSupport.ts`) is already structurally narrower than `DeviceDescriptor`
   (takes `{ managed? }`); the executor projection readers
   (`lib/executor/executablePlanProjection.ts`) read ACROSS both surfaces (`controlModel` +
   observed fields) so they can't narrow to `ObservedDeviceState` until stage 5; settings-UI
   consumes `DecoratedDeviceSnapshot` wholesale (descriptor + observed) and narrows later. Drawing
   the line here kept PR-4 to two files with the intersection alias doing the structural work.
4. **Move `ObservedDeviceState` onto the observer**, fed by the dispatcher push
   (gate: sequenced apply + replay test). Transport keeps `latestSnapshot` as the
   parse/merge scratchpad + descriptor source. *(highest-risk slice — split 4a/4b)*
   - **4a — DONE (PR-4a):** stood up `lib/observer/observedDeviceStateProjection.ts`
     fed by the dispatcher push, with **zero consumer switch** (shadow-verified only).
     The events now carry the *decided* `ObservedDeviceState` value (enriched once at
     transport's `dispatchObservedStateChanged` funnel), and a new full-refresh batch
     event fires from `commitRefreshedSnapshot` after `setSnapshot` (so the abandon-grace
     deferral never emits it). Apply is sequenced (per-device `observationSeq` primary,
     `observedAtMs` defensive fallback) + idempotent + prunes vanished devices. Shared
     refresh-event types + `projectObservedState` live in `packages/contracts`. Gate met:
     replay-out-of-order + dedup + cold-start + interleave/no-rollback + abandon-grace +
     prune + targets-aliasing + shadow-equality tests, all via the Homey SDK boundary.
     Shared refresh-event *types* live in `packages/contracts`; the `projectObservedState`
     *function* lives in `lib/device/observedStateProjection.ts` — runtime functions can't
     live in `packages/contracts/src/**` (deploy-excluded source; runtime may only
     `import type` from it, enforced by `test/integration/runtimePackaging.test.ts`).
   - **4b — IN PROGRESS:** route real readers onto the projection (wiring-side observed
     reads first). **Status correction (2026-09-08):** the "first reader" named below was
     superseded twice and then deleted with the concept, so it no longer demonstrates
     anything. The readers that DO exist were wired later and from the other end:
     the settings-UI state-of-charge read now goes through the observer's resolved
     `readObservedStateOfCharge` (#2322), `/ui_devices` serves a resolved level rather
     than the transport bag (#2322), and `AppContext` grew one named read per observed
     cluster with `getObservedState` narrowed to carry none of them (#2326). All three
     prereqs below are paid: the epoch hazard by co-creating the projection with the
     transport, the by-reference hazard by `freezeObserved` (deep-frozen for the nested
     state-of-charge objects), and the enrichment ordering by deferring the events and
     flushing after the commit. **Historical, superseded:** `toPlanDevice`
     (`setup/appInit.ts`) resolved `observationStale` from `ctx.getObservedState(id)` (the projection's maintained truth)
     instead of the snapshot's freshness fields, falling back to the snapshot only for the
     boot window before the first observation lands (identical values there).
     **Superseded:** `observationStale` was subsequently removed from the plan kinds entirely
     (the plan trusts producer-resolved control state and must not distrust observer data), so
     `toPlanDevice` no longer resolves it. The projection-reader pattern this stage established
     stands for the remaining observed fields. **Superseded again (2026-08-29):** the concept
     itself is gone — no timeout ages a device observation out anywhere, so idle classification,
     the overview gray-state, and starvation counting read the last trusted value directly
     (`lib/observer/AGENTS.md`).
     The test seam
     `DeviceTransport.setSnapshotForTests` now mirrors the production refresh funnel
     (`setSnapshot` + `dispatchObservedStateRefresh`) so the whole suite exercises the
     projection-fed reader rather than the fallback. All three prereqs below were paid first.
     **Before any reader is wired**, address the in-process-restart hazard: the
     projection shares the `PelsApp` lifecycle today, but the `set deviceManager` AppContext
     seam could swap transport in-process and reset its seq counter while the long-lived
     projection holds high seqs → it would silently drop post-swap deltas. Tie the
     drop-guard to a transport epoch (or co-recreate the projection with the transport).
     Also: `getObservedState`/`getAllObservedStates` return the stored value **by
     reference** — a consumer that mutates it would corrupt the projection; return a copy
     (or freeze) when the first reader is wired. **Third:** the device-update path enriches
     the observed value from `latestSnapshotById` *before* `syncRealtimeDeviceUpdateSnapshot`
     commits the freshly-parsed snapshot, so the projection lags one device-update-only
     change until the next capability event or full refresh re-seeds it (Codex P2 on PR-4a).
     Harmless while shadow-only (refresh self-heals), but a reader must see the committed
     value: move the device-update enrichment to *after* the sync (mind the
     `preservePreviousSnapshot` invalid-binary-payload edge — enrich from the committed,
     not the parsed, snapshot). Plan/executor reads convert in stage 5.
5. **Convert plan + executor reads** from `DeviceObservation` → observer's
   `ObservedDeviceState` — **DONE.** The executor's device read is
   `readExecutorDevice` / `readExecutorDevices` (`lib/executor/executorDeviceRead.ts`):
   the descriptor (`getDeviceDescriptor` on `AppHostApi`, surface 2 from stage 6.5)
   joined per device with the observer's record (`getObservedState`). `PlanExecutorDeps`
   lost `deviceManager`; the binary-control decision's one observed read is
   `getObservedBinaryControl` (`ObservedBinaryControlRead`, the projection's binary
   axis); `PlanExecutorSteppedContext.observation` turned out to have no reader and
   went with it. `DeviceObservation` is deleted and both cruiser rules tightened:
   `no-executor-to-device-internals` allows the executor nothing from `lib/device`,
   `no-plan-to-device` only the two producer seams.
   Faithfulness: every observed field the executor reads was already load-bearing on
   the projection — `targets` (slice 2), `binaryControl` (slice 3, the optimistic-write
   dispatch), the reported step / measured power / EV state (the drift check) — except
   one. `available` is not a capability, so it has no per-capability event: it changes
   only when a re-parsed `device.update` REPLACES the entry, and that path emitted an
   observation event only for a control-state change or a temperature / state-of-charge
   facet. A grep for in-place `.available =` writes could not see the replacement; review
   did. `handleRealtimeDeviceUpdateEvent` now dispatches for the device when the commit
   flipped `available` and nothing else was emitted, so the executor no longer keeps
   writing to a device Homey marked unreachable (or skips one that came back) for up to
   a poll interval. (The executor reads none of `lastFreshDataMs`, `lastLocalWriteMs`,
   `binaryControlObservation` or the `*ObservedAtMs` stamps, so their dispatch behaviour
   is not load-bearing here.) The descriptor half is the transport's
   own truth, so it has no faithfulness question — but it had a LEAK question, found
   in review: the join is a spread, and a spread copies what the object physically
   carries, so a descriptor that was the raw snapshot under a narrower type would
   have handed the executor every observed key the projection did not override.
   `projectDeviceDescriptor` (`lib/device/deviceDescriptorProjection.ts`, sibling of
   `projectObservedState`) is what closes it: every descriptor read on `AppHostApi`
   now serves a fresh object carrying exactly the keys of `DeviceDescriptorRead`, a
   key list gated at the type level. A device with either half missing
   is unreadable this cycle — the same answer dispatch already gave for a device absent
   between planning and dispatch. It never happens for a tracked device: the
   projection subscribes to the emitter before the bootstrap refresh
   (`wireDeviceTransport.ts`), so the first committed snapshot's refresh batch lands in
   it, and every realtime add dispatches enriched after its commit; the boot seed
   (`seedMissing`, run before every plan build) is a belt over those braces.
6. **Convert `toPlanDevice` to `(descriptor, observed)`**; replace `...device` spread
   with explicit copies; `getPlanDevices` zips the two.
## The API layer has no home

Surfaced while doing 6.4, and worth stating because it will keep recurring.

The settings-UI payload assembly is a CONSUMER of the domain, not part of it. It
belongs to neither layer it can currently be filed under:

- `lib/**` is domain. A settings-UI DTO spanning decorated control state, mode
  priorities, transport-owned car associations and observed state is not a domain
  concept, and filing it under whichever domain will accept its imports —
  `lib/observer` was tried and reverted — hides peer dependencies behind injected
  callbacks without making them that domain's concerns.
- `setup/**` is wiring, and holds no domain logic by rule. The assembly is
  projection over domain values, which the rule names explicitly.

So it sits in `setup/settingsUiApi.ts` today because there is nowhere else, which
is the same failure the no-domain-logic rule describes, one layer up. That rule
already says what to do about it: *"A file needing two domains at once is a
concept nobody has named."* The unnamed concept here is the API layer itself —
`api.ts` at the root is its only acknowledged surface, and the payload builders
that feed it live in `setup/`.

Naming it (an `api/` peer that may import `lib/**` and `packages/**`, that
`setup/` wires and that nothing in `lib/` may import) is a migration, not a file
move: it needs a dependency-cruiser peer entry, the AGENTS.md layer table, and
the `setup/settingsUi*` payload modules moved together. Out of scope for the
decomposition stages, but it is why 6.4's builder sits where it does.

6.4. **One owner for the settings-UI device list** — DONE. `/ui_devices` used to
   assemble its payload in four sequential passes over the whole device list
   (`withAssociatedCars` → `withLiveObservedState` → `withResolvedPriorities` →
   `withResolvedStateOfCharge`), each allocating a fresh object per device, spread
   across `setup/settingsUiApi.ts`. Nothing named the assembled thing, so the cost
   of a payload read was not answerable from any one place and a fifth pass was
   the natural way to add a field. `buildSettingsUiDeviceList`
   (`lib/observer/settingsUiDeviceList.ts`) does it once, with the order stated:
   priorities resolve up front because ranking is relative, everything else is
   per-device. The projection is looked up ONCE per device rather than twice —
   the state-of-charge read now takes the record rather than the id.
   Behaviour-preserving by construction, including the two absences that are
   deliberately no-ops: a device with no projection entry keeps its stored parse
   (permanent for an unmanaged picker row, which the projection drops), and a
   field the projection omits keeps its stored value. Both pinned in
   `test/unit/settingsUiDeviceList.test.ts`. `setup/settingsUiApi.ts` drops from
   806 to 674 lines and no longer names `DecoratedDeviceSnapshot`,
   `ProjectedObservedDeviceState` or `TargetDeviceSnapshot` at all.

6.5. **Descriptor read for the callers that never wanted an observation** — the
   stage this staging was missing. Stage 3 introduced `DeviceDescriptor` as a
   *type* with no owner behind it, so stage 7's clearing list had no route: an
   audit of the 42 external `getSnapshot()` pullers found most of the Flow cards
   resolve a device by id and filter on descriptor predicates
   (`deviceClass`, `controlAdapter`, `targetPowerConfig`) — pulling a ~58-field
   god-struct array to read a name and a config flag.
   `DeviceDescriptorRead` (`DeviceDescriptor & SteppedLoadDescriptorProbe`) +
   `getFlowDeviceDescriptors()` serve them. **DONE for four cards**
   (`deviceSettingsCards`, `expectedPower`, `steppedLoadFlowCards`,
   `evChargingPhaseCard`) — checkable as zero `deps.getSnapshot()` remaining in
   those four files, which is the condition to re-run when adding a fifth; `deadlineObjectiveCards`, `headroomAndEvSocCards` and
   `steppedLoadReport` genuinely read observations (`targets`, `stateOfCharge`,
   `reportedStepId`) and convert with stage 5.
   The narrowing was DECLARATIVE at first — the served objects still physically
   carried the observations — which was enough to stop consumers *reading* them.
   Stage 5 made it physical (`projectDeviceDescriptor`), because its join spreads
   the descriptor and a spread is not a read.

7. **Seal `getSnapshot()` inside transport** once no external caller remains; cruiser-
   enforce. External pullers to clear first: the `app.ts` composition callbacks,
   `AppHostApi`/`AppRuntimeApi`, `setup/flowConflictProbe`, and
   `setup/appDebugHelpers`. The executor and plan-layer pullers are gone (stage 5),
   and the descriptor reads already live with their owner
   (`readDeviceDescriptor(s)` in `lib/device/deviceDescriptorProjection.ts`, over the
   two snapshot lookups; `AppHostApi` only delegates). Sealing `getSnapshot()` leaves
   them as the descriptor's only exit — they are what stage 7 keeps, not what it
   clears.

## Invariants the implementation + tests must preserve

- Fresher-wins authority stays in transport (`managerObservation.ts`); the observer
  projection only records the decided value — never re-merges.
- Empty/missing-read abandon-grace stays transport-side (`shouldDeferEmptySnapshotCommit`).
- Realtime in-place mutations must surface to the projection as deltas (not lost
  between full refreshes).
- No `observer → device`/`power` edge; descriptor/observed reach observer-side via
  injection/push, never a concrete transport import.
- The capacity-guard power-sample path stays decoupled (per PR2a — poll return value,
  not the observer holder).

## Consumer-import gate (the other axis: keep the raw snapshot from escaping)

Separate from decomposing the producer, an ESLint `no-restricted-imports` gate keeps
the raw `TargetDeviceSnapshot` **name** from being imported by consumer layers — they
must take the decomposed halves (`ObservedDeviceState` / a `DeviceDescriptor` Pick) or
a discriminated/read-model carrier. dependency-cruiser can't police this (the type is
one export among many in a shared file; type edges erase post-compile), so `importNames`
is the only honest gate — same mechanism as the homey-leaf ban. Sealed surfaces:

- **Runtime consumers** (`SNAPSHOT_CONSUMER_DIRS` in `eslint.config.mjs`): `lib/objectives/**`,
  `lib/plan/**`, `lib/executor/**` (PRs #1635 / #1637).
- **Settings-UI source** (`SETTINGS_UI_SNAPSHOT_FORBID_PATTERN`): the whole browser surface,
  migrated surface-by-surface onto read-model carriers — list/detail (`SettingsUiDeviceListItem`
  / `SettingsUiDeviceDetailItem` in `deviceUtils.ts`), price-opt + control-profiles (the
  `SettingsUiDeviceView` store type), deadline-plan (plain `ObservedDeviceState`). Tests are
  excluded — they legitimately build snapshot fixtures. The settings-UI group glob differs from
  the runtime one because the UI imports contracts by a relative `../../../contracts/src/types.ts`
  path (no `packages/` segment, keeps `.ts`).

`DecoratedDeviceSnapshot` is deliberately **not** banned in the settings-UI: it backs the
store type (`SettingsUiDeviceView` in `state.ts`) and the device-payload ingest
(`getTargetDevices`) — the UI's own producer boundary. Dissolving that structural embedding
(decompose `SettingsUiDeviceView` onto the carriers) is the remaining deeper follow-up.
