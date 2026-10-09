/**
 * Resolve validated Price-choice provenance. Each persistence adapter maps a
 * legacy missing field to `true` before calling; only a newly persisted literal
 * `false` identifies a solar-only entry.
 */
export const resolvePriceConfigured = (enabled: boolean, storedValue: boolean): boolean => (
  enabled || storedValue !== false
);

/**
 * The solar-surplus lift, in °C, for an entry that stores none. The settings UI
 * offers it as the starting value and the runtime applies it, so an entry with
 * no stored lift reads the same on both sides.
 */
export const DEFAULT_SURPLUS_LIFT_C = 2;

/** The largest Cheap-hour boost or Expensive-hour reduction any editor accepts, in °C. */
export const MAX_PRICE_ADJUSTMENT_C = 20;

/** Which of a device's two price adjustments an edit sets, as the settings UI labels them. */
export type PriceAdjustmentKind = 'cheap_hour_boost' | 'expensive_hour_reduction';

/**
 * The stored field and value for an adjustment of `sizeC`: the boost positive
 * and the reduction negative, the heating-shaped convention every PELS writer
 * keeps. The reader applies only the size (`lib/thermostat/priceShift.ts`), so
 * the sign is for the bytes. `null` for a size outside 0 to
 * {@link MAX_PRICE_ADJUSTMENT_C}.
 */
export const encodePriceAdjustment = (
  kind: PriceAdjustmentKind,
  sizeC: number,
): { field: 'cheapDelta' | 'expensiveDelta'; value: number } | null => {
  if (!Number.isFinite(sizeC) || sizeC < 0 || sizeC > MAX_PRICE_ADJUSTMENT_C) return null;
  return kind === 'cheap_hour_boost'
    ? { field: 'cheapDelta', value: sizeC }
    : { field: 'expensiveDelta', value: sizeC === 0 ? 0 : -sizeC };
};
