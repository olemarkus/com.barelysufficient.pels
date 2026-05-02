import type { DevicePlanDevice, PlanInputDevice, ShedAction } from './planTypes';
import type { PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { resolveCandidatePower } from './planCandidatePower';
import { RECENT_RESTORE_SHED_GRACE_MS } from './planConstants';
import { isPendingBinaryCommandActive } from './planObservationPolicy';
import {
  getPrimaryTargetCapability,
  normalizeTargetCapabilityValue,
} from '../utils/targetCapabilities';
import { applyOffStateReason } from './planOffStateReason';
import {
  isSteppedLoadDevice,
  resolveSteppedKeepDesiredStepId,
  resolveSteppedLoadInitialDesiredStepId,
  resolveSteppedLoadPlanningKw,
  resolveSteppedUnknownCurrentMeasuredShedding,
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
import {
  buildBoostPlanDeviceFields,
  emitEvBoostStateChange,
  resolveEvBoostActive,
} from './planEvBoost';
import {
  emitTemperatureBoostStateChange,
  resolveTemperatureBoostActive,
  supportsTemperatureBoostDevice,
} from './planTemperatureBoost';
import { resolveEffectiveCurrentOn } from './planCurrentState';
import type { StructuredDebugEmitter } from '../logging/logger';

export type PlanDevicesDeps = {
  getPriorityForDevice: (deviceId: string) => number;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
  debugStructured?: StructuredDebugEmitter;
};
const supportsTemperatureDevice = (device: PlanInputDevice): boolean => {
  return supportsTemperatureBoostDevice(device);
};
export function buildInitialPlanDevices(params: {
  context: PlanContext;
  state: PlanEngineState;
  shedSet: Set<string>;
  shedReasons: Map<string, DeviceReason>;
  guardInShortfall: boolean;
  deps: PlanDevicesDeps;
}): DevicePlanDevice[] {
  const {
    context,
    state,
    shedSet,
    shedReasons,
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
    const previousActive = state.temperatureBoostActiveByDevice[dev.id] === true;
    const active = resolveTemperatureBoostActive({ dev, previousActive });
    emitTemperatureBoostStateChange({ dev, previousActive, active, debugStructured: deps.debugStructured });
    const previousEvBoostActive = state.evBoostActiveByDevice[dev.id] === true;
    const evBoostActive = resolveEvBoostActive({ dev, previousActive: previousEvBoostActive });
    emitEvBoostStateChange({
      dev,
      previousActive: previousEvBoostActive,
      active: evBoostActive,
      debugStructured: deps.debugStructured,
    });
    const base = buildBasePlanDevice({
      dev,
      devices: context.devices,
      state,
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
      temperatureBoostActive: active,
      evBoostActive,
    });
    state.temperatureBoostActiveByDevice[dev.id] = base.temperatureBoostActive === true;
    state.evBoostActiveByDevice[dev.id] = base.evBoostActive === true;
    const withOffStateReason = applyOffStateReason({
      planDevice: base,
      headroomRaw: context.headroomRaw,
      guardInShortfall,
    });
    return withOffStateReason;
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
  devices: PlanInputDevice[];
  state: PlanEngineState;
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
  temperatureBoostActive: boolean;
  evBoostActive: boolean;
}): DevicePlanDevice {
  const {
    dev,
    devices,
    state,
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
    temperatureBoostActive,
    evBoostActive,
  } = params;
  const initialDesiredStepId = resolveSteppedLoadInitialDesiredStepId(dev);
  const runtimeDesiredStepId = dev.desiredStepId ?? initialDesiredStepId;
  const directShedStepId = resolveSteppedLoadDirectShedStepId({
    dev,
    devices,
    state,
    shedBehavior,
    shouldShed: shedSet.has(dev.id),
    currentDesiredStepId: resolveSteppedShedCurrentDesiredStepId(dev),
  });
  const shedDesiredStepId = directShedStepId;
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
    previousStepId: dev.previousStepId,
    lastDesiredStepId: dev.desiredStepId,
    lastStepCommandIssuedAt: dev.lastStepCommandIssuedAt,
    stepCommandRetryCount: dev.stepCommandRetryCount,
    nextStepCommandRetryAtMs: dev.nextStepCommandRetryAtMs,
    actualStepId: dev.actualStepId,
    assumedStepId: dev.assumedStepId,
    actualStepSource: dev.actualStepSource,
    hasBinaryControl: dev.hasBinaryControl,
    priority,
    powerKw: dev.powerKw,
    expectedPowerKw: resolveExpectedPowerKw(dev, currentState, plannedState, effectiveDesiredStepId),
    planningPowerKw: dev.planningPowerKw,
    expectedPowerSource: dev.expectedPowerSource,
    measuredPowerKw: dev.measuredPowerKw,
    controlCapabilityId: dev.controlCapabilityId,
    controlAdapter: dev.controlAdapter,
    nativeSteppedLoadStatus: dev.nativeSteppedLoadStatus,
    evChargingState: dev.evChargingState,
    reason: baseReason,
    zone: dev.zone || 'Unknown',
    controllable,
    budgetExempt: dev.budgetExempt,
    available: dev.available,
    ...buildBoostPlanDeviceFields({ dev, temperatureBoostActive, evBoostActive }),
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
}): { shedAction: ShedAction; shedTemperature: number | null; shedStepId: string | null } {
  const { dev, controllable, shouldShed, shedBehavior } = params;
  if (controllable && shouldShed
    && shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null) {
    const target = getPrimaryTargetCapability(dev.targets);
    return {
      shedAction: 'set_temperature',
      shedTemperature: normalizeTargetCapabilityValue({ target, value: shedBehavior.temperature }),
      shedStepId: null,
    };
  }
  if (isSteppedLoadDevice(dev)) {
    return resolveSteppedShedAction({ controllable, hasBinaryControl: dev.hasBinaryControl, shedBehavior });
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
  devices: PlanInputDevice[];
  state: PlanEngineState;
  shedBehavior: { action: ShedAction; temperature: number | null; stepId: string | null };
  shouldShed: boolean;
  currentDesiredStepId?: string;
}): string | undefined {
  const {
    dev,
    devices,
    state,
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
  if (shouldForceLowestActiveStep({ dev, devices, state, shedBehaviorAction: shedBehavior.action })) {
    return dev.steppedLoadProfile ? getSteppedLoadLowestActiveStep(dev.steppedLoadProfile)?.id : undefined;
  }
  const targetStep = getSteppedLoadShedTargetStep({
    device: dev,
    shedAction: 'set_step',
    currentDesiredStepId,
  });
  return targetStep?.id
    ?? resolveSteppedUnknownCurrentMeasuredShedding({ device: dev, shedAction: 'set_step' })?.targetStep.id;
}
function shouldForceLowestActiveStep(params: {
  dev: PlanInputDevice;
  devices: PlanInputDevice[];
  state: Pick<PlanEngineState, 'lastDeviceShedMs' | 'lastDeviceRestoreMs' | 'swapByDevice'>;
  shedBehaviorAction: ShedAction;
}): boolean {
  const { dev, devices, state, shedBehaviorAction } = params;
  return shedBehaviorAction === 'set_step'
    && devices.some((candidate) => candidate.id !== dev.id && isNonSteppedDeviceRecovering(candidate, state));
}
function isNonSteppedDeviceRecovering(
  candidate: PlanInputDevice,
  state: Pick<PlanEngineState, 'lastDeviceShedMs' | 'lastDeviceRestoreMs' | 'swapByDevice'>,
): boolean {
  const effectiveCurrentOn = resolveEffectiveCurrentOn(candidate);
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
function resolveSteppedShedCurrentDesiredStepId(dev: PlanInputDevice): string | undefined {
  if (!isSteppedLoadDevice(dev) || !dev.stepCommandPending || !dev.desiredStepId || !dev.selectedStepId) {
    return dev.selectedStepId;
  }
  const desiredKw = resolveSteppedLoadPlanningKw(dev, dev.desiredStepId);
  const selectedKw = resolveSteppedLoadPlanningKw(dev, dev.selectedStepId);
  return desiredKw < selectedKw ? dev.desiredStepId : dev.selectedStepId;
}
