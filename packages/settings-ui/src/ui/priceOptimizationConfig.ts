import { resolvePriceConfigured } from '../../../shared-domain/src/settings/priceOptimization.ts';

/**
 * Fully resolved settings-UI state for one device's Price and solar choices.
 * Persisted legacy omissions are classified by this module before consumers
 * receive the value; inward code never interprets field presence.
 */
export type PriceOptimizationConfig = {
  enabled: boolean;
  cheapDelta: number;
  expensiveDelta: number;
  /** The owner explicitly changed a Price control, including choosing Off. */
  priceConfigured: boolean;
  surplusWilling: boolean;
  surplusDelta: number;
};

export const DEFAULT_PRICE_OPTIMIZATION_CONFIG: PriceOptimizationConfig = {
  enabled: false,
  cheapDelta: 5,
  expensiveDelta: -5,
  priceConfigured: false,
  surplusWilling: false,
  surplusDelta: 2,
};

export type PriceOptimizationConfigMapRead =
  | { state: 'resolved'; settings: Record<string, PriceOptimizationConfig> }
  | { state: 'unavailable' };

type PriceOptimizationConfigRead =
  | { state: 'resolved'; config: PriceOptimizationConfig }
  | { state: 'unavailable' };

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const classifyEntry = (value: unknown): PriceOptimizationConfigRead => {
  if (!isRecord(value)
    || typeof value.enabled !== 'boolean'
    || !isFiniteNumber(value.cheapDelta)
    || !isFiniteNumber(value.expensiveDelta)) return { state: 'unavailable' };
  if (value.priceConfigured !== undefined && typeof value.priceConfigured !== 'boolean') {
    return { state: 'unavailable' };
  }
  if (value.surplusWilling !== undefined && typeof value.surplusWilling !== 'boolean') {
    return { state: 'unavailable' };
  }
  if (value.surplusDelta !== undefined && !isFiniteNumber(value.surplusDelta)) {
    return { state: 'unavailable' };
  }
  const storedPriceConfigured = typeof value.priceConfigured === 'boolean'
    ? value.priceConfigured
    : true;
  return {
    state: 'resolved',
    config: {
      enabled: value.enabled,
      cheapDelta: value.cheapDelta,
      expensiveDelta: value.expensiveDelta,
      priceConfigured: resolvePriceConfigured(value.enabled, storedPriceConfigured),
      surplusWilling: value.surplusWilling === true,
      surplusDelta: typeof value.surplusDelta === 'number' ? value.surplusDelta : 2,
    },
  };
};

/** Classify and fully resolve the persisted settings map at the Homey settings boundary. */
export const classifyPriceOptimizationConfigMap = (value: unknown): PriceOptimizationConfigMapRead => {
  if (!isRecord(value)) return { state: 'unavailable' };
  const settings: Record<string, PriceOptimizationConfig> = {};
  for (const [deviceId, rawEntry] of Object.entries(value)) {
    const read = classifyEntry(rawEntry);
    if (read.state === 'unavailable') return read;
    settings[deviceId] = read.config;
  }
  return { state: 'resolved', settings };
};
