import type { DevicePlan, PlanInputDevice, SteppedClusterFields, TemperatureClusterFields } from './planTypes';
import { withSteppedDiscriminant, withTemperatureDiscriminant } from './planTypes';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { isBinaryPlanDevice } from './planBinaryDevice';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { getSteppedLoadStep } from '../utils/deviceControlProfiles';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { resolveCurrentOn, resolveObservedCurrentState } from '../observer/observedState';
import {
  normalizeSteppedLoadStepStateFromLegacyFields,
  resolveKnownEffectiveStepId,
  serializeLegacyStepFields,
} from './planSteppedLoadState';

/**
 * Merges live observations onto a plan snapshot, producing a refreshed snapshot
 * for publication and for use as the next build's base. Observed fields are
 * overwritten (`currentState`, `selectedStepId`, `powerKw`, `currentOn`,
 * `currentTarget`, …); the decisions — `plannedState`, `shedAction`,
 * `plannedTarget` — are carried through, because this is a projection, not a
 * re-plan.
 *
 * TWO deliberate exceptions, both about not letting a stale reference become a
 * command:
 * - `desiredStepId` is clamped DOWN by `clampShedDesiredStepId` when a shed
 *   device has already reached or passed its planned step. Left alone, the stale
 *   intermediate value reads as a step-UP and the executor restores the device.
 * - The step command-history fields (`lastDesiredStepId`,
 *   `lastStepCommandIssuedAt`, `stepCommandRetryCount`,
 *   `nextStepCommandRetryAtMs`) prefer the live values. They are execution
 *   bookkeeping, not decisions; the freshest copy is the correct one.
 *
 * The asymmetry is the reason this module must never grow a "should we
 * re-actuate?" predicate: its output is by construction the OLD decision seen
 * freshly, so acting on it would re-assert a plan nobody re-decided. Whether
 * observed still disagrees with intent is `lib/executor/executorConvergence.ts`.
 */
/**
 * The stepped cluster for a merged device, taken from ONE source: the live
 * device if it is stepped, else the prior plan device, else absent.
 *
 * The profile used to fall back live->prior while `planningPowerKw` was read off
 * `live` independently, so a live device with no profile and a prior device with
 * one produced a PRIOR profile paired with the LIVE power — two devices' answers
 * inside one stepped state. Taking the pair together makes that unrepresentable.
 */
function resolveMergedSteppedCluster(
  live: PlanInputDevice,
  device: DevicePlan['devices'][number],
): { cluster: SteppedClusterFields; reportedStepId: string | undefined } {
  if (isSteppedLoadDevice(live)) {
    // The live device's step evidence, resolved through the typed stepped-state
    // adapter: a live reported step wins; otherwise the live producer-resolved
    // effective step. The whole triple travels from this ONE source.
    const liveState = normalizeSteppedLoadStepStateFromLegacyFields({
      fields: live,
      selectedStepFallbackIsPlanningAssumption: false,
    });
    return {
      cluster: {
        steppedLoadProfile: live.steppedLoadProfile,
        selectedStepId: resolveKnownEffectiveStepId(liveState) ?? live.selectedStepId,
        planningPowerKw: live.planningPowerKw,
      },
      reportedStepId: serializeLegacyStepFields(liveState).reportedStepId,
    };
  }
  if (isSteppedLoadDevice(device)) {
    return {
      cluster: {
        steppedLoadProfile: device.steppedLoadProfile,
        selectedStepId: device.selectedStepId,
        planningPowerKw: device.planningPowerKw,
      },
      // The reported step is an OBSERVATION, so the live device's answer wins
      // even when the prior device supplies the cluster: a live snapshot with
      // no report clears the stale evidence rather than carrying it forward.
      reportedStepId: live.reportedStepId,
    };
  }
  return { cluster: {}, reportedStepId: undefined };
}

/**
 * The temperature cluster for a merged device, from ONE source: the LIVE device.
 *
 * Observations (`currentTarget` / `currentTemperature`) are re-sourced from the
 * live atomic facet; the DECISION (`plannedTarget`) is carried from the prior
 * plan device, because this is a projection, not a re-plan. A device that
 * became temperature since the plan was built has no decision yet — planned ===
 * current is the no-op materialization of "no decision" (the executor's fence
 * skips it). A device whose live snapshot LOST the facet leaves the temperature
 * branch entirely (the merged `deviceType` is re-sourced from live, so the
 * regrouper strips the cluster) — there is no partial temperature state to
 * carry, matching the observer's atomicity invariant.
 */
