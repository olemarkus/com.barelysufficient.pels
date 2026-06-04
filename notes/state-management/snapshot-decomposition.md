# Snapshot Decomposition — finishing the observer/transport split

Design-of-record for the last leg of the observer/transport split. **Supersedes
the deferred PR2b "snapshot store → observer" bullet** (that was the wrong handle —
moving the store wholesale is a risky dual-store with no behavior change). This is
the right handle: **move the observation *contract* to the observer, decompose the
god-struct, and seal the raw snapshot inside transport.**

> Status: **design + in progress.** Slice 1 (dead-field cull) first. Read
> [`observer-transport-split.md`](./observer-transport-split.md) +
> [`CLAUDE.md`](./CLAUDE.md) first.

## The smell (why this exists)

`DeviceObservation` (`lib/device/deviceObservation.ts`) — the read contract plan +
executor depend on — is **named for the observer, titled "view over the snapshot
store," but defined in `lib/device/` and implemented only by `DeviceTransport`.**
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
   `evCharging`/`evChargingState`, `stateOfCharge`, `currentTemperature`,
   `measuredPowerKw`/`measuredPowerObservedAtMs`, `reportedStepId`,
   `binaryControlObservation`, `available`, `lastFreshDataMs`/`lastLocalWriteMs`/
   `lastUpdated`, plus the observed `targets` value. This is the consolidated truth
   plan/executor decide on.
2. **`DeviceDescriptor` → a descriptor read (NOT observer)** (static-ish): identity +
   config + capabilities — `controlModel`, `controlCapabilityId`, `controlAdapter`,
   `deviceClass`/`deviceType`/`zone`, `steppedLoadProfile`,
   `suggestedSteppedLoadProfile`, `nativeWriteCapabilities`, `flowConflict`,
   `targetPowerConfig`, `capabilities`, `flowBacked*`, `canSetControl`,
   `powerCapable`, `controllable`/`managed`/`budgetExempt`/`priority`, the nameplate
   power hints (`powerKw`/`expectedPowerKw`/`loadKw`/`expectedPowerSource`). Consumed
   by settings-UI, native-wiring, `isRuntimePlannedDevice`. Never realtime-merged, so
   peeling it off de-risks the observer surface (UI re-renders can't race the merge).
3. **Planning projection → resolved in `toPlanDevice`/producer, off the snapshot
   entirely.** `planningPowerKw` is already off the snapshot (DEAD-SNAP); the
   observer surface carries **no** planning projection.

`toPlanDevice` (`setup/appInit.ts:335`) is the existing "snapshot → curated
projection" seam (builds `PlanInputDevice`). Post-split it takes
`(descriptor, observedState)` instead of one `TargetDeviceSnapshot`, and the
`...device` spread becomes explicit field copies.

## CORRECTION (Slice-1 implementation finding): there is a SECOND producer

The original audit checked only the **transport** parse/merge/realtime pipeline and
concluded the step-command/planning fields were dead. **That was wrong.** A second
producer writes them onto the snapshot *after* `getSnapshot()`:

`lib/app/appDeviceControlHelpers.ts:172-189` `decorateSnapshotWithDeviceControl`
returns a `TargetDeviceSnapshot` with `targetStepId`, `selectedStepId`,
`desiredStepId`, `previousStepId`, `planningPowerKw`, `lastStepCommandIssuedAt`,
`stepCommandRetryCount`, `nextStepCommandRetryAtMs`, `stepCommandPending`,
`stepCommandStatus`, `lastDesiredStepChangeAt` written on it for stepped-load devices.
`app.ts:1841 latestTargetSnapshot` returns the **decorated** list; `getPlanDevices` →
`toPlanDevice`'s `...device` spread (`setup/appInit.ts:382`) carries those live values
into `PlanInputDevice` (which independently declares the same fields). And they ARE
read off the decorated snapshot: `residualKwForPlanDevice.ts:97,135` (`selectedStepId`),
`:102` (`planningPowerKw`), `calibrationViews.ts:61` (`planningPowerKw`).

So these fields are **path-dependent**: *live* on the decorated planner path, *dead*
on the raw executor path (`executablePlanProjection.ts:187` reads `selectedStepId` off
the undecorated `getSnapshot()`, always undefined). A blind type-level cull is unsafe.

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
- **`temperatureBoost`, `evBoost`** — not written/read on a snapshot at runtime (sourced
  by `toPlanDevice`'s explicit `ctx.get*BoostConfig`), BUT
  `packages/contracts/src/settingsUiApi.ts:156,158` reference them via indexed-access
  types (`TargetDeviceSnapshot['temperatureBoost']`). Removing breaks that contract type
  — a separate, small, decision-gated change, not a behavior-preserving cull.
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
3. **Introduce `DeviceDescriptor` + `ObservedDeviceState` read interfaces**;
   `DeviceTransport` implements both (it already produces all fields). Repoint UI/
   native-wiring/`isRuntimePlannedDevice` → descriptor; observer/executor readers →
   observed. `DeviceObservation` stays as a transitional union.
4. **Move `ObservedDeviceState` onto the observer**, fed by the dispatcher push
   (gate: sequenced apply + replay test). Transport keeps `latestSnapshot` as the
   parse/merge scratchpad + descriptor source. *(highest-risk slice)*
5. **Convert plan + executor reads** from `DeviceObservation` → observer's
   `ObservedDeviceState`.
6. **Convert `toPlanDevice` to `(descriptor, observed)`**; replace `...device` spread
   with explicit copies; `getPlanDevices` zips the two.
7. **Seal `getSnapshot()` inside transport** once no external caller remains; cruiser-
   enforce. External pullers to clear first: `app.ts` (×5), `setup/flowConflictProbe`,
   `lib/executor/{binaryExecutor,binaryControlDispatch,targetExecutor,planExecutor}`,
   `lib/app/appDebugHelpers`, and the plan-layer `DeviceObservation` consumers.

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
