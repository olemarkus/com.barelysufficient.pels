/* eslint-disable max-lines --
  shedding candidate evaluation and overshoot diagnostics share the same control-authority math.
*/
import type CapacityGuard from '../core/capacityGuard';
import type { PowerTrackerState } from '../core/powerTracker';
import type { PlanInputDevice, ShedAction } from './planTypes';
import type { PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import { resolveEffectiveCurrentOn, resolveObservedCurrentState } from './planCurrentState';
import { resolveCandidatePower } from './planCandidatePower';
import {
  getSteppedLoadShedTargetStep,
  isSteppedLoadDevice,
  resolveSteppedCandidatePower,
  resolveSteppedLoadPlanningKw,
  resolveSteppedLoadSheddingTarget,
} from './planSteppedLoad';
import { getSteppedLoadLowestActiveStep } from '../utils/deviceControlProfiles';

import { isPendingBinaryCommandActive } from './planObservationPolicy';
import { updateGuardState, isCapacityBreached } from './planSheddingGuard';
import { normalizeTargetCapabilityValue } from '../utils/targetCapabilities';
import {
  type BinaryShedCandidate,
  type ShedCandidate,
  type TemperatureShedCandidate,
  emitOvershootEscalationBlocked,
  resolveRecentRestoreState,
  resolveSameMeasurementSheddingDecision,
  resolveShedReason,
  selectShedDevices,
} from './planSheddingHelpers';

export type SheddingPlan = {
  shedSet: Set<string>;
  shedReasons: Map<string, string>;
  steppedDesiredStepByDeviceId: Map<string, string>;
  temperatureShedTargets: Map<string, { temperature: number; capabilityId: string }>;
  sheddingActive: boolean;
  guardInShortfall: boolean;
  updates: {
    lastInstabilityMs?: number;
    lastRecoveryMs?: number;
    lastShedPlanMeasurementTs?: number;
    lastOvershootEscalationMs?: number;
    lastOvershootMitigationMs?: number;
  };
  overshootStats: OvershootStats | null;
};

export type OvershootStats = {
  needed: number;
  eligibleCandidateCount: number;
  blockedCandidateCount: number;
  reducibleControlledKw: number;
  blockedReducibleControlledKw: number;
  allShedCandidatesExhausted: boolean;
  controlRecoverable: boolean;
};

export type SheddingDeps = {
  capacityGuard: CapacityGuard | undefined;
  powerTracker: PowerTrackerState;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
  getPriorityForDevice: (deviceId: string) => number;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  structuredLog?: import('../logging/logger').Logger;
};

type ShedCandidateParams = {
  devices: PlanInputDevice[];
  needed: number;
  limitSource: PlanContext['softLimitSource'];
  total: number | null;
  capacitySoftLimit: number;
  state: PlanEngineState;
  deps: SheddingDeps;
};

export async function buildSheddingPlan(
  context: PlanContext,
  state: PlanEngineState,
  deps: SheddingDeps,
  overshootActionable = context.headroom !== null && context.headroom < 0,
): Promise<SheddingPlan> {
  const {
    shedSet,
    shedReasons,
    steppedDesiredStepByDeviceId,
    temperatureShedTargets,
    updates,
    overshootStats,
  } = planShedding(context, state, deps, overshootActionable);
  const wasSheddingActive = deps.capacityGuard?.isSheddingActive() ?? false;
  const guardResult = await updateGuardState({
    headroom: context.headroom,
    overshootActionable,
    capacitySoftLimit: context.capacitySoftLimit,
    total: context.total,
    devices: context.devices,
    shedSet,
    softLimitSource: context.softLimitSource,
    getShedBehavior: deps.getShedBehavior,
    capacityGuard: deps.capacityGuard,
  });
  const guardInShortfall = deps.capacityGuard?.isInShortfall() ?? false;
  const recoveredFromShedding = wasSheddingActive && !guardResult.sheddingActive;
  const mergedUpdates = recoveredFromShedding
    ? { ...updates, lastRecoveryMs: Date.now() }
    : updates;
  return {
    shedSet,
    shedReasons,
    steppedDesiredStepByDeviceId,
    temperatureShedTargets,
    sheddingActive: guardResult.sheddingActive,
    guardInShortfall,
    updates: mergedUpdates,
    overshootStats,
  };
}

function shouldPlanShedding(headroom: number | null): boolean {
  return headroom !== null && headroom < 0;
}

type PlanSheddingResult = {
  shedSet: Set<string>;
  shedReasons: Map<string, string>;
  steppedDesiredStepByDeviceId: Map<string, string>;
  temperatureShedTargets: Map<string, { temperature: number; capabilityId: string }>;
  updates: {
    lastInstabilityMs?: number;
    lastRecoveryMs?: number;
    lastShedPlanMeasurementTs?: number;
    lastOvershootEscalationMs?: number;
    lastOvershootMitigationMs?: number;
  };
  overshootStats: SheddingPlan['overshootStats'];
};

function emptySheddingResult(
  updates: PlanSheddingResult['updates'] = {},
  overshootStats: PlanSheddingResult['overshootStats'] = null,
): PlanSheddingResult {
  return {
    shedSet: new Set<string>(),
    shedReasons: new Map<string, string>(),
    steppedDesiredStepByDeviceId: new Map<string, string>(),
    temperatureShedTargets: new Map<string, { temperature: number; capabilityId: string }>(),
    updates,
    overshootStats,
  };
}

function planShedding(
  context: PlanContext,
  state: PlanEngineState,
  deps: SheddingDeps,
  overshootActionable: boolean,
): PlanSheddingResult {
  if (!overshootActionable || !shouldPlanShedding(context.headroom)) return emptySheddingResult();

  const nowTs = Date.now();
  const measurementTs = deps.powerTracker.lastTimestamp ?? null;
  const measurementDecision = resolveSameMeasurementSheddingDecision({
    state,
    measurementTs,
    nowTs,
    allowEscalation: isCapacityBreached(context.total, context.capacitySoftLimit),
  });

  // Type narrowing: headroom is guaranteed to be non-null here due to shouldPlanShedding check
  if (context.headroom === null) return emptySheddingResult();
  const needed = -context.headroom;
  if (measurementDecision.skip) {
    const summary = summarizeSheddingCandidates({
      devices: context.devices,
      needed,
      limitSource: context.softLimitSource,
      total: context.total,
      capacitySoftLimit: context.capacitySoftLimit,
      state,
      deps,
    });
    deps.logDebug('Plan: skipping additional shedding until a new power measurement arrives');
    return emptySheddingResult({}, buildOvershootStats({
      needed,
      eligibleCandidateCount: summary.eligibleCandidateCount,
      blockedCandidateCount: summary.blockedCandidateCount,
      reducibleControlledKw: summary.reducibleControlledKw,
      blockedReducibleControlledKw: summary.blockedReducibleControlledKw,
    }));
  }
  if (measurementDecision.escalatedSameSample) {
    deps.logDebug('Plan: escalating overshoot despite unchanged power measurement');
  }
  const candidateSummary = buildSheddingCandidates({
    devices: context.devices,
    needed,
    limitSource: context.softLimitSource,
    total: context.total,
    capacitySoftLimit: context.capacitySoftLimit,
    state,
    deps,
  });
  const { candidates } = candidateSummary;
  const overshootStats = buildOvershootStats({
    needed,
    eligibleCandidateCount: candidates.length,
    blockedCandidateCount: candidateSummary.blockedCandidateCount,
    reducibleControlledKw: candidateSummary.reducibleControlledKw,
    blockedReducibleControlledKw: candidateSummary.blockedReducibleControlledKw,
  });
  const result = selectShedDevices({
    candidates,
    needed,
    reason: resolveShedReason(context.softLimitSource),
    logDebug: deps.logDebug,
  });

  if (result.shedSet.size === 0) {
    if (measurementDecision.escalatedSameSample) {
      const controllableDeviceCount = context.devices
        .filter((device) => device.controllable !== false)
        .length;
      if (controllableDeviceCount > 0) {
        emitOvershootEscalationBlocked({
          structuredLog: deps.structuredLog,
          capacityGuard: deps.capacityGuard,
          neededKw: needed,
          remainingCandidates: candidates.length,
          measurementTs,
          nowTs,
        });
      }
      return emptySheddingResult({
        lastOvershootEscalationMs: nowTs,
        lastOvershootMitigationMs: nowTs,
      }, overshootStats);
    }
    return emptySheddingResult({}, overshootStats);
  }
  const updates = {
    lastInstabilityMs: nowTs,
    ...(measurementTs !== null ? { lastShedPlanMeasurementTs: measurementTs } : {}),
    lastOvershootMitigationMs: nowTs,
    ...(measurementDecision.escalatedSameSample ? { lastOvershootEscalationMs: nowTs } : {}),
  };
  return {
    ...result,
    updates,
    overshootStats,
  };
}

function buildOvershootStats(params: {
  needed: number;
  eligibleCandidateCount: number;
  blockedCandidateCount: number;
  reducibleControlledKw: number;
  blockedReducibleControlledKw: number;
}): OvershootStats {
  const {
    needed,
    eligibleCandidateCount,
    blockedCandidateCount,
    reducibleControlledKw,
    blockedReducibleControlledKw,
  } = params;
  return {
    needed,
    eligibleCandidateCount,
    blockedCandidateCount,
    reducibleControlledKw,
    blockedReducibleControlledKw,
    allShedCandidatesExhausted: eligibleCandidateCount === 0,
    controlRecoverable: reducibleControlledKw > 0,
  };
}

function summarizeSheddingCandidates(params: ShedCandidateParams): {
  eligibleCandidateCount: number;
  blockedCandidateCount: number;
  reducibleControlledKw: number;
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
  let eligibleCandidateCount = 0;
  let blockedCandidateCount = 0;
  let reducibleControlledKw = 0;
  let blockedReducibleControlledKw = 0;

  for (const device of devices) {
    if (device.controllable === false) continue;
    if (!isEligibleForShedding({ device, state, nowTs })) continue;

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
      reducibleControlledKw += candidate.effectivePower;
      continue;
    }

    blockedCandidateCount += 1;
    blockedReducibleControlledKw += candidate.effectivePower;
  }

  return {
    eligibleCandidateCount,
    blockedCandidateCount,
    reducibleControlledKw,
    blockedReducibleControlledKw,
  };
}

