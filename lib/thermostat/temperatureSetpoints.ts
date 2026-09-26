/**
 * The owner's temperature intent, resolved into setpoints for each temperature
 * device before the planner runs.
 *
 * ## Why this is not the planner's
 *
 * The planner decides outcomes: keep a device, lift it for surplus, limit it.
 * What setpoint each outcome commands is execution, and every piece of it —
 * the mode's target, this hour's price shift, a smart task's deadline floor, the
 * surplus lift, the capability's step — depends on which way the device moves
 * demand. A heater works harder when its setpoint goes up and a cooling unit
 * when it goes down. Resolved inside the planner, that direction leaked into
 * every stage that compared two setpoints, and each comparison was a heating
 * assumption waiting for a cooling unit (`notes/temperature-ownership.md`).
 *
 * So the planner is handed {@link TemperatureSetpoints} and never a direction.
 * This module is the only place a setpoint is computed or two setpoints are
 * ordered (`setpointDemand.ts`).
 *
 * ## When it runs
 *
 * Once per plan build, after the smart-task decoration has stamped any deadline
 * floor onto the admitted devices, through the builder's
 * `resolveTemperatureSetpoints` seam. The inputs are read through
 * {@link TemperatureIntentReads}, which the wiring binds to the owning home.
 */
import type { ThermalDirection } from '../../packages/contracts/src/types';
import type {
  PlanInputDevice,
  TemperaturePlanInputKind,
} from '../../packages/planner-types/src/planInputDevice';
import type { ShedBehavior } from '../../packages/planner-types/src/shedBehavior';
import type {
  ResolveTemperatureSetpoints,
  ResolvedShedBehavior,
  TemperatureSetpoints,
} from '../../packages/planner-types/src/temperatureSetpoints';
import { isTemperatureControlDevice } from '../../packages/shared-domain/src/temperatureDeviceKind';
import { PriceLevel } from '../price/priceLevels';
import {
  resolvePriceOptimizationConfig,
  type PriceOptimizationSettings,
} from '../price/priceOptimizer';
import { getPrimaryTargetCapability, normalizeTargetCapabilityValue } from '../utils/targetCapabilities';
import { applyPriceShift } from './priceShift';
import {
  demandShortfallC,
  moreDemandingSetpoint,
  setpointAddsDemand,
  towardDemand,
} from './setpointDemand';

/**
 * Where the owner's intent is read from, bound by the wiring to one home. The
 * same reads the plan builder used to take for itself.
 */
export type TemperatureIntentReads = {
  getOperatingMode: () => string;
  getModeDeviceTargets: () => Readonly<Record<string, Readonly<Record<string, number>>>>;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Readonly<Record<string, PriceOptimizationSettings>>;
  /** Expensive on a Homey Pro; asked at most once per build, and only when a device can spend it. */
  getCurrentHourPriceLevel: () => PriceLevel;
  /** A manual change may cancel this device's shift for the current price level. */
  shouldApplyPriceShift: (deviceId: string, level: PriceLevel) => boolean;
  /** A saved cancellation must observe level changes even with deltas switched off. */
  hasPendingPriceShiftCancellations: (deviceIds: readonly string[]) => boolean;
  getThermalDirection: (deviceId: string) => ThermalDirection;
  /** Already resolved for the device's direction and policy (`AppHostApi.getShedBehavior`). */
  getShedBehavior: (deviceId: string) => ShedBehavior;
};

// The tolerance for "the target is short of what the owner wants" — as before.
const TARGET_DEFICIT_TOLERANCE_C = 0.5;
// The step assumed for a capability that declares none, by temperature range.
const LOW_TEMPERATURE_STEP_C = 0.5;
const HIGH_TEMPERATURE_STEP_C = 1.0;
const HIGH_TEMPERATURE_FROM_C = 30;

type TemperatureInputDevice = PlanInputDevice & TemperaturePlanInputKind;

const isTemperatureInputDevice = (device: PlanInputDevice): device is TemperatureInputDevice => (
  isTemperatureControlDevice(device)
);

/** The build's shared inputs: one mode, one settings map, one price level. */
type BuildIntent = {
  modeTargets: Readonly<Record<string, number>>;
  settings: Readonly<Record<string, PriceOptimizationSettings>>;
  priceShiftActive: boolean;
  priceLevel: PriceLevel;
};

export function createTemperatureSetpointResolver(reads: TemperatureIntentReads): ResolveTemperatureSetpoints {
  return (devices) => {
    const temperatureDevices = devices.filter(isTemperatureInputDevice);
    if (temperatureDevices.length === 0) return new Map();
    const intent = resolveBuildIntent(reads, temperatureDevices);
    return new Map(temperatureDevices.map((device) => [device.id, resolveDeviceSetpoints(reads, intent, device)]));
  };
}

/**
 * The price level is resolved only when a device here can spend it: the global
 * switch defaults ON while the device map is still empty on a fresh install, and
 * each resolution rebuilds the whole price series (~25 ms on a Homey Pro).
 */
