import type Homey from 'homey';
import CapacityGuard from '../power/capacityGuard';
import type { DailyBudgetUpdateStateOptions } from '../dailyBudget/dailyBudgetTypes';
import type { SettingsUiLogEntry } from '../../packages/contracts/src/types';
import {
  BUDGET_EXEMPT_DEVICES,
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  COMBINED_PRICES,
  CONTROLLABLE_DEVICES,
  DEVICE_CONTROL_PROFILES,
  DEVICE_COMMUNICATION_MODELS,
  DEVICE_DRIVER_OVERRIDES,
  DEVICE_TARGET_POWER_CONFIGS,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DAILY_BUDGET_RESET,
  DEBUG_LOGGING_TOPICS,
  EV_BOOST_SETTINGS,
  FLOW_PRICES_TODAY,
  FLOW_PRICES_TOMORROW,
  HOMEY_PRICES_CURRENCY,
  NORWAY_PRICE_MODEL,
  HOMEY_PRICES_TODAY,
  HOMEY_PRICES_TOMORROW,
  MANAGED_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  OVERSHOOT_BEHAVIORS,
  TEMPERATURE_BOOST_SETTINGS,
  OPERATING_MODE_SETTING,
  POWER_SOURCE,
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_OPTIMIZATION_SETTINGS,
  PRICE_SCHEME,
} from './settingsKeys';
import { incPerfCounters } from './perfCounters';
import { getLogger } from '../logging/logger';
import { normalizeError } from './errorUtils';
import {
  createDebouncedSyncScheduler,
  type DebouncedSyncScheduler,
} from './settingsHandlerDebounce';
import { toStableFingerprint } from './stableFingerprint';

const settingsLogger = getLogger('settings');
export type PriceServiceLike = {
  refreshGridTariffData: (forceRefresh?: boolean) => Promise<void>;
  refreshSpotPrices: (forceRefresh?: boolean) => Promise<void>;
  updateCombinedPrices: () => void;
};

export type SettingsHandlerDeps = {
  homey: Homey.App['homey'];
  loadCapacitySettings: () => void;
  rebuildPlanFromCache: (reason?: string) => Promise<void>;
  refreshTargetDevicesSnapshot: () => Promise<void>;
  loadPowerTracker: () => void;
  getCapacityGuard: () => CapacityGuard | undefined;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityDryRun: () => boolean;
  loadPriceOptimizationSettings: () => void;
  loadDailyBudgetSettings: () => void;
  updateDailyBudgetState: (options?: DailyBudgetUpdateStateOptions) => void;
  resetDailyBudgetLearning: () => void;
  priceService: PriceServiceLike;
  updatePriceOptimizationEnabled: (logChange?: boolean) => void;
  updateOverheadToken: (value?: number) => Promise<void>;
  updateDebugLoggingEnabled: (logChange?: boolean) => void;
  restartHomeyEnergyPoll?: () => void;
};

const DEDUPED_CAPACITY_KEYS = [
  'mode_device_targets',
  OPERATING_MODE_SETTING,
  'mode_aliases',
  'capacity_priorities',
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  DEVICE_DRIVER_OVERRIDES,
  BUDGET_EXEMPT_DEVICES,
  DEVICE_CONTROL_PROFILES,
  DEVICE_TARGET_POWER_CONFIGS,
  DEVICE_COMMUNICATION_MODELS,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_DRY_RUN,
  OVERSHOOT_BEHAVIORS,
];

