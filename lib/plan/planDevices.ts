import type { DevicePlanDevice, PlanInputDevice, ShedAction } from './planTypes';
import type { PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import { computeBaseRestoreNeed } from './planRestoreSwap';
import { RECENT_RESTORE_SHED_GRACE_MS } from './planConstants';
import { isPendingBinaryCommandActive } from './planObservationPolicy';
import {
  getPrimaryTargetCapability,
  normalizeTargetCapabilityValue,
} from '../utils/targetCapabilities';
import { getInactiveReason } from './planRestoreDevices';
import {
  isSteppedLoadDevice,
  resolveSteppedLoadCurrentState,
  resolveSteppedLoadInitialDesiredStepId,
  getSteppedLoadShedTargetStep,
} from './planSteppedLoad';

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
  shedReasons: Map<string, string>;
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
    const currentTarget = Array.isArray(dev.targets) && dev.targets.length ? dev.targets[0].value ?? null : null;
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
  if (device.observationStale === true) {
    return device.hasBinaryControl === false ? 'not_applicable' : 'unknown';
  }
  const steppedState = resolveSteppedLoadCurrentState(device);
  if (steppedState !== 'unknown') return steppedState;
  if (device.hasBinaryControl === false) return 'not_applicable';
  return device.currentOn ? 'on' : 'off';
}

function buildBasePlanDevice(params: {
  dev: PlanInputDevice;
  priority: number;
  recentlyRestored: boolean;
  binaryCommandPending: boolean;
  currentState: string;
  currentTarget: unknown;
  plannedTarget: number | null;
  controllable: boolean;
  shedBehavior: { action: ShedAction; temperature: number | null; stepId: string | null };
  shedSet: Set<string>;
  shedReasons: Map<string, string>;
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
  const directShedStepId = resolveSteppedLoadDirectShedStepId({
    dev,
    shedBehavior,
    shouldShed: shedSet.has(dev.id),
    currentDesiredStepId: steppedDesiredStepByDeviceId.get(dev.id) ?? initialDesiredStepId,
  });
  const desiredStepId = directShedStepId ?? steppedDesiredStepByDeviceId.get(dev.id) ?? initialDesiredStepId;
  const isSteppedShed = isSteppedLoadDevice(dev)
    && desiredStepId !== undefined
    && desiredStepId !== dev.selectedStepId;
  const plannedState = resolvePlannedState(controllable, shedSet.has(dev.id) || isSteppedShed);
  const baseReason = controllable
    ? shedReasons.get(dev.id) || (recentlyRestored ? 'keep (recently restored)' : 'keep')
    : 'capacity control off';
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
    currentOn: dev.currentOn,
    currentState,
    plannedState,
    currentTarget,
    plannedTarget: resolvedPlannedTarget,
    observationStale: dev.observationStale,
    communicationModel: dev.communicationModel,
    controlModel: dev.controlModel,
    steppedLoadProfile: dev.steppedLoadProfile,
    selectedStepId: dev.selectedStepId,
    desiredStepId,
    lastDesiredStepId: dev.desiredStepId,
    actualStepId: dev.actualStepId,
    assumedStepId: dev.assumedStepId,
    actualStepSource: dev.actualStepSource,
    priority,
    powerKw: dev.powerKw,
    expectedPowerKw: dev.expectedPowerKw,
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
    return resolveSteppedShedAction({ controllable, shedBehavior });
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
  shedBehavior: { action: ShedAction; temperature: number | null; stepId: string | null };
}): { shedAction: ShedAction; shedTemperature: number | null; shedStepId: string | null } {
  const { controllable, shedBehavior } = params;
  if (controllable && shedBehavior.action === 'set_step') {
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
  if (!shouldShed || !isSteppedLoadDevice(dev) || shedBehavior.action !== 'set_step') return undefined;
  const targetStep = getSteppedLoadShedTargetStep({
    device: dev,
    shedAction: 'set_step',
    currentDesiredStepId,
  });
  return targetStep?.id;
}

function applyOffStateReason(params: {
  planDevice: DevicePlanDevice;
  headroomRaw: number | null;
  guardInShortfall: boolean;
}): DevicePlanDevice {
  const { planDevice, headroomRaw, guardInShortfall } = params;
  if (!planDevice.controllable) return planDevice;
  if (planDevice.currentState !== 'off') return planDevice;
  const inactiveReason = getInactiveReason(planDevice);
  if (inactiveReason) {
    return {
      ...planDevice,
      plannedState: 'inactive',
      reason: inactiveReason,
    };
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
      reason: `shortfall (need ${need.toFixed(2)}kW, headroom `
        + `${headroomRaw === null ? 'unknown' : headroomRaw.toFixed(2)}kW)`,
    };
  }
  return {
    ...planDevice,
    reason: `restore (need ${need.toFixed(2)}kW, headroom `
      + `${headroomRaw === null ? 'unknown' : headroomRaw.toFixed(2)}kW)`,
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
    reason: 'shed due to hourly budget',
  };
}
