import type { DevicePlanDevice, PlanInputDevice } from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
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

type RemainingSheddableResidualFields = {
  residualKw: { shed: number };
};

/**
 * Flat consumer view of a device the shed math may still reduce.
 *
 * There is no kind here on purpose. This used to be a four-member union
 * (simple / temperature / stepped / stepped+temperature) left over from the
 * dual-read era, and it did nothing twice over: `resolveRemainingSheddableLoadKw`
 * reads only `controllable`, the binary axis, `budgetExempt` and
 * `residualKw.shed`, and the union was assignability-vacuous anyway
 * (`A | (A & B)` accepts any bare `A`), so it constrained no caller. The
 * kind-switch decision happens once, at the producer seam
 * (`lib/device/deviceResidualKw.ts`); leaving a kind-shaped union in the module
 * whose point was collapsing that switch is what invites the next consumer to
 * branch on kind again.
 *
 * It keeps the local `{ shed: number }` residual view because that is the ONLY
 * residual half this consumer reads: requiring the producer's full residual here
 * would make a consumer demand a `restore` number it never looks at, and
 * `toPlanRemainingSheddableDevice` legitimately builds a post-plan device that
 * has only the recomputed shed half.
 *
 * By the same measure it carries no draw, no power estimate and no state label.
 * The shed kW is already resolved when it arrives, so those were copied per
 * device per plan cycle for nobody — the same cost the kind-shaped union was
 * removed for.
 */
export type RemainingSheddableDevice = RemainingSheddableResidualFields & {
  id: string;
  controllable: boolean;
  // Producer-resolved on/off truth, present iff binary; read via `isBinaryPlanDevice`.
  currentOn?: boolean;
  budgetExempt: boolean;
};

export type RemainingSheddableLoadParams = {
  device: RemainingSheddableDevice;
  alreadyShed: boolean;
  limitSource: 'capacity' | 'daily' | 'both';
  capacityBreached: boolean;
};

type RemainingSheddableSourceDevice = RemainingSheddableResidualFields & {
  id: string;
  controllable: boolean;
  currentOn?: boolean;
  // Optional here and required on the view: the producer's own `budgetExempt` is
  // optional, and this projection is where absence becomes the explicit `false`.
  budgetExempt?: boolean;
};

export function isCapacityBreached(totalKw: number | null, capacitySoftLimitKw: number): boolean {
  return typeof totalKw === 'number' && Number.isFinite(totalKw) && totalKw > capacitySoftLimitKw;
}

export function toInputRemainingSheddableDevice(device: PlanInputDevice): RemainingSheddableDevice {
  return toRemainingSheddableDevice(device);
}

export function toPlanRemainingSheddableDevice(device: DevicePlanDevice): RemainingSheddableDevice {
  return toRemainingSheddableDevice({
    ...device,
    residualKw: { shed: residualKwAfterSnapshot(device) },
  });
}

/**
 * Output-side residualKw.shed re-resolution (chunk 3 of the planner-detype
 * refactor). Mirrors the input-side `toPlanDevice` wiring in
 * `setup/appInit/toPlanDevice.ts`, but reads from a post-plan `DevicePlanDevice` whose
 * shed action / setpoint / step state are already materialised by the
 * planner. Lets `sumRemainingSheddableLoadKw` collapse to the producer-
 * resolved number for the output recompute path too.
 *
 * Mirrors the input-side `resolveResidualShedBehavior` default
 * (`setup/appInit/residualKwForPlanDevice.ts`): when there is no resolved shed
 * action, treat it as `turn_off` (the legacy default) so non-shed devices still
 * get an honest residual instead of a structural 0.
 */
function residualKwAfterSnapshot(device: DevicePlanDevice): number {
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

function toRemainingSheddableDevice(device: RemainingSheddableSourceDevice): RemainingSheddableDevice {
  return {
    id: device.id,
    controllable: device.controllable,
    // Written unconditionally: `isBinaryPlanDevice` is a key-presence test, so
    // dropping the key for a non-binary device would change the narrowing.
    currentOn: device.currentOn,
    budgetExempt: device.budgetExempt === true,
    residualKw: device.residualKw,
  };
}
