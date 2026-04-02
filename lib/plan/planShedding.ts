import type CapacityGuard from '../core/capacityGuard';
import type { PowerTrackerState } from '../core/powerTracker';
import type { PlanInputDevice, ShedAction } from './planTypes';
import type { PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import { resolveCandidatePower } from './planCandidatePower';
import {
  isSteppedLoadDevice,
  resolveSteppedCandidatePower,
  resolveSteppedLoadPlanningKw,
  resolveSteppedLoadSheddingTarget,
} from './planSteppedLoad';
import { getSteppedLoadLowestActiveStep } from '../utils/deviceControlProfiles';
import { resolveSteppedShedTargetStep } from './planSheddingStepped';
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
  };
  overshootStats: {
    needed: number;
    candidates: number;
    totalSheddable: number;
  } | null;
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
): Promise<SheddingPlan> {
  const {
    shedSet,
    shedReasons,
    steppedDesiredStepByDeviceId,
    temperatureShedTargets,
    updates,
    overshootStats,
  } = planShedding(context, state, deps);
  const wasSheddingActive = deps.capacityGuard?.isSheddingActive() ?? false;
  const guardResult = await updateGuardState({
    headroom: context.headroom,
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
  };
  overshootStats: SheddingPlan['overshootStats'];
};

function emptySheddingResult(
  updates: PlanSheddingResult['updates'] = {},
): PlanSheddingResult {
  return {
    shedSet: new Set<string>(),
    shedReasons: new Map<string, string>(),
    steppedDesiredStepByDeviceId: new Map<string, string>(),
    temperatureShedTargets: new Map<string, { temperature: number; capabilityId: string }>(),
    updates,
    overshootStats: null,
  };
}

function planShedding(
  context: PlanContext,
  state: PlanEngineState,
  deps: SheddingDeps,
): PlanSheddingResult {
  if (!shouldPlanShedding(context.headroom)) return emptySheddingResult();

  const nowTs = Date.now();
  const measurementTs = deps.powerTracker.lastTimestamp ?? null;
  const measurementDecision = resolveSameMeasurementSheddingDecision({
    state,
    measurementTs,
    nowTs,
  });
  if (measurementDecision.skip) {
    deps.logDebug('Plan: skipping additional shedding until a new power measurement arrives');
    return emptySheddingResult();
  }
  if (measurementDecision.escalatedSameSample) {
    deps.logDebug('Plan: escalating overshoot despite unchanged power measurement');
  }

  // Type narrowing: headroom is guaranteed to be non-null here due to shouldPlanShedding check
  if (context.headroom === null) return emptySheddingResult();
  const needed = -context.headroom;
  deps.logDebug(
    `Planning shed: soft=${context.softLimit.toFixed(3)} `
    + `headroom=${context.headroom.toFixed(3)} `
    + `total=${context.total === null ? 'unknown' : context.total.toFixed(3)}`,
  );
  const candidates = buildSheddingCandidates({
    devices: context.devices,
    needed,
    limitSource: context.softLimitSource,
    total: context.total,
    capacitySoftLimit: context.capacitySoftLimit,
    state,
    deps,
  });
  const result = selectShedDevices({
    candidates,
    needed,
    reason: resolveShedReason(context.softLimitSource),
    logDebug: deps.logDebug,
  });

  if (result.shedSet.size === 0) {
    if (measurementDecision.escalatedSameSample) {
      emitOvershootEscalationBlocked({
        structuredLog: deps.structuredLog,
        capacityGuard: deps.capacityGuard,
        neededKw: needed,
        remainingCandidates: candidates.length,
        measurementTs,
        nowTs,
      });
      return emptySheddingResult({ lastOvershootEscalationMs: nowTs });
    }
    return emptySheddingResult();
  }
  const updates = {
    lastInstabilityMs: nowTs,
    ...(measurementTs !== null ? { lastShedPlanMeasurementTs: measurementTs } : {}),
    ...(measurementDecision.escalatedSameSample ? { lastOvershootEscalationMs: nowTs } : {}),
  };
  return {
    ...result,
    updates,
    overshootStats: {
      needed,
      candidates: candidates.length,
      totalSheddable: candidates.reduce((sum, c) => sum + c.effectivePower, 0),
    },
  };
}

function buildSheddingCandidates(params: ShedCandidateParams): ShedCandidate[] {
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
  return devices
    .filter((d) => d.controllable !== false && isEligibleForShedding({
      device: d,
      state,
      nowTs,
    }))
    // Budget exemption only bypasses daily soft-limit control. Capacity shedding
    // still considers the device because hard-cap protection remains in force.
    .filter((d) => limitSource !== 'daily' || capacityBreached || d.budgetExempt !== true)
    .map((device) => addCandidatePower({
      device,
      devices,
      state,
      nowTs,
      needed,
      deps,
    }))
    .filter((candidate): candidate is ShedCandidate => candidate !== null)
    .filter((d) => isNotAtShedTemperature(d))
    .sort(sortCandidates);
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
  if (device.observationStale === true) return true;
  if (device.currentOn !== false) return true;
  return isPendingBinaryCommandActive({
    pending: state.pendingBinaryCommands[device.id],
    nowMs: nowTs,
    communicationModel: device.communicationModel,
  }) && state.pendingBinaryCommands[device.id]?.desired === true;
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
