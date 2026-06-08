import type { PriceOptimizationSettings } from './priceOptimizer';

export type PriceOptimizationDeviceSettings = Record<string, PriceOptimizationSettings>;

/**
 * Domain-owned read boundary for the price-optimization *configuration* keys:
 * the global enabled toggle, the per-device cheap/expensive deltas, and the
 * threshold / min-diff scalars. Consumers depend on this type, never on
 * `homey.settings` — the adapter owns the raw reads + normalization (guarding
 * persisted garbage and applying canonical defaults), so the coordinator only
 * ever sees typed values.
 *
 * `readDeviceSettings` returns `null` when the persisted blob fails validation,
 * letting the caller keep its last-known-good map rather than dropping it (the
 * historical `loadPriceOptimizationSettings` semantics). The combined-prices
 * *state* blob is a separate seam and not owned here.
 */
export type PriceOptimizationSettingsStore = {
  isEnabled(): boolean;
  readDeviceSettings(): PriceOptimizationDeviceSettings | null;
  getThresholdPercent(): number;
  getMinDiffOre(): number;
};
