import type {
  DeviceDiagnosticsBlockCause,
  DeviceDiagnosticsPlanObservation,
  DeviceDiagnosticsStarvationCountingCause,
  DeviceDiagnosticsStarvationPauseReason,
  DeviceDiagnosticsStarvationSuppressionState,
} from '../diagnostics/deviceDiagnosticsService';
import {
  PLAN_REASON_CODES,
  type DeviceReason,
  type PlanReasonCode,
} from '../../packages/shared-domain/src/planReasonSemantics';
import type { PlanContext } from './planContext';
import type { RestorePlanResult } from './planRestore';
import type { DevicePlanDevice, PlanInputDevice } from './planTypes';
import { getPrimaryTargetCapability } from '../utils/targetCapabilities';

const TARGET_DEFICIT_EPSILON_C = 0.5;
const STARVATION_LOW_TEMP_STEP_C = 0.5;
const STARVATION_HIGH_TEMP_STEP_C = 1.0;
const STARVATION_SUPPORTED_DEVICE_CLASSES = new Set([
  'thermostat',
  'heater',
  'heatpump',
  'airconditioning',
  'airtreatment',
]);

const noStarvationSuppression = (): StarvationSuppressionNormalization => ({
  suppressionState: 'none',
  countingCause: null,
  pauseReason: null,
});

type StarvationSuppressionNormalization = {
  suppressionState: DeviceDiagnosticsStarvationSuppressionState;
  countingCause: DeviceDiagnosticsStarvationCountingCause | null;
  pauseReason: DeviceDiagnosticsStarvationPauseReason | null;
};

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

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const isTemperatureInputDevice = (inputDevice?: PlanInputDevice): boolean => (
  inputDevice?.deviceType === 'temperature'
);

const resolveCurrentTemperatureC = (
  device: DevicePlanDevice,
  inputDevice?: PlanInputDevice,
): number | null => {
  if (isFiniteNumber(device.currentTemperature)) return device.currentTemperature;
  if (isFiniteNumber(inputDevice?.currentTemperature)) return inputDevice.currentTemperature;
  return null;
};

const resolveIntendedNormalTemperatureTarget = (params: {
  desiredForMode: Record<string, number>;
  inputDevice?: PlanInputDevice;
}): number | null => {
  const { desiredForMode, inputDevice } = params;
  if (!inputDevice || !isTemperatureInputDevice(inputDevice)) return null;
  if (!Array.isArray(inputDevice.targets) || inputDevice.targets.length === 0) return null;
  const desired = desiredForMode[inputDevice.id];
  return Number.isFinite(desired) ? Number(desired) : null;
};

const resolveTargetStepC = (
  inputDevice: PlanInputDevice | undefined,
  intendedNormalTargetC: number | null,
): number | null => {
  if (!inputDevice || !isFiniteNumber(intendedNormalTargetC)) return null;
  const target = getPrimaryTargetCapability(inputDevice.targets);
  if (isFiniteNumber(target?.step) && target.step > 0) {
    return target.step;
  }
  return intendedNormalTargetC < 30 ? STARVATION_LOW_TEMP_STEP_C : STARVATION_HIGH_TEMP_STEP_C;
};

const resolveObservationFresh = (
  device: DevicePlanDevice,
  inputDevice?: PlanInputDevice,
): boolean => (
  device.observationStale !== true
  && inputDevice?.observationStale !== true
);

const resolveEligibleForStarvation = (params: {
  device: DevicePlanDevice;
  inputDevice?: PlanInputDevice;
  isEv: boolean;
}): boolean => {
  const { device, inputDevice, isEv } = params;
  if (isEv || !inputDevice) return false;
  if (!isTemperatureInputDevice(inputDevice)) return false;
  const deviceClass = (device.deviceClass ?? inputDevice.deviceClass ?? '').trim().toLowerCase();
  if (!STARVATION_SUPPORTED_DEVICE_CLASSES.has(deviceClass)) return false;
  return inputDevice.managed === true
    && inputDevice.controllable === true
    && device.controllable !== false
    && inputDevice.available !== false
    && device.available !== false;
};

const PAUSED_COOLDOWN_CODES = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.cooldownShedding,
  PLAN_REASON_CODES.cooldownRestore,
  PLAN_REASON_CODES.meterSettling,
]);

const PAUSED_RESTORE_CODES = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.restorePending,
  PLAN_REASON_CODES.waitingForOtherDevices,
  PLAN_REASON_CODES.restoreNeed,
]);

