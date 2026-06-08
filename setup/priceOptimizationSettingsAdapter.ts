import type Homey from 'homey';
import type {
  PriceOptimizationDeviceSettings,
  PriceOptimizationSettingsStore,
} from '../lib/price/priceOptimizationSettingsStore';
import {
  PRICE_MIN_DIFF_ORE,
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_OPTIMIZATION_SETTINGS,
  PRICE_THRESHOLD_PERCENT,
} from '../lib/utils/settingsKeys';

const DEFAULT_THRESHOLD_PERCENT = 25;
const DEFAULT_MIN_DIFF_ORE = 0;

const isPriceOptimizationDeviceSettings = (
  value: unknown,
): value is PriceOptimizationDeviceSettings => {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as { enabled?: unknown; cheapDelta?: unknown; expensiveDelta?: unknown };
    return typeof record.enabled === 'boolean'
      && typeof record.cheapDelta === 'number'
      && typeof record.expensiveDelta === 'number';
  });
};

const readNumberOrDefault = (value: unknown, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

/**
 * Builds the {@link PriceOptimizationSettingsStore}: the sole owner of the
 * `homey.settings` reads for the price-optimization configuration keys plus the
 * validation/defaults that snap persisted garbage to canonical values. The
 * coordinator receives only typed values.
 */
export const createPriceOptimizationSettingsStore = (
  homey: Homey.App['homey'],
): PriceOptimizationSettingsStore => ({
  isEnabled(): boolean {
    return homey.settings.get(PRICE_OPTIMIZATION_ENABLED) !== false;
  },
  readDeviceSettings(): PriceOptimizationDeviceSettings | null {
    const value = homey.settings.get(PRICE_OPTIMIZATION_SETTINGS) as unknown;
    return isPriceOptimizationDeviceSettings(value) ? value : null;
  },
  getThresholdPercent(): number {
    return readNumberOrDefault(homey.settings.get(PRICE_THRESHOLD_PERCENT), DEFAULT_THRESHOLD_PERCENT);
  },
  getMinDiffOre(): number {
    return readNumberOrDefault(homey.settings.get(PRICE_MIN_DIFF_ORE), DEFAULT_MIN_DIFF_ORE);
  },
});
