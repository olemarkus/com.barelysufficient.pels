/**
 * The `overshoot_behaviors` setting: one key, one reader.
 *
 * How far PELS may go when it limits a device: turn it off, step it down, or
 * move its setpoint to the owner's limit. Both sides read these bytes — the
 * runtime to plan, the settings UI to render and edit them — so the type, the
 * bounds and the read policy live here, once (`notes/settings-key-ownership.md`).
 * Before this module the runtime clamped both limits to ±50 °C while the editor
 * accepted -20..50 and 16..40, and the editor held the raw blob with every field
 * optional.
 *
 * ## The setpoint entry carries both limits
 *
 * `temperature` is the limit while heating (a floor the device may fall to),
 * `coolingTemperature` the limit while cooling (a ceiling it may rise to). Both
 * are always present on a read value. A device with no mode axis is a heater
 * and never reads the second; an entry persisted before the second existed
 * reads as {@link COOLING_SHED_DEFAULT_C}. Nothing inward of this reader asks
 * whether a limit is configured.
 *
 * ## Read policy: sanitize and keep
 *
 * A limit outside its range is clamped into it. A `set_temperature` entry with
 * no usable heating limit reads as `turn_off`, the behaviour every device has
 * by default. An entry that is not an object is dropped, which is the same
 * answer: a device with no entry is turned off.
 *
 * Transport stays with the callers, and so does a read that is not a map at
 * all ({@link isShedBehaviorsSetting}): the runtime can cross-check `getKeys()`
 * to tell a never-written key from a failed read, the settings UI cannot, and
 * both keep the map they already hold rather than read a miss as "every limit
 * cleared".
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */
import { COOLING_SHED_DEFAULT_C } from '../utils/airtreatmentConstants';
import { clamp } from '../utils/math';

export type ConfiguredShedBehavior =
  | { action: 'turn_off' }
  | { action: 'set_step' }
  | { action: 'set_temperature'; temperature: number; coolingTemperature: number };

export type ConfiguredShedAction = ConfiguredShedBehavior['action'];

/** The range a limit may take. The editor's fields use the same numbers. */
export type ShedLimitRange = { readonly minC: number; readonly maxC: number };

export const HEATING_SHED_LIMIT_RANGE: ShedLimitRange = { minC: -20, maxC: 50 };

/**
 * Narrower than the heating range on purpose: a ceiling below any real cooling
 * setpoint would make limiting add load, which is the outcome the second limit
 * exists to prevent.
 */
export const COOLING_SHED_LIMIT_RANGE: ShedLimitRange = { minC: 16, maxC: 40 };

const TURN_OFF: ConfiguredShedBehavior = { action: 'turn_off' };

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const clampToRange = (value: number, range: ShedLimitRange): number => clamp(value, range.minC, range.maxC);

/** Whether a read is the map at all. A caller that gets `false` keeps the map it holds. */
export const isShedBehaviorsSetting = (value: unknown): value is Readonly<Record<string, unknown>> => (
  isObject(value)
);

const readShedBehaviorEntry = (raw: Readonly<Record<string, unknown>>): ConfiguredShedBehavior => {
  if (raw.action === 'set_step') return { action: 'set_step' };
  if (raw.action !== 'set_temperature' || !isFiniteNumber(raw.temperature)) return TURN_OFF;
  return {
    action: 'set_temperature',
    temperature: clampToRange(raw.temperature, HEATING_SHED_LIMIT_RANGE),
    coolingTemperature: isFiniteNumber(raw.coolingTemperature)
      ? clampToRange(raw.coolingTemperature, COOLING_SHED_LIMIT_RANGE)
      : COOLING_SHED_DEFAULT_C,
  };
};

export const readShedBehaviors = (
  setting: Readonly<Record<string, unknown>>,
): Record<string, ConfiguredShedBehavior> => Object.fromEntries(
  Object.entries(setting).flatMap(([deviceId, raw]) => (
    isObject(raw) ? [[deviceId, readShedBehaviorEntry(raw)] as const] : []
  )),
);

/**
 * The device's configured behaviour, always. A device with no entry is turned
 * off — an answer, not a gap, so no caller branches on presence.
 */
export const resolveShedBehavior = (
  behaviors: Readonly<Record<string, ConfiguredShedBehavior>>,
  deviceId: string,
): ConfiguredShedBehavior => {
  // Own keys only: a device id that happens to name an Object.prototype member
  // must not read an inherited function as a behaviour.
  const entry = behaviors[deviceId];
  return Object.hasOwn(behaviors, deviceId) && entry !== undefined ? entry : TURN_OFF;
};

/**
 * Both setpoints the owner configured as limits for this device, or none. For
 * the write fence under "Save as current mode target", which admits either
 * limit because it does not know which way the device is running.
 */
export const shedLimitTemperatures = (behavior: ConfiguredShedBehavior): readonly number[] => (
  behavior.action === 'set_temperature' ? [behavior.temperature, behavior.coolingTemperature] : []
);