function resolveBuildIntent(reads: TemperatureIntentReads, devices: readonly TemperatureInputDevice[]): BuildIntent {
  const modeTargets = reads.getModeDeviceTargets()[reads.getOperatingMode()] ?? {};
  const settings = reads.getPriceOptimizationSettings();
  const priceShiftActive = reads.getPriceOptimizationEnabled()
    && devices.some((device) => resolvePriceOptimizationConfig(settings, device.id).enabled);
  return {
    modeTargets,
    settings,
    priceShiftActive,
    priceLevel: priceShiftActive || reads.hasPendingPriceShiftCancellations(devices.map((device) => device.id))
      ? reads.getCurrentHourPriceLevel()
      : PriceLevel.UNKNOWN,
  };
}

function resolveTargetStepC(device: TemperatureInputDevice, intendedC: number): number {
  const step = getPrimaryTargetCapability(device.targets)?.step;
  if (typeof step === 'number' && Number.isFinite(step) && step > 0) return step;
  return intendedC < HIGH_TEMPERATURE_FROM_C ? LOW_TEMPERATURE_STEP_C : HIGH_TEMPERATURE_STEP_C;
}

/** The setpoint the owner's surplus lift commands, or `desiredC` when the device has none. */
function resolveSurplusRawC(
  direction: ThermalDirection,
  lift: number,
  intendedC: number,
  desiredC: number,
): number {
  // The lift comes off the bare mode target and wins over an expensive-hour
  // shift: surplus is free even on an expensive grid hour.
  return lift > 0 ? moreDemandingSetpoint(direction, desiredC, towardDemand(direction, intendedC, lift)) : desiredC;
}

function resolveDeviceSetpoints(
  reads: TemperatureIntentReads,
  intent: BuildIntent,
  device: TemperatureInputDevice,
): TemperatureSetpoints {
  const direction = reads.getThermalDirection(device.id);
  const target = getPrimaryTargetCapability(device.targets);
  const storedIntendedC = intent.modeTargets[device.id];
  const intendedC = typeof storedIntendedC === 'number' ? storedIntendedC : device.currentTarget;
  const config = resolvePriceOptimizationConfig(intent.settings, device.id);
  // Observe cancellation expiry on every build with a known level, even while
  // price deltas are disabled. Applying a delta still requires both gates.
  const shiftAllowed = intent.priceLevel === PriceLevel.UNKNOWN
    || reads.shouldApplyPriceShift(device.id, intent.priceLevel);
  const desiredC = intent.priceShiftActive && shiftAllowed && config.enabled
    ? applyPriceShift(intendedC, config, intent.priceLevel, direction)
    : intendedC;
  // A smart task in its planned hours holds the device at least at its deadline floor.
  const floorC = device.deadlineFloorTargetC;
  const withFloor = (setpointC: number): number => (
    typeof floorC === 'number' ? moreDemandingSetpoint(direction, setpointC, floorC) : setpointC
  );
  const keepC = normalizeTargetCapabilityValue({ target, value: withFloor(desiredC) });
  const surplusC = normalizeTargetCapabilityValue({
    target,
    value: withFloor(resolveSurplusRawC(direction, config.surplusLiftC, intendedC, desiredC)),
  });
  const targetStepC = resolveTargetStepC(device, intendedC);
  // Half a step: keeps float quantization from reading an equal command as short.
  const toleranceC = targetStepC / 2;
  const asksLessThanIntended = (setpointC: number): boolean => (
    demandShortfallC(direction, setpointC, intendedC) > toleranceC
  );
  const configured = reads.getShedBehavior(device.id);
  const resolveSetpointShed = (limitC: number): ResolvedShedBehavior => ({
    action: 'set_temperature',
    limitC,
    releasesDemand: setpointAddsDemand(direction, limitC, device.currentTarget),
    asksLessThanIntended: asksLessThanIntended(limitC),
  });
  const shed: ResolvedShedBehavior = configured.action === 'set_temperature'
    ? resolveSetpointShed(normalizeTargetCapabilityValue({ target, value: configured.temperature }))
    : configured;
  return {
    intendedC,
    desiredC,
    keepC,
    surplusC,
    targetStepC,
    shed,
    keepAddsDemand: setpointAddsDemand(direction, device.currentTarget, keepC),
    surplusAddsDemand: setpointAddsDemand(direction, device.currentTarget, surplusC),
    keepAsksLessThanIntended: asksLessThanIntended(keepC),
    surplusAsksLessThanIntended: asksLessThanIntended(surplusC),
    // Against what the capability can hold: a desired setpoint past its range is
    // one the device can never report, so it is never short of it for that part.
    targetShortOfDesired: demandShortfallC(
      direction, device.currentTarget, normalizeTargetCapabilityValue({ target, value: desiredC }),
    ) >= TARGET_DEFICIT_TOLERANCE_C,
    roomShortOfIntended: demandShortfallC(direction, device.currentTemperature, intendedC) > toleranceC,
  };
}
