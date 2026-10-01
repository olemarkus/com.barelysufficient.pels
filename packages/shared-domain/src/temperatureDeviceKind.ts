/**
 * Device-KIND classification for temperature control, shared so the planner
 * (`lib/plan`) and diagnostics branch on these predicates instead of inlining
 * `deviceType` / `deviceClass` literals. Same vocabulary-containment goal as
 * `isEvDevice` (`commandableNow.ts`): the kind vocabulary lives here
 * (browser-safe), and consumers stay abstract — they ask "is this a temperature
 * device?" without knowing the literal values. (Starvation eligibility is
 * resolved by device configuration into `starvationSupported`.)
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
