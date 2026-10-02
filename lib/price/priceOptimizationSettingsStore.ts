import type { SettingsPort } from '../ports/homeyRuntime';
import {
  PRICE_MIN_DIFF_ORE,
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_OPTIMIZATION_SETTINGS,
  PRICE_THRESHOLD_PERCENT,
} from '../utils/settingsKeys';
import type { PriceOptimizationSetupRead } from '../../packages/contracts/src/priceOptimizationSettings';
import {
  encodePriceAdjustment,
  resolvePriceConfigured,
  type PriceAdjustmentKind,
} from '../../packages/shared-domain/src/settings/priceOptimization';
import type { PriceOptimizationSettings } from './priceOptimizer';

export type PriceOptimizationDeviceSetting = PriceOptimizationSettings & {
  priceConfigured: boolean;
};

export type PriceOptimizationDeviceSettings = Record<string, PriceOptimizationDeviceSetting>;

export type PriceOptimizationDeviceSettingsRead =
  | { state: 'resolved'; settings: PriceOptimizationDeviceSettings }
  | { state: 'unavailable' };

type PriceOptimizationDeviceSettingRead =
  | { state: 'resolved'; setting: PriceOptimizationDeviceSetting }
  | { state: 'unavailable' };

/**
 * Domain-owned read boundary for the price-optimization *configuration* keys:
 * the global enabled toggle, the per-device cheap/expensive deltas, and the
 * threshold / min-diff scalars. Consumers depend on this type, never on
 * `homey.settings` — {@link createPriceOptimizationSettingsStore} below owns
 * the raw reads + normalization (guarding persisted garbage and applying
 * canonical defaults), so the coordinator only ever sees typed values.
 *
 * An unavailable persisted blob is named explicitly, letting the caller keep
 * its last-known-good map rather than dropping it (the historical
 * `loadPriceOptimizationSettings` semantics). The combined-prices *state* blob
 * is a separate seam and not owned here.
 */
export type PriceOptimizationSettingsStore = {
  isEnabled(): boolean;
  readDeviceSettings(): PriceOptimizationDeviceSettingsRead;
  readSetup(): PriceOptimizationSetupRead;
  getThresholdPercent(): number;
  getMinDiffOre(): number;
};

const DEFAULT_THRESHOLD_PERCENT = 25;
const DEFAULT_MIN_DIFF_ORE = 0;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const classifyDeviceSetting = (value: unknown): PriceOptimizationDeviceSettingRead => {
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
    setting: {
      enabled: value.enabled,
      cheapDelta: value.cheapDelta,
      expensiveDelta: value.expensiveDelta,
      priceConfigured: resolvePriceConfigured(value.enabled, storedPriceConfigured),
      surplusWilling: value.surplusWilling === true,
      surplusDelta: typeof value.surplusDelta === 'number' ? value.surplusDelta : 0,
    },
  };
};

const classifyDeviceSettings = (value: unknown): PriceOptimizationDeviceSettingsRead => {
  if (!isRecord(value)) return { state: 'unavailable' };
  return Object.entries(value).reduce<PriceOptimizationDeviceSettingsRead>((result, [deviceId, rawConfig]) => {
    if (result.state === 'unavailable') return result;
    const entryRead = classifyDeviceSetting(rawConfig);
    if (entryRead.state === 'unavailable') return entryRead;
    return { state: 'resolved', settings: { ...result.settings, [deviceId]: entryRead.setting } };
  }, { state: 'resolved', settings: {} });
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
  readDeviceSettings(): PriceOptimizationDeviceSettingsRead {
    try {
      return classifyDeviceSettings(settings.get(PRICE_OPTIMIZATION_SETTINGS));
    } catch {
      return { state: 'unavailable' };
    }
  },
  readSetup(): PriceOptimizationSetupRead {
    try {
      const keys = settings.getKeys();
      // PELS always owns settings keys. An empty inventory is the SDK's
      // transient unreadable-store spelling, never proof of a fresh install.
      if (keys.length === 0) return { state: 'unavailable' };

      const enabled = keys.includes(PRICE_OPTIMIZATION_ENABLED)
        ? settings.get(PRICE_OPTIMIZATION_ENABLED)
        : true;
      if (typeof enabled !== 'boolean') return { state: 'unavailable' };

      if (!keys.includes(PRICE_OPTIMIZATION_SETTINGS)) {
        return {
          state: 'resolved',
          setup: { enabled, configuredDeviceIds: [], solarSurplusDeviceIds: [] },
        };
      }

      const deviceSettings = classifyDeviceSettings(settings.get(PRICE_OPTIMIZATION_SETTINGS));
      if (deviceSettings.state === 'unavailable') return deviceSettings;
      const entries = Object.entries(deviceSettings.settings);
      return {
        state: 'resolved',
        setup: {
          enabled,
          configuredDeviceIds: entries
            .filter(([, config]) => config.priceConfigured)
            .map(([deviceId]) => deviceId),
          solarSurplusDeviceIds: entries
            .filter(([, config]) => config.surplusWilling === true)
            .map(([deviceId]) => deviceId),
        },
      };
    } catch {
      return { state: 'unavailable' };
    }
  },
  getThresholdPercent(): number {
    return readNumberOrDefault(settings.get(PRICE_THRESHOLD_PERCENT), DEFAULT_THRESHOLD_PERCENT);
  },
  getMinDiffOre(): number {
    return readNumberOrDefault(settings.get(PRICE_MIN_DIFF_ORE), DEFAULT_MIN_DIFF_ORE);
  },
});

export type DevicePriceAdjustmentWrite =
  | 'written' | 'unchanged' | 'out_of_range' | 'price_control_off' | 'unavailable';

/**
 * Saves one of a device's price adjustments, as the device's Price response
 * fields do, encoded by the key's shared owner (`encodePriceAdjustment`).
 *
 * Only while Price-based control is on for the device, which is when the
 * settings UI lets the owner edit these fields. A device with no price
 * settings at all is the same answer: creating an entry would also decide
 * whether price-based control is on, a different setting than this edit names.
 * Every other device's entry is written back exactly as it was read.
 */
export function writeDevicePriceAdjustment(
  settings: SettingsPort,
  deviceId: string,
  kind: PriceAdjustmentKind,
  sizeC: number,
): DevicePriceAdjustmentWrite {
  const encoded = encodePriceAdjustment(kind, sizeC);
  if (encoded === null) return 'out_of_range';
  let raw: unknown;
  try {
    raw = settings.get(PRICE_OPTIMIZATION_SETTINGS);
    if (raw === null || raw === undefined) {
      const keys = settings.getKeys();
      // An empty key list is the SDK's transient unreadable-store answer.
      return keys.length > 0 && !keys.includes(PRICE_OPTIMIZATION_SETTINGS) ? 'price_control_off' : 'unavailable';
    }
  } catch {
    return 'unavailable';
  }
  const read = classifyDeviceSettings(raw);
  if (read.state === 'unavailable' || !isRecord(raw)) return 'unavailable';
  const entry = raw[deviceId];
  if (!Object.hasOwn(read.settings, deviceId) || !isRecord(entry) || !read.settings[deviceId]?.enabled) {
    return 'price_control_off';
  }
  if (entry[encoded.field] === encoded.value) return 'unchanged';
  settings.set(PRICE_OPTIMIZATION_SETTINGS, { ...raw, [deviceId]: { ...entry, [encoded.field]: encoded.value } });
  return 'written';
}
