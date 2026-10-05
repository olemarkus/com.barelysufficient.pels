// Noop-write dedupe for settings-change dispatch: writes to these exact keys
// are skipped when the stored value did not actually change since the last
// processed write. Exact-key by design — home-suffixed keys
// (`<base>:<homeId>`, see `parseHomeScopedSettingsKey`) are routed before this
// check runs and never consult it.
import {
  BATTERY_CONTROL_DEVICES,
  BUDGET_EXEMPT_DEVICES,
  RESPECT_EXTERNAL_OFF_DEVICES,
  DEVICE_START_POLICIES,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  CONTROLLABLE_DEVICES,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DEBUG_LOGGING_TOPICS,
  DEVICE_CONTROL_PROFILES,
  DEVICE_DRIVER_OVERRIDES,
  DEVICE_EXPECTED_POWER_OVERRIDES,
  DEVICE_TARGET_POWER_CONFIGS,
  EXPORT_FIXED,
  EXPORT_PRICE_ENABLED,
  EXPORT_SPOT_FACTOR,
  MANAGED_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  NORWAY_PRICE_MODEL,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
  POWERHOUR_DEVICE_ID,
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_OPTIMIZATION_SETTINGS,
  PRICE_SCHEME,
} from './settingsKeys';
import { toStableFingerprint } from './stableFingerprint';

const DEDUPED_CAPACITY_KEYS = [
  'mode_device_targets',
  OPERATING_MODE_SETTING,
  'mode_aliases',
  'capacity_priorities',
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  DEVICE_DRIVER_OVERRIDES,
  // The Flow card and the settings-UI field write the same record, and the Flow
  // card refreshes + replans on its own path. Deduping stops a re-persist of an
  // unchanged record from costing a second snapshot re-parse.
  DEVICE_EXPECTED_POWER_OVERRIDES,
  BUDGET_EXEMPT_DEVICES,
  RESPECT_EXTERNAL_OFF_DEVICES,
  DEVICE_START_POLICIES,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
  BATTERY_CONTROL_DEVICES,
  DEVICE_CONTROL_PROFILES,
  DEVICE_TARGET_POWER_CONFIGS,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  CAPACITY_DRY_RUN,
  OVERSHOOT_BEHAVIORS,
];

const DEDUPED_PRICE_KEYS = [
  PRICE_SCHEME,
  POWERHOUR_DEVICE_ID,
  NORWAY_PRICE_MODEL,
  'provider_surcharge',
  'price_threshold_percent',
  'price_min_diff_ore',
  EXPORT_PRICE_ENABLED,
  EXPORT_SPOT_FACTOR,
  EXPORT_FIXED,
  PRICE_OPTIMIZATION_SETTINGS,
  PRICE_OPTIMIZATION_ENABLED,
];

const DEDUPED_DAILY_BUDGET_KEYS = [
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
];

const DEDUPED_LOGGING_KEYS = ['debug_logging_enabled', DEBUG_LOGGING_TOPICS];

const DEDUPED_WRITE_KEYS = new Set<string>([
  ...DEDUPED_CAPACITY_KEYS,
  ...DEDUPED_PRICE_KEYS,
  ...DEDUPED_DAILY_BUDGET_KEYS,
  ...DEDUPED_LOGGING_KEYS,
]);

export const createSettingsWriteDedupe = (
  readSetting: (key: string) => unknown,
) => {
  const lastProcessedFingerprints = new Map<string, string>();

  return async (key: string, handle: () => Promise<void>): Promise<void> => {
    const fingerprint = DEDUPED_WRITE_KEYS.has(key)
      ? toStableFingerprint(readSetting(key))
      : null;
    if (fingerprint !== null && lastProcessedFingerprints.get(key) === fingerprint) return;
    await handle();
    // A later write may have arrived while the handler awaited refresh/replan.
    // Only acknowledge the value this operation started processing.
    if (fingerprint !== null) {
      lastProcessedFingerprints.set(key, fingerprint);
    }
  };
};
