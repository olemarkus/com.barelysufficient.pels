import type { SettingsPort } from '../ports/homeyRuntime';
import {
  PRICE_MIN_DIFF_ORE,
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_OPTIMIZATION_SETTINGS,
  PRICE_THRESHOLD_PERCENT,
} from '../utils/settingsKeys';
import type { PriceOptimizationSettings } from './priceOptimizer';

export type PriceOptimizationDeviceSettings = Record<string, PriceOptimizationSettings>;

/**
 * Domain-owned read boundary for the price-optimization *configuration* keys:
 * the global enabled toggle, the per-device cheap/expensive deltas, and the
 * threshold / min-diff scalars. Consumers depend on this type, never on
 * `homey.settings` — {@link createPriceOptimizationSettingsStore} below owns
 * the raw reads + normalization (guarding persisted garbage and applying
 * canonical defaults), so the coordinator only ever sees typed values.
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

const DEFAULT_THRESHOLD_PERCENT = 25;
const DEFAULT_MIN_DIFF_ORE = 0;

const isPriceOptimizationDeviceSettings = (
  value: unknown,
): value is PriceOptimizationDeviceSettings => {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as {
      enabled?: unknown; cheapDelta?: unknown; expensiveDelta?: unknown;
      surplusWilling?: unknown; surplusDelta?: unknown;
    };
    // Require FINITE deltas: typeof NaN/Infinity === 'number', and a NaN delta
    // poisons the planned setpoint (NaN <= 0 is false, so it survives the apply
    // guard and propagates through Math.max to the executor).
    return typeof record.enabled === 'boolean'
      && Number.isFinite(record.cheapDelta)
      && Number.isFinite(record.expensiveDelta)
      // Surplus-absorb fields are optional (older blobs / non-solar homes omit them).
      && (record.surplusWilling === undefined || typeof record.surplusWilling === 'boolean')
      && (record.surplusDelta === undefined || Number.isFinite(record.surplusDelta));
  });
};

const readNumberOrDefault = (value: unknown, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

/**
 * The settings-backed {@link PriceOptimizationSettingsStore}: the sole owner of
 * the reads for the price-optimization configuration keys plus the validation
 * and defaults that snap persisted garbage to canonical values. It lives here
 * rather than in `setup/` because deciding that a non-finite `cheapDelta` is
 * garbage is a price-domain judgement, not wiring.
 */
export const createPriceOptimizationSettingsStore = (
  settings: SettingsPort,
): PriceOptimizationSettingsStore => ({
  isEnabled(): boolean {
    return settings.get(PRICE_OPTIMIZATION_ENABLED) !== false;
  },
  readDeviceSettings(): PriceOptimizationDeviceSettings | null {
    const value = settings.get(PRICE_OPTIMIZATION_SETTINGS);
    return isPriceOptimizationDeviceSettings(value) ? value : null;
  },
  getThresholdPercent(): number {
    return readNumberOrDefault(settings.get(PRICE_THRESHOLD_PERCENT), DEFAULT_THRESHOLD_PERCENT);
  },
  getMinDiffOre(): number {
    return readNumberOrDefault(settings.get(PRICE_MIN_DIFF_ORE), DEFAULT_MIN_DIFF_ORE);
  },
});