const DEDUPED_PRICE_KEYS = [
  PRICE_SCHEME,
  FLOW_PRICES_TODAY,
  FLOW_PRICES_TOMORROW,
  HOMEY_PRICES_TODAY,
  HOMEY_PRICES_TOMORROW,
  HOMEY_PRICES_CURRENCY,
  NORWAY_PRICE_MODEL,
  'provider_surcharge',
  'price_threshold_percent',
  'price_min_diff_ore',
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
const DAILY_BUDGET_PRICE_REBUILD_DEBOUNCE_MS = 1000;
const DAILY_BUDGET_SETTINGS_REBUILD_DEBOUNCE_MS = 500;
const FORCE_DAILY_BUDGET_STATE_PERSIST: DailyBudgetUpdateStateOptions = {
  forcePlanRebuild: true,
  persistReason: 'manual',
};

export type SettingsHandler = ((key: string) => Promise<void>) & {
  stop: () => void;
};

const createDailyBudgetPriceSyncScheduler = (deps: SettingsHandlerDeps): DebouncedSyncScheduler => (
  createDebouncedSyncScheduler({
    debounceMs: DAILY_BUDGET_PRICE_REBUILD_DEBOUNCE_MS,
    run: async () => {
      deps.updateDailyBudgetState(FORCE_DAILY_BUDGET_STATE_PERSIST);
      await rebuildPlanFromSettings(deps, 'daily_budget_price');
    },
    onError: (error) => settingsLogger.error({
      event: 'daily_budget_combined_price_sync_failed',
      err: normalizeError(error),
    }),
  })
);

const createDailyBudgetSettingsSyncScheduler = (deps: SettingsHandlerDeps): DebouncedSyncScheduler => (
  createDebouncedSyncScheduler({
    debounceMs: DAILY_BUDGET_SETTINGS_REBUILD_DEBOUNCE_MS,
    rerunAfterRun: 'immediate',
    run: async () => {
      deps.loadDailyBudgetSettings();
      deps.updateDailyBudgetState(FORCE_DAILY_BUDGET_STATE_PERSIST);
      await rebuildPlanFromSettings(deps, 'daily_budget_settings');
    },
    onError: (error) => settingsLogger.error({
      event: 'daily_budget_settings_sync_failed',
      err: normalizeError(error),
    }),
  })
);

const refreshPriceDerivedState = async (deps: SettingsHandlerDeps): Promise<void> => {
  deps.priceService.updateCombinedPrices();
  await handleDailyBudgetPriceChange(deps);
};

type NoopWriteSkipper = {
  shouldSkipNoopWrite: (key: string) => boolean;
  markProcessedWrite: (key: string) => void;
};

type SettingsHandlerMap = Record<string, () => Promise<void>>;
const DAILY_BUDGET_SETTING_KEYS = [
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
] as const;

const buildDailyBudgetSettingsHandlers = (
  scheduleDailyBudgetSettingsSync: () => Promise<void>,
): Pick<SettingsHandlerMap,
  typeof DAILY_BUDGET_SETTING_KEYS[number]
> => Object.fromEntries(DAILY_BUDGET_SETTING_KEYS.map((key) => [
  key,
  async () => {
    void scheduleDailyBudgetSettingsSync();
  },
])) as Pick<SettingsHandlerMap, typeof DAILY_BUDGET_SETTING_KEYS[number]>;

const createNoopWriteSkipper = (deps: SettingsHandlerDeps): NoopWriteSkipper => {
  const lastProcessedFingerprints = new Map<string, string>();

  const readFingerprint = (key: string): string | null => {
    if (!DEDUPED_WRITE_KEYS.has(key)) return null;
    return toStableFingerprint(deps.homey.settings.get(key) as unknown);
  };

  const shouldSkipNoopWrite = (key: string): boolean => {
    const fingerprint = readFingerprint(key);
    if (fingerprint === null) return false;
    return lastProcessedFingerprints.get(key) === fingerprint;
  };

  const markProcessedWrite = (key: string): void => {
    const fingerprint = readFingerprint(key);
    if (fingerprint !== null) {
      lastProcessedFingerprints.set(key, fingerprint);
    }
  };

  return { shouldSkipNoopWrite, markProcessedWrite };
};

export function createSettingsHandler(deps: SettingsHandlerDeps): SettingsHandler {
  const dailyBudgetPriceSyncScheduler = createDailyBudgetPriceSyncScheduler(deps);
  const dailyBudgetSettingsSyncScheduler = createDailyBudgetSettingsSyncScheduler(deps);
  const handlers = buildSettingsHandlers(
    deps,
    () => dailyBudgetPriceSyncScheduler.schedule(),
    () => dailyBudgetSettingsSyncScheduler.schedule(),
  );

  const { shouldSkipNoopWrite, markProcessedWrite } = createNoopWriteSkipper(deps);

  let queue = Promise.resolve();
  const handler = (async (key: string) => {
    const keyHandler = handlers[key];
    if (!keyHandler) return;
    queue = queue.then(async () => {
      if (shouldSkipNoopWrite(key)) return;
      await keyHandler();
      markProcessedWrite(key);
    }).catch((error) => {
      settingsLogger.error({
        event: 'settings_handler_failed',
        settingKey: key,
        err: normalizeError(error),
      });
    });
    await queue;
  }) as SettingsHandler;

  // eslint-disable-next-line functional/immutable-data
  return Object.assign(handler, {
    stop: (): void => {
      dailyBudgetPriceSyncScheduler.stop();
      dailyBudgetSettingsSyncScheduler.stop();
    },
  });
}

function buildSettingsHandlers(
  deps: SettingsHandlerDeps,
  scheduleDailyBudgetPriceSync: () => Promise<void>,
  scheduleDailyBudgetSettingsSync: () => Promise<void>,
): SettingsHandlerMap {
  return {
    ...buildDailyBudgetSettingsHandlers(scheduleDailyBudgetSettingsSync),
    ...buildCapacitySettingsHandlers(deps),
    ...buildPriceSettingsHandlers(deps, scheduleDailyBudgetPriceSync),
    ...buildMiscSettingsHandlers(deps),
  };
}

function buildCapacitySettingsHandlers(deps: SettingsHandlerDeps): SettingsHandlerMap {
  return {
    mode_device_targets: async () => handleModeTargetsChange(deps),
    [OPERATING_MODE_SETTING]: async () => handleModeTargetsChange(deps),
    mode_aliases: async () => deps.loadCapacitySettings(),
    capacity_priorities: async () => {
      deps.loadCapacitySettings();
      await rebuildPlanFromSettings(deps, 'capacity_priorities');
    },
    [CONTROLLABLE_DEVICES]: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'controllable_devices_change');
      await rebuildPlanFromSettings(deps, 'controllable_devices');
    },
    [MANAGED_DEVICES]: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'managed_devices_change');
      await rebuildPlanFromSettings(deps, 'managed_devices');
    },
    [NATIVE_EV_WIRING_DEVICES]: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'native_ev_wiring_change');
      await rebuildPlanFromSettings(deps, NATIVE_EV_WIRING_DEVICES);
    },
    [DEVICE_DRIVER_OVERRIDES]: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'device_driver_override_change');
      await rebuildPlanFromSettings(deps, DEVICE_DRIVER_OVERRIDES);
    },
    [DEVICE_CONTROL_PROFILES]: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'device_control_profile_change');
      await rebuildPlanFromSettings(deps, DEVICE_CONTROL_PROFILES);
    },
    [DEVICE_TARGET_POWER_CONFIGS]: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'device_target_power_change');
      await rebuildPlanFromSettings(deps, DEVICE_TARGET_POWER_CONFIGS);
    },
    [DEVICE_COMMUNICATION_MODELS]: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'device_communication_model_change');
      await rebuildPlanFromSettings(deps, DEVICE_COMMUNICATION_MODELS);
    },
    [BUDGET_EXEMPT_DEVICES]: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'budget_exemption_change');
      deps.updateDailyBudgetState(FORCE_DAILY_BUDGET_STATE_PERSIST);
      await rebuildPlanFromSettings(deps, BUDGET_EXEMPT_DEVICES);
    },
    [TEMPERATURE_BOOST_SETTINGS]: async () => {
      deps.loadCapacitySettings();
      await rebuildPlanFromSettings(deps, TEMPERATURE_BOOST_SETTINGS);
    },
    [EV_BOOST_SETTINGS]: async () => {
      deps.loadCapacitySettings();
      await rebuildPlanFromSettings(deps, EV_BOOST_SETTINGS);
    },
    power_tracker_state: async () => deps.loadPowerTracker(),
    [CAPACITY_LIMIT_KW]: async () => handleCapacityLimitChange(deps),
    [CAPACITY_MARGIN_KW]: async () => handleCapacityLimitChange(deps),
    [CAPACITY_DRY_RUN]: async () => {
      deps.loadCapacitySettings();
      await rebuildPlanFromSettings(deps, 'capacity_dry_run');
    },
    [OVERSHOOT_BEHAVIORS]: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'overshoot_behavior_change');
      await rebuildPlanFromSettings(deps, OVERSHOOT_BEHAVIORS);
    },
    refresh_target_devices_snapshot: async () => {
      await refreshSnapshotWithLog(deps, 'manual_snapshot_refresh');
    },
  };
}

