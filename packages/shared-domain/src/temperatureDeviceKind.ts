/**
 * Device-KIND classification for temperature control, shared so the planner
 * (`lib/plan`) and diagnostics branch on these predicates instead of inlining
 * `deviceType` / `deviceClass` literals. Same vocabulary-containment goal as
 * `isEvDevice` (`commandableNow.ts`): the kind vocabulary lives here
 * (browser-safe), and consumers stay abstract — they ask "is this a temperature
 * device / a starvation-eligible class?" without knowing the literal values.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

/**
 * A device PELS drives by writing a temperature setpoint. Keyed on the resolved
 * `deviceType` modality (`'temperature'`), NOT on a device class — a thermostat,
 * heat pump, or air-treatment unit are all temperature devices.
 */
export const isTemperatureControlDevice = (
  dev: { deviceType?: string | null } | null | undefined,
): boolean => dev?.deviceType === 'temperature';

/**
 * Thermostat-family device classes whose "held below target" condition PELS
 * surfaces as a starvation diagnostic. Owned here (not in `lib/plan`) so the
 * planner reads the predicate, never the class set.
 */
const STARVATION_SUPPORTED_DEVICE_CLASSES: ReadonlySet<string> = new Set([
  'thermostat',
  'heater',
  'heatpump',
  'airconditioning',
  'airtreatment',
]);

/** Whether a device class is one PELS reports starvation for. Case-insensitive. */
export const isStarvationSupportedDeviceClass = (deviceClass: string | null | undefined): boolean => (
  STARVATION_SUPPORTED_DEVICE_CLASSES.has((deviceClass ?? '').trim().toLowerCase())
);
