import type { DevicePlan, PlanInputDevice } from '../plan/planTypes';
import { isSteppedLoadOffStep } from '../utils/deviceControlProfiles';
import { resolveObservedCurrentState } from '../plan/planCurrentState';
import { resolveSteppedLoadTransition } from '../plan/planSteppedLoad';
import { getPrimaryTargetCapability } from '../utils/targetCapabilities';

type PlanDevice = DevicePlan['devices'][number];

export function hasPlanExecutionDriftForDevice(params: {
  plan: DevicePlan;
  liveDevices: PlanInputDevice[];
  deviceId: string;
}): boolean {
  const { plan, liveDevices, deviceId } = params;
  const previous = plan.devices.find((device) => device.id === deviceId);
  if (!previous) return false;

  const live = liveDevices.find((device) => device.id === deviceId);
  if (!live) return false;
  return hasPlanDeviceExecutionDrift({ planDevice: previous, liveDevice: live });
}

export function hasPlanDeviceExecutionDrift(params: {
  planDevice: PlanDevice;
  liveDevice: PlanInputDevice;
}): boolean {
  const { planDevice, liveDevice } = params;
  if (liveDevice.observationStale === true) return false;
  const liveCurrentState = resolveCurrentStateFromPlanInput(planDevice, liveDevice);
  const liveSelectedStepId = liveDevice.selectedStepId ?? planDevice.selectedStepId;
  if (hasRealtimeBinaryExecutionDrift(planDevice, {
    currentState: liveCurrentState,
    selectedStepId: liveSelectedStepId,
    binaryCommandPending: liveDevice.binaryCommandPending,
    stepCommandPending: liveDevice.stepCommandPending,
    observationStale: liveDevice.observationStale,
  })) {
    return true;
  }
  const liveCurrentTarget = getPrimaryTargetCapability(liveDevice.targets)?.value ?? null;
  return hasRelevantTargetExecutionDrift(planDevice, { currentTarget: liveCurrentTarget });
}

function resolveCurrentStateFromPlanInput(
  planDevice: PlanDevice,
  liveDevice: PlanInputDevice,
): string {
  return resolveObservedCurrentState({
    currentOn: liveDevice.currentOn,
    hasBinaryControl: liveDevice.hasBinaryControl,
    observationStale: liveDevice.observationStale,
    controlModel: planDevice.controlModel,
    steppedLoadProfile: planDevice.steppedLoadProfile,
    selectedStepId: liveDevice.selectedStepId,
  });
}

function hasRelevantTargetExecutionDrift(
  planDevice: PlanDevice,
  liveDevice: Pick<PlanDevice, 'currentTarget'>,
): boolean {
  if (!tracksTargetForExecution(planDevice)) return false;
  return planDevice.currentTarget !== liveDevice.currentTarget;
}

function hasRealtimeBinaryExecutionDrift(
  planDevice: PlanDevice,
  liveDevice: Pick<PlanDevice, 'currentState' | 'selectedStepId'> & {
    binaryCommandPending?: boolean;
    stepCommandPending?: boolean;
    observationStale?: boolean;
  },
): boolean {
  if (liveDevice.observationStale === true) return false;
  if (planDevice.controlModel === 'stepped_load' && isSteppedBinaryTransitionInFlight(planDevice, liveDevice)) {
    return false;
  }
  const expectedBinaryState = resolveExpectedBinaryStateForPlan(planDevice);
  const binaryStateDrift = liveDevice.binaryCommandPending !== true
    && liveDevice.currentState !== 'unknown'
    && liveDevice.currentState !== (expectedBinaryState ?? planDevice.currentState);
  if (planDevice.controlModel === 'stepped_load') {
    return planDevice.selectedStepId !== liveDevice.selectedStepId || binaryStateDrift;
  }
  return binaryStateDrift;
}

function resolveExpectedBinaryStateForPlan(device: PlanDevice): 'on' | 'off' | undefined {
  if (device.currentState === 'not_applicable') return undefined;
  if (device.controllable === false) return undefined;
  if (device.plannedState === 'keep') return 'on';
  if (device.plannedState !== 'shed') return undefined;
  if (device.shedAction === 'set_temperature') return undefined;
  if (device.shedAction !== 'set_step') return 'off';
  return resolveSteppedShedBinaryState(device);
}

function resolveSteppedShedBinaryState(device: PlanDevice): 'on' | 'off' {
  const stepId = device.desiredStepId ?? device.selectedStepId;
  if (device.steppedLoadProfile && stepId) {
    return isSteppedLoadOffStep(device.steppedLoadProfile, stepId) ? 'off' : 'on';
  }
  return 'on';
}

function isSteppedBinaryTransitionInFlight(
  planDevice: PlanDevice,
  liveDevice: Pick<PlanDevice, 'currentState' | 'selectedStepId'> & {
    binaryCommandPending?: boolean;
    stepCommandPending?: boolean;
  },
): boolean {
  const transition = resolveSteppedLoadTransition(planDevice);
  if (!transition || transition.binaryTarget === null) return false;
  if (liveDevice.binaryCommandPending !== true && liveDevice.stepCommandPending !== true) return false;
  const previousStepId = planDevice.selectedStepId;
  if (
    transition.transitionPhase === 'binary_transition'
    && (!transition.commandStepId || liveDevice.selectedStepId !== transition.commandStepId)
  ) {
    return false;
  }
  if (transition.transitionPhase === 'step_preparation') {
    const expectedStepIds = new Set(
      [previousStepId, transition.commandStepId].filter((stepId): stepId is string => typeof stepId === 'string'),
    );
    if (expectedStepIds.size > 0 && !expectedStepIds.has(liveDevice.selectedStepId ?? '')) {
      return false;
    }
  }
  if (transition.effectiveTransition === 'restore_from_off_at_low') {
    return liveDevice.currentState === 'off';
  }
  if (transition.effectiveTransition === 'full_shed_to_off') {
    return liveDevice.currentState === 'on';
  }
  return false;
}

function tracksTargetForExecution(device: PlanDevice): boolean {
  if (device.plannedState === 'shed' && device.shedAction !== 'set_temperature') {
    return false;
  }
  return typeof device.plannedTarget === 'number';
}
