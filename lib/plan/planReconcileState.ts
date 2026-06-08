import type { DevicePlan, PlanInputDevice } from './planTypes';
import { withEvDiscriminant, withSteppedDiscriminant } from './planTypes';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { isEvPlanDevice } from './planEvDevice';
import { getSteppedLoadStep } from '../utils/deviceControlProfiles';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { resolveObservedCurrentState } from './planCurrentState';
import { isObservedOff, isObservedOn } from '../observer/observedState';
import { getPrimaryTargetCapability } from '../utils/targetCapabilities';
import {
  normalizeSteppedLoadStepStateFromLegacyFields,
  resolveKnownEffectiveStepId,
  serializeLegacyStepFields,
} from './planSteppedLoadState';
import { hasPlanDeviceExecutionDrift } from '../executor/planExecutionDrift';

export function buildLiveStatePlan(plan: DevicePlan, liveDevices: PlanInputDevice[]): DevicePlan {
  const liveById = new Map(liveDevices.map((device) => [device.id, device]));
  return {
    ...plan,
    // Keeping the live-plan merge in one place makes reconciliation easier to audit.
    // eslint-disable-next-line complexity
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
      // The EV cluster (`evBoost` / `evBoostActive` / `stateOfCharge`) is
      // orthogonal to the stepped axis and off the base, so the `...device`
      // spread does not carry it at the type level. Re-source it explicitly from
      // the prior plan device (which `...device` previously carried wholesale),
      // then regroup through `withEvDiscriminant`. The flat EV plug-state
      // sub-fields (`evBlockReason` / `evSessionInactive` / `evChargerNotResumable`)
      // are base fields re-sourced from the live device so the producer-resolved
      // decisions follow the freshest observation. Runtime values are byte-identical.
      const evDevice = isEvPlanDevice(device) ? device : null;
      return withSteppedDiscriminant(withEvDiscriminant({
        ...device,
        evBlockReason: live.evBlockReason,
        evSessionInactive: live.evSessionInactive,
        evChargerNotResumable: live.evChargerNotResumable,
        evBoost: evDevice?.evBoost,
        evBoostActive: evDevice?.evBoostActive,
        stateOfCharge: evDevice?.stateOfCharge,
        steppedLoadProfile: mergedProfile,
        currentState: resolveCurrentStateFromPlanInput(device, live),
        currentTarget: getPrimaryTargetCapability(live.targets)?.value ?? null,
        observationStale: live.observationStale ?? device.observationStale,
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
        currentTemperature: live.currentTemperature,
        powerKw: live.powerKw,
        expectedPowerKw: live.expectedPowerKw,
        planningPowerKw: live.planningPowerKw,
        expectedPowerSource: live.expectedPowerSource,
        measuredPowerKw: live.measuredPowerKw,
        controlCapabilityId: live.controlCapabilityId,
        binaryCommandPending: live.binaryCommandPending,
        available: live.available,
        zone: live.zone ?? device.zone,
        controllable: live.controllable ?? device.controllable,
        stepCommandPending: live.stepCommandPending ?? device.stepCommandPending,
        stepCommandStatus: live.stepCommandStatus ?? device.stepCommandStatus,
      }));
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

export function hasPlanExecutionDrift(previousPlan: DevicePlan, livePlan: DevicePlan): boolean {
  if (previousPlan.devices.length !== livePlan.devices.length) return true;
  for (let index = 0; index < previousPlan.devices.length; index += 1) {
    const previous = previousPlan.devices[index];
    const live = livePlan.devices[index];
    if (previous.id !== live.id) return true;
    if (hasRelevantBinaryExecutionDrift(previous, live)) return true;
    if (hasRelevantTargetExecutionDrift(previous, live)) return true;
  }
  return false;
}

export function canRefreshPlanSnapshotFromLiveState(
  basePlan: DevicePlan,
  livePlan: DevicePlan,
): boolean {
  if (!hasPlanExecutionDrift(basePlan, livePlan)) return false;
  if (basePlan.devices.length !== livePlan.devices.length) return false;

  for (let index = 0; index < basePlan.devices.length; index += 1) {
    const baseDevice = basePlan.devices[index];
    const liveDevice = livePlan.devices[index];
    if (!liveDevice || baseDevice.id !== liveDevice.id) return false;
    if (!hasSettledPostActuationState(baseDevice, liveDevice)) return false;
  }
  return true;
}
export function hasPlanExecutionDriftAgainstIntent(
  previousPlan: DevicePlan,
  liveDevices: PlanInputDevice[],
): boolean {
  const liveById = new Map(liveDevices.map((device) => [device.id, device]));
  for (const previous of previousPlan.devices) {
    const live = liveById.get(previous.id);
    if (!live) continue;
    if (hasPlanDeviceExecutionDrift({ planDevice: previous, liveDevice: live })) return true;
  }
  return false;
}

function resolveCurrentStateFromPlanInput(
  previousDevice: DevicePlan['devices'][number],
  liveDevice: PlanInputDevice,
): string {
  return resolveObservedCurrentState({
    binaryControl: liveDevice.binaryControl,
    controlCapabilityId: liveDevice.controlCapabilityId,
    observationStale: liveDevice.observationStale,
    steppedLoadProfile: isSteppedLoadDevice(previousDevice) ? previousDevice.steppedLoadProfile : undefined,
    selectedStepId: liveDevice.selectedStepId,
  });
}

function hasSettledPostActuationState(
  baseDevice: DevicePlan['devices'][number],
  liveDevice: DevicePlan['devices'][number],
): boolean {
  if (baseDevice.available === false || liveDevice.available === false) return true;
  if (
    isSteppedLoadDevice(baseDevice)
    && baseDevice.desiredStepId
    && liveDevice.selectedStepId !== baseDevice.desiredStepId
  ) {
    return false;
  }
  if (requiresBinaryRestore(baseDevice) && !isObservedOn(liveDevice)) return false;
  if (requiresBinaryShed(baseDevice) && !isObservedOff(liveDevice)) return false;
  if (requiresTargetUpdate(baseDevice) && liveDevice.currentTarget !== baseDevice.plannedTarget) return false;
  return true;
}

function requiresBinaryRestore(device: DevicePlan['devices'][number]): boolean {
  return device.controllable !== false
    && device.plannedState === 'keep'
    && isObservedOff(device);
}

function requiresBinaryShed(device: DevicePlan['devices'][number]): boolean {
  return device.plannedState === 'shed'
    && !isObservedOff(device)
    && device.shedAction !== 'set_temperature';
}

function requiresTargetUpdate(device: DevicePlan['devices'][number]): boolean {
  if (device.plannedState === 'shed' && device.shedAction !== 'set_temperature') {
    return false;
  }
  return typeof device.plannedTarget === 'number' && device.plannedTarget !== device.currentTarget;
}

function hasRelevantBinaryExecutionDrift(
  previousDevice: DevicePlan['devices'][number],
  liveDevice: DevicePlan['devices'][number],
): boolean {
  if (isSteppedLoadDevice(previousDevice)) {
    return previousDevice.selectedStepId !== liveDevice.selectedStepId
      || previousDevice.currentState !== liveDevice.currentState
      || hasSteppedEvidenceChanged(previousDevice, liveDevice);
  }
  return previousDevice.currentState !== liveDevice.currentState;
}

function hasSteppedEvidenceChanged(
  previousDevice: DevicePlan['devices'][number],
  liveDevice: DevicePlan['devices'][number],
): boolean {
  return previousDevice.reportedStepId !== liveDevice.reportedStepId;
}

function hasRelevantTargetExecutionDrift(
  previousDevice: DevicePlan['devices'][number],
  liveDevice: Pick<DevicePlan['devices'][number], 'currentTarget'>,
): boolean {
  if (!tracksTargetForExecution(previousDevice)) return false;
  return previousDevice.currentTarget !== liveDevice.currentTarget;
}

function tracksTargetForExecution(device: DevicePlan['devices'][number]): boolean {
  if (device.plannedState === 'shed' && device.shedAction !== 'set_temperature') {
    return false;
  }
  return typeof device.plannedTarget === 'number';
}
