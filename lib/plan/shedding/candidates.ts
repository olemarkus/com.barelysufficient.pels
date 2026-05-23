import type { PlanEngineState } from '../planState';
import type { PlanInputDevice, ShedAction } from '../planTypes';
import type { SteppedLoadProfile } from '../../../packages/contracts/src/types';
import { isObservedOff } from '../../observer/observedState';
import { getCurrentDrawKw } from '../../observer/observedPower';
import {
  getSteppedLoadShedTargetStep,
  isSteppedLoadDevice,
  resolveSteppedCandidatePower,
  resolveSteppedLoadPlanningKw,
  resolveSteppedLoadSheddingTarget,
  resolveSteppedUnknownCurrentMeasuredShedding,
} from '../planSteppedLoad';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../../utils/deviceControlProfiles';
import { isPendingBinaryCommandActive } from '../planObservationPolicy';
import { isCapacityBreached } from '../planRemainingSheddableLoad';
import { normalizeTargetCapabilityValue } from '../../utils/targetCapabilities';
import { isFiniteNumber } from '../../utils/appTypeGuards';
import { resolveRecentRestoreState } from './overshoot';
import {
  type BinaryShedCandidate,
  type ShedCandidate,
  type ShedCandidateParams,
  type SheddingDeps,
  type TemperatureShedCandidate,
} from './types';

export function summarizeSheddingCandidates(params: ShedCandidateParams): {
  eligibleCandidateCount: number;
  blockedCandidateCount: number;
  reducibleControlledKw: number;
  blockedReducibleControlledKw: number;
} {
  const {
    eligibleCandidateCount,
    blockedCandidateCount,
    reducibleControlledKw,
    blockedReducibleControlledKw,
  } = collectSheddingCandidates(params, { includeCandidates: false });
  return {
    eligibleCandidateCount,
    blockedCandidateCount,
    reducibleControlledKw,
    blockedReducibleControlledKw,
  };
}

export function buildSheddingCandidates(params: ShedCandidateParams): {
  candidates: ShedCandidate[];
  reducibleControlledKw: number;
  blockedCandidateCount: number;
  blockedReducibleControlledKw: number;
} {
  const result = collectSheddingCandidates(params, { includeCandidates: true });
  result.candidates.sort(sortCandidates);
  return result;
}

function collectSheddingCandidates(
  params: ShedCandidateParams,
  options: { includeCandidates: boolean },
): {
  candidates: ShedCandidate[];
  eligibleCandidateCount: number;
  reducibleControlledKw: number;
  blockedCandidateCount: number;
  blockedReducibleControlledKw: number;
} {
  const {
    devices,
    needed,
    limitSource,
    total,
    capacitySoftLimit,
    state,
    deps,
  } = params;
  const nowTs = Date.now();
  const capacityBreached = isCapacityBreached(total, capacitySoftLimit);
  const candidates: ShedCandidate[] = [];
  let eligibleCandidateCount = 0;
  let reducibleControlledKw = 0;
  let blockedCandidateCount = 0;
  let blockedReducibleControlledKw = 0;

  for (const device of devices) {
    if (device.controllable === false) continue;
    if (!isEligibleForShedding(device)) continue;

    const candidate = addCandidatePower({
      device,
      devices,
      state,
      nowTs,
      needed,
      deps,
    });
    if (!candidate || !isNotAtShedTemperature(candidate)) continue;

    const allowedByLimitPolicy = limitSource !== 'daily' || capacityBreached || device.budgetExempt !== true;
    if (allowedByLimitPolicy) {
      eligibleCandidateCount += 1;
      if (options.includeCandidates) candidates.push(candidate);
      reducibleControlledKw += candidate.effectivePower;
      continue;
    }

    blockedCandidateCount += 1;
    blockedReducibleControlledKw += candidate.effectivePower;
  }

  return {
    candidates,
    eligibleCandidateCount,
    reducibleControlledKw,
    blockedCandidateCount,
    blockedReducibleControlledKw,
  };
}