const COUNTING_SUPPRESSION_CAUSES: Partial<Record<PlanReasonCode, DeviceDiagnosticsStarvationCountingCause>> = {
  [PLAN_REASON_CODES.capacity]: 'capacity',
  [PLAN_REASON_CODES.dailyBudget]: 'daily_budget',
  [PLAN_REASON_CODES.hourlyBudget]: 'hourly_budget',
  [PLAN_REASON_CODES.shortfall]: 'shortfall',
  [PLAN_REASON_CODES.swapPending]: 'swap_pending',
  [PLAN_REASON_CODES.swappedOut]: 'swapped_out',
  [PLAN_REASON_CODES.insufficientHeadroom]: 'insufficient_headroom',
  [PLAN_REASON_CODES.sheddingActive]: 'shedding_active',
};

const resolveSuppressionFromReason = (reason: DeviceReason): StarvationSuppressionNormalization => {
  if (reason.code === PLAN_REASON_CODES.headroomCooldown) {
    return { suppressionState: 'paused', countingCause: null, pauseReason: 'headroom_cooldown' };
  }
  if (PAUSED_COOLDOWN_CODES.has(reason.code)) {
    return { suppressionState: 'paused', countingCause: null, pauseReason: 'cooldown' };
  }
  if (reason.code === PLAN_REASON_CODES.restoreThrottled) {
    return { suppressionState: 'paused', countingCause: null, pauseReason: 'restore_throttled' };
  }
  if (PAUSED_RESTORE_CODES.has(reason.code)) {
    return { suppressionState: 'paused', countingCause: null, pauseReason: 'restore' };
  }
  if (reason.code === PLAN_REASON_CODES.keep) {
    return { suppressionState: 'paused', countingCause: null, pauseReason: 'keep' };
  }
  if (reason.code === PLAN_REASON_CODES.inactive) {
    return { suppressionState: 'paused', countingCause: null, pauseReason: 'inactive' };
  }
  const countingCause = COUNTING_SUPPRESSION_CAUSES[reason.code];
  if (countingCause) {
    return { suppressionState: 'counting', countingCause, pauseReason: null };
  }
  return noStarvationSuppression();
};

const resolveSuppressionFromHeadroomCooldown = (
  device: DevicePlanDevice,
): StarvationSuppressionNormalization => {
  if (device.plannedState !== 'keep') return noStarvationSuppression();
  if (device.headroomCardBlocked !== true || !device.headroomCardCooldownSource) {
    return noStarvationSuppression();
  }
  return {
    suppressionState: 'paused',
    countingCause: null,
    pauseReason: 'headroom_cooldown',
  };
};

const resolveStarvationSuppression = (params: {
  device: DevicePlanDevice;
  inputDevice?: PlanInputDevice;
  isEv: boolean;
}): StarvationSuppressionNormalization => {
  const { device, inputDevice, isEv } = params;
  if (isEv || !inputDevice || device.controllable === false || inputDevice.controllable !== true) {
    return noStarvationSuppression();
  }
  const reason = device.reason;
  const headroomCooldown = resolveSuppressionFromHeadroomCooldown(device);
  if (!reason) {
    if (headroomCooldown.suppressionState !== 'none') {
      return headroomCooldown;
    }
    return {
      suppressionState: device.plannedState === 'shed' ? 'paused' : 'none',
      countingCause: null,
      pauseReason: device.plannedState === 'shed' ? 'unknown_suppression_reason' : null,
    };
  }

  const normalized = resolveSuppressionFromReason(reason);
  if (
    headroomCooldown.suppressionState !== 'none'
    && normalized.pauseReason === 'keep'
  ) {
    return headroomCooldown;
  }

  if (normalized.suppressionState !== 'none') {
    return normalized;
  }

  if (device.plannedState === 'shed') {
    return {
      suppressionState: 'paused',
      countingCause: null,
      pauseReason: 'unknown_suppression_reason',
    };
  }

  return normalized;
};

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
  const intendedNormalTargetC = resolveIntendedNormalTemperatureTarget({
    desiredForMode,
    inputDevice,
  });
  const currentTemperatureC = resolveCurrentTemperatureC(device, inputDevice);
  const targetStepC = resolveTargetStepC(inputDevice, intendedNormalTargetC);
  const observationFresh = resolveObservationFresh(device, inputDevice);
  const eligibleForStarvation = resolveEligibleForStarvation({
    device,
    inputDevice,
    isEv,
  });
  const starvationSuppression = resolveStarvationSuppression({
    device,
    inputDevice,
    isEv,
  });
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
    eligibleForStarvation,
    currentTemperatureC,
    intendedNormalTargetC,
    targetStepC,
    suppressionState: starvationSuppression.suppressionState,
    countingCause: starvationSuppression.countingCause,
    pauseReason: starvationSuppression.pauseReason,
    observationFresh,
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
