import type {
  DeviceDiagnosticsBlockCause,
  DeviceDiagnosticsPlanObservation,
} from '../diagnostics/deviceDiagnosticsService';
import type { PlanContext } from './planContext';
import type { RestorePlanResult } from './planRestore';
import type { DevicePlanDevice, PlanInputDevice } from './planTypes';

const TARGET_DEFICIT_EPSILON_C = 0.5;

type BuildDeviceDiagnosticsObservationsParams = {
  context: PlanContext;
  planDevices: DevicePlanDevice[];
  restoreResult: RestorePlanResult;
  priceOptimizationEnabled: boolean;
  priceOptimizationSettings: Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
};

export const buildDeviceDiagnosticsObservations = (
  params: BuildDeviceDiagnosticsObservationsParams,
): DeviceDiagnosticsPlanObservation[] => {
  const inputDeviceById = new Map(params.context.devices.map((device) => [device.id, device]));
  return params.planDevices.map((device) => buildDiagnosticsObservation({
    desiredForMode: params.context.desiredForMode,
    inputDevice: inputDeviceById.get(device.id),
    device,
    restoreResult: params.restoreResult,
    priceOptimizationEnabled: params.priceOptimizationEnabled,
    priceOptimizationSettings: params.priceOptimizationSettings,
    isCurrentHourCheap: params.isCurrentHourCheap,
    isCurrentHourExpensive: params.isCurrentHourExpensive,
  }));
};

const isEvLikeDevice = (device: DevicePlanDevice, inputDevice?: PlanInputDevice): boolean => (
  device.controlCapabilityId === 'evcharger_charging'
  || inputDevice?.controlCapabilityId === 'evcharger_charging'
  || typeof device.evChargingState === 'string'
  || typeof inputDevice?.evChargingState === 'string'
);

const buildAppliedStateSummary = (
  desiredTarget: number | null,
  currentTarget: number | null,
  currentState: string,
): string => {
  if (desiredTarget === null) return currentState;
  return currentTarget !== null ? `${currentTarget.toFixed(1)}C` : 'unknown';
};

const resolveUnmetDemand = (
  desiredTarget: number | null,
  includeDemandMetrics: boolean,
  targetDeficitActive: boolean,
  device: DevicePlanDevice,
): boolean => {
  if (desiredTarget !== null) return targetDeficitActive;
  return includeDemandMetrics && device.currentState === 'off' && device.plannedState !== 'inactive';
};

const buildDiagnosticsObservation = (params: {
  desiredForMode: Record<string, number>;
  inputDevice?: PlanInputDevice;
  device: DevicePlanDevice;
  restoreResult: RestorePlanResult;
  priceOptimizationEnabled: boolean;
  priceOptimizationSettings: Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
}): DeviceDiagnosticsPlanObservation => {
  const {
    desiredForMode,
    inputDevice,
    device,
    restoreResult,
    priceOptimizationEnabled,
    priceOptimizationSettings,
    isCurrentHourCheap,
    isCurrentHourExpensive,
  } = params;
  const isEv = isEvLikeDevice(device, inputDevice);
  const includeDemandMetrics = !isEv && device.controllable !== false && device.available !== false;
  const desiredTarget = resolveDesiredTemperatureTarget({
    desiredForMode,
    inputDevice,
    priceOptimizationEnabled,
    priceOptimizationSettings,
    isCurrentHourCheap,
    isCurrentHourExpensive,
  });
  const currentTarget = typeof device.currentTarget === 'number' ? device.currentTarget : null;
  const targetDeficitActive = includeDemandMetrics
    && desiredTarget !== null
    && currentTarget !== null
    && desiredTarget - currentTarget >= TARGET_DEFICIT_EPSILON_C;
  const unmetDemand = resolveUnmetDemand(desiredTarget, includeDemandMetrics, targetDeficitActive, device);

  return {
    deviceId: device.id,
    name: device.name,
    includeDemandMetrics,
    unmetDemand,
    blockCause: resolveDiagnosticsBlockCause({
      device,
      desiredTarget,
      targetDeficitActive,
      unmetDemand,
      restoreResult,
    }),
    targetDeficitActive,
    desiredStateSummary: desiredTarget !== null ? `${desiredTarget.toFixed(1)}C` : 'on',
    appliedStateSummary: buildAppliedStateSummary(desiredTarget, currentTarget, device.currentState),
  };
};

