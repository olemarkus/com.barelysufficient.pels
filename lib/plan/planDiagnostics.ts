import type {
  DeviceDiagnosticsBlockCause,
  DeviceDiagnosticsPlanObservation,
  DeviceDiagnosticsStarvationCountingCause,
  DeviceDiagnosticsStarvationPauseReason,
  DeviceDiagnosticsStarvationSuppressionState,
} from '../diagnostics/deviceDiagnosticsService';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { resolveStarvationSuppressionSemantics } from '../planContract/planDecisionSemantics';
import type { CurrentHourPriceLevel, PlanContext } from './planContext';
import type { RestorePlanResult } from './restore';
import type { DevicePlanDevice, PlanInputDevice } from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import {
  isStarvationSupportedDeviceClass,
  isTemperatureControlDevice,
} from '../../packages/shared-domain/src/temperatureDeviceKind';
import { getPrimaryTargetCapability } from '../utils/targetCapabilities';
import type { TemperaturePlanInputKind } from '../../packages/planner-types/src/planInputDevice';

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
  // Observer-resolved per-device staleness, supplied by the producer/wiring layer
  // (createPlanEngine wires `isDeviceObservationStale(ctx.getObservedState(id))`).
  // The starvation freshness gate must source from the observer, NOT a plan-device
  // field — the plan device carries no staleness.
  getObservationStale: (deviceId: string) => boolean;
};

export const buildDeviceDiagnosticsObservations = (
  params: BuildDeviceDiagnosticsObservationsParams,
): DeviceDiagnosticsPlanObservation[] => {
  const inputDeviceById = new Map(params.context.devices.map((device) => [device.id, device]));
  return params.planDevices.map((device) => buildDiagnosticsObservation({
    modeTargetCFor: params.context.modeTargetCFor,
    inputDevice: inputDeviceById.get(device.id),
    device,
    restoreResult: params.restoreResult,
    // Producer-resolved on `PlanContext` (see the field doc there): daily pace binding
    // AND fresh power AND capacity not also breached. Hourly-cap exhaustion forces
    // `softLimitSource` to 'capacity' (capacitySoftLimit → 0), so exhausted hours stay
    // in the capacity bucket too. Reading the shared field keeps this fold and the
    // device-reason re-attribution in `normalizeShedReasons` in lockstep — the breach
    // term is what stops the rescue widget offering "Let it run now" during a genuine
    // capacity breach while the card correctly keeps the headroom framing.
    budgetReleasableHeadroomHold: params.context.budgetReleasableHeadroomHold,
    priceOptimizationEnabled: params.priceOptimizationEnabled,
    priceOptimizationSettings: params.priceOptimizationSettings,
    // Producer-resolved once per build (see `CurrentHourPriceLevel`) — this loop
    // must not ask the price service per device.
    currentHourPriceLevel: params.context.currentHourPriceLevel,
    // Freshness is observer-resolved (not read off the plan device); a stale
    // observation is gated out of starvation counting downstream.
    observationFresh: !params.getObservationStale(device.id),
  }));
};

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const isTemperatureInputDevice = (inputDevice?: PlanInputDevice): boolean => (
  isTemperatureControlDevice(inputDevice)
);

const resolveCurrentTemperatureC = (
  device: DevicePlanDevice,
): number | null => (
  // The temperature cluster is complete on a narrowed device (atomic facet):
  // one read, no input-device fallback, no finiteness re-check.
  isTemperaturePlanDevice(device) ? device.currentTemperature : null
);

const resolveIntendedNormalTemperatureTarget = (params: {
  modeTargetCFor: (device: PlanInputDevice & TemperaturePlanInputKind) => number;
  inputDevice?: PlanInputDevice;
}): number | null => {
  const { modeTargetCFor, inputDevice } = params;
  if (!inputDevice || !isTemperaturePlanDevice(inputDevice)) return null;
  if (!Array.isArray(inputDevice.targets) || inputDevice.targets.length === 0) return null;
  return modeTargetCFor(inputDevice);
};

