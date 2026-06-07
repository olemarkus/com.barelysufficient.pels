/**
 * Producer-side wiring for `PlanInputDevice.residualKw` (chunks 3-4 of the
 * planner-detype refactor). `toPlanDevice` in `./toPlanDevice.ts` calls
 * `buildResidualKwForPlanDevice`, which adapts a `TargetDeviceSnapshot` to
 * the structural input shapes consumed by `resolveResidualKwShed` (chunk 3)
 * and `resolveResidualKwRestore` (chunk 4) in
 * `lib/device/deviceResidualKw.ts`.
 *
 * Exposes `.shed` (chunk 3) and `.restore` (chunk 4). Future chunks may layer
 * `keep` onto the same field. The consumers in
 * `lib/plan/planRemainingSheddableLoad.ts` (shed) and
 * `lib/plan/restore/accounting.ts` (restore) read these after their flat
 * plan-cycle gates instead of branching on the device's discriminated-union
 * kind.
 *
 * The restore wiring funnels the observer-resolved `getRestoreDrawKw`
 * fallback into the producer so the producer module stays free of
 * `lib/observer/**` (enforced by the `no-device-residual-kw-to-plan`
 * dep-cruiser rule).
 */
import type {
  BinaryControlCapabilityId,
  DecoratedDeviceSnapshot,
  RestorePowerSource,
} from '../../packages/contracts/src/types';
import {
  resolveResidualKwRestore,
  resolveResidualKwShed,
  type ResidualKwRestoreSteppedDevice,
  type ResidualKwShedBehavior,
  type ResidualKwShedSteppedDevice,
  type ResidualKwShedTemperatureTarget,
} from '../../lib/device/deviceResidualKw';
import { getCurrentDrawKw, getRestoreDrawKw } from '../../lib/observer/observedPower';
import { resolveObservedCurrentState } from '../../lib/observer/observedState';
import {
  normalizeSteppedLoadStepStateFromLegacyFields,
  resolveKnownEffectiveStepId,
} from '../../lib/plan/planSteppedLoadState';
import { getPrimaryTargetCapability } from '../../lib/utils/targetCapabilities';
import type { ShedAction } from '../../lib/plan/planTypes';

export type ResidualKwForPlanDeviceShedBehavior = {
  action: ShedAction;
  temperature: number | null;
  stepId: string | null;
};

export function buildResidualKwForPlanDevice(params: {
  device: DecoratedDeviceSnapshot;
  controlCapabilityId?: BinaryControlCapabilityId;
  shedBehavior: ResidualKwForPlanDeviceShedBehavior;
  // Resolved once by the caller (`toPlanDevice`) from the observer projection so
  // every freshness consumer in a single plan-device build shares one source of
  // truth — the residual-power credit and the device's `observationStale` flag
  // can't disagree within the same pass.
  observationStale: boolean;
}): { shed: number; restore: { kw: number; source: RestorePowerSource } } {
  const { device, controlCapabilityId, shedBehavior, observationStale } = params;
  const currentDrawKw = getCurrentDrawKw({
    ...device,
    observationStale,
  });
  const shed = resolveResidualKwShed({
    device: {
      currentDrawKw,
      temperatureTarget: toResidualTemperatureTarget(device),
      steppedLoad: toResidualSteppedLoad(device, controlCapabilityId),
    },
    shedBehavior: toResidualShedBehavior(shedBehavior),
  });
  const restore = resolveResidualKwRestore({
    steppedLoad: toRestoreSteppedLoad(device, controlCapabilityId, observationStale),
    restoreFallback: getRestoreDrawKw(device),
  });
  return { shed, restore };
}

function toRestoreSteppedLoad(
  device: DecoratedDeviceSnapshot,
  controlCapabilityId: BinaryControlCapabilityId | undefined,
  observationStale: boolean,
): ResidualKwRestoreSteppedDevice | undefined {
  if (
    device.controlModel !== 'stepped_load'
    || !device.steppedLoadProfile
    || device.steppedLoadProfile.model !== 'stepped_load'
  ) {
    return undefined;
  }
  // Mirrors `dev.currentState !== 'off'` in the legacy
  // `resolveSteppedRestorePower` chain. `currentState` is observer-resolved,
  // so the wiring layer computes the same projection here and funnels the
  // resolved boolean into the producer.
  const currentState = resolveObservedCurrentState({
    binaryControl: device.binaryControl,
    controlCapabilityId,
    observationStale,
    controlModel: device.controlModel,
    steppedLoadProfile: device.steppedLoadProfile,
    selectedStepId: device.selectedStepId,
  });
  return {
    profile: device.steppedLoadProfile,
    currentStateIsOff: currentState === 'off',
    ...(typeof device.planningPowerKw === 'number' && Number.isFinite(device.planningPowerKw)
      ? { planningPowerKw: device.planningPowerKw }
      : {}),
  };
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
  device: DecoratedDeviceSnapshot,
  controlCapabilityId: BinaryControlCapabilityId | undefined,
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
    controlCapabilityId,
  };
}

function toResidualTemperatureTarget(
  device: DecoratedDeviceSnapshot,
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