function buildPriceSettingsHandlers(
  deps: SettingsHandlerDeps,
  scheduleDailyBudgetPriceSync: () => Promise<void>,
): SettingsHandlerMap {
  return {
    refresh_nettleie: async () => {
      try {
        await deps.priceService.refreshGridTariffData(true);
      } catch (error) {
        settingsLogger.error({
          event: 'grid_tariff_refresh_failed',
          err: normalizeError(error),
        });
      }
    },
    refresh_spot_prices: async () => {
      try {
        await deps.priceService.refreshSpotPrices(true);
      } catch (error) {
        settingsLogger.error({
          event: 'spot_prices_refresh_failed',
          err: normalizeError(error),
        });
      }
    },
    [PRICE_SCHEME]: async () => {
      await refreshPriceDerivedState(deps);
    },
    [FLOW_PRICES_TODAY]: async () => {
      await refreshPriceDerivedState(deps);
    },
    [FLOW_PRICES_TOMORROW]: async () => {
      await refreshPriceDerivedState(deps);
    },
    [HOMEY_PRICES_TODAY]: async () => {
      await refreshPriceDerivedState(deps);
    },
    [HOMEY_PRICES_TOMORROW]: async () => {
      await refreshPriceDerivedState(deps);
    },
    [HOMEY_PRICES_CURRENCY]: async () => {
      await refreshPriceDerivedState(deps);
    },
    [NORWAY_PRICE_MODEL]: async () => {
      await refreshPriceDerivedState(deps);
    },
    provider_surcharge: async () => refreshPriceDerivedState(deps),
    price_threshold_percent: async () => refreshPriceDerivedState(deps),
    price_min_diff_ore: async () => refreshPriceDerivedState(deps),
    [PRICE_OPTIMIZATION_SETTINGS]: async () => {
      deps.loadPriceOptimizationSettings();
      await refreshSnapshotWithLog(deps, 'price_optimization_settings_change');
    },
    [COMBINED_PRICES]: async () => {
      void scheduleDailyBudgetPriceSync();
    },
    [POWER_SOURCE]: async () => handlePowerSourceChange(deps),
    [PRICE_OPTIMIZATION_ENABLED]: async () => {
      deps.updatePriceOptimizationEnabled(true);
      deps.updateDailyBudgetState(FORCE_DAILY_BUDGET_STATE_PERSIST);
      await rebuildPlanFromSettings(deps, 'price_optimization_enabled');
    },
  };
}

