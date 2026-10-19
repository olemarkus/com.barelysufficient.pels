import type { DeferredObjectiveSettingsKind } from '../../../packages/contracts/src/deferredObjectiveSettings';
import type { MeasuredPowerObservedProbe, TemperatureObservedProbe } from '../../../packages/contracts/src/types';
import type {
  CreateSmartTaskCandidateDevice,
  SmartTaskTemperatureObservation,
} from '../../../packages/contracts/src/widgetHostApi';
import {
  resolveSmartTaskCurrentValue,
  resolveSmartTaskGoalBounds,
  type SmartTaskDeviceLike,
  type SmartTaskGoalBounds,
} from '../../../packages/shared-domain/src/smartTaskDeviceKind';

// The few goals a creation surface offers as one-tap choices before "Customize".
// A target the device has already reached is never offered.
//
// EV: the usual battery-health stops, topped up from the highest remaining tens
// when the car is already past some of them (at 58 % that adds 90 %, never a 60 %
// that is two points away). Without a known battery level there is no
// plan to time a target against, so there are no quick targets.
//
// Temperature: the device class cannot tell a room from a water heater (a water
// heater reports `heater`, the class panel heaters use too), and the headroom to
// the maximum is about the same for both. The operating point does separate
// them: a room runs at 15-26 °C, a storage heater at 40 °C and above. So the
// step is 5 °C at or above 35 °C and 1 °C below, counted from the setpoint the
// owner's mode wants, or from the next step above the current temperature when
// that setpoint is already reached (a frost-guard setpoint in a warm room). Not
// from the reported setpoint: while PELS holds the device back, that is PELS's
// limit, and a room held at 16 °C would be offered 16-19 °C.
const QUICK_TARGET_COUNT = 4;
const PREFERRED_EV_QUICK_TARGETS = [50, 70, 80, 100];
const EV_QUICK_TARGET_POOL = [50, 60, 70, 80, 90, 100];
const STORAGE_HEATER_OPERATING_POINT_C = 35;
const STORAGE_HEATER_QUICK_STEP_C = 5;
const ROOM_QUICK_STEP_C = 1;

/** A candidate as the quick targets read it: the temperature carries the owner's setpoint. */
export type SmartTaskQuickTargetDevice = Omit<SmartTaskDeviceLike, 'temperature'>
  & Pick<CreateSmartTaskCandidateDevice, 'temperature'>;

const resolveEvQuickTargets = (currentPercent: number): number[] => {
  const above = (target: number): boolean => target > currentPercent;
  const preferred = PREFERRED_EV_QUICK_TARGETS.filter(above);
  const fill = EV_QUICK_TARGET_POOL.filter((target) => above(target) && !preferred.includes(target)).reverse();
  return [...preferred, ...fill.slice(0, Math.max(0, QUICK_TARGET_COUNT - preferred.length))]
    .sort((a, b) => a - b);
};

const snapUpToStep = (value: number, bounds: SmartTaskGoalBounds): number => {
  const steps = Math.ceil((value - bounds.min) / bounds.step - 1e-9);
  return Math.round((bounds.min + steps * bounds.step) * 100) / 100;
};

const resolveTemperatureQuickTargets = (
  temperature: SmartTaskTemperatureObservation,
  bounds: SmartTaskGoalBounds,
): number[] => {
  const intended = temperature.intendedTargetC;
  const current = temperature.currentTemperature;
  const quickStep = Math.max(intended, current) >= STORAGE_HEATER_OPERATING_POINT_C
    ? STORAGE_HEATER_QUICK_STEP_C
    : ROOM_QUICK_STEP_C;
  // Never finer than the device's own setpoint step, or targets snap together.
  const step = Math.max(quickStep, bounds.step);
  const first = intended > current ? intended : (Math.floor(current / step) + 1) * step;
  const targets: number[] = [];
  for (let index = 0; index < QUICK_TARGET_COUNT; index += 1) {
    const target = snapUpToStep(first + index * step, bounds);
    if (target > bounds.max || target <= current || targets.includes(target)) break;
    // eslint-disable-next-line functional/immutable-data -- In-place accumulation of a local result list.
    targets.push(target);
  }
  return targets;
};

/**
 * The quick targets to offer for a new task of `kind` on `device`, ascending.
 * Empty when there is nothing to offer: an energy task, a charger with no known
 * battery level, or a device already at its maximum.
 */
export const resolveSmartTaskQuickTargets = (
  device: SmartTaskQuickTargetDevice,
  kind: DeferredObjectiveSettingsKind,
): number[] => {
  if (kind === 'energy') return [];
  if (kind === 'ev_soc') {
    const current = resolveSmartTaskCurrentValue(device, kind);
    return current === null ? [] : resolveEvQuickTargets(current);
  }
  if (!device.temperature) return [];
  return resolveTemperatureQuickTargets(device.temperature, resolveSmartTaskGoalBounds(device, kind));
};

/**
 * Adds the owner's setpoint to a temperature device's observation, as the
 * planner resolves it (`lib/thermostat/temperatureSetpoints.ts`): the governing
 * mode's target, or the device's own setpoint when the mode holds none.
 */
export const withSmartTaskTemperatureIntent = <T extends TemperatureObservedProbe & { id: string }>(
  device: T,
  readModeTargetC: (deviceId: string) => number | null,
): Omit<T, 'temperature'> & { temperature?: SmartTaskTemperatureObservation } => {
  const { temperature, ...rest } = device;
  if (!temperature) return rest;
  return {
    ...rest,
    temperature: { ...temperature, intendedTargetC: readModeTargetC(device.id) ?? temperature.target.value },
  };
};

/** A device as the planner input serves it, before the smart-task candidate read. */
export type SmartTaskCandidateSource = Omit<CreateSmartTaskCandidateDevice, 'temperature'>
  & TemperatureObservedProbe & MeasuredPowerObservedProbe & { managed: boolean };