function addCandidatePower(params: {
  device: PlanInputDevice;
  devices: PlanInputDevice[];
  state: PlanEngineState;
  nowTs: number;
  needed: number;
  deps: Pick<SheddingDeps, 'getPriorityForDevice' | 'getShedBehavior' | 'logDebug'>;
}): ShedCandidate | null {
  const {
    device,
    devices,
    state,
    nowTs,
    needed,
    deps,
  } = params;
  const priority = deps.getPriorityForDevice(device.id);
  const recentlyRestored = resolveRecentRestoreState({
    device,
    state,
    nowTs,
    needed,
    logDebug: deps.logDebug,
  });
  if (isSteppedLoadDevice(device)) {
    return buildSteppedCandidate({
      device,
      devices,
      priority,
      recentlyRestored,
      state,
      getShedBehavior: deps.getShedBehavior,
    });
  }
  const shedBehavior = deps.getShedBehavior(device.id);
  if (shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null) {
    const target = device.targets?.[0];
    if (target?.id) {
      return buildTemperatureCandidate({
        device,
        priority,
        recentlyRestored,
        shedTemperature: shedBehavior.temperature,
        targetCapabilityId: target.id,
        targetCapability: target,
        pendingTargetCommands: state.pendingTargetCommands,
      });
    }
  }
  return buildBinaryCandidate(device, priority, recentlyRestored, state);
}

function buildBinaryCandidate(
  device: PlanInputDevice,
  priority: number,
  recentlyRestored: boolean,
  state: PlanEngineState,
): BinaryShedCandidate | null {
  const power = getCurrentDrawKw(device);
  if (power <= 0) return null;
  const pendingBinary = isPendingBinaryCommandActive({
    pending: state.pendingBinaryCommands[device.id],
    communicationModel: device.communicationModel,
  }) ? state.pendingBinaryCommands[device.id] : undefined;
  return {
    ...device,
    kind: 'binary',
    priority,
    recentlyRestored,
    effectivePower: power,
    unconfirmedRelief: pendingBinary?.desired === false,
  };
}

function isEligibleForShedding(device: PlanInputDevice): boolean {
  return !isObservedOff(device);
}

function buildTemperatureCandidate(params: {
  device: PlanInputDevice;
  priority: number;
  recentlyRestored: boolean;
  shedTemperature: number;
  targetCapabilityId: string;
  targetCapability?: Partial<{ min?: number; max?: number; step?: number }> | null;
  pendingTargetCommands: PlanEngineState['pendingTargetCommands'];
}): TemperatureShedCandidate | null {
  const {
    device, priority, recentlyRestored, targetCapabilityId, targetCapability, pendingTargetCommands,
  } = params;
  const shedTemperature = normalizeTargetCapabilityValue({ target: targetCapability, value: params.shedTemperature });
  const power = getCurrentDrawKw(device);
  if (power <= 0) return null;
  const pending = pendingTargetCommands[device.id];
  const unconfirmedRelief = pending !== undefined
    && pending.status === 'waiting_confirmation'
    && pending.capabilityId === targetCapabilityId
    && pending.desired === shedTemperature;
  return {
    ...device,
    kind: 'temperature',
    priority,
    recentlyRestored,
    effectivePower: power,
    unconfirmedRelief,
    targetCapabilityId,
    shedTemperature,
  };
}

