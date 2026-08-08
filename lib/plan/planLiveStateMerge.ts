import type { DevicePlan, PlanInputDevice } from './planTypes';
import { withEvDiscriminant, withSteppedDiscriminant, withTemperatureDiscriminant } from './planTypes';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { isEvPlanDevice } from './planEvDevice';
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
export function buildLiveStatePlan(plan: DevicePlan, liveDevices: PlanInputDevice[]): DevicePlan {
  const liveById = new Map(liveDevices.map((device) => [device.id, device]));
  return {
    ...plan,
    // Keeping the live-plan merge in one place makes reconciliation easier to audit.
    // eslint-disable-next-line complexity -- wide live/prior field merge; ?? fallbacks + discriminant re-tie inherent
    devices: plan.devices.map((device) => {
      const live = liveById.get(device.id);
      if (!live) return device;
      const liveStepState = resolveLiveSteppedStepState(device, live);
      // The live snapshot's profile wins when present; otherwise keep the prior
      // device's. The merged literal spreads `...device` (a union) wholesale, so
      // `withSteppedDiscriminant` re-ties the discriminant into one variant —
      // stripping any stale `steppedLoadProfile` the spread carried over.
      const mergedProfile = (isSteppedLoadDevice(live) ? live.steppedLoadProfile : undefined)
        ?? (isSteppedLoadDevice(device) ? device.steppedLoadProfile : undefined);
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
      // then regroup through `withEvDiscriminant`. The flat EV plug-state
      // sub-fields (`evBlockReason` / `evSessionInactive` / `evChargerNotResumable`)
      // are base fields re-sourced from the live device so the producer-resolved
      // decisions follow the freshest observation. Runtime values are byte-identical.
      const evDevice = isEvPlanDevice(device) ? device : null;
      // The temperature cluster (`currentTarget` / `currentTemperature`) is
      // orthogonal to the stepped axis and off the base, so the `...device`
      // spread does not carry it at the type level. Re-source `currentTarget`
      // from the live targets and `currentTemperature` from the live device
      // (narrowed), then regroup through `withTemperatureDiscriminant`.
      const liveTemperature = isTemperaturePlanDevice(live) ? live : null;
      return withSteppedDiscriminant(withTemperatureDiscriminant(withEvDiscriminant({
        ...device,
        commandableNow: live.commandableNow,
        commandableNowReason: live.commandableNowReason,
        evBlockReason: live.evBlockReason,
        evSessionInactive: live.evSessionInactive,
        evChargerNotResumable: live.evChargerNotResumable,
        evBoost: evDevice?.evBoost,
        evBoostActive: evDevice?.evBoostActive,
        stateOfCharge: evDevice?.stateOfCharge,
        steppedLoadProfile: mergedProfile,
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
        powerKw: live.powerKw,
        expectedPowerKw: live.expectedPowerKw,
        planningPowerKw: live.planningPowerKw,
        expectedPowerSource: live.expectedPowerSource,
        currentDrawKw: live.currentDrawKw,
        controlCapabilityId: live.controlCapabilityId,
        binaryCommandPending: live.binaryCommandPending,
        available: live.available,
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
    controlCapabilityId: liveDevice.controlCapabilityId,
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
