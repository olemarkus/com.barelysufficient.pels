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
 * The restore wiring funnels the observer-resolved `getHighestKnownPowerKw`
 * fallback into the producer so the producer module stays free of
 * `lib/observer/**` (enforced by the `no-device-residual-kw-to-plan`
 * dep-cruiser rule).
 */
import type {
  DecoratedDeviceSnapshot,
  MeasuredPowerObservedProbe,
  RestorePowerSource,
  TemperatureObservedProbe,
} from '../../packages/contracts/src/types';
import type { ShedBehavior } from '../../lib/plan/planTypes';
import { getSteppedLoadLowestActiveStep } from '../../lib/utils/deviceControlProfiles';
import {
  resolveResidualKwRestore,
  resolveResidualKwShed,
  type ResidualKwRestoreSteppedDevice,
  type ResidualKwShedBehavior,
  type ResidualKwShedSteppedDevice,
  type ResidualKwShedTemperatureTarget,
} from '../../lib/device/deviceResidualKw';
import { getCurrentDrawKw, getHighestKnownPowerKw } from '../../lib/observer/observedPower';
import { resolveObservedCurrentState } from '../../lib/observer/observedState';
import {
  normalizeSteppedLoadStepStateFromLegacyFields,
  resolveKnownEffectiveStepId,
} from '../../lib/plan/planSteppedLoadState';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import { getPrimaryTargetCapability } from '../../lib/utils/targetCapabilities';

export type ResidualKwForPlanDeviceShedBehavior =
  | { action: 'turn_off' }
  | { action: 'set_temperature'; temperature: number }
  | { action: 'set_step'; stepId: string };

/**
 * Project the owner's CONFIGURED shed behaviour onto the device it applies to.
 *
 * The configured value is a floor, not a decision: `set_step` carries no rung
 * (the producer never stores one), and `set_temperature` is denied outright when
 * the owner switched temperature control off or the device has no observed
 * temperature. This is the whole of that projection, and it is pure — the ctx
 * lookup stays at the `toPlanDevice` seam, so the fixture builders can ask the
 * SAME function rather than restating the two arms. A restated mirror already
 * dropped the denial arm once.
 */
export function resolveResidualShedBehavior(
  configured: ShedBehavior,
  device: DecoratedDeviceSnapshot & TemperatureObservedProbe,
): ResidualKwForPlanDeviceShedBehavior {
  if (configured.action === 'set_temperature') {
    // The setpoint arm — and only it — is denied when the owner switched
    // temperature control off. Relaxing this to "the fence will catch it" would
    // let a stale persisted setpoint shed reach the planner: a stepped device
    // routes its release through `shed_release`, which would issue a `target`
    // command the fence refuses, leaving the device shed with no way back.
    // The first disjunct cannot decide anything in production:
    // `projectEffectiveControlDevice` (`toPlanDevice.ts`) already blanks
    // `targets`/`temperature` and stamps `deviceType: 'onoff'` for a
    // temperature-disabled device before this runs. It is kept because fixture
    // callers reach this function directly, without that projection — so the
    // denial must hold here too rather than rely on a caller that may not exist.
    if (device.temperatureControlDisabled === true || device.temperature === undefined) {
      return resolveShedBehaviorWithoutTemperature(device);
    }
    return { action: 'set_temperature', temperature: configured.temperature };
  }
  if (configured.action === 'set_step') {
    // The rung is the device's own — a configured step id used to take
    // precedence here, but nothing ever wrote one.
    const stepId = isSteppedLoadSnapshot(device)
      ? getSteppedLoadLowestActiveStep(device.steppedLoadProfile)?.id
      : undefined;
    return stepId ? { action: 'set_step', stepId } : { action: 'turn_off' };
  }
  return { action: 'turn_off' };
}

