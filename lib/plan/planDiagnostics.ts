import type {
  DeviceDiagnosticsBlockCause,
  DeviceDiagnosticsPlanObservation,
  DeviceDiagnosticsStarvationCountingCause,
  DeviceDiagnosticsStarvationPauseReason,
  DeviceDiagnosticsStarvationSuppressionState,
} from '../diagnostics/deviceDiagnosticsService';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { resolveStarvationSuppressionSemantics } from '../planContract/planDecisionSemantics';
import type { PlanContext } from './planContext';
import type { RestorePlanResult } from './restore';
import type { DevicePlanDevice, PlanInputDevice } from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { isEvDevice } from '../../packages/shared-domain/src/commandableNow';
import {
  isStarvationSupportedDeviceClass,
  isTemperatureControlDevice,
} from '../../packages/shared-domain/src/temperatureDeviceKind';
import { getPrimaryTargetCapability } from '../utils/targetCapabilities';
import { isDeviceObservationTrusted } from '../observer/observationTrust';

const TARGET_DEFICIT_EPSILON_C = 0.5;
const STARVATION_LOW_TEMP_STEP_C = 0.5;
const STARVATION_HIGH_TEMP_STEP_C = 1.0;

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
    // A headroom-blocked restore hold is releasable by the budget rescue ONLY when the
    // daily budget is the binding limit AND the power sample is fresh (`powerKnown`).
    // Hourly-cap exhaustion forces `softLimitSource` to 'capacity' (capacitySoftLimit → 0),
    // and any non-fresh meter (`stale_hold` uses a synthetic 0 headroom, `stale_fail_closed`
    // forces -1) blocks the restore for reasons the daily budget can't lift — the rescue
    // never raises the physical hard cap and can't make restoring safe until power is fresh.
    // Those stay in the capacity bucket. Resolved to a flat boolean HERE so no consumer re-derives it.
    budgetReleasableHeadroomHold:
      params.context.softLimitSource === 'daily' && params.context.powerKnown,
    priceOptimizationEnabled: params.priceOptimizationEnabled,
    priceOptimizationSettings: params.priceOptimizationSettings,
    isCurrentHourCheap: params.isCurrentHourCheap,
    isCurrentHourExpensive: params.isCurrentHourExpensive,
  }));
};

const isEvLikeDevice = (device: DevicePlanDevice, inputDevice?: PlanInputDevice): boolean => (
  isEvDevice(device) || (inputDevice !== undefined && isEvDevice(inputDevice))
);

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const isTemperatureInputDevice = (inputDevice?: PlanInputDevice): boolean => (
  isTemperatureControlDevice(inputDevice)
);

const resolveCurrentTemperatureC = (
  device: DevicePlanDevice,
  inputDevice?: PlanInputDevice,
): number | null => {
  const deviceTemperature = isTemperaturePlanDevice(device) ? device.currentTemperature : undefined;
  if (isFiniteNumber(deviceTemperature)) return deviceTemperature;
  const inputTemperature = inputDevice && isTemperaturePlanDevice(inputDevice)
    ? inputDevice.currentTemperature
    : undefined;
  if (isFiniteNumber(inputTemperature)) return inputTemperature;
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

// The effective target PELS is currently COMMANDING the device toward: the
// planned setpoint this cycle when PELS is applying one, otherwise the held
// current setpoint. Starvation compares this against the intended/mode target —
// a device PELS commands in full (`keep`) is not starved, however cold it is.
const resolveCommandedTargetC = (device: DevicePlanDevice): number | null => {
  if (!isTemperaturePlanDevice(device)) return null;
  if (isFiniteNumber(device.plannedTarget)) return device.plannedTarget;
  if (isFiniteNumber(device.currentTarget)) return device.currentTarget;
  return null;
};

// True when PELS is shedding this temperature device by commanding it OFF: the
// plan decided to shed it (`plannedState === 'shed'`) and the resolved shed
// action is `turn_off` (the default shed behavior — cut power without lowering a
// setpoint). This is just as much PELS holding the device below its target as a
// setpoint-lowering shed, but it leaves no lowered commanded target for the
// commanded-vs-intended check to detect, so it is surfaced as its own signal.
// A device the USER turned off is not being shed by PELS (`plannedState` is
// `keep`), so it never sets this.
const resolvePelsCommandsTurnOffShed = (
  device: DevicePlanDevice,
  isTemperatureDevice: boolean,
): boolean => (
  isTemperatureDevice
  && device.plannedState === 'shed'
  && device.shedAction === 'turn_off'
);

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
  isDeviceObservationTrusted(device)
  && (inputDevice === undefined || isDeviceObservationTrusted(inputDevice))
);

