import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings.js';
import { deadlineLabels } from './deadlineLabels.js';

// Browser-safe resolution of "which kind of smart task can this device carry,
// and what are its goal bounds" — shared by the create-smart-task widget
// payload builder (browser) and the runtime create-validation path (Node) so
// the eligibility rule stays in one place.
//
// The structural input mirrors the relevant slice of `TargetDeviceSnapshot`
// without importing the full contract: callers pass the device snapshot
// directly (extra fields are ignored). The eligibility rule matches the
// deadline Flow cards' `isEvCharger` / `supportsTemperatureObjective`
// predicates: an EV charger takes an EV-SoC goal; any device that reports a
// temperature device type or a settable target takes a temperature goal.

export type SmartTaskDeviceLike = {
  deviceClass?: string;
  deviceType?: 'temperature' | 'onoff';
  targets?: ReadonlyArray<{ value?: number; min?: number; max?: number; step?: number }>;
  currentTemperature?: number;
  stateOfCharge?: { percent?: number };
};

const isEvCharger = (device: SmartTaskDeviceLike): boolean => device.deviceClass === 'evcharger';

const supportsTemperatureGoal = (device: SmartTaskDeviceLike): boolean => (
  device.deviceType === 'temperature' || (device.targets?.length ?? 0) > 0
);

// Resolve the goal kind for a device. EV chargers win over the temperature
// branch so an EV charger that also happens to expose a settable target still
// reads as an EV-SoC task. Returns null when the device can carry neither goal
// (i.e. the device is ineligible for a smart task).
export const resolveSmartTaskDeviceKind = (
  device: SmartTaskDeviceLike,
): DeferredObjectiveSettingsKind | null => {
  if (isEvCharger(device)) return 'ev_soc';
  if (supportsTemperatureGoal(device)) return 'temperature';
  return null;
};

// Inclusive goal bounds + step for a kind. Temperature pulls min/max/step from
// the device's settable target when present, falling back to a sane thermostat
// range; EV-SoC is always a 1..100 % battery target. Mirrors the validation
// ranges the deadline Flow cards enforce.
export type SmartTaskGoalBounds = {
  unit: '°C' | '%';
  min: number;
  max: number;
  step: number;
};

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
  const target = device.targets?.[0];
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
    return isFiniteNumber(device.currentTemperature) ? device.currentTemperature : null;
  }
  const percent = device.stateOfCharge?.percent;
  return isFiniteNumber(percent) ? percent : null;
};

// Sensible "common case" goals to seed the stepper with — an EV charges to 80%
// (the typical battery-health daily target) and a thermal device heats to a
// comfortable 60 °C (water-heater scald-safe). These are starting points the
// user adjusts; they matter because seeding at the *current* reading would make
// the goal a no-op (heat to where you already are / charge to current SoC).
const DEFAULT_EV_TARGET_PERCENT = 80;
const DEFAULT_TEMPERATURE_TARGET_C = 60;

// Seed the goal stepper with a goal-oriented default snapped to the step grid:
// the larger of the common-case target and the current reading (so the default
// is never below where the device already is), clamped into bounds.
export const resolveSmartTaskDefaultGoal = (params: {
  kind: DeferredObjectiveSettingsKind;
  bounds: SmartTaskGoalBounds;
  currentValue: number | null;
}): number => {
  const { kind, bounds, currentValue } = params;
  const commonCase = kind === 'ev_soc' ? DEFAULT_EV_TARGET_PERCENT : DEFAULT_TEMPERATURE_TARGET_C;
  const target = currentValue !== null ? Math.max(commonCase, currentValue) : commonCase;
  const clamped = Math.min(bounds.max, Math.max(bounds.min, target));
  const snapped = bounds.min + Math.round((clamped - bounds.min) / bounds.step) * bounds.step;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(snapped * 100) / 100));
};
