/**
 * Producer-side wiring for `PlanInputDevice.residualKw` (chunk 3 of the
 * planner-detype refactor). `toPlanDevice` in `../appInit.ts` calls
 * `buildResidualKwForPlanDevice`, which adapts a `TargetDeviceSnapshot` to
 * the structural input shape consumed by `resolveResidualKwShed` in
 * `lib/device/deviceResidualKw.ts`.
 *
 * Currently exposes only `.shed`; chunks 4-6 will layer `restore` (and
 * possibly `keep`) onto the same field. The consumer in
 * `lib/plan/planRemainingSheddableLoad.ts` reads `.shed` after its flat
 * plan-cycle gates instead of branching on the device's discriminated-union
 * kind.
 */
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import {
  resolveResidualKwShed,
  type ResidualKwShedBehavior,
  type ResidualKwShedSteppedDevice,
  type ResidualKwShedTemperatureTarget,
} from '../../device/deviceResidualKw';
import { isDeviceObservationStale } from '../../observer/observationFreshness';
import { getCurrentDrawKw } from '../../observer/observedPower';
import {
  normalizeSteppedLoadStepStateFromLegacyFields,
  resolveKnownEffectiveStepId,
} from '../../plan/planSteppedLoadState';
import { getPrimaryTargetCapability } from '../../utils/targetCapabilities';
import type { ShedAction } from '../../plan/planTypes';

export type ResidualKwForPlanDeviceShedBehavior = {
  action: ShedAction;
  temperature: number | null;
  stepId: string | null;
};

export function buildResidualKwForPlanDevice(params: {
  device: TargetDeviceSnapshot;
  hasBinaryControl: boolean;
  shedBehavior: ResidualKwForPlanDeviceShedBehavior;
}): { shed: number } {
  const { device, hasBinaryControl, shedBehavior } = params;
  const observationStale = isDeviceObservationStale(device);
  const currentDrawKw = getCurrentDrawKw({
    ...device,
    observationStale,
  });
  const shed = resolveResidualKwShed({
    device: {
      currentDrawKw,
      temperatureTarget: toResidualTemperatureTarget(device),
      steppedLoad: toResidualSteppedLoad(device, hasBinaryControl),
    },
    shedBehavior: toResidualShedBehavior(shedBehavior),
  });
  return { shed };
}

function toResidualShedBehavior(
  shedBehavior: ResidualKwForPlanDeviceShedBehavior,
): ResidualKwShedBehavior {
  if (shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null) {
    return { action: 'set_temperature', temperature: shedBehavior.temperature };
  }
  if (shedBehavior.action === 'set_step') {
    return { action: 'set_step' };
  }
  return { action: 'turn_off' };
}

function toResidualSteppedLoad(
  device: TargetDeviceSnapshot,
  hasBinaryControl: boolean,
): ResidualKwShedSteppedDevice | undefined {
  if (device.controlModel !== 'stepped_load' || !device.steppedLoadProfile
    || device.steppedLoadProfile.model !== 'stepped_load') {
    return undefined;
  }
  const stepState = normalizeSteppedLoadStepStateFromLegacyFields({
    fields: device,
    selectedStepFallbackIsPlanningAssumption: true,
  });
  const hasKnownEffectiveStep = resolveKnownEffectiveStepId(stepState) !== undefined;
  return {
    profile: device.steppedLoadProfile,
    selectedStepId: device.selectedStepId,
    hasKnownEffectiveStep,
    measuredPowerKw: device.measuredPowerKw,
    hasBinaryControl,
  };
}

function toResidualTemperatureTarget(
  device: TargetDeviceSnapshot,
): ResidualKwShedTemperatureTarget | undefined {
  const target = getPrimaryTargetCapability(device.targets);
  if (!target) return undefined;
  return {
    ...(typeof target.value === 'number' && Number.isFinite(target.value)
      ? { currentValue: target.value }
      : {}),
    ...(typeof target.min === 'number' && Number.isFinite(target.min) ? { min: target.min } : {}),
    ...(typeof target.max === 'number' && Number.isFinite(target.max) ? { max: target.max } : {}),
    ...(typeof target.step === 'number' && Number.isFinite(target.step) ? { step: target.step } : {}),
  };
}