const resolveDesiredTemperatureTarget = (params: {
  desiredForMode: Record<string, number>;
  inputDevice?: PlanInputDevice;
  priceOptimizationEnabled: boolean;
  priceOptimizationSettings: Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
}): number | null => {
  const {
    desiredForMode,
    inputDevice,
    priceOptimizationEnabled,
    priceOptimizationSettings,
    isCurrentHourCheap,
    isCurrentHourExpensive,
  } = params;
  if (!inputDevice || !Array.isArray(inputDevice.targets) || inputDevice.targets.length === 0) {
    return null;
  }
  if (inputDevice.deviceType && inputDevice.deviceType !== 'temperature') {
    return null;
  }
  const desired = desiredForMode[inputDevice.id];
  if (!Number.isFinite(desired)) return null;

  let desiredTarget = Number(desired);
  const priceOptConfig = priceOptimizationSettings[inputDevice.id];
  if (priceOptimizationEnabled && priceOptConfig?.enabled) {
    if (isCurrentHourCheap() && priceOptConfig.cheapDelta) {
      desiredTarget += priceOptConfig.cheapDelta;
    } else if (isCurrentHourExpensive() && priceOptConfig.expensiveDelta) {
      desiredTarget += priceOptConfig.expensiveDelta;
    }
  }
  return desiredTarget;
};

const resolveDiagnosticsBlockCause = (params: {
  device: DevicePlanDevice;
  desiredTarget: number | null;
  targetDeficitActive: boolean;
  unmetDemand: boolean;
  restoreResult: RestorePlanResult;
}): DeviceDiagnosticsBlockCause => {
  const {
    device,
    desiredTarget,
    targetDeficitActive,
    unmetDemand,
    restoreResult,
  } = params;
  if (!unmetDemand) return 'not_blocked';

  if (desiredTarget !== null) {
    return resolveTemperatureBlockCause(device, desiredTarget, targetDeficitActive, restoreResult);
  }

  if (device.plannedState === 'inactive' || device.plannedState === 'keep') {
    return 'not_blocked';
  }
  if (restoreResult.activeOvershoot) {
    return 'headroom';
  }
  if (isBinaryDeviceBlockedByCooldown(device, restoreResult)) {
    return 'cooldown_backoff';
  }
  return 'headroom';
};

const resolveTemperatureBlockCause = (
  device: DevicePlanDevice,
  desiredTarget: number,
  targetDeficitActive: boolean,
  restoreResult: RestorePlanResult,
): DeviceDiagnosticsBlockCause => {
  const plannedTarget = typeof device.plannedTarget === 'number' ? device.plannedTarget : null;
  const plannedToRecover = targetDeficitActive
    && plannedTarget !== null
    && plannedTarget >= desiredTarget - TARGET_DEFICIT_EPSILON_C;
  if (plannedToRecover) return 'not_blocked';
  if (restoreResult.activeOvershoot) {
    return 'headroom';
  }
  if (restoreResult.inCooldown || restoreResult.inRestoreCooldown) {
    return 'cooldown_backoff';
  }
  return 'headroom';
};

const isBinaryDeviceBlockedByCooldown = (
  device: DevicePlanDevice,
  restoreResult: RestorePlanResult,
): boolean => (
  restoreResult.inCooldown
  || restoreResult.inRestoreCooldown
  || (restoreResult.restoredOneThisCycle && !restoreResult.restoredThisCycle.has(device.id))
);
