import type { SteppedLoadCommandStatus, SteppedLoadProfile } from '../utils/types';
import type { DevicePlanDevice, PlanInputDevice } from './planTypes';
import { getPrimaryTargetCapability, normalizeTargetCapabilityValue } from '../utils/targetCapabilities';
import { resolveEffectiveCurrentOn } from './planCurrentState';
import { resolveCandidatePower } from './planCandidatePower';
import {
  getSteppedLoadShedTargetStep,
  isSteppedLoadDevice,
  resolveSteppedUnknownCurrentMeasuredShedding,
} from './planSteppedLoad';

type RemainingSheddablePowerFields = {
  measuredPowerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  powerKw?: number;
};

type RemainingSheddableBaseDevice = RemainingSheddablePowerFields & {
  id: string;
  controllable: boolean;
  currentOn: boolean;
  currentState?: string;
  budgetExempt: boolean;
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

export type SimpleRemainingSheddableDevice = RemainingSheddableBaseDevice & {
  kind: 'simple';
};

export type TemperatureRemainingSheddableDevice = RemainingSheddableBaseDevice
  & RemainingSheddableTemperatureFields
  & {
    kind: 'temperature';
  };

export type SteppedRemainingSheddableDevice = RemainingSheddableBaseDevice & RemainingSheddableSteppedFields & {
  kind: 'stepped';
};

export type SteppedTemperatureRemainingSheddableDevice = RemainingSheddableBaseDevice
  & RemainingSheddableSteppedFields
  & RemainingSheddableTemperatureFields
  & {
    kind: 'stepped_temperature';
  };

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

type RemainingSheddableSourceDevice = RemainingSheddablePowerFields & {
  id: string;
  controllable?: boolean;
  currentOn: boolean;
  currentState?: string;
  budgetExempt?: boolean;
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
  const base = toRemainingSheddableBaseDevice(device);
  const temperatureTarget = device.shedAction === 'set_temperature'
    ? toPlanRemainingTemperatureTarget(device)
    : undefined;
  return toRemainingSheddableDeviceFromParts({
    base,
    steppedSource: device,
    temperatureTarget,
  });
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
  if (resolveEffectiveCurrentOn(device) === false) return 0;
  if (alreadyShed) return 0;
  if (limitSource === 'daily' && !capacityBreached && device.budgetExempt) return 0;
  if (!canStillShedDevice({ device, shedBehavior })) return 0;

  const power = resolveCandidatePower(device);
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
    currentOn: device.currentOn,
    currentState: device.currentState,
    budgetExempt: device.budgetExempt === true,
    measuredPowerKw: device.measuredPowerKw,
    expectedPowerKw: device.expectedPowerKw,
    planningPowerKw: device.planningPowerKw,
    powerKw: device.powerKw,
  };
}

function toRemainingSheddableDeviceFromParts(params: {
  base: RemainingSheddableBaseDevice;
  steppedSource: PlanInputDevice | DevicePlanDevice;
  temperatureTarget?: RemainingSheddableTemperatureTarget;
}): RemainingSheddableDevice {
  const { base, steppedSource, temperatureTarget } = params;
  if (isSteppedLoadDevice(steppedSource) && steppedSource.steppedLoadProfile) {
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
        kind: 'stepped_temperature',
        temperatureTarget,
      };
    }
    return {
      ...base,
      ...steppedFields,
      kind: 'stepped',
    };
  }
  if (temperatureTarget) {
    return {
      ...base,
      kind: 'temperature',
      temperatureTarget,
    };
  }
  return {
    ...base,
    kind: 'simple',
  };
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

function canStillShedDevice(params: {
  device: RemainingSheddableDevice;
  shedBehavior: RemainingShedBehavior;
}): boolean {
  const { device, shedBehavior } = params;
  if (shedBehavior.action === 'set_temperature') {
    return canStillShedTemperatureDevice({ device, shedTemperature: shedBehavior.temperature });
  }
  if (device.kind === 'simple' || device.kind === 'temperature') return true;
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
  return Boolean(targetStep && targetStep.id !== device.selectedStepId);
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

function isTemperatureRemainingSheddableDevice(
  device: RemainingSheddableDevice,
): device is TemperatureRemainingSheddableDevice | SteppedTemperatureRemainingSheddableDevice {
  return device.kind === 'temperature' || device.kind === 'stepped_temperature';
}