function buildMiscSettingsHandlers(deps: SettingsHandlerDeps): SettingsHandlerMap {
  return {
    [DAILY_BUDGET_RESET]: async () => {
      deps.resetDailyBudgetLearning();
      deps.updateDailyBudgetState(FORCE_DAILY_BUDGET_STATE_PERSIST);
      deps.homey.settings.set(DAILY_BUDGET_RESET, null);
      await rebuildPlanFromSettings(deps, 'daily_budget_reset');
    },
    debug_logging_enabled: async () => deps.updateDebugLoggingEnabled(true),
    [DEBUG_LOGGING_TOPICS]: async () => deps.updateDebugLoggingEnabled(true),
    settings_ui_log: async () => handleSettingsUiLog(deps),
  };
}

const settingsUiLogLevelMethod = (level: SettingsUiLogEntry['level']): 'error' | 'warn' | 'info' => {
  if (level === 'error') return 'error';
  return level === 'warn' ? 'warn' : 'info';
};

const handleSettingsUiLog = async (deps: SettingsHandlerDeps): Promise<void> => {
  const raw = deps.homey.settings.get('settings_ui_log') as unknown;
  if (!raw || typeof raw !== 'object') return;
  const entry = raw as SettingsUiLogEntry;
  if (!entry.level || !entry.message) return;

  settingsLogger[settingsUiLogLevelMethod(entry.level)]({
    event: 'settings_ui_log',
    level: entry.level,
    message: entry.message,
    detail: entry.detail ?? null,
    context: entry.context ?? null,
  });

  deps.homey.settings.set('settings_ui_log', null);
};