function buildSteppedCandidate(params: {
  device: PlanInputDevice;
  devices: PlanInputDevice[];
  priority: number;
  recentlyRestored: boolean;
  state: PlanEngineState;
  getShedBehavior: SheddingDeps['getShedBehavior'];
}): ShedCandidate | null {
  const {
    device,
    devices,
    priority,
    recentlyRestored,
    state,
    getShedBehavior,
  } = params;
  const deviceSteppedProfile = device.steppedLoadProfile;
  if (!deviceSteppedProfile) return null;
  if (isFiniteNumber(device.measuredPowerKw) && device.measuredPowerKw === 0) return null;
  const shedBehavior = getShedBehavior(device.id);
  if (shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null) {
    const target = device.targets?.[0];
    if (!target?.id) return null;
    return buildTemperatureCandidate({
      device,
      priority,
      recentlyRestored,
      shedTemperature: shedBehavior.temperature,
      targetCapabilityId: target.id,
      targetCapability: target,
      pendingTargetCommands: state.pendingTargetCommands,
    });
  }
  const effectiveCurrentStepId = resolveEffectiveCurrentStepIdForSteppedShedding(device);
  const steppedShedAction = shedBehavior.action === 'set_step' ? 'set_step' : 'turn_off';
  const targetStep = resolveSteppedShedTargetStep({
    device,
    devices,
    state,
    shedBehaviorAction: steppedShedAction,
    effectiveCurrentStepId,
  });
  const steppedTarget = resolveSteppedLoadSheddingTarget({ device, targetStep });
  if (!steppedTarget) {
    const preparedBinaryOffCandidate = buildPreparedSteppedBinaryOffCandidate({
      device,
      steppedProfile: deviceSteppedProfile,
      targetStep,
      priority,
      recentlyRestored,
      shedAction: steppedShedAction,
      state,
    });
    if (preparedBinaryOffCandidate) return preparedBinaryOffCandidate;
    return buildUnknownCurrentMeasuredSteppedCandidate({
      device,
      priority,
      recentlyRestored,
      shedAction: steppedShedAction,
    });
  }
  const { steppedProfile, selectedStep, clampedTargetStep, hasUnconfirmedLowerDesiredStep } = steppedTarget;
  const lowestActiveStep = getSteppedLoadLowestActiveStep(steppedProfile);
  // Preemptive when the confirmed position is above the lowest active step,
  // regardless of where the computed target lands.
  const preemptiveStepDown = Boolean(
    lowestActiveStep
    && selectedStep.id !== lowestActiveStep.id
    && selectedStep.planningPowerW > lowestActiveStep.planningPowerW,
  );
  const effectivePower = resolveSteppedCandidatePower(device, selectedStep, clampedTargetStep);
  if (effectivePower <= 0) return null;
  return {
    ...device,
    kind: 'stepped',
    priority,
    recentlyRestored,
    unconfirmedRelief: hasUnconfirmedLowerDesiredStep,
    effectivePower,
    fromStepId: selectedStep.id,
    toStepId: clampedTargetStep.id,
    preemptiveStepDown,
  };
}

function resolveEffectiveCurrentStepIdForSteppedShedding(device: PlanInputDevice): string | undefined {
  // Advance past a pending step-down rather than re-issuing the same command.
  // Only use the pending step when it is lower (a shed, not a restore).
  const pendingIsLower = device.stepCommandPending
    && device.desiredStepId
    && device.selectedStepId
    && device.desiredStepId !== device.selectedStepId
    && resolveSteppedLoadPlanningKw(device, device.desiredStepId)
      < resolveSteppedLoadPlanningKw(device, device.selectedStepId);
  return pendingIsLower ? device.desiredStepId : device.selectedStepId;
}

function buildPreparedSteppedBinaryOffCandidate(params: {
  device: PlanInputDevice;
  steppedProfile: SteppedLoadProfile;
  targetStep: ReturnType<typeof getSteppedLoadShedTargetStep>;
  priority: number;
  recentlyRestored: boolean;
  shedAction: 'turn_off' | 'set_step';
  state: Pick<PlanEngineState, 'pendingBinaryCommands'>;
}): ShedCandidate | null {
  const {
    device,
    steppedProfile,
    targetStep,
    priority,
    recentlyRestored,
    shedAction,
    state,
  } = params;
  if (
    shedAction !== 'turn_off'
    || device.hasBinaryControl === false
    || !device.selectedStepId
    || targetStep?.id !== device.selectedStepId
  ) {
    return null;
  }
  const selectedStep = getSteppedLoadStep(steppedProfile, device.selectedStepId);
  if (!selectedStep || isSteppedLoadOffStep(steppedProfile, selectedStep.id)) return null;
  const effectivePower = getCurrentDrawKw(device);
  if (effectivePower <= 0) return null;
  const pendingBinary = isPendingBinaryCommandActive({
    pending: state.pendingBinaryCommands[device.id],
    communicationModel: device.communicationModel,
  }) ? state.pendingBinaryCommands[device.id] : undefined;
  return {
    ...device,
    kind: 'stepped',
    priority,
    recentlyRestored,
    unconfirmedRelief: pendingBinary?.desired === false,
    effectivePower,
    fromStepId: selectedStep.id,
    toStepId: selectedStep.id,
    preemptiveStepDown: false,
  };
}

