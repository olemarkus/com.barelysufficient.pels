/**
 * Resolution-in-producer helper for the per-device minimum run time (the
 * "anti-cycle hold"). The app producer (`app.ts` `getDeviceMinRunMinutes`)
 * calls this once per device; the planner consumes only the flat
 * `number | undefined` result and must never branch on the global
 * toggle/default itself.
 *
 * Precedence:
 *   1. An explicit per-device override ALWAYS wins — including `0`, which is the
 *      deliberate per-device opt-out (legacy grace).
 *   2. Otherwise the global default applies, but only while the admission toggle
 *      is on.
 *   3. Toggle off (or no default) ⇒ `undefined` ⇒ legacy 3-minute grace
 *      downstream.
 *
 * `0` and `undefined` both mean "legacy behaviour" to the planner, so the
 * feature is byte-identical to today when unset/off.
 */
export function resolveEffectiveMinRunMinutes(params: {
  deviceOverride: number | undefined;
  energyBudgetAdmissionEnabled: boolean;
  defaultMinRunMinutes: number | undefined;
}): number | undefined {
  const { deviceOverride, energyBudgetAdmissionEnabled, defaultMinRunMinutes } = params;
  if (deviceOverride !== undefined) return deviceOverride;
  return energyBudgetAdmissionEnabled ? defaultMinRunMinutes : undefined;
}
