import type { DevicePlanDevice, PlanInputDevice, ShedAction } from './planTypes';
import type { PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import { computeRestoreBufferKw, estimateRestorePower } from './planRestoreSwap';

export type PlanDevicesDeps = {
  getPriorityForDevice: (deviceId: string) => number;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null };
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
};

export function buildInitialPlanDevices(params: {
  context: PlanContext;
  state: PlanEngineState;
  shedSet: Set<string>;
  shedReasons: Map<string, string>;
  guardInShortfall: boolean;
  deps: PlanDevicesDeps;
}): DevicePlanDevice[] {
  const { context, shedSet, shedReasons, guardInShortfall, deps } = params;
  return context.devices.map((dev) => {
    const priority = deps.getPriorityForDevice(dev.id);
    const plannedTarget = resolvePlannedTarget({
      dev,
      desiredForMode: context.desiredForMode,
      deps,
    });
    const currentTarget = Array.isArray(dev.targets) && dev.targets.length ? dev.targets[0].value ?? null : null;
    const currentState = resolveCurrentState(dev.currentOn);
    const controllable = dev.controllable !== false;
    const shedBehavior = deps.getShedBehavior(dev.id);

    const base = buildBasePlanDevice({
      dev,
      priority,
      currentState,
      currentTarget,
      plannedTarget,
      controllable,
      shedBehavior,
      shedSet,
      shedReasons,
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
  deps: PlanDevicesDeps;
}): number | null {
  const { dev, desiredForMode, deps } = params;
  const desired = desiredForMode[dev.id];
  let plannedTarget = Number.isFinite(desired) ? Number(desired) : null;
  const priceOptConfig = deps.getPriceOptimizationSettings()[dev.id];
  if (deps.getPriceOptimizationEnabled() && plannedTarget !== null && priceOptConfig?.enabled) {
    plannedTarget = applyPriceOptimizationDelta(plannedTarget, priceOptConfig, deps);
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

function resolveCurrentState(currentOn?: boolean): string {
  if (typeof currentOn === 'boolean') return currentOn ? 'on' : 'off';
  return 'unknown';
}

function buildBasePlanDevice(params: {
  dev: PlanInputDevice;
  priority: number;
  currentState: string;
  currentTarget: unknown;
  plannedTarget: number | null;
  controllable: boolean;
  shedBehavior: { action: ShedAction; temperature: number | null };
  shedSet: Set<string>;
  shedReasons: Map<string, string>;
}): DevicePlanDevice {
  const {
    dev,
    priority,
    currentState,
    currentTarget,
    plannedTarget,
    controllable,
    shedBehavior,
    shedSet,
    shedReasons,
  } = params;

  const plannedState = resolvePlannedState(controllable, shedSet.has(dev.id));
  const baseReason = controllable
    ? shedReasons.get(dev.id) || `keep (priority ${priority})`
    : 'capacity control off';
  const { shedAction, shedTemperature } = resolveShedAction(controllable, shedSet.has(dev.id), shedBehavior);
  const resolvedPlannedTarget = shedAction === 'set_temperature' && shedTemperature !== null
    ? shedTemperature
    : plannedTarget;

  return {
    id: dev.id,
    name: dev.name,
    currentState,
    plannedState,
    currentTarget,
    plannedTarget: resolvedPlannedTarget,
    priority,
    powerKw: dev.powerKw,
    expectedPowerKw: dev.expectedPowerKw,
    measuredPowerKw: dev.measuredPowerKw,
    reason: baseReason,
    zone: dev.zone || 'Unknown',
    controllable,
    currentTemperature: dev.currentTemperature,
    shedAction,
    shedTemperature,
  };
}

function resolvePlannedState(controllable: boolean, shouldShed: boolean): 'shed' | 'keep' {
  if (!controllable) return 'keep';
  return shouldShed ? 'shed' : 'keep';
}

function resolveShedAction(
  controllable: boolean,
  shouldShed: boolean,
  shedBehavior: { action: ShedAction; temperature: number | null },
): { shedAction: ShedAction; shedTemperature: number | null } {
  if (controllable && shouldShed && shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null) {
    return { shedAction: 'set_temperature', shedTemperature: shedBehavior.temperature };
  }
  return { shedAction: 'turn_off', shedTemperature: null };
}

function applyOffStateReason(params: {
  planDevice: DevicePlanDevice;
  headroomRaw: number | null;
  guardInShortfall: boolean;
}): DevicePlanDevice {
  const { planDevice, headroomRaw, guardInShortfall } = params;
  if (!planDevice.controllable) return planDevice;
  if (planDevice.plannedState === 'shed' || planDevice.currentState !== 'off') return planDevice;
  const estimatedPower = estimateRestorePower(planDevice);
  const restoreBuffer = computeRestoreBufferKw(estimatedPower);
  const need = estimatedPower + restoreBuffer;
  if (guardInShortfall) {
    return {
      ...planDevice,
      plannedState: 'shed',
      reason: `shortfall (need ${need.toFixed(2)}kW, headroom ${headroomRaw === null ? 'unknown' : headroomRaw.toFixed(2)}kW)`,
    };
  }
  return {
    ...planDevice,
    reason: `restore (need ${need.toFixed(2)}kW, headroom ${headroomRaw === null ? 'unknown' : headroomRaw.toFixed(2)}kW)`,
  };
}

function applyHourlyBudgetShed(params: {
  planDevice: DevicePlanDevice;
  hourlyBudgetExhausted: boolean;
}): DevicePlanDevice {
  const { planDevice, hourlyBudgetExhausted } = params;
  if (!planDevice.controllable) return planDevice;
  if (!hourlyBudgetExhausted || planDevice.plannedState === 'shed') return planDevice;
  if (planDevice.currentState !== 'on' && planDevice.currentState !== 'unknown') return planDevice;
  return {
    ...planDevice,
    plannedState: 'shed',
    reason: 'shed due to hourly budget',
  };
}
