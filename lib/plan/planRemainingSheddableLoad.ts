import type {
  SteppedLoadCommandStatus,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import type { DevicePlanDevice, PlanInputDevice } from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { getPrimaryTargetCapability } from '../utils/targetCapabilities';
import { isBinaryPlanDevice } from './planBinaryDevice';
import {
  isSteppedLoadDevice,
} from './planSteppedLoad';
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
  // Producer-resolved draw; the raw reading is not carried on plan devices.
  currentDrawKw: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
};

type RemainingSheddableResidualFields = {
  residualKw: { shed: number };
};

type RemainingSheddableBaseDevice = RemainingSheddablePowerFields & RemainingSheddableResidualFields & {
  id: string;
  controllable: boolean;
  // Producer-resolved on/off truth, present iff binary; read via `isBinaryPlanDevice`.
  currentOn?: boolean;
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

// The local stepped discriminant is profile presence (`steppedLoadProfile`),
// mirroring the planner-wide collapse off `controlModel`. The required profile
// field is what distinguishes the stepped union members below.
type RemainingSheddableSteppedFields = {
  steppedLoadProfile: SteppedLoadProfile;
  // Producer-guaranteed alongside the profile (stepped cluster).
  selectedStepId: string;
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
 * Structural superset covering the four shapes the legacy kind switch used to
 * inspect (simple / temperature / stepped / stepped+temperature).
 *
 * The shed dual-read is gone — `resolveRemainingSheddableLoadKw` reads
 * `residualKw.shed` and nothing else — so this union carries no fallback. It
 * keeps the local `{ shed: number }` view because that is the ONLY residual half
 * this consumer reads: requiring the restore half here would make a consumer
 * demand a number it never looks at.
 *
 * The variant members no longer discriminate anything for that reader, and the
 * union is assignability-vacuous (`A | (A&B)` accepts any bare `A`), so they
 * constrain no caller either.
 */
export type RemainingSheddableDevice =
  | SimpleRemainingSheddableDevice
  | TemperatureRemainingSheddableDevice
  | SteppedTemperatureRemainingSheddableDevice
  | SteppedRemainingSheddableDevice;

export type RemainingSheddableLoadParams = {
  device: RemainingSheddableDevice;
  alreadyShed: boolean;
  limitSource: 'capacity' | 'daily' | 'both';
  capacityBreached: boolean;
};

type RemainingSheddableSourceDevice = RemainingSheddablePowerFields & RemainingSheddableResidualFields & {
  id: string;
  controllable: boolean;
  currentOn?: boolean;
  currentState?: string;
  budgetExempt?: boolean;
};

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
  const drawKw = device.currentDrawKw;
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
  if (!isSteppedLoadDevice(device)) {
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
    currentDrawKw: device.currentDrawKw,
    hasBinaryControl: isBinaryPlanDevice(device),
  };
}

function toPlanResidualTemperatureTarget(
  device: DevicePlanDevice,
): ResidualKwShedTemperatureTarget | undefined {
  if (device.shedAction !== 'set_temperature') return undefined;
  return {
    ...(isTemperaturePlanDevice(device) ? { currentValue: device.currentTarget } : {}),
  };
}

export function resolveRemainingSheddableLoadKw(params: RemainingSheddableLoadParams): number {
  const {
    device,
    alreadyShed,
    limitSource,
    capacityBreached,
  } = params;

  if (device.controllable === false) return 0;
  if (isBinaryPlanDevice(device) && !device.currentOn) return 0;
  if (alreadyShed) return 0;
  if (limitSource === 'daily' && !capacityBreached && device.budgetExempt) return 0;

  // The kind-switch decision happened at the producer seam
  // (`lib/device/deviceResidualKw.ts`); the consumer just reads the number.
  return Math.max(0, device.residualKw.shed);
}

export function sumRemainingSheddableLoadKw(params: {
  devices: RemainingSheddableDevice[];
  isAlreadyShed: (device: RemainingSheddableDevice) => boolean;
  limitSource: 'capacity' | 'daily' | 'both';
  capacityBreached: boolean;
}): number {
  const {
    devices,
    isAlreadyShed,
    limitSource,
    capacityBreached,
  } = params;
  let totalKw = 0;
  for (const device of devices) {
    totalKw += resolveRemainingSheddableLoadKw({
      device,
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
    controllable: device.controllable,
    currentOn: device.currentOn,
    currentState: device.currentState,
    budgetExempt: device.budgetExempt === true,
    currentDrawKw: device.currentDrawKw,
    expectedPowerKw: device.expectedPowerKw,
    planningPowerKw: device.planningPowerKw,
    residualKw: device.residualKw,
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
    ...(isTemperaturePlanDevice(device) ? { currentValue: device.currentTarget } : {}),
  };
}
