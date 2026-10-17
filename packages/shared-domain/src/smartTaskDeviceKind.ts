import type {
  DeferredObjectiveSettingsKind,
  DeferredObjectiveUnit,
} from '../../contracts/src/deferredObjectiveSettings.js';
import type {
  DeviceDescriptor,
  MeasuredPowerObservedProbe,
  ObservedDeviceState,
  ObservedStateOfCharge,
  SteppedLoadDescriptorProbe,
} from '../../contracts/src/types.js';
import { deadlineLabels } from './deadlineLabels.js';
import { hasLiveMeasuredPower } from './measuredPowerObservedState.js';
import { isSteppedLoadSnapshot } from './steppedLoadObservedState.js';
import { MAX_TARGET_ENERGY_KWH, MIN_TARGET_ENERGY_KWH } from './settings/deferredObjectiveSettings.js';

// Browser-safe resolution of "which kind of smart task can this device carry,
// and what are its goal bounds" — shared by the create-smart-task widget
// payload builder (browser) and the runtime create-validation path (Node) so
// the eligibility rule stays in one place.
//
// The structural input mirrors the relevant slice of `TargetDeviceSnapshot`.
// Default selection keeps existing creation surfaces stable; eligibility is
// independent because a charger supports both battery and energy targets.

export type SmartTaskDeviceLike = {
  temperatureControlDisabled?: true;
  temperatureAdjustmentsDisabled?: true;
  temperature?: {
    currentTemperature: number;
    target: { value: number; min?: number; max?: number; step?: number };
  };
  // The named contract type, not a hand-mirrored slice. As `{ percent?: number }`
  // this accepted any object at all, so a shape change compiled fine and every EV
  // charger silently seeded its goal stepper from `null`. Naming
  // `ObservedStateOfCharge` makes the next such change a build error here, and
  // keeps one spelling across every consumer of a resolved level.
  stateOfCharge?: ObservedStateOfCharge;
// The resolved identity facts, named off the contract and required there, so a
// carrier that lacks one is a build error rather than a device that silently
// reads as "not a charger". The raw class is not here on purpose: planner input
// does not carry it, and reading it there classed every EV charger as
// ineligible. The stepped ladder is read through its cluster
// (`isSteppedLoadSnapshot`), which the snapshot carries physically; callers
// holding the base type pass it unchanged.
} & Pick<DeviceDescriptor, 'isEvCharger' | 'binaryControllable'>
  & Pick<ObservedDeviceState, 'targets'>
  & SteppedLoadDescriptorProbe;

// A pure on/off load: a relay switching a water heater, a plug, a pump. It can
// be on or off and nothing else, so its default goal is an amount of energy.
// Chargers have their own eligibility branch, including stepped chargers.
const isPureBinaryDevice = (device: SmartTaskDeviceLike): boolean => (
  device.binaryControllable
  && !device.isEvCharger
  && device.targets.length === 0
  && !isSteppedLoadSnapshot(device)
);

const supportsTemperatureGoal = (device: SmartTaskDeviceLike): boolean => (
  device.temperature !== undefined
);

// Resolve the default goal kind for a device. EV chargers win over the temperature
// branch so an EV charger that also happens to expose a settable target still
// defaults to an EV-SoC task. This is a picker default, not an exhaustive
// capability check: chargers can also take energy tasks.
export const resolveDefaultSmartTaskKind = (
  device: SmartTaskDeviceLike,
): DeferredObjectiveSettingsKind | null => {
  if (device.isEvCharger) return 'ev_soc';
  if (device.temperatureControlDisabled === true || device.temperatureAdjustmentsDisabled === true) return null;
  if (supportsTemperatureGoal(device)) return 'temperature';
  if (isPureBinaryDevice(device)) return 'energy';
  return null;
};

/**
 * Whether a new task of `kind` may be created on `device` right now: the
 * supported goal and, for energy, live power to count progress. Chargers support
 * energy targets with or without a linked car or battery level. Every creation
 * path (Flow card, widget, settings API) asks this same gate.
 */
export const supportsSmartTaskKind = (
  device: SmartTaskDeviceLike & MeasuredPowerObservedProbe,
  kind: DeferredObjectiveSettingsKind,
): boolean => (
  kind === 'energy'
    ? (device.isEvCharger || resolveDefaultSmartTaskKind(device) === 'energy') && hasLiveMeasuredPower(device)
    : resolveDefaultSmartTaskKind(device) === kind
);

// Inclusive goal bounds + step for a kind. Temperature pulls min/max/step from
// the device's settable target when present, falling back to a sane thermostat
// range; EV-SoC is always a 1..100 % battery target. Mirrors the validation
// ranges the deadline Flow cards enforce.
export type SmartTaskGoalBounds = {
  unit: DeferredObjectiveUnit;
  min: number;
  max: number;
  step: number;
};

const ENERGY_TARGET_STEP_KWH = 0.1;
const TEMPERATURE_FALLBACK_MIN = 5;
const TEMPERATURE_FALLBACK_MAX = 95;
const TEMPERATURE_FALLBACK_STEP = 0.5;

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

