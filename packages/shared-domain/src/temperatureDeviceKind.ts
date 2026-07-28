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

/**
 * Device classes for which LOWERING the setpoint may ADD load (compressor work
 * in cooling mode), so the heat-device rule "raise = more load" does not hold.
 * PELS cannot observe whether a reversible unit is currently heating or
 * cooling — the class is the only signal — so consumers that gate load-adding
 * setpoint changes must treat BOTH directions as potentially load-adding here.
 *
 * `thermostat` is in the set because it is AMBIGUOUS, not because it cools:
 * many heat pumps register under the generic thermostat class (the repo's own
 * e2e fixture models one), and a class that cannot prove heat-only must
 * fail closed for a load-adding write. Only `heater` remains single-direction:
 * it is the one class that promises heating-only hardware.
 */
const COOLING_CAPABLE_DEVICE_CLASSES: ReadonlySet<string> = new Set([
  'heatpump',
  'airconditioning',
  'airtreatment',
  'thermostat',
]);

/** Whether a device class may add load when its setpoint is lowered. Case-insensitive. */
export const isCoolingCapableTemperatureDeviceClass = (deviceClass: string | null | undefined): boolean => (
  COOLING_CAPABLE_DEVICE_CLASSES.has((deviceClass ?? '').trim().toLowerCase())
);
