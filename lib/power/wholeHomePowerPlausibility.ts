/**
 * The widest whole-home reading PELS accepts as a measurement.
 *
 * A home on a 3 × 125 A, 400 V supply draws under 90 kW, and a farm or small
 * business on a larger fuse stays well inside this bound. A reading past it in
 * either direction (import or export) is a meter or scaling fault, such as an
 * app reporting mW or a corrupted frame. Taken as a reading, one such sample
 * fills the hour's energy bucket and sheds every managed device.
 *
 * Both producers of whole-home samples drop such a reading at their boundary
 * (the Homey Energy read and the report-power Flow card), so it never reaches
 * the tracker. To the rest of PELS it is a missing sample: the last accepted
 * reading stays, and a meter that keeps sending them goes silent under the
 * usual meter-silence policy (`lib/power/meterSilence.ts`).
 */
export const MAX_PLAUSIBLE_WHOLE_HOME_POWER_W = 250_000;

/** Whether a finite whole-home reading in W is inside the plausible range. */
export const isPlausibleWholeHomePowerW = (powerW: number): boolean => (
  Math.abs(powerW) <= MAX_PLAUSIBLE_WHOLE_HOME_POWER_W
);