function buildUnknownCurrentMeasuredSteppedCandidate(params: {
  device: PlanInputDevice;
  priority: number;
  recentlyRestored: boolean;
  shedAction: 'turn_off' | 'set_step';
}): ShedCandidate | null {
  const { device, priority, recentlyRestored, shedAction } = params;
  const measuredFallback = resolveSteppedUnknownCurrentMeasuredShedding({
    device,
    shedAction,
  });
  if (!measuredFallback) return null;
  return {
    ...device,
    kind: 'stepped',
    priority,
    recentlyRestored,
    unconfirmedRelief: false,
    effectivePower: measuredFallback.effectivePowerKw,
    fromStepId: 'unknown',
    toStepId: measuredFallback.targetStep.id,
    preemptiveStepDown: shedAction === 'set_step',
  };
}

function sortCandidates(a: ShedCandidate, b: ShedCandidate): number {
  // Preemptive step-down candidates sort before everything else so that step
  // reductions are attempted before turning off any device in this planning
  // cycle. A stepped device already at its lowest active step (going to off)
  // is effectively a turn-off and follows normal priority ordering.
  const aPreemptive = a.kind === 'stepped' && a.preemptiveStepDown;
  const bPreemptive = b.kind === 'stepped' && b.preemptiveStepDown;
  if (aPreemptive !== bPreemptive) return Number(bPreemptive) - Number(aPreemptive);
  const pa = a.priority ?? 100;
  const pb = b.priority ?? 100;
  if (pa !== pb) return pb - pa; // Higher number sheds first
  if (a.recentlyRestored !== b.recentlyRestored) {
    return Number(a.recentlyRestored) - Number(b.recentlyRestored);
  }
  return b.effectivePower - a.effectivePower;
}

function resolveSteppedShedTargetStep(params: {
  device: PlanInputDevice;
  devices: PlanInputDevice[];
  state: Pick<PlanEngineState, 'lastDeviceShedMs' | 'lastDeviceRestoreMs' | 'swapByDevice'>;
  shedBehaviorAction: ShedAction;
  effectiveCurrentStepId?: string;
}) {
  const { device, devices, state, shedBehaviorAction, effectiveCurrentStepId } = params;
  const forceLowestActiveStep = shedBehaviorAction === 'set_step'
    && devices.some((candidate) => candidate.id !== device.id && isNonSteppedDeviceRecovering(candidate, state));
  if (forceLowestActiveStep) {
    if (!isSteppedLoadDevice(device) || !device.steppedLoadProfile) return null;
    return getSteppedLoadLowestActiveStep(device.steppedLoadProfile);
  }
  return getSteppedLoadShedTargetStep({
    device,
    shedAction: shedBehaviorAction === 'set_step' ? 'set_step' : 'turn_off',
    currentDesiredStepId: effectiveCurrentStepId,
  });
}

function isNonSteppedDeviceRecovering(
  candidate: PlanInputDevice,
  state: Pick<PlanEngineState, 'lastDeviceShedMs' | 'lastDeviceRestoreMs' | 'swapByDevice'>,
): boolean {
  if (candidate.controllable === false || isSteppedLoadDevice(candidate) || !isObservedOff(candidate)) {
    return false;
  }
  if (state.swapByDevice[candidate.id]?.swappedOutFor || state.swapByDevice[candidate.id]?.pendingTarget) {
    return true;
  }
  const lastShedMs = state.lastDeviceShedMs[candidate.id];
  if (lastShedMs == null) return false;
  const lastRestoreMs = state.lastDeviceRestoreMs[candidate.id];
  return lastRestoreMs == null || lastRestoreMs < lastShedMs;
}

export function isNotAtShedTemperature(device: ShedCandidate): boolean {
  if (device.kind !== 'temperature') return true;
  const currentTarget = device.targets?.find((t) => t.id === device.targetCapabilityId)?.value;
  return !(typeof currentTarget === 'number' && currentTarget === device.shedTemperature);
}