export const resolveSmartTaskGoalBounds = (
  device: SmartTaskDeviceLike,
  kind: DeferredObjectiveSettingsKind,
): SmartTaskGoalBounds => {
  const unit = deadlineLabels(kind).targetUnit;
  if (kind === 'ev_soc') {
    return { unit, min: 1, max: 100, step: 1 };
  }
  if (kind === 'energy') {
    return { unit, min: MIN_TARGET_ENERGY_KWH, max: MAX_TARGET_ENERGY_KWH, step: ENERGY_TARGET_STEP_KWH };
  }
  const target = device.temperature?.target;
  const min = isFiniteNumber(target?.min) ? target.min : TEMPERATURE_FALLBACK_MIN;
  const max = isFiniteNumber(target?.max) ? target.max : TEMPERATURE_FALLBACK_MAX;
  const step = isFiniteNumber(target?.step) && target.step > 0 ? target.step : TEMPERATURE_FALLBACK_STEP;
  return { unit, min, max, step };
};

// Current observed goal value for the device, used to seed the goal stepper and
// render a "now → target" line. Null when the device hasn't reported a reading.
export const resolveSmartTaskCurrentValue = (
  device: SmartTaskDeviceLike,
  kind: DeferredObjectiveSettingsKind,
): number | null => {
  if (kind === 'temperature') {
    return device.temperature?.currentTemperature ?? null;
  }
  // An energy task counts from the moment it starts: before then there is
  // nothing fed to show.
  if (kind === 'energy') return null;
  // `level`, never the raw report: a charger whose car has gone reports no level,
  // and seeding the stepper from the percentage that car left behind would show a
  // departed car's charge as this one's. Same answer `resolveObjectiveObservedQuantity`
  // gives for the same state.
  const level = device.stateOfCharge?.level;
  return level?.kind === 'known' ? level.percent : null;
};

// Sensible "common case" goals to seed the stepper with — an EV charges to 80%
// (the typical battery-health daily target) and a thermal device heats to a
// comfortable 60 °C (water-heater scald-safe). These are starting points the
// user adjusts; they matter because seeding at the *current* reading would make
// the goal a no-op (heat to where you already are / charge to current SoC).
const DEFAULT_EV_TARGET_PERCENT = 80;
const DEFAULT_TEMPERATURE_TARGET_C = 60;
// Roughly a night's heating of a 200 l water heater.
const DEFAULT_ENERGY_TARGET_KWH = 10;

const COMMON_CASE_GOAL: Record<DeferredObjectiveSettingsKind, number> = {
  ev_soc: DEFAULT_EV_TARGET_PERCENT,
  temperature: DEFAULT_TEMPERATURE_TARGET_C,
  energy: DEFAULT_ENERGY_TARGET_KWH,
};

// Seed the goal stepper with a goal-oriented default snapped to the step grid:
// the larger of the common-case target and the current reading (so the default
// is never below where the device already is), clamped into bounds. A
// temperature device seeds from its first quick target instead
// (`resolveSmartTaskDeviceDefaultGoal`): the 60 °C common case is a water
// heater's, and clamped into a room thermostat's range it seeded 40 °C.
export const resolveSmartTaskDefaultGoal = (params: {
  kind: DeferredObjectiveSettingsKind;
  bounds: SmartTaskGoalBounds;
  currentValue: number | null;
}): number => {
  const { kind, bounds, currentValue } = params;
  const commonCase = COMMON_CASE_GOAL[kind];
  const target = currentValue !== null ? Math.max(commonCase, currentValue) : commonCase;
  const clamped = Math.min(bounds.max, Math.max(bounds.min, target));
  const snapped = bounds.min + Math.round((clamped - bounds.min) / bounds.step) * bounds.step;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(snapped * 100) / 100));
};

// ─── Quick targets ──────────────────────────────────────────────────────────
//
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
// step is 5 °C at or above 35 °C and 1 °C below, counted from the device's own
// setpoint, or from the next step above the current temperature when that
// setpoint is already reached (a frost-guard setpoint in a warm room).
const QUICK_TARGET_COUNT = 4;
const PREFERRED_EV_QUICK_TARGETS = [50, 70, 80, 100];
const EV_QUICK_TARGET_POOL = [50, 60, 70, 80, 90, 100];
const STORAGE_HEATER_OPERATING_POINT_C = 35;
const STORAGE_HEATER_QUICK_STEP_C = 5;
const ROOM_QUICK_STEP_C = 1;

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
  temperature: NonNullable<SmartTaskDeviceLike['temperature']>,
  bounds: SmartTaskGoalBounds,
): number[] => {
  const setpoint = temperature.target.value;
  const current = temperature.currentTemperature;
  const quickStep = Math.max(setpoint, current) >= STORAGE_HEATER_OPERATING_POINT_C
    ? STORAGE_HEATER_QUICK_STEP_C
    : ROOM_QUICK_STEP_C;
  // Never finer than the device's own setpoint step, or targets snap together.
  const step = Math.max(quickStep, bounds.step);
  const first = setpoint > current ? setpoint : (Math.floor(current / step) + 1) * step;
  const targets: number[] = [];
  for (let index = 0; index < QUICK_TARGET_COUNT; index += 1) {
    const target = snapUpToStep(first + index * step, bounds);
    if (target > bounds.max || target <= current || targets.includes(target)) break;
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
  device: SmartTaskDeviceLike,
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

/** The goal a creation surface seeds its stepper with for `device`. */
export const resolveSmartTaskDeviceDefaultGoal = (
  device: SmartTaskDeviceLike,
  kind: DeferredObjectiveSettingsKind,
): number => {
  const bounds = resolveSmartTaskGoalBounds(device, kind);
  const [firstQuickTarget] = kind === 'temperature' ? resolveSmartTaskQuickTargets(device, kind) : [];
  return firstQuickTarget ?? resolveSmartTaskDefaultGoal({
    kind, bounds, currentValue: resolveSmartTaskCurrentValue(device, kind),
  });
};