async function handleModeTargetsChange(deps: SettingsHandlerDeps): Promise<void> {
  deps.loadCapacitySettings();
  try {
    await deps.refreshTargetDevicesSnapshot();
    await rebuildPlanFromSettings(deps, 'mode_targets');
  } catch (error) {
    settingsLogger.error({
      event: 'mode_targets_snapshot_refresh_failed',
      err: normalizeError(error),
    });
    await rebuildPlanFromSettings(deps, 'mode_targets_fallback');
  }
}

async function handleCapacityLimitChange(deps: SettingsHandlerDeps): Promise<void> {
  deps.loadCapacitySettings();
  const guard = deps.getCapacityGuard();
  const { limitKw, marginKw } = deps.getCapacitySettings();
  guard?.setLimit(limitKw);
  guard?.setSoftMargin(marginKw);
  await deps.updateOverheadToken(marginKw);
  deps.updateDailyBudgetState(FORCE_DAILY_BUDGET_STATE_PERSIST);
  await rebuildPlanFromSettings(deps, 'capacity_limit_or_margin');
}

async function handleDailyBudgetPriceChange(deps: SettingsHandlerDeps): Promise<void> {
  deps.updateDailyBudgetState(FORCE_DAILY_BUDGET_STATE_PERSIST);
  await rebuildPlanFromSettings(deps, 'daily_budget_price');
}

async function handlePowerSourceChange(deps: SettingsHandlerDeps): Promise<void> {
  settingsLogger.info({ event: 'power_source_changed' });
  deps.restartHomeyEnergyPoll?.();
  await refreshSnapshotWithLog(deps, 'power_source_change');
  await rebuildPlanFromSettings(deps, 'power_source');
}

function recordSettingsRebuildRequest(source: string): void {
  incPerfCounters([
    'plan_rebuild_requested_total',
    'plan_rebuild_requested.settings_total',
    `plan_rebuild_requested.settings.${source}_total`,
  ]);
}

async function rebuildPlanFromSettings(deps: SettingsHandlerDeps, source: string): Promise<void> {
  recordSettingsRebuildRequest(source);
  await deps.rebuildPlanFromCache(`settings:${source}`);
}

async function refreshSnapshotWithLog(deps: SettingsHandlerDeps, reasonCode: string): Promise<void> {
  try {
    await deps.refreshTargetDevicesSnapshot();
  } catch (error) {
    settingsLogger.error({
      event: 'settings_snapshot_refresh_failed',
      reasonCode,
      err: normalizeError(error),
    });
  }
}
