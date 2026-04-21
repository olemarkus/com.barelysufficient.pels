import type { DevicePlanDevice, PlanInputDevice, ShedAction } from './planTypes';
import type { PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import {
  formatDeviceReason,
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { resolveCandidatePower } from './planCandidatePower';
import { computeBaseRestoreNeed } from './planRestoreSwap';
import { RECENT_RESTORE_SHED_GRACE_MS } from './planConstants';
import { isPendingBinaryCommandActive } from './planObservationPolicy';
import {
  getPrimaryTargetCapability,
  normalizeTargetCapabilityValue,
} from '../utils/targetCapabilities';
import { getInactiveReason, getEvRestoreStateBlockReason } from './planRestoreDevices';
import { buildRestoreNeedReason, buildShortfallReason } from './planReasonStrings';
import {
  isSteppedLoadDevice,
  resolveSteppedKeepDesiredStepId,
  resolveSteppedLoadInitialDesiredStepId,
  getSteppedLoadShedTargetStep,
} from './planSteppedLoad';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadLowestStep,
  getSteppedLoadOffStep,
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';
import { resolveObservedCurrentState } from './planStateResolution';

export type PlanDevicesDeps = {
  getPriorityForDevice: (deviceId: string) => number;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
};

const supportsTemperatureDevice = (device: PlanInputDevice): boolean => {
  const hasTargets = Array.isArray(device.targets) && device.targets.length > 0;
  if (device.deviceType) {
    return device.deviceType === 'temperature' && hasTargets;
  }
  return hasTargets;
};

export function buildInitialPlanDevices(params: {
  context: PlanContext;
  state: PlanEngineState;
  shedSet: Set<string>;
  shedReasons: Map<string, DeviceReason>;
  steppedDesiredStepByDeviceId: Map<string, string>;
  temperatureShedTargets: Map<string, { temperature: number; capabilityId: string }>;
  guardInShortfall: boolean;
  deps: PlanDevicesDeps;
}): DevicePlanDevice[] {
  const {
    context,
    state,
    shedSet,
    shedReasons,
    steppedDesiredStepByDeviceId,
    temperatureShedTargets,
    guardInShortfall,
    deps,
  } = params;
  return context.devices.map((dev) => {
    const supportsTemperature = supportsTemperatureDevice(dev);
    const priority = deps.getPriorityForDevice(dev.id);
    const plannedTarget = resolvePlannedTarget({
      dev,
      desiredForMode: context.desiredForMode,
      supportsTemperature,
      deps,
    });
    const currentTarget = getPrimaryTargetCapability(dev.targets)?.value ?? null;
    const currentState = resolveCurrentState(dev);
    const controllable = dev.controllable !== false;
    const shedBehavior: { action: ShedAction; temperature: number | null; stepId: string | null } = (
      isSteppedLoadDevice(dev) || supportsTemperature
    )
      ? deps.getShedBehavior(dev.id)
      : { action: 'turn_off', temperature: null, stepId: null };

    const base = buildBasePlanDevice({
      dev,
      priority,
      recentlyRestored: isRecentlyRestored(state.lastDeviceRestoreMs[dev.id]),
      binaryCommandPending: isPendingBinaryCommandActive({
        pending: state.pendingBinaryCommands[dev.id],
        communicationModel: dev.communicationModel,
      }) && state.pendingBinaryCommands[dev.id]?.desired === true,
      currentState,
      currentTarget,
      plannedTarget,
      controllable,
      shedBehavior,
      shedSet,
      shedReasons,
      steppedDesiredStepByDeviceId,
      temperatureShedTargets,
    });

    const withOffStateReason = applyOffStateReason({
      planDevice: base,
      headroomRaw: context.headroomRaw,
      guardInShortfall,
    });

    return applyHourlyBudgetShed({
      planDevice: withOffStateReason,
      hourlyBudgetExhausted: params.state.hourlyBudgetExhausted,
    });
  });
}

function resolvePlannedTarget(params: {
  dev: PlanInputDevice;
  desiredForMode: Record<string, number>;
  supportsTemperature: boolean;
  deps: PlanDevicesDeps;
}): number | null {
  const { dev, desiredForMode, supportsTemperature, deps } = params;
  if (!supportsTemperature) return null;
  const target = getPrimaryTargetCapability(dev.targets);
  const desired = desiredForMode[dev.id];
  let plannedTarget = Number.isFinite(desired) ? Number(desired) : null;
  const priceOptConfig = deps.getPriceOptimizationSettings()[dev.id];
  if (deps.getPriceOptimizationEnabled() && plannedTarget !== null && priceOptConfig?.enabled) {
    plannedTarget = applyPriceOptimizationDelta(plannedTarget, priceOptConfig, deps);
  }
  if (plannedTarget !== null) {
    plannedTarget = normalizeTargetCapabilityValue({ target, value: plannedTarget });
  }
  return plannedTarget;
}

function applyPriceOptimizationDelta(
  target: number,
  config: { cheapDelta: number; expensiveDelta: number },
  deps: Pick<PlanDevicesDeps, 'isCurrentHourCheap' | 'isCurrentHourExpensive'>,
): number {
  if (deps.isCurrentHourCheap() && config.cheapDelta) {
    return target + config.cheapDelta;
  }
  if (deps.isCurrentHourExpensive() && config.expensiveDelta) {
    return target + config.expensiveDelta;
  }
  return target;
}

function resolveCurrentState(device: PlanInputDevice): string {
  return resolveObservedCurrentState(device);
}

// For shed stepped-load devices at the off step, expectedPowerKw should reflect the lowest
// positive step so that restore planning uses a realistic power estimate rather than zero.
function resolveExpectedPowerKw(
  dev: PlanInputDevice,
  currentState: string,
  plannedState: 'shed' | 'keep',
  effectiveDesiredStepId: string | undefined,
): number | undefined {
  const steppedExpectedPowerKw = resolveSteppedExpectedPowerKw({
    dev,
    currentState,
    plannedState,
    effectiveDesiredStepId,
  });
  if (steppedExpectedPowerKw !== null) return steppedExpectedPowerKw;
  if (!hasKnownPowerFields(dev)) return undefined;
  return resolveCandidatePower(dev);
}

function resolveSteppedExpectedPowerKw(params: {
  dev: PlanInputDevice;
  currentState: string;
  plannedState: 'shed' | 'keep';
  effectiveDesiredStepId: string | undefined;
}): number | null {
  const {
    dev,
    currentState,
    plannedState,
    effectiveDesiredStepId,
  } = params;

  if (
    plannedState === 'keep'
    && currentState === 'off'
    && isSteppedLoadDevice(dev)
    && dev.steppedLoadProfile
  ) {
    const desiredStep = getSteppedLoadStep(dev.steppedLoadProfile, effectiveDesiredStepId);
    if (desiredStep && desiredStep.planningPowerW > 0) {
      return desiredStep.planningPowerW / 1000;
    }
  }

  if (
    plannedState === 'shed'
    && isSteppedLoadDevice(dev)
    && dev.steppedLoadProfile
    && isSteppedLoadOffStep(dev.steppedLoadProfile, dev.selectedStepId)
  ) {
    const lowestActiveStep = getSteppedLoadLowestActiveStep(dev.steppedLoadProfile);
    if (lowestActiveStep) {
      return lowestActiveStep.planningPowerW / 1000;
    }
  }

  return null;
}

function hasKnownPowerFields(dev: PlanInputDevice): boolean {
  return Number.isFinite(dev.measuredPowerKw)
    || Number.isFinite(dev.expectedPowerKw)
    || Number.isFinite(dev.planningPowerKw)
    || Number.isFinite(dev.powerKw);
}

function buildBasePlanDevice(params: {
  dev: PlanInputDevice;
  priority: number;
  recentlyRestored: boolean;
  binaryCommandPending: boolean;
  currentState: string;
  currentTarget: number | null;
  plannedTarget: number | null;
  controllable: boolean;
  shedBehavior: { action: ShedAction; temperature: number | null; stepId: string | null };
  shedSet: Set<string>;
  shedReasons: Map<string, DeviceReason>;
  steppedDesiredStepByDeviceId: Map<string, string>;
  temperatureShedTargets: Map<string, { temperature: number; capabilityId: string }>;
}): DevicePlanDevice {
  const {
    dev,
    priority,
    recentlyRestored,
    binaryCommandPending,
    currentState,
    currentTarget,
    plannedTarget,
    controllable,
    shedBehavior,
    shedSet,
    shedReasons,
    steppedDesiredStepByDeviceId,
    temperatureShedTargets,
  } = params;

  const initialDesiredStepId = resolveSteppedLoadInitialDesiredStepId(dev);
  const runtimeDesiredStepId = dev.desiredStepId ?? initialDesiredStepId;
  const directShedStepId = resolveSteppedLoadDirectShedStepId({
    dev,
    shedBehavior,
    shouldShed: shedSet.has(dev.id),
    currentDesiredStepId: steppedDesiredStepByDeviceId.get(dev.id) ?? dev.selectedStepId,
  });
  const shedDesiredStepId = directShedStepId ?? steppedDesiredStepByDeviceId.get(dev.id);
  const desiredStepId = shedDesiredStepId ?? runtimeDesiredStepId;
  const isSteppedShed = isSteppedLoadDevice(dev)
    && shedDesiredStepId !== undefined
    && shedDesiredStepId !== dev.selectedStepId;
  const plannedState = resolvePlannedState(controllable, shedSet.has(dev.id) || isSteppedShed);
  // For keep/restore devices at off-step, normalize desired step to lowest non-zero.
  // Computed after plannedState to avoid a circular effect on isSteppedShed.
  const effectiveDesiredStepId = resolveSteppedKeepDesiredStepId({
    ...dev,
    currentState,
    plannedState,
    desiredStepId,
  });
  const baseReason: DeviceReason = controllable
    ? shedReasons.get(dev.id) ?? { code: PLAN_REASON_CODES.keep, detail: recentlyRestored ? 'recently restored' : null }
    : { code: PLAN_REASON_CODES.capacityControlOff };
  const { shedAction, shedTemperature, shedStepId } = resolveShedAction({
    dev,
    controllable,
    shouldShed: shedSet.has(dev.id),
    shedBehavior,
    temperatureShedTargets,
  });
  const resolvedPlannedTarget = shedAction === 'set_temperature' && shedTemperature !== null
    ? shedTemperature
    : plannedTarget;

  return {
    id: dev.id,
    name: dev.name,
    deviceClass: dev.deviceClass,
    currentOn: dev.currentOn,
    currentState,
    plannedState,
    currentTarget,
    plannedTarget: resolvedPlannedTarget,
    observationStale: dev.observationStale,
    communicationModel: dev.communicationModel,
    controlModel: dev.controlModel,
    steppedLoadProfile: dev.steppedLoadProfile,
    reportedStepId: dev.reportedStepId,
    targetStepId: effectiveDesiredStepId,
    selectedStepId: dev.selectedStepId,
    desiredStepId: effectiveDesiredStepId,
    lastDesiredStepId: dev.desiredStepId,
    lastStepCommandIssuedAt: dev.lastStepCommandIssuedAt,
    stepCommandRetryCount: dev.stepCommandRetryCount,
    nextStepCommandRetryAtMs: dev.nextStepCommandRetryAtMs,
    actualStepId: dev.actualStepId,
    assumedStepId: dev.assumedStepId,
    actualStepSource: dev.actualStepSource,
    priority,
    powerKw: dev.powerKw,
    expectedPowerKw: resolveExpectedPowerKw(dev, currentState, plannedState, effectiveDesiredStepId),
    planningPowerKw: dev.planningPowerKw,
    expectedPowerSource: dev.expectedPowerSource,
    measuredPowerKw: dev.measuredPowerKw,
    controlCapabilityId: dev.controlCapabilityId,
    evChargingState: dev.evChargingState,
    reason: baseReason,
    zone: dev.zone || 'Unknown',
    controllable,
    budgetExempt: dev.budgetExempt,
    available: dev.available,
    currentTemperature: dev.currentTemperature,
    stepCommandPending: dev.stepCommandPending,
    stepCommandStatus: dev.stepCommandStatus,
    binaryCommandPending: binaryCommandPending || undefined,
    shedAction,
    shedTemperature,
    shedStepId,
  };
}

function isRecentlyRestored(lastRestoreMs: number | undefined): boolean {
  if (!lastRestoreMs) return false;
  return Date.now() - lastRestoreMs < RECENT_RESTORE_SHED_GRACE_MS;
}

function resolvePlannedState(controllable: boolean, shouldShed: boolean): 'shed' | 'keep' {
  if (!controllable) return 'keep';
  return shouldShed ? 'shed' : 'keep';
}

function resolveShedAction(params: {
  dev: PlanInputDevice;
  controllable: boolean;
  shouldShed: boolean;
  shedBehavior: { action: ShedAction; temperature: number | null; stepId: string | null };
  temperatureShedTargets: Map<string, { temperature: number; capabilityId: string }>;
}): { shedAction: ShedAction; shedTemperature: number | null; shedStepId: string | null } {
  const { dev, controllable, shouldShed, shedBehavior, temperatureShedTargets } = params;
  // Use pre-computed temperature target from the shedding planner when available
  if (controllable && shouldShed) {
    const tempTarget = temperatureShedTargets.get(dev.id);
    if (tempTarget) {
      const target = dev.targets?.find((t) => t.id === tempTarget.capabilityId) ?? null;
      return {
        shedAction: 'set_temperature',
        shedTemperature: normalizeTargetCapabilityValue({ target, value: tempTarget.temperature }),
        shedStepId: null,
      };
    }
  }
  if (isSteppedLoadDevice(dev)) {
    return resolveSteppedShedAction({ controllable, hasBinaryControl: dev.hasBinaryControl, shedBehavior });
  }
  // Non-stepped temperature devices: fall back to shedBehavior when not in temperatureShedTargets
  if (controllable && shouldShed
    && shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null) {
    const target = getPrimaryTargetCapability(dev.targets);
    return {
      shedAction: 'set_temperature',
      shedTemperature: normalizeTargetCapabilityValue({ target, value: shedBehavior.temperature }),
      shedStepId: null,
    };
  }
  return { shedAction: 'turn_off', shedTemperature: null, shedStepId: null };
}

function resolveSteppedShedAction(params: {
  controllable: boolean;
  hasBinaryControl: boolean | undefined;
  shedBehavior: { action: ShedAction; temperature: number | null; stepId: string | null };
}): { shedAction: ShedAction; shedTemperature: number | null; shedStepId: string | null } {
  const { controllable, hasBinaryControl, shedBehavior } = params;
  if (controllable && shedBehavior.action === 'set_step') {
    return { shedAction: 'set_step', shedTemperature: null, shedStepId: null };
  }
  // turn_off requires binary control; normalize to set_step when missing
  if (hasBinaryControl === false) {
    return { shedAction: 'set_step', shedTemperature: null, shedStepId: null };
  }
  return { shedAction: 'turn_off', shedTemperature: null, shedStepId: null };
}

function resolveSteppedLoadDirectShedStepId(params: {
  dev: PlanInputDevice;
  shedBehavior: { action: ShedAction; temperature: number | null; stepId: string | null };
  shouldShed: boolean;
  currentDesiredStepId?: string;
}): string | undefined {
  const {
    dev,
    shedBehavior,
    shouldShed,
    currentDesiredStepId,
  } = params;
  if (!shouldShed || !isSteppedLoadDevice(dev)) return undefined;
  if (shedBehavior.action === 'turn_off') {
    const profile = dev.steppedLoadProfile;
    if (!profile) return undefined;
    // turn_off targets the off-step (zero-usage) directly, not gradual stepping
    return (getSteppedLoadOffStep(profile) ?? getSteppedLoadLowestStep(profile))?.id;
  }
  if (shedBehavior.action !== 'set_step') return undefined;
  const targetStep = getSteppedLoadShedTargetStep({
    device: dev,
    shedAction: 'set_step',
    currentDesiredStepId,
  });
  return targetStep?.id;
}

// Only physically-confirmed blocking EV states (plugged_out, discharging) warrant marking
// inactive before the currentState guard. Unknown/undefined evChargingState is ambiguous —
// defer those to the off path so an actively-charging device is never incorrectly blocked.
function resolveEvPhysicalBlockInactiveReason(planDevice: DevicePlanDevice): string | null {
  const { evChargingState } = planDevice;
  if (evChargingState !== 'plugged_out' && evChargingState !== 'plugged_in_discharging') return null;
  const reason = getEvRestoreStateBlockReason(planDevice);
  return reason ?? null;
}

function applyOffStateReason(params: {
  planDevice: DevicePlanDevice;
  headroomRaw: number;
  guardInShortfall: boolean;
}): DevicePlanDevice {
  const { planDevice, headroomRaw, guardInShortfall } = params;
  if (!planDevice.controllable) return planDevice;
  const physicalBlockReason = resolveEvPhysicalBlockInactiveReason(planDevice);
  if (physicalBlockReason) {
    return {
      ...planDevice,
      plannedState: 'inactive',
      reason: { code: PLAN_REASON_CODES.inactive, detail: physicalBlockReason },
    };
  }
  if (planDevice.currentState !== 'off') return planDevice;
  // Full inactive check (including power-unknown) is safe once the device is confirmed off.
  const inactiveReason = getInactiveReason(planDevice);
  if (inactiveReason) {
    return { ...planDevice, plannedState: 'inactive', reason: inactiveReason };
  }
  const shouldForceOffStep = guardInShortfall && isSteppedLoadDevice(planDevice);
  const desiredStepId = shouldForceOffStep
    ? getSteppedLoadShedTargetStep({
      device: planDevice,
      shedAction: 'turn_off',
      currentDesiredStepId: planDevice.desiredStepId,
    })?.id ?? planDevice.desiredStepId
    : planDevice.desiredStepId;
  if (planDevice.plannedState === 'shed') {
    return desiredStepId === planDevice.desiredStepId ? planDevice : {
      ...planDevice,
      desiredStepId,
    };
  }
  const { needed: need } = computeBaseRestoreNeed(planDevice);

  if (guardInShortfall) {
    return {
      ...planDevice,
      plannedState: 'shed',
      desiredStepId,
      reason: buildShortfallReason(need, headroomRaw),
    };
  }
  return {
    ...planDevice,
    reason: { code: PLAN_REASON_CODES.keep, detail: null },
    candidateReasons: {
      ...planDevice.candidateReasons,
      offStateAnalysis: formatDeviceReason(buildRestoreNeedReason(need, headroomRaw)),
    },
  };
}

function applyHourlyBudgetShed(params: {
  planDevice: DevicePlanDevice;
  hourlyBudgetExhausted: boolean;
}): DevicePlanDevice {
  const { planDevice, hourlyBudgetExhausted } = params;
  if (!planDevice.controllable) return planDevice;
  if (!hourlyBudgetExhausted || planDevice.plannedState === 'shed') return planDevice;
  if (
    planDevice.currentState !== 'on'
    && planDevice.currentState !== 'unknown'
    && planDevice.currentState !== 'not_applicable'
  ) return planDevice;
  const desiredStepId = isSteppedLoadDevice(planDevice)
    ? getSteppedLoadShedTargetStep({
      device: planDevice,
      shedAction: planDevice.shedAction === 'set_step' ? 'set_step' : 'turn_off',
      currentDesiredStepId: planDevice.desiredStepId,
    })?.id ?? planDevice.desiredStepId
    : planDevice.desiredStepId;
  return {
    ...planDevice,
    plannedState: 'shed',
    desiredStepId,
    reason: { code: PLAN_REASON_CODES.hourlyBudget, detail: null },
  };
}
