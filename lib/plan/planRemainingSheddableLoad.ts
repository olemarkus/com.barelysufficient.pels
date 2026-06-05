import type { SteppedLoadCommandStatus, SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { DevicePlanDevice, PlanInputDevice } from './planTypes';
import { getPrimaryTargetCapability, normalizeTargetCapabilityValue } from '../utils/targetCapabilities';
import { isObservedOff } from '../observer/observedState';
import { getCurrentDrawKw } from '../observer/observedPower';
import {
  getSteppedLoadShedTargetStep,
  isSteppedLoadDevice,
  resolveSteppedUnknownCurrentMeasuredShedding,
} from './planSteppedLoad';
import {
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';
import {
  resolveResidualKwShed,
  type ResidualKwShedBehavior,
  type ResidualKwShedSteppedDevice,
  type ResidualKwShedTemperatureTarget,
} from '../device/deviceResidualKw';
import {
  normalizeSteppedLoadStepStateFromLegacyFields,
  resolveKnownEffectiveStepId,
} from './planSteppedLoadState';

type RemainingSheddablePowerFields = {
  measuredPowerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  powerKw?: number;
};

type RemainingSheddableResidualFields = {
  residualKw?: { shed: number };
};

type RemainingSheddableBaseDevice = RemainingSheddablePowerFields & RemainingSheddableResidualFields & {
  id: string;
  controllable: boolean;
  binaryControl?: { on: boolean };
  currentState?: string;
  budgetExempt: boolean;
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  observationStale?: boolean;
};

export type RemainingSheddableTemperatureTarget = {
  id: string;
  currentValue?: number;
  min?: number;
  max?: number;
  step?: number;
};

type RemainingSheddableTemperatureFields = {
  temperatureTarget: RemainingSheddableTemperatureTarget;
};

type RemainingSheddableSteppedFields = {
  controlModel: 'stepped_load';
  steppedLoadProfile: SteppedLoadProfile;
  selectedStepId?: string;
  desiredStepId?: string;
  stepCommandPending: boolean;
  stepCommandStatus?: SteppedLoadCommandStatus;
};

type SimpleRemainingSheddableDevice = RemainingSheddableBaseDevice;

type TemperatureRemainingSheddableDevice = RemainingSheddableBaseDevice
  & RemainingSheddableTemperatureFields;

type SteppedRemainingSheddableDevice = RemainingSheddableBaseDevice & RemainingSheddableSteppedFields;

type SteppedTemperatureRemainingSheddableDevice = RemainingSheddableBaseDevice
  & RemainingSheddableSteppedFields
  & RemainingSheddableTemperatureFields;

/**
 * Structural superset covering every shape the legacy dual-read fallback needs
 * to inspect (simple / temperature / stepped / stepped+temperature). The
 * post-chunk-3 producer-resolved path collapses the kind switch into
 * `residualKw.shed`; this type stays as a transitional fallback container
 * until chunk 6 removes the dual-read path entirely.
 */
export type RemainingSheddableDevice =
  | SimpleRemainingSheddableDevice
  | TemperatureRemainingSheddableDevice
  | SteppedTemperatureRemainingSheddableDevice
  | SteppedRemainingSheddableDevice;

export type RemainingShedBehavior =
  | { action: 'turn_off' }
  | { action: 'set_step' }
  | { action: 'set_temperature'; temperature: number };

export type RawShedBehavior = {
  action: 'turn_off' | 'set_step' | 'set_temperature';
  temperature: number | null;
};

export type RemainingSheddableLoadParams = {
  device: RemainingSheddableDevice;
  shedBehavior: RemainingShedBehavior;
  alreadyShed: boolean;
  limitSource: 'capacity' | 'daily' | 'both';
  capacityBreached: boolean;
};

type RemainingSheddableSourceDevice = RemainingSheddablePowerFields & RemainingSheddableResidualFields & {
  id: string;
  controllable?: boolean;
  binaryControl?: { on: boolean };
  currentState?: string;
  budgetExempt?: boolean;
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  observationStale?: boolean;
};

export function normalizeRemainingShedBehavior(behavior: RawShedBehavior): RemainingShedBehavior {
  if (behavior.action === 'set_temperature' && behavior.temperature !== null) {
    return { action: 'set_temperature', temperature: behavior.temperature };
  }
  if (behavior.action === 'set_step') {
    return { action: 'set_step' };
  }
  return { action: 'turn_off' };
}

export function isCapacityBreached(totalKw: number | null, capacitySoftLimitKw: number): boolean {
  return typeof totalKw === 'number' && Number.isFinite(totalKw) && totalKw > capacitySoftLimitKw;
}

export function toInputRemainingSheddableDevice(device: PlanInputDevice): RemainingSheddableDevice {
  const base = toRemainingSheddableBaseDevice(device);
  const temperatureTarget = toRemainingTemperatureTarget(getPrimaryTargetCapability(device.targets));
  return toRemainingSheddableDeviceFromParts({
    base,
    steppedSource: device,
    temperatureTarget,
  });
}

export function toPlanRemainingSheddableDevice(device: DevicePlanDevice): RemainingSheddableDevice {
  const base = toRemainingSheddableBaseDevice({
    ...device,
    residualKw: { shed: residualKwAfterSnapshot(device) },
  });
  const temperatureTarget = device.shedAction === 'set_temperature'
    ? toPlanRemainingTemperatureTarget(device)
    : undefined;
  return toRemainingSheddableDeviceFromParts({
    base,
    steppedSource: device,
    temperatureTarget,
  });
}

/**
 * Output-side residualKw.shed re-resolution (chunk 3 of the planner-detype
 * refactor). Mirrors the input-side `toPlanDevice` wiring in
 * `setup/appInit.ts`, but reads from a post-plan `DevicePlanDevice` whose
 * shed action / setpoint / step state are already materialised by the
 * planner. Lets `sumRemainingSheddableLoadKw` collapse to the producer-
 * resolved number for the output recompute path too.
 *
 * Mirrors the caller-side `resolvePlanDeviceShedBehavior` default in
 * `planLogging.ts`: when there is no resolved shed action, treat it as
 * `turn_off` (the legacy default) so non-shed devices still get an honest
 * residual instead of a structural 0.
 */
export function residualKwAfterSnapshot(device: DevicePlanDevice): number {
  const shedBehavior = toPlanResidualShedBehavior(device);
  const drawKw = getCurrentDrawKw(device);
  const steppedLoad = toPlanResidualSteppedLoad(device);
  const temperatureTarget = toPlanResidualTemperatureTarget(device);
  return resolveResidualKwShed({
    device: {
      currentDrawKw: drawKw,
      temperatureTarget,
      steppedLoad,
    },
    shedBehavior,
  });
}

function toPlanResidualShedBehavior(device: DevicePlanDevice): ResidualKwShedBehavior {
  if (device.shedAction === 'set_temperature' && typeof device.shedTemperature === 'number'
    && Number.isFinite(device.shedTemperature)) {
    return { action: 'set_temperature', temperature: device.shedTemperature };
  }
  if (device.shedAction === 'set_step') return { action: 'set_step' };
  return { action: 'turn_off' };
}

function toPlanResidualSteppedLoad(device: DevicePlanDevice): ResidualKwShedSteppedDevice | undefined {
  if (device.controlModel !== 'stepped_load' || !device.steppedLoadProfile
    || device.steppedLoadProfile.model !== 'stepped_load') {
    return undefined;
  }
  const stepState = normalizeSteppedLoadStepStateFromLegacyFields({
    fields: device,
    selectedStepFallbackIsPlanningAssumption: true,
  });
  return {
    profile: device.steppedLoadProfile,
    selectedStepId: device.selectedStepId,
    hasKnownEffectiveStep: resolveKnownEffectiveStepId(stepState) !== undefined,
    measuredPowerKw: device.measuredPowerKw,
    controlCapabilityId: device.controlCapabilityId,
  };
}

function toPlanResidualTemperatureTarget(
  device: DevicePlanDevice,
): ResidualKwShedTemperatureTarget | undefined {
  if (device.shedAction !== 'set_temperature') return undefined;
  return {
    ...(typeof device.currentTarget === 'number' && Number.isFinite(device.currentTarget)
      ? { currentValue: device.currentTarget }
      : {}),
  };
}

export function resolveRemainingSheddableLoadKw(params: RemainingSheddableLoadParams): number {
  const {
    device,
    shedBehavior,
    alreadyShed,
    limitSource,
    capacityBreached,
  } = params;

  if (device.controllable === false) return 0;
  if (isObservedOff(device)) return 0;
  if (alreadyShed) return 0;
  if (limitSource === 'daily' && !capacityBreached && device.budgetExempt) return 0;

  // Producer-resolved path (chunk 3 of the planner-detype refactor). When the
  // device snapshot carries `residualKw.shed`, the kind-switch decision has
  // already happened at the producer seam (`lib/device/deviceResidualKw.ts`),
  // so the consumer just reads the number. Dual-read fallback below covers
  // legacy/test fixtures built without the producer; chunk 6 removes it.
  if (device.residualKw) {
    return Math.max(0, device.residualKw.shed);
  }

  if (!canStillShedDevice({ device, shedBehavior })) return 0;
  const power = getCurrentDrawKw(device);
  return power > 0 ? power : 0;
}

export function sumRemainingSheddableLoadKw(params: {
  devices: RemainingSheddableDevice[];
  shedBehaviorForDevice: (device: RemainingSheddableDevice) => RemainingShedBehavior;
  isAlreadyShed: (device: RemainingSheddableDevice) => boolean;
  limitSource: 'capacity' | 'daily' | 'both';
  capacityBreached: boolean;
}): number {
  const {
    devices,
    shedBehaviorForDevice,
    isAlreadyShed,
    limitSource,
    capacityBreached,
  } = params;
  let totalKw = 0;
  for (const device of devices) {
    totalKw += resolveRemainingSheddableLoadKw({
      device,
      shedBehavior: shedBehaviorForDevice(device),
      alreadyShed: isAlreadyShed(device),
      limitSource,
      capacityBreached,
    });
  }
  return totalKw;
}

function toRemainingSheddableBaseDevice(device: RemainingSheddableSourceDevice): RemainingSheddableBaseDevice {
  return {
    id: device.id,
    controllable: device.controllable !== false,
    binaryControl: device.binaryControl,
    currentState: device.currentState,
    budgetExempt: device.budgetExempt === true,
    controlCapabilityId: device.controlCapabilityId,
    observationStale: device.observationStale,
    measuredPowerKw: device.measuredPowerKw,
    expectedPowerKw: device.expectedPowerKw,
    planningPowerKw: device.planningPowerKw,
    powerKw: device.powerKw,
    ...(device.residualKw ? { residualKw: device.residualKw } : {}),
  };
}

function toRemainingSheddableDeviceFromParts(params: {
  base: RemainingSheddableBaseDevice;
  steppedSource: PlanInputDevice | DevicePlanDevice;
  temperatureTarget?: RemainingSheddableTemperatureTarget;
}): RemainingSheddableDevice {
  const { base, steppedSource, temperatureTarget } = params;
  if (isSteppedLoadDevice(steppedSource)) {
    const steppedFields: RemainingSheddableSteppedFields = {
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedSource.steppedLoadProfile,
      selectedStepId: steppedSource.selectedStepId,
      desiredStepId: steppedSource.desiredStepId,
      stepCommandPending: steppedSource.stepCommandPending === true,
      stepCommandStatus: steppedSource.stepCommandStatus,
    };
    if (temperatureTarget) {
      return {
        ...base,
        ...steppedFields,
        temperatureTarget,
      };
    }
    return {
      ...base,
      ...steppedFields,
    };
  }
  if (temperatureTarget) {
    return {
      ...base,
      temperatureTarget,
    };
  }
  return base;
}

function toRemainingTemperatureTarget(target: {
  id: string;
  value?: number;
  min?: number;
  max?: number;
  step?: number;
} | null): RemainingSheddableTemperatureTarget | undefined {
  if (!target) return undefined;
  return {
    id: target.id,
    ...(typeof target.value === 'number' && Number.isFinite(target.value) ? { currentValue: target.value } : {}),
    ...(typeof target.min === 'number' && Number.isFinite(target.min) ? { min: target.min } : {}),
    ...(typeof target.max === 'number' && Number.isFinite(target.max) ? { max: target.max } : {}),
    ...(typeof target.step === 'number' && Number.isFinite(target.step) ? { step: target.step } : {}),
  };
}

function toPlanRemainingTemperatureTarget(device: DevicePlanDevice): RemainingSheddableTemperatureTarget {
  return {
    id: 'target_temperature',
    ...(typeof device.currentTarget === 'number' && Number.isFinite(device.currentTarget)
      ? { currentValue: device.currentTarget }
      : {}),
  };
}

// =============================================================================
// Dual-read fallback: legacy kind-switch logic, retained for the chunk-3
// transition. Removed in chunk 6 once all PlanInputDevice / DevicePlanDevice
// inputs carry `residualKw.shed` from the producer. Behavior preserved exactly.
// =============================================================================

function canStillShedDevice(params: {
  device: RemainingSheddableDevice;
  shedBehavior: RemainingShedBehavior;
}): boolean {
  const { device, shedBehavior } = params;
  if (shedBehavior.action === 'set_temperature') {
    return canStillShedTemperatureDevice({ device, shedTemperature: shedBehavior.temperature });
  }
  if (!isSteppedRemainingSheddableDevice(device)) return true;
  return canStillShedSteppedLoad({
    device,
    shedAction: shedBehavior.action === 'set_step' ? 'set_step' : 'turn_off',
  });
}

function canStillShedSteppedLoad(params: {
  device: SteppedRemainingSheddableDevice | SteppedTemperatureRemainingSheddableDevice;
  shedAction: 'turn_off' | 'set_step';
}): boolean {
  const { device, shedAction } = params;
  if (!device.selectedStepId) {
    return Boolean(resolveSteppedUnknownCurrentMeasuredShedding({
      device,
      shedAction,
    }));
  }
  const targetStep = getSteppedLoadShedTargetStep({
    device,
    shedAction,
    currentDesiredStepId: device.selectedStepId,
  });
  if (targetStep && targetStep.id !== device.selectedStepId) return true;
  return canFinishSteppedTurnOffWithBinary({ device, shedAction, targetStep });
}

function canFinishSteppedTurnOffWithBinary(params: {
  device: SteppedRemainingSheddableDevice | SteppedTemperatureRemainingSheddableDevice;
  shedAction: 'turn_off' | 'set_step';
  targetStep: ReturnType<typeof getSteppedLoadShedTargetStep>;
}): boolean {
  const { device, shedAction, targetStep } = params;
  if (
    shedAction !== 'turn_off'
    || device.controlCapabilityId === undefined
    || !device.selectedStepId
    || targetStep?.id !== device.selectedStepId
  ) {
    return false;
  }
  const selectedStep = getSteppedLoadStep(device.steppedLoadProfile, device.selectedStepId);
  return Boolean(selectedStep && !isSteppedLoadOffStep(device.steppedLoadProfile, selectedStep.id));
}

function canStillShedTemperatureDevice(params: {
  device: RemainingSheddableDevice;
  shedTemperature: number;
}): boolean {
  const { device, shedTemperature } = params;
  if (!isTemperatureRemainingSheddableDevice(device)) return false;
  const { temperatureTarget } = device;
  if (typeof temperatureTarget.currentValue !== 'number' || !Number.isFinite(temperatureTarget.currentValue)) {
    return true;
  }
  const normalizedShedTemperature = normalizeTargetCapabilityValue({
    target: temperatureTarget,
    value: shedTemperature,
  });
  return temperatureTarget.currentValue !== normalizedShedTemperature;
}

function isSteppedRemainingSheddableDevice(
  device: RemainingSheddableDevice,
): device is SteppedRemainingSheddableDevice | SteppedTemperatureRemainingSheddableDevice {
  return 'controlModel' in device && device.controlModel === 'stepped_load'
    && 'steppedLoadProfile' in device;
}

function isTemperatureRemainingSheddableDevice(
  device: RemainingSheddableDevice,
): device is TemperatureRemainingSheddableDevice | SteppedTemperatureRemainingSheddableDevice {
  return 'temperatureTarget' in device;
}