function resolveMergedTemperatureCluster(
  live: PlanInputDevice,
  device: DevicePlan['devices'][number],
): TemperatureClusterFields {
  if (!isTemperaturePlanDevice(live)) return {};
  const priorPlannedTarget = isTemperaturePlanDevice(device) ? device.plannedTarget : undefined;
  return {
    currentTarget: live.currentTarget,
    currentTemperature: live.currentTemperature,
    plannedTarget: priorPlannedTarget ?? live.currentTarget,
  };
}

/**
 * "Is PELS turning this device on right now, unconfirmed?" — answered by
 * `PendingBinaryCommandStore.hasActiveTurnOn`, reached through the engine.
 *
 * A resolved boolean, not the pending record: this module must not re-derive
 * the rule, or the republished device can disagree with the one the builder
 * just decided. That is not hypothetical — the producer used to stamp this bit
 * onto `PlanInputDevice` under a rule of its own (any direction, not a turn-ON),
 * and the merge copied it, so a device's `binaryCommandPending` changed meaning
 * on republish.
 *
 * Required, not optional: an omitted reader would default to "nothing in
 * flight", the more favourable answer, and that is the fabrication the boundary
 * rules forbid.
 */
export type PendingBinaryCommandRead = (deviceId: string) => boolean;

export function buildLiveStatePlan(
  plan: DevicePlan,
  liveDevices: PlanInputDevice[],
  hasPendingBinaryTurnOn: PendingBinaryCommandRead,
): DevicePlan {
  const liveById = new Map(liveDevices.map((device) => [device.id, device]));
  return {
    ...plan,
    // Keeping the live-plan merge in one place makes reconciliation easier to audit.
    devices: plan.devices.map((device) => {
      const live = liveById.get(device.id);
      if (!live) return device;
      // The live snapshot's cluster wins when present; otherwise keep the prior
      // device's. The merged literal spreads `...device` (a union) wholesale, so
      // `withSteppedDiscriminant` re-ties the discriminant into one variant —
      // stripping any stale stepped fields the spread carried over. The whole
      // TRIPLE (profile / selectedStepId / planningPowerKw) travels from ONE
      // source — mixing two devices' answers inside one stepped state is
      // unrepresentable (`SteppedClusterFields`).
      const mergedStepped = resolveMergedSteppedCluster(live, device);
      const steppedCluster = mergedStepped.cluster;
      const mergedProfile = steppedCluster.steppedLoadProfile;
      const mergedSelectedStepId = steppedCluster.selectedStepId;
      const mergedCurrentState = resolveCurrentStateFromPlanInput(
        live,
        mergedProfile,
        mergedSelectedStepId,
      );
      const liveBinaryFields = resolveLiveBinaryFields(
        live,
        mergedProfile,
        mergedSelectedStepId,
      );
      // `commandableNow` comes from the LIVE device (it is an observation, so
      // the freshest one wins). The boost DECISION is not re-sourced here and
      // must not be: it rides `...device` like every other decision this merge
      // carries through untouched.
      // The temperature cluster is orthogonal to the stepped axis and off the
      // base, so the `...device` spread does not carry it at the type level.
      // Re-source it as a unit from the live device (`resolveMergedTemperatureCluster`)
      // and re-source `deviceType` from live alongside it, so the discriminant
      // and the cluster cannot drift apart in the merged snapshot.
      // `residualKw` rides in on the spread, from the plan it was resolved
      // against — deliberately, and unlike the inputs re-sourced below. It is
      // read only during plan build, on freshly built devices, never off a
      // merged snapshot, so restore admission cannot see the stale value. Do
      // not read it from here without re-resolving it first.
      return withSteppedDiscriminant(withTemperatureDiscriminant({
        ...device,
        commandableNow: live.commandableNow,
        deviceType: live.deviceType,
        ...steppedCluster,
        currentState: mergedCurrentState,
        ...resolveMergedTemperatureCluster(live, device),
        desiredStepId: clampShedDesiredStepId(
          device,
          mergedSelectedStepId,
          mergedProfile,
        ),
        lastDesiredStepId: live.desiredStepId ?? device.lastDesiredStepId,
        lastStepCommandIssuedAt: live.lastStepCommandIssuedAt ?? device.lastStepCommandIssuedAt,
        stepCommandRetryCount: live.stepCommandRetryCount ?? device.stepCommandRetryCount,
        nextStepCommandRetryAtMs: live.nextStepCommandRetryAtMs ?? device.nextStepCommandRetryAtMs,
        reportedStepId: mergedStepped.reportedStepId,
        expectedPowerKw: live.expectedPowerKw,
        expectedPowerSource: live.expectedPowerSource,
        currentDrawKw: live.currentDrawKw,
        // Re-read from the command store through the SAME predicate the builder
        // uses (`planDevices.ts` → `hasActiveTurnOn`). Refreshing it here is the
        // point of this path — a confirmed command must stop reading as pending
        // — but it has to refresh to the answer a rebuild would give.
        binaryCommandPending: hasPendingBinaryTurnOn(device.id) || undefined,
        available: live.available,
        zone: live.zone ?? device.zone,
        controllable: live.controllable,
        stepCommandPending: live.stepCommandPending ?? device.stepCommandPending,
        stepCommandStatus: live.stepCommandStatus ?? device.stepCommandStatus,
        // Re-fold the on/off truth against the merged step/profile, using the
        // producer-resolved `live.currentOn` as the binary signal — NOT the raw
        // `binaryControl` (which no longer rides on the plan kinds). A live snapshot
        // can lack the stepped profile while still reporting the selected step; in
        // that case `live.currentOn` is exactly the binary axis (no stepped fold),
        // so recombining it with the preserved profile keeps `currentState`/
        // `currentOn` consistent with the merged device.
        ...liveBinaryFields,
      }));
    }),
  };
}

