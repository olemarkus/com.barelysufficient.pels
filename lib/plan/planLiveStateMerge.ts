import type { DevicePlan, PlanInputDevice, SteppedClusterFields } from './planTypes';
import { withEvDiscriminant, withSteppedDiscriminant, withTemperatureDiscriminant } from './planTypes';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { isBinaryPlanDevice } from './planBinaryDevice';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { getSteppedLoadStep } from '../utils/deviceControlProfiles';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { resolveCurrentOn } from '../observer/observedState';
import { resolveObservedCurrentState } from './planCurrentState';
import { getPrimaryTargetCapability } from '../utils/targetCapabilities';
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
): SteppedClusterFields {
  if (isSteppedLoadDevice(live)) {
    return { steppedLoadProfile: live.steppedLoadProfile, planningPowerKw: live.planningPowerKw };
  }
  if (isSteppedLoadDevice(device)) {
    return { steppedLoadProfile: device.steppedLoadProfile, planningPowerKw: device.planningPowerKw };
  }
  return {};
}

export function buildLiveStatePlan(plan: DevicePlan, liveDevices: PlanInputDevice[]): DevicePlan {
  const liveById = new Map(liveDevices.map((device) => [device.id, device]));
  return {
    ...plan,
    // Keeping the live-plan merge in one place makes reconciliation easier to audit.
    devices: plan.devices.map((device) => {
      const live = liveById.get(device.id);
      if (!live) return device;
      const liveStepState = resolveLiveSteppedStepState(device, live);
      // The live snapshot's profile wins when present; otherwise keep the prior
      // device's. The merged literal spreads `...device` (a union) wholesale, so
      // `withSteppedDiscriminant` re-ties the discriminant into one variant —
      // stripping any stale `steppedLoadProfile` the spread carried over.
      // The cluster travels from ONE source. Previously the profile fell back
      // live->prior while `planningPowerKw` was read off `live` independently,
      // so a live device with no profile and a prior device with one produced a
      // prior profile paired with the live power — two devices' answers in one
      // stepped state. Taking the pair together makes that unrepresentable
      // (`SteppedClusterFields`).
      const steppedCluster = resolveMergedSteppedCluster(live, device);
      const mergedProfile = steppedCluster.steppedLoadProfile;
      const mergedCurrentState = resolveCurrentStateFromPlanInput(
        live,
        mergedProfile,
        liveStepState.selectedStepId,
      );
      const liveBinaryFields = resolveLiveBinaryFields(
        live,
        mergedProfile,
        liveStepState.selectedStepId,
      );
      // The EV cluster (`evBoost` / `evBoostActive` / `stateOfCharge`) is
      // orthogonal to the stepped axis and off the base, so the `...device`
      // spread does not carry it at the type level. Re-source it explicitly from
      // the prior plan device (which `...device` previously carried wholesale),
      // then regroup through `withEvDiscriminant`. The observed `evChargingState`
      // is re-sourced from the LIVE device (it is an observation, so the freshest
      // one wins), and `commandableNow` with it.
      // The temperature cluster (`currentTarget` / `currentTemperature`) is
      // orthogonal to the stepped axis and off the base, so the `...device`
      // spread does not carry it at the type level. Re-source `currentTarget`
      // from the live targets and `currentTemperature` from the live device
      // (narrowed), then regroup through `withTemperatureDiscriminant`.
      const liveTemperature = isTemperaturePlanDevice(live) ? live : null;
      return withSteppedDiscriminant(withTemperatureDiscriminant(withEvDiscriminant({
        ...device,
        commandableNow: live.commandableNow,
        evBoost: device.evBoost,
        evBoostActive: device.evBoostActive,
        stateOfCharge: device.stateOfCharge,
        ...steppedCluster,
        currentState: mergedCurrentState,
        currentTarget: getPrimaryTargetCapability(live.targets)?.value ?? null,
        selectedStepId: liveStepState.selectedStepId,
        desiredStepId: clampShedDesiredStepId(
          device,
          liveStepState.selectedStepId,
          mergedProfile,
        ),
        lastDesiredStepId: live.desiredStepId ?? device.lastDesiredStepId,
        lastStepCommandIssuedAt: live.lastStepCommandIssuedAt ?? device.lastStepCommandIssuedAt,
        stepCommandRetryCount: live.stepCommandRetryCount ?? device.stepCommandRetryCount,
        nextStepCommandRetryAtMs: live.nextStepCommandRetryAtMs ?? device.nextStepCommandRetryAtMs,
        reportedStepId: liveStepState.reportedStepId,
        currentTemperature: liveTemperature?.currentTemperature,
        expectedPowerKw: live.expectedPowerKw,
        expectedPowerSource: live.expectedPowerSource,
        currentDrawKw: live.currentDrawKw,
        binaryCommandPending: live.binaryCommandPending,
        // Deliberately NOT the producer's `!== false` collapse — for either
        // field. This is a MERGE, not a build: the plan device already carries a
        // resolved boolean, so an absent live value means "the live snapshot
        // says nothing", and the answer is the one already decided.
        //
        // The collapse is destructive in exactly the direction that matters. It
        // turns `undefined` into `true`, so a device the producer had resolved
        // as UNAVAILABLE becomes available the moment a live snapshot omits the
        // field, and one the owner had set unmanaged becomes managed. Absent is
        // not a report of availability, and a merge must not treat missing data
        // as a reset (`notes/persisted-settings-state.md`).
        available: live.available ?? device.available,
        zone: live.zone ?? device.zone,
        controllable: live.controllable ?? device.controllable,
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
      })));
    }),
  };
}

function resolveLiveSteppedStepState(
  previous: DevicePlan['devices'][number],
  live: PlanInputDevice,
): Pick<
  DevicePlan['devices'][number],
  'reportedStepId' | 'selectedStepId'
> {
  if (!isSteppedLoadDevice(live) && !isSteppedLoadDevice(previous)) {
    return {
      reportedStepId: undefined,
      selectedStepId: undefined,
    };
  }
  const liveState = normalizeSteppedLoadStepStateFromLegacyFields({
    fields: live,
    selectedStepFallbackIsPlanningAssumption: false,
  });
  const stepFields = serializeLegacyStepFields(liveState);
  return {
    reportedStepId: stepFields.reportedStepId,
    selectedStepId: resolveKnownEffectiveStepId(liveState) ?? live.selectedStepId ?? previous.selectedStepId,
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