function buildSheddingCandidates(params: ShedCandidateParams): {
  candidates: ShedCandidate[];
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
  let reducibleControlledKw = 0;
  let blockedCandidateCount = 0;
  let blockedReducibleControlledKw = 0;

  for (const device of devices) {
    if (device.controllable === false) continue;
    const eligible = isEligibleForShedding({
      device,
      state,
      nowTs,
    });
    if (!eligible) continue;

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
      candidates.push(candidate);
      reducibleControlledKw += candidate.effectivePower;
      continue;
    }

    blockedCandidateCount += 1;
    blockedReducibleControlledKw += candidate.effectivePower;
  }

  candidates.sort(sortCandidates);
  return {
    candidates,
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
  const power = resolveCandidatePower(device);
  if (power === null || power <= 0) return null;
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

function isEligibleForShedding(params: {
  device: PlanInputDevice;
  state: PlanEngineState;
  nowTs: number;
}): boolean {
  const { device, state, nowTs } = params;
  const effectiveCurrentOn = resolveEffectiveCurrentOn({
    ...device,
    currentState: resolveObservedCurrentState(device),
  }, {
    pendingPresent: isPendingBinaryCommandActive({
      pending: state.pendingBinaryCommands[device.id],
      nowMs: nowTs,
      communicationModel: device.communicationModel,
    }),
  });
  return effectiveCurrentOn !== false;
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
  const power = resolveCandidatePower(device);
  if (power === null || power <= 0) return null;
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
  // Advance past a pending step-down rather than re-issuing the same command.
  // Only use the pending step when it is lower (a shed, not a restore).
  const pendingIsLower = device.stepCommandPending
    && device.desiredStepId
    && device.desiredStepId !== device.selectedStepId
    && resolveSteppedLoadPlanningKw(device, device.desiredStepId)
      < resolveSteppedLoadPlanningKw(device, device.selectedStepId);
  const effectiveCurrentStepId = pendingIsLower
    ? device.desiredStepId : device.selectedStepId;
  const steppedShedAction = shedBehavior.action === 'set_step' ? 'set_step' : 'turn_off';
  const targetStep = resolveSteppedShedTargetStep({
    device,
    devices,
    state,
    shedBehaviorAction: steppedShedAction,
    effectiveCurrentStepId,
  });
  const steppedTarget = resolveSteppedLoadSheddingTarget({ device, targetStep });
  if (!steppedTarget) return null;
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

function isNotAtShedTemperature(device: ShedCandidate): boolean {
  if (device.kind !== 'temperature') return true;
  const currentTarget = device.targets?.find((t) => t.id === device.targetCapabilityId)?.value;
  return !(typeof currentTarget === 'number' && currentTarget === device.shedTemperature);
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
  const effectiveCurrentOn = resolveEffectiveCurrentOn({
    ...candidate,
    currentState: resolveObservedCurrentState(candidate),
  });
  if (candidate.controllable === false || isSteppedLoadDevice(candidate) || effectiveCurrentOn !== false) {
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