// For shed stepped-load devices, clamp desiredStepId down to the merged selectedStepId when the
// device has reached or passed its planned target. Without this, a stale desiredStepId from an
// intermediate shed step causes the executor to fire a step-UP command (inadvertent restore).
// Receives the already-merged profile and selectedStepId so the comparison uses the same values
// as the returned plan device.
function clampShedDesiredStepId(
  device: DevicePlan['devices'][number],
  mergedSelectedStepId: string | undefined,
  mergedProfile: SteppedLoadProfile | undefined,
): string | undefined {
  if (!device.desiredStepId || !mergedSelectedStepId || device.plannedState !== 'shed') {
    return device.desiredStepId;
  }
  if (!mergedProfile) return device.desiredStepId;
  const desiredStep = getSteppedLoadStep(mergedProfile, device.desiredStepId);
  const selectedStep = getSteppedLoadStep(mergedProfile, mergedSelectedStepId);
  if (!desiredStep || !selectedStep) return device.desiredStepId;
  // The device has shed further than planned (selectedStep power ≤ desiredStep power).
  // Clamp to the actual position to prevent the stale reference from becoming a restore signal.
  if (selectedStep.planningPowerW <= desiredStep.planningPowerW) return mergedSelectedStepId;
  return device.desiredStepId;
}

function resolveCurrentStateFromPlanInput(
  liveDevice: PlanInputDevice,
  mergedProfile: SteppedLoadProfile | undefined,
  mergedSelectedStepId: string | undefined,
): string {
  // Recompute the four-valued label against the MERGED step/profile, feeding the
  // producer-resolved `live.currentOn` in as the binary signal (the raw
  // `binaryControl` no longer rides on the plan input). When the live snapshot
  // lacked the profile, `live.currentOn` is exactly the binary axis; when it had
  // it, `{ on: currentOn }` still resolves to the same merged label. The producer
  // emits the CONCRETE latched label and never folds staleness into 'unknown', so
  // this recompute agrees with `toPlanDevice` (both concrete/latched).
  return resolveObservedCurrentState({
    ...(isBinaryPlanDevice(liveDevice) ? { binaryControl: { on: liveDevice.currentOn } } : {}),
    steppedLoadProfile: mergedProfile,
    selectedStepId: mergedSelectedStepId,
  });
}

function resolveLiveBinaryFields(
  liveDevice: PlanInputDevice,
  mergedProfile: SteppedLoadProfile | undefined,
  mergedSelectedStepId: string | undefined,
): { currentOn?: boolean } {
  if (!isBinaryPlanDevice(liveDevice)) return {};
  return {
    // Recombine the binary signal (`live.currentOn`) with the merged stepped
    // profile, so a device whose live snapshot dropped its profile still folds the
    // preserved off-step. No raw `binaryControl` needed.
    currentOn: resolveCurrentOn({
      binaryControl: { on: liveDevice.currentOn },
      steppedLoadProfile: mergedProfile,
      selectedStepId: mergedSelectedStepId,
    }),
  };
}