const resolveEligibleForStarvation = (params: {
  device: DevicePlanDevice;
  inputDevice?: PlanInputDevice;
  isEv: boolean;
}): boolean => {
  const { device, inputDevice, isEv } = params;
  if (isEv || !inputDevice) return false;
  if (!isTemperatureInputDevice(inputDevice)) return false;
  if (!isStarvationSupportedDeviceClass(device.deviceClass ?? inputDevice.deviceClass)) return false;
  return inputDevice.managed === true
    && inputDevice.controllable === true
    && device.controllable !== false
    && inputDevice.available !== false
    && device.available !== false;
};

// A restore held for `insufficient_headroom` is blocked against the binding soft limit.
// When that hold is BUDGET-RELEASABLE — the daily budget is the binding limit and the
// power sample is trustworthy (`budgetReleasableHeadroomHold`, resolved in the producer)
// — the physical capacity cap is not the constraint doing the work; the daily budget is,
// and it is the releasable lever the owner can rescue against. Re-attribute the counting
// cause to `daily_budget` so the overview budget-vs-capacity bucket, the rescue-widget
// gating, and the emitted `device_starvation_started` cause all read the true, releasable
// cause — without any consumer re-deriving the source. This mirrors the shed-time
// re-attribution `resolveShedReason`/`buildBaseReason` already perform for capacity→daily.
// A genuine capacity-bound shortfall — physical capacity, an exhausted hourly cap (which
// forces `softLimitSource` to 'capacity'), or a non-fresh meter (stale hold/fail-closed, so
// `powerKnown` is false) — keeps `insufficient_headroom` (→ the capacity bucket, no rescue
// the budget exemption can honor).
const reattributeHeadroomShortfallCause = (
  countingCause: DeviceDiagnosticsStarvationCountingCause | null,
  budgetReleasableHeadroomHold: boolean,
): DeviceDiagnosticsStarvationCountingCause | null => (
  countingCause === 'insufficient_headroom' && budgetReleasableHeadroomHold
    ? 'daily_budget'
    : countingCause
);

const resolveSuppressionFromReason = (
  reason: DeviceReason,
  budgetReleasableHeadroomHold: boolean,
): StarvationSuppressionNormalization => {
  const semantics = resolveStarvationSuppressionSemantics(reason);
  return {
    suppressionState: semantics.state,
    countingCause: reattributeHeadroomShortfallCause(semantics.countingCause, budgetReleasableHeadroomHold),
    pauseReason: semantics.pauseReason,
  };
};

const resolveStarvationSuppression = (params: {
  device: DevicePlanDevice;
  inputDevice?: PlanInputDevice;
  isEv: boolean;
  budgetReleasableHeadroomHold: boolean;
}): StarvationSuppressionNormalization => {
  const { device, inputDevice, isEv, budgetReleasableHeadroomHold } = params;
  if (isEv || !inputDevice || device.controllable === false || inputDevice.controllable !== true) {
    return noStarvationSuppression();
  }
  const reason = device.reason;
  const normalized = resolveSuppressionFromReason(reason, budgetReleasableHeadroomHold);
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
  budgetReleasableHeadroomHold: boolean;
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
    budgetReleasableHeadroomHold,
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
  const currentTarget = isTemperaturePlanDevice(device) && typeof device.currentTarget === 'number'
    ? device.currentTarget
    : null;
  const intendedNormalTargetC = resolveIntendedNormalTemperatureTarget({
    desiredForMode,
    inputDevice,
  });
  const currentTemperatureC = resolveCurrentTemperatureC(device, inputDevice);
  const commandedTargetC = resolveCommandedTargetC(device);
  const pelsCommandsTurnOffShed = resolvePelsCommandsTurnOffShed(
    device,
    isTemperatureInputDevice(inputDevice),
  );
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
    budgetReleasableHeadroomHold,
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
    commandedTargetC,
    targetStepC,
    pelsCommandsTurnOffShed,
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
  // Bail only when the device declares a non-temperature modality; an unset
  // deviceType is left to the downstream target check (behaviour preserved —
  // matches the prior `deviceType && deviceType !== 'temperature'` truthiness).
  if (inputDevice.deviceType && !isTemperatureControlDevice(inputDevice)) {
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
  const plannedTarget = isTemperaturePlanDevice(device) && typeof device.plannedTarget === 'number'
    ? device.plannedTarget
    : null;
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