function resolveShedBehaviorWithoutTemperature(
  device: DecoratedDeviceSnapshot,
): ResidualKwForPlanDeviceShedBehavior {
  if (device.binaryControl !== undefined) return { action: 'turn_off' };
  if (!isSteppedLoadSnapshot(device)) return { action: 'turn_off' };
  const lowestActiveStep = getSteppedLoadLowestActiveStep(device.steppedLoadProfile);
  return lowestActiveStep
    ? { action: 'set_step', stepId: lowestActiveStep.id }
    : { action: 'turn_off' };
}

export function buildResidualKwForPlanDevice(params: {
  device: DecoratedDeviceSnapshot & MeasuredPowerObservedProbe;
  hasBinaryControl: boolean;
  shedBehavior: ResidualKwForPlanDeviceShedBehavior;
}): { shed: number; restore: { kw: number; source: RestorePowerSource } } {
  const { device, hasBinaryControl, shedBehavior } = params;
  // The same producer answer `toPlanDevice` stamps as `currentDrawKw`: the
  // meter's reading, with no on/off or configured-demand ladder behind it.
  const currentDrawKw = getCurrentDrawKw(device);
  const shed = resolveResidualKwShed({
    device: {
      currentDrawKw,
      temperatureTarget: toResidualTemperatureTarget(device),
      steppedLoad: toResidualSteppedLoad(device, currentDrawKw, hasBinaryControl),
    },
    shedBehavior: toResidualShedBehavior(shedBehavior),
  });
  const restore = resolveResidualKwRestore({
    steppedLoad: toRestoreSteppedLoad(device),
    // The snapshot's own resolved draw is the `measured` candidate in the
    // restore ladder; the raw field never travels past this seam.
    restoreFallback: getHighestKnownPowerKw({ ...device, currentDrawKw }),
  });
  return { shed, restore };
}

function toRestoreSteppedLoad(
  device: DecoratedDeviceSnapshot,
): ResidualKwRestoreSteppedDevice | undefined {
  if (!isSteppedLoadSnapshot(device)) return undefined;
  // The `currentState !== 'off'` question the restore ladder asks.
  // `currentState` is observer-resolved
  // (the concrete latched label — no staleness gate), so the wiring layer
  // computes the same projection here and funnels the resolved boolean.
  const currentState = resolveObservedCurrentState({
    binaryControl: device.binaryControl,
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
  if (shedBehavior.action === 'set_temperature') {
    return { action: 'set_temperature', temperature: shedBehavior.temperature };
  }
  if (shedBehavior.action === 'set_step') {
    return { action: 'set_step' };
  }
  return { action: 'turn_off' };
}

function toResidualSteppedLoad(
  device: DecoratedDeviceSnapshot & MeasuredPowerObservedProbe,
  currentDrawKw: number,
  hasBinaryControl: boolean,
): ResidualKwShedSteppedDevice | undefined {
  if (!isSteppedLoadSnapshot(device)) return undefined;
  const stepState = normalizeSteppedLoadStepStateFromLegacyFields({
    fields: device,
    selectedStepFallbackIsPlanningAssumption: true,
  });
  const hasKnownEffectiveStep = resolveKnownEffectiveStepId(stepState) !== undefined;
  return {
    profile: device.steppedLoadProfile,
    selectedStepId: device.selectedStepId,
    hasKnownEffectiveStep,
    currentDrawKw,
    hasBinaryControl,
  };
}

function toResidualTemperatureTarget(
  device: DecoratedDeviceSnapshot,
): ResidualKwShedTemperatureTarget | undefined {
  // Taking `targets[0]` is safe because the parse seam already made the list
  // atomic with the facet: `managerParseDeviceFields.ts` writes
  // `targets = temperature ? [temperature.target] : []`, so a snapshot's list
  // holds the `target_temperature` entry alone or nothing, and `toPlanDevice`
  // only passes it through. Reviewers have twice read this as "picks by index
  // where admission finds by id" and filed a defect; the divergence is not
  // reachable. If the seam ever emits a second target capability, this must
  // become a find-by-id — the shed math would otherwise be normalized against
  // another capability's min/max/step.
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
