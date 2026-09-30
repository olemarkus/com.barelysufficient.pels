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
// The structural input mirrors the relevant slice of `TargetDeviceSnapshot`
// without importing the full contract: callers pass the device snapshot
// directly (extra fields are ignored). The eligibility rule matches the
// deadline Flow cards' `isEvCharger` / `supportsTemperatureObjective` /
// `supportsEnergyObjective` predicates: an EV charger takes an EV-SoC goal; a
// device with the complete observer-admitted temperature facet takes a
// temperature goal; a pure on/off device takes an energy goal. Every device carries at most
// one kind, so "which kind is this task" and "which kind can this device take"
// have one answer.

export type SmartTaskDeviceLike = {
  deviceClass?: string;
  deviceType?: 'temperature' | 'onoff';
  temperatureControlDisabled?: true;
  /** Legacy runtime stamp used to deny Smart Tasks under manual target policies. */
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
// The facts that say a device is a pure on/off load: an on/off axis, and no
// target, stepped ladder or charger role on top of it. Named off the contract
// so a change to any of them is a build error here. The stepped ladder is read
// through its cluster (`isSteppedLoadSnapshot`), which the snapshot carries
// physically; callers holding the base type pass it unchanged.
} & Pick<DeviceDescriptor, 'binaryControllable' | 'deviceRole'>
  & Pick<ObservedDeviceState, 'targets'>
  & SteppedLoadDescriptorProbe;

const isEvCharger = (device: SmartTaskDeviceLike): boolean => device.deviceClass === 'evcharger';

// A pure on/off load: a relay switching a water heater, a plug, a pump. It can
// be on or off and nothing else, so running it is all a smart task can do with
// it, and the only goal it can carry is an amount of energy. A device with a
// charger role is not one, whatever its class: it is excluded here rather than
// counted as an EV above, which would change which devices take an EV task.
const isPureBinaryDevice = (device: SmartTaskDeviceLike): boolean => (
  device.binaryControllable === true
  && device.deviceRole !== 'ev_charger'
  && device.deviceType !== 'temperature'
  && device.targets.length === 0
  && !isSteppedLoadSnapshot(device)
);

const supportsTemperatureGoal = (device: SmartTaskDeviceLike): boolean => (
  device.temperature !== undefined
);

// Resolve the goal kind for a device. EV chargers win over the temperature
// branch so an EV charger that also happens to expose a settable target still
// reads as an EV-SoC task. Returns null when the device can carry neither goal
// (i.e. the device is ineligible for a smart task).
export const resolveSmartTaskDeviceKind = (
  device: SmartTaskDeviceLike,
): DeferredObjectiveSettingsKind | null => {
  if (isEvCharger(device)) return 'ev_soc';
  if (device.temperatureControlDisabled === true || device.temperatureAdjustmentsDisabled === true) return null;
  if (supportsTemperatureGoal(device)) return 'temperature';
  if (isPureBinaryDevice(device)) return 'energy';
  return null;
};

/**
 * Whether a new task of `kind` may be created on `device` right now: the
 * device's kind, and for an energy task a live power reading to count progress
 * from. The one gate every creation path (Flow card, widget, settings API) asks.
 */
export const supportsSmartTaskKind = (
  device: SmartTaskDeviceLike & MeasuredPowerObservedProbe,
  kind: DeferredObjectiveSettingsKind,
): boolean => (
  resolveSmartTaskDeviceKind(device) === kind
  // An energy task's progress is the energy the device takes, counted from its
  // power readings, so it needs a live reading of its draw.
  && (kind !== 'energy' || hasLiveMeasuredPower(device))
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
// is never below where the device already is), clamped into bounds.
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