// The effective target PELS is currently COMMANDING the device toward: the
// planned setpoint this cycle when PELS is applying one, otherwise the held
// current setpoint. Starvation compares this against the intended/mode target —
// a device PELS commands in full (`keep`) is not starved, however cold it is.
const resolveCommandedTargetC = (device: DevicePlanDevice): number | null => {
  if (!isTemperaturePlanDevice(device)) return null;
  return device.plannedTarget;
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

// Half a target step, the epsilon both below-target checks use. It keeps float
// quantization noise from reading an equal command as "below".
const belowTargetEpsilonC = (targetStepC: number | null): number => (
  isFiniteNumber(targetStepC) && targetStepC > 0 ? targetStepC / 2 : 0.25
);

// PELS is holding the device below its intended/mode target when the target it
// is COMMANDING sits more than half a target step under the intended target.
// A device PELS commands in full (commanded == intended) is never below.
const pelsCommandsBelowTarget = (
  intendedNormalTargetC: number | null,
  commandedTargetC: number | null,
  targetStepC: number | null,
): boolean => {
  if (!isFiniteNumber(intendedNormalTargetC) || !isFiniteNumber(commandedTargetC)) return false;
  return commandedTargetC < intendedNormalTargetC - belowTargetEpsilonC(targetStepC);
};

// PELS is holding a turn_off-shed device below its intended target when it has
// commanded the device OFF as a shed AND the device's temperature still sits
// more than half a target step under the intended target. The turn_off shed
// itself is PELS limiting the device (no setpoint is lowered, so
// `pelsCommandsBelowTarget` cannot see it); the temperature comparison excludes
// a device that is off because it has already reached / overshot its target
// (genuinely satisfied, not starved). Only PELS-commanded turn_off sheds set
// `pelsCommandsTurnOffShed` — a user-off device never qualifies.
const pelsHoldsOffBelowTarget = (
  pelsCommandsTurnOffShed: boolean,
  intendedNormalTargetC: number | null,
  currentTemperatureC: number | null,
  targetStepC: number | null,
): boolean => {
  if (!pelsCommandsTurnOffShed) return false;
  if (!isFiniteNumber(intendedNormalTargetC) || !isFiniteNumber(currentTemperatureC)) return false;
  return currentTemperatureC < intendedNormalTargetC - belowTargetEpsilonC(targetStepC);
};

/**
 * The one resolution of "PELS is holding this device below its intended target",
 * resolved HERE in the producer and carried on the observation. Both consumers
 * read the same boolean: the starvation episode engine (the "Held back" clock)
 * and the demand/censoring counters that feed the daily-budget evidence. They
 * disagreed for five days in production — the censoring side saw only a lowered
 * setpoint, so a turn_off shed recorded nothing while the badge counted hours —
 * which is exactly the divergence a single producer-side resolution forecloses.
 */
const resolvePelsHoldsBelowTarget = (params: {
  intendedNormalTargetC: number | null;
  commandedTargetC: number | null;
  currentTemperatureC: number | null;
  targetStepC: number | null;
  pelsCommandsTurnOffShed: boolean;
}): boolean => (
  pelsCommandsBelowTarget(params.intendedNormalTargetC, params.commandedTargetC, params.targetStepC)
  || pelsHoldsOffBelowTarget(
    params.pelsCommandsTurnOffShed,
    params.intendedNormalTargetC,
    params.currentTemperatureC,
    params.targetStepC,
  )
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

const resolveEligibleForStarvation = (params: {
  device: DevicePlanDevice;
  inputDevice?: PlanInputDevice;
  hasStandingDemand: boolean;
}): boolean => {
  const { device, inputDevice, hasStandingDemand } = params;
  if (!hasStandingDemand || !inputDevice) return false;
  if (!isTemperatureInputDevice(inputDevice)) return false;
  if (!isStarvationSupportedDeviceClass(device.deviceClass ?? inputDevice.deviceClass)) return false;
  // A device the user turned off outside PELS is not starved — PELS is not
  // withholding power from it, it is respecting an explicit action. Excluding it
  // from ELIGIBILITY (rather than pausing an episode) resets any accrual and
  // keeps it out of the Held-back list entirely, which is what keeps
  // `notes/ui-terminology.md` § "Held back" accurate: there is still no
  // "manual"/"external" starvation cause.
  if (device.externalOffHoldActive === true) return false;
  return inputDevice.managed === true
    && inputDevice.controllable
    && device.controllable
    && inputDevice.available
    && device.available;
};

// A restore held for `insufficient_headroom` is blocked against the binding soft limit.
// When that hold is BUDGET-RELEASABLE — the daily budget is the binding limit and the
// power sample is trustworthy (`budgetReleasableHeadroomHold`, resolved in the producer)
// — the physical capacity cap is not the constraint doing the work; the daily budget is,
// and it is the releasable lever the owner can rescue against. Re-attribute the counting
// cause to `daily_budget` so device detail and the emitted `device_starvation_started`
// cause both read the true, releasable cause — without any consumer re-deriving the
// source. This mirrors the shed-time re-attribution `resolveShedReason`/`buildBaseReason`
// already perform for capacity→daily. A genuine capacity-bound shortfall — physical
// capacity, an exhausted hourly cap (which forces `softLimitSource` to 'capacity'), or a
// non-fresh meter (stale hold/fail-closed, so there is no measured total) — keeps
// `insufficient_headroom`.
//
// This re-attribution no longer gates anything user-facing. Until 2026-08-04 it fed the
// flat overview `budget | capacity` bucket, which decided whether the "Let it run now"
// rescue was offered; both the bucket and that gate are gone (the rescue is offered on
// either axis). What remains is diagnostic honesty — do not restore a consumer that
// branches on it.
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
  hasStandingDemand: boolean;
  budgetReleasableHeadroomHold: boolean;
}): StarvationSuppressionNormalization => {
  const { device, inputDevice, hasStandingDemand, budgetReleasableHeadroomHold } = params;
  if (!hasStandingDemand || !inputDevice || !device.controllable || !inputDevice.controllable) {
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

// A device wants energy it is not getting. For a device with a resolvable target
// that is EITHER a lowered setpoint (`targetDeficitActive`) OR a turn_off shed
// while the room sits below target — the second disjunct is load-bearing: a
// turn_off shed leaves the setpoint intact, so the setpoint comparison alone
// reads a device PELS has switched off for hours as fully satisfied, and every
// counter gated on `unmetDemand` records nothing. Devices with no resolvable
// target keep the plain off-and-not-inactive test.
const resolveUnmetDemand = (
  desiredTarget: number | null,
  includeDemandMetrics: boolean,
  targetDeficitActive: boolean,
  pelsHoldsBelowTarget: boolean,
  device: DevicePlanDevice,
): boolean => {
  if (desiredTarget !== null) return targetDeficitActive || (includeDemandMetrics && pelsHoldsBelowTarget);
  return includeDemandMetrics && device.currentState === 'off' && device.plannedState !== 'inactive';
};

const buildDiagnosticsObservation = (params: {
  modeTargetCFor: (device: PlanInputDevice & TemperaturePlanInputKind) => number;
  inputDevice?: PlanInputDevice;
  device: DevicePlanDevice;
  restoreResult: RestorePlanResult;
  budgetReleasableHeadroomHold: boolean;
  priceOptimizationEnabled: boolean;
  priceOptimizationSettings: Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
  currentHourPriceLevel: CurrentHourPriceLevel;
  observationFresh: boolean;
}): DeviceDiagnosticsPlanObservation => {
  const {
    modeTargetCFor,
    inputDevice,
    device,
    restoreResult,
    budgetReleasableHeadroomHold,
    priceOptimizationEnabled,
    priceOptimizationSettings,
    currentHourPriceLevel,
    observationFresh,
  } = params;
  // Demand metrics and the starvation lanes both ask the same question — does
  // being off mean this device is going without? — and the producer answered it
  // (`hasStandingDemand`). A charger with no car is not starved, and neither
  // this file nor its callers need to know that is what makes it different.
  const { hasStandingDemand } = device;
  const includeDemandMetrics = hasStandingDemand && device.controllable && device.available;
  const desiredTarget = resolveDesiredTemperatureTarget({
    modeTargetCFor,
    inputDevice,
    priceOptimizationEnabled,
    priceOptimizationSettings,
    currentHourPriceLevel,
  });
  const currentTarget = isTemperaturePlanDevice(device) ? device.currentTarget : null;
  const intendedNormalTargetC = resolveIntendedNormalTemperatureTarget({
    modeTargetCFor,
    inputDevice,
  });
  const currentTemperatureC = resolveCurrentTemperatureC(device);
  const commandedTargetC = resolveCommandedTargetC(device);
  const pelsCommandsTurnOffShed = resolvePelsCommandsTurnOffShed(
    device,
    isTemperatureInputDevice(inputDevice),
  );
  const targetStepC = resolveTargetStepC(inputDevice, intendedNormalTargetC);
  const eligibleForStarvation = resolveEligibleForStarvation({
    device,
    inputDevice,
    hasStandingDemand,
  });
  const starvationSuppression = resolveStarvationSuppression({
    device,
    inputDevice,
    hasStandingDemand,
    budgetReleasableHeadroomHold,
  });
  const targetDeficitActive = includeDemandMetrics
    && desiredTarget !== null
    && currentTarget !== null
    && desiredTarget - currentTarget >= TARGET_DEFICIT_EPSILON_C;
  const pelsHoldsBelowTarget = resolvePelsHoldsBelowTarget({
    intendedNormalTargetC,
    commandedTargetC,
    currentTemperatureC,
    targetStepC,
    pelsCommandsTurnOffShed,
  });
  const unmetDemand = resolveUnmetDemand(
    desiredTarget,
    includeDemandMetrics,
    targetDeficitActive,
    pelsHoldsBelowTarget,
    device,
  );

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
    pelsHoldsBelowTarget,
    expectedPowerKw: device.expectedPowerKw,
    suppressionState: starvationSuppression.suppressionState,
    countingCause: starvationSuppression.countingCause,
    pauseReason: starvationSuppression.pauseReason,
    observationFresh,
  };
};

const resolveDesiredTemperatureTarget = (params: {
  modeTargetCFor: (device: PlanInputDevice & TemperaturePlanInputKind) => number;
  inputDevice?: PlanInputDevice;
  priceOptimizationEnabled: boolean;
  priceOptimizationSettings: Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
  currentHourPriceLevel: CurrentHourPriceLevel;
}): number | null => {
  const {
    modeTargetCFor,
    inputDevice,
    priceOptimizationEnabled,
    priceOptimizationSettings,
    currentHourPriceLevel,
  } = params;
  if (!inputDevice || !Array.isArray(inputDevice.targets) || inputDevice.targets.length === 0) {
    return null;
  }
  // Bail only when the device declares a non-temperature modality; an unset
  // deviceType is left to the downstream target check (behaviour preserved —
  // matches the prior `deviceType && deviceType !== 'temperature'` truthiness).
  if (!isTemperaturePlanDevice(inputDevice)) return null;

  let desiredTarget = modeTargetCFor(inputDevice);
  const priceOptConfig = priceOptimizationSettings[inputDevice.id];
  if (priceOptimizationEnabled && priceOptConfig?.enabled) {
    if (currentHourPriceLevel.cheap && priceOptConfig.cheapDelta) {
      desiredTarget += priceOptConfig.cheapDelta;
    } else if (currentHourPriceLevel.expensive && priceOptConfig.expensiveDelta) {
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
  const plannedTarget = isTemperaturePlanDevice(device) ? device.plannedTarget : null;
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
