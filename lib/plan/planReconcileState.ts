import type { DevicePlan, PlanInputDevice } from './planTypes';
import { getSteppedLoadStep, isSteppedLoadOffStep } from '../utils/deviceControlProfiles';
import type { SteppedLoadProfile } from '../utils/types';
import { resolveEffectiveCurrentOn, resolveObservedCurrentState } from './planCurrentState';

export function buildLiveStatePlan(plan: DevicePlan, liveDevices: PlanInputDevice[]): DevicePlan {
  const liveById = new Map(liveDevices.map((device) => [device.id, device]));
  return {
    ...plan,
    // Keeping the live-plan merge in one place makes reconciliation easier to audit.
    // eslint-disable-next-line complexity
    devices: plan.devices.map((device) => {
      const live = liveById.get(device.id);
      if (!live) return device;
      return {
        ...device,
        currentState: resolveCurrentStateFromPlanInput(device, live),
        currentTarget: Array.isArray(live.targets) && live.targets.length > 0 ? live.targets[0].value ?? null : null,
        observationStale: live.observationStale ?? device.observationStale,
        controlModel: live.controlModel ?? device.controlModel,
        steppedLoadProfile: live.steppedLoadProfile ?? device.steppedLoadProfile,
        selectedStepId: live.selectedStepId ?? device.selectedStepId,
        desiredStepId: clampShedDesiredStepId(
          device,
          live.selectedStepId ?? device.selectedStepId,
          live.steppedLoadProfile ?? device.steppedLoadProfile,
        ),
        lastDesiredStepId: live.desiredStepId ?? device.lastDesiredStepId,
        actualStepId: live.actualStepId ?? device.actualStepId,
        assumedStepId: live.assumedStepId ?? device.assumedStepId,
        actualStepSource: live.actualStepSource ?? device.actualStepSource,
        currentTemperature: live.currentTemperature,
        powerKw: live.powerKw,
        expectedPowerKw: live.expectedPowerKw,
        planningPowerKw: live.planningPowerKw,
        expectedPowerSource: live.expectedPowerSource,
        measuredPowerKw: live.measuredPowerKw,
        controlCapabilityId: live.controlCapabilityId,
        evChargingState: live.evChargingState,
        binaryCommandPending: live.binaryCommandPending,
        available: live.available,
        zone: live.zone ?? device.zone,
        controllable: live.controllable ?? device.controllable,
        stepCommandPending: live.stepCommandPending ?? device.stepCommandPending,
        stepCommandStatus: live.stepCommandStatus ?? device.stepCommandStatus,
      };
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
export function hasPlanExecutionDriftForDevice(
  previousPlan: DevicePlan,
  liveDevices: PlanInputDevice[],
  deviceId: string,
): boolean {
  const previous = previousPlan.devices.find((device) => device.id === deviceId);
  if (!previous) return false;

  const live = liveDevices.find((device) => device.id === deviceId);
  if (!live) return false;
  if (live.observationStale === true) return false;

  const liveCurrentState = resolveCurrentStateFromPlanInput(previous, live);
  const liveCurrentTarget = Array.isArray(live.targets) && live.targets.length > 0
    ? live.targets[0].value ?? null
    : null;

  return hasRealtimeBinaryExecutionDrift(previous, {
    ...previous,
    currentState: liveCurrentState,
    selectedStepId: live.selectedStepId ?? previous.selectedStepId,
    binaryCommandPending: live.binaryCommandPending,
    observationStale: live.observationStale,
  }) || hasRelevantTargetExecutionDrift(previous, {
    ...previous,
    currentTarget: liveCurrentTarget,
  });
}

export function hasPlanExecutionDriftAgainstIntent(
  previousPlan: DevicePlan,
  liveDevices: PlanInputDevice[],
): boolean {
  const liveById = new Map(liveDevices.map((device) => [device.id, device]));
  for (const previous of previousPlan.devices) {
    const live = liveById.get(previous.id);
    if (!live) continue;
    if (hasRealtimeExecutionDriftForLiveDevice(previous, live)) return true;
  }
  return false;
}

function hasRealtimeExecutionDriftForLiveDevice(
  previousDevice: DevicePlan['devices'][number],
  liveDevice: PlanInputDevice,
): boolean {
  if (liveDevice.observationStale === true) return false;
  const liveCurrentState = resolveCurrentStateFromPlanInput(previousDevice, liveDevice);
  const liveSelectedStepId = liveDevice.selectedStepId ?? previousDevice.selectedStepId;
  if (hasRealtimeBinaryExecutionDrift(previousDevice, {
    currentState: liveCurrentState,
    selectedStepId: liveSelectedStepId,
    binaryCommandPending: liveDevice.binaryCommandPending,
    observationStale: liveDevice.observationStale,
  })) {
    return true;
  }
  const liveCurrentTarget = Array.isArray(liveDevice.targets) && liveDevice.targets.length > 0
    ? liveDevice.targets[0].value ?? null
    : null;
  return hasRelevantTargetExecutionDrift(previousDevice, { currentTarget: liveCurrentTarget });
}

function resolveCurrentStateFromPlanInput(
  previousDevice: DevicePlan['devices'][number],
  liveDevice: PlanInputDevice,
): string {
  return resolveObservedCurrentState({
    currentOn: liveDevice.currentOn,
    hasBinaryControl: liveDevice.hasBinaryControl,
    observationStale: liveDevice.observationStale,
    controlModel: previousDevice.controlModel,
    steppedLoadProfile: previousDevice.steppedLoadProfile,
    selectedStepId: liveDevice.selectedStepId,
  });
}

function hasSettledPostActuationState(
  baseDevice: DevicePlan['devices'][number],
  liveDevice: DevicePlan['devices'][number],
): boolean {
  if (baseDevice.available === false || liveDevice.available === false) return true;
  if (
    baseDevice.controlModel === 'stepped_load'
    && baseDevice.desiredStepId
    && liveDevice.selectedStepId !== baseDevice.desiredStepId
  ) {
    return false;
  }
  if (requiresBinaryRestore(baseDevice) && resolveEffectiveCurrentOn(liveDevice) !== true) return false;
  if (requiresBinaryShed(baseDevice) && resolveEffectiveCurrentOn(liveDevice) !== false) return false;
  if (requiresTargetUpdate(baseDevice) && liveDevice.currentTarget !== baseDevice.plannedTarget) return false;
  return true;
}

function requiresBinaryRestore(device: DevicePlan['devices'][number]): boolean {
  return device.controllable !== false
    && device.plannedState === 'keep'
    && resolveEffectiveCurrentOn(device) === false;
}

function requiresBinaryShed(device: DevicePlan['devices'][number]): boolean {
  return device.plannedState === 'shed'
    && resolveEffectiveCurrentOn(device) !== false
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
  if (previousDevice.controlModel === 'stepped_load') {
    // Check both step drift and binary (onoff) drift for dual-control devices.
    // A stepped device can drift in step alone, binary alone, or both.
    return previousDevice.selectedStepId !== liveDevice.selectedStepId
      || previousDevice.currentState !== liveDevice.currentState;
  }
  return previousDevice.currentState !== liveDevice.currentState;
}

function hasRelevantTargetExecutionDrift(
  previousDevice: DevicePlan['devices'][number],
  liveDevice: Pick<DevicePlan['devices'][number], 'currentTarget'>,
): boolean {
  if (!tracksTargetForExecution(previousDevice)) return false;
  return previousDevice.currentTarget !== liveDevice.currentTarget;
}

function hasRealtimeBinaryExecutionDrift(
  previousDevice: DevicePlan['devices'][number],
  liveDevice: Pick<DevicePlan['devices'][number], 'currentState' | 'selectedStepId'> & {
    binaryCommandPending?: boolean;
    observationStale?: boolean;
  },
): boolean {
  if (liveDevice.observationStale === true) return false;
  const expectedBinaryState = resolveExpectedBinaryStateForPlan(previousDevice);
  const binaryStateDrift = liveDevice.binaryCommandPending !== true
    && liveDevice.currentState !== 'unknown'
    && liveDevice.currentState !== (expectedBinaryState ?? previousDevice.currentState);
  if (previousDevice.controlModel === 'stepped_load') {
    return previousDevice.selectedStepId !== liveDevice.selectedStepId || binaryStateDrift;
  }
  return binaryStateDrift;
}

function resolveExpectedBinaryStateForPlan(device: DevicePlan['devices'][number]): 'on' | 'off' | undefined {
  if (device.currentState === 'not_applicable') return undefined;
  if (device.controllable === false) return undefined;
  if (device.plannedState === 'keep') return 'on';
  if (device.plannedState !== 'shed') return undefined;
  if (device.shedAction === 'set_temperature') return undefined;
  if (device.shedAction !== 'set_step') return 'off';
  return resolveSteppedShedBinaryState(device);
}

function resolveSteppedShedBinaryState(device: DevicePlan['devices'][number]): 'on' | 'off' {
  const stepId = device.desiredStepId ?? device.selectedStepId;
  if (device.steppedLoadProfile && stepId) {
    return isSteppedLoadOffStep(device.steppedLoadProfile, stepId) ? 'off' : 'on';
  }
  return 'on';
}

function tracksTargetForExecution(device: DevicePlan['devices'][number]): boolean {
  if (device.plannedState === 'shed' && device.shedAction !== 'set_temperature') {
    return false;
  }
  return typeof device.plannedTarget === 'number';
}
