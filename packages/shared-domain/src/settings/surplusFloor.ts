/**
 * The `surplusFloor` field of `price_optimization_settings`: one field, one
 * reader, one writer.
 *
 * It answers a single question — when a device set to match solar surplus can no
 * longer be covered by the sun, does it stop, or keep running at its lowest
 * level and take the shortfall from the grid? There is no level between off and
 * that floor (6 A on an EV charger, so about 1.4 kW on one phase and 4.1 kW on
 * three), which is why the choice exists at all.
 *
 * This module exists because three callers read the field independently — the
 * runtime adapter's validator, the planner's allocator, and the settings UI —
 * and they each did it with their own inline `=== 'minimum' ? … : …`. They
 * agreed, but nothing kept them agreeing: that is exactly the drift
 * `notes/settings-key-ownership.md` was written about, caught here before it
 * had a chance to happen rather than after.
 *
 * The whole `price_optimization_settings` key does not have an owner yet, and
 * giving it one is a larger migration than this field justifies. What is owned
 * here is this field's meaning; the surrounding blob keeps its existing
 * validator until that key gets the same treatment.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

/**
 * What a surplus-tracking device does when its allocation no longer covers its
 * lowest running level.
 *
 * - `'off'` — stop. Nothing is ever imported on this feature's account.
 * - `'minimum'` — hold the lowest level and let the grid cover the gap.
 */
export type SurplusFloorPolicy = 'off' | 'minimum';

/**
 * The conservative reading, and the meaning of absence. Every blob written
 * before this field existed omits it, so the default is load-bearing rather than
 * cosmetic: it must be the option that cannot surprise an owner with grid
 * import they did not ask for.
 */
export const DEFAULT_SURPLUS_FLOOR: SurplusFloorPolicy = 'off';

/**
 * Write policy: REFUSE anything the reader would have to repair. A writer is
 * choosing the bytes and has no excuse for malformed ones.
 */
export const isSurplusFloorPolicy = (value: unknown): value is SurplusFloorPolicy => (
  value === 'off' || value === 'minimum'
);

/**
 * Read policy: SANITIZE AND KEEP. Anything that is not one of the two known
 * values — absent, a stale option name from a future build, junk written through
 * `homey api` — reads as the conservative default rather than failing the read.
 *
 * Failing would be worse than it looks: the blob this field rides in also
 * carries the price-response deltas and the surplus opt-in, so refusing it over
 * an unrecognised floor value would take a device's whole price configuration
 * down with it.
 */
export const readSurplusFloorPolicy = (value: unknown): SurplusFloorPolicy => (
  isSurplusFloorPolicy(value) ? value : DEFAULT_SURPLUS_FLOOR
);
