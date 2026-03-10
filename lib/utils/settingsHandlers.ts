import Homey from 'homey';
import CapacityGuard from '../core/capacityGuard';
import type { SettingsUiLogEntry } from './types';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  COMBINED_PRICES,
  CONTROLLABLE_DEVICES,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DAILY_BUDGET_RESET,
  DEBUG_LOGGING_TOPICS,
  EXPERIMENTAL_EV_SUPPORT_ENABLED,
  FLOW_PRICES_TODAY,
  FLOW_PRICES_TOMORROW,
  HOMEY_PRICES_CURRENCY,
  NORWAY_PRICE_MODEL,
  HOMEY_PRICES_TODAY,
  HOMEY_PRICES_TOMORROW,
  MANAGED_DEVICES,
  OVERSHOOT_BEHAVIORS,
  OPERATING_MODE_SETTING,
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_OPTIMIZATION_SETTINGS,
  PRICE_SCHEME,
} from './settingsKeys';
import { incPerfCounters } from './perfCounters';
import { toStableFingerprint } from './stableFingerprint';
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
  updateDailyBudgetState: (options?: { forcePlanRebuild?: boolean }) => void;
  resetDailyBudgetLearning: () => void;
  priceService: PriceServiceLike;
  updatePriceOptimizationEnabled: (logChange?: boolean) => void;
  updateOverheadToken: (value?: number) => Promise<void>;
  updateDebugLoggingEnabled: (logChange?: boolean) => void;
  getExperimentalEvSupportEnabled: () => boolean;
  disableManagedEvDevices: () => void;
  log: (message: string) => void;
  errorLog: (message: string, error: unknown) => void;
};

const DEDUPED_CAPACITY_KEYS = [
  'mode_device_targets',
  OPERATING_MODE_SETTING,
  'mode_aliases',
  'capacity_priorities',
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  EXPERIMENTAL_EV_SUPPORT_ENABLED,
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

const DEDUPED_LOGGING_KEYS = [
  'debug_logging_enabled',
  DEBUG_LOGGING_TOPICS,
];

const DEDUPED_WRITE_KEYS = new Set<string>([
  ...DEDUPED_CAPACITY_KEYS,
  ...DEDUPED_PRICE_KEYS,
  ...DEDUPED_DAILY_BUDGET_KEYS,
  ...DEDUPED_LOGGING_KEYS,
]);
const DAILY_BUDGET_PRICE_REBUILD_DEBOUNCE_MS = 1000;
const DAILY_BUDGET_SETTINGS_REBUILD_DEBOUNCE_MS = 500;

type DebouncedSyncSchedulerParams = {
  debounceMs: number;
  rerunAfterRun?: 'debounce' | 'immediate';
  run: () => Promise<void>;
  onError: (error: unknown) => void;
};

type DebouncedSyncScheduler = {
  schedule: () => Promise<void>;
  stop: () => void;
};

const createDebouncedSyncScheduler = (
  params: DebouncedSyncSchedulerParams,
): DebouncedSyncScheduler => {
  const {
    debounceMs,
    rerunAfterRun = 'debounce',
    run,
    onError,
  } = params;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let rerunRequested = false;
  let pendingRun: Promise<void> | null = null;
  let resolvePendingRun: (() => void) | null = null;

  const ensurePendingRun = (): Promise<void> => {
    if (!pendingRun) {
      pendingRun = new Promise((resolve) => {
        resolvePendingRun = resolve;
      });
    }
    return pendingRun;
  };

  const finishPendingRun = (): void => {
    const resolve = resolvePendingRun;
    resolvePendingRun = null;
    pendingRun = null;
    resolve?.();
  };

  const executeRun = (): void => {
    timer = null;
    running = true;
    void Promise.resolve()
      .then(() => run())
      .catch((error) => onError(error))
      .finally(() => {
        running = false;
        if (rerunRequested) {
          rerunRequested = false;
          if (rerunAfterRun === 'immediate') {
            executeRun();
            return;
          }
          scheduleRun();
          return;
        }
        finishPendingRun();
      });
  };

  const scheduleRun = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      executeRun();
    }, debounceMs);
  };

  return {
    schedule: (): Promise<void> => {
      const promise = ensurePendingRun();
      if (running) {
        rerunRequested = true;
        return promise;
      }
      scheduleRun();
      return promise;
    },
    stop: (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      rerunRequested = false;
      finishPendingRun();
    },
  };
};

export type SettingsHandler = ((key: string) => Promise<void>) & {
  stop: () => void;
};

const createDailyBudgetPriceSyncScheduler = (deps: SettingsHandlerDeps): DebouncedSyncScheduler => (
  createDebouncedSyncScheduler({
    debounceMs: DAILY_BUDGET_PRICE_REBUILD_DEBOUNCE_MS,
    run: async () => {
      deps.updateDailyBudgetState({ forcePlanRebuild: true });
      await rebuildPlanFromSettings(deps, 'daily_budget_price');
    },
    onError: (error) => deps.errorLog('Failed to sync daily budget state after combined price update', error),
  })
);

const createDailyBudgetSettingsSyncScheduler = (deps: SettingsHandlerDeps): DebouncedSyncScheduler => (
  createDebouncedSyncScheduler({
    debounceMs: DAILY_BUDGET_SETTINGS_REBUILD_DEBOUNCE_MS,
    rerunAfterRun: 'immediate',
    run: async () => {
      deps.loadDailyBudgetSettings();
      deps.updateDailyBudgetState({ forcePlanRebuild: true });
      await rebuildPlanFromSettings(deps, 'daily_budget_settings');
    },
    onError: (error) => deps.errorLog('Failed to sync daily budget settings', error),
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

const buildDailyBudgetSettingsHandlers = (
  scheduleDailyBudgetSettingsSync: () => Promise<void>,
): Pick<SettingsHandlerMap,
  typeof DAILY_BUDGET_ENABLED
  | typeof DAILY_BUDGET_KWH
  | typeof DAILY_BUDGET_PRICE_SHAPING_ENABLED
  | typeof DAILY_BUDGET_CONTROLLED_WEIGHT
  | typeof DAILY_BUDGET_PRICE_FLEX_SHARE
> => ({
  [DAILY_BUDGET_ENABLED]: async () => {
    void scheduleDailyBudgetSettingsSync();
  },
  [DAILY_BUDGET_KWH]: async () => {
    void scheduleDailyBudgetSettingsSync();
  },
  [DAILY_BUDGET_PRICE_SHAPING_ENABLED]: async () => {
    void scheduleDailyBudgetSettingsSync();
  },
  [DAILY_BUDGET_CONTROLLED_WEIGHT]: async () => {
    void scheduleDailyBudgetSettingsSync();
  },
  [DAILY_BUDGET_PRICE_FLEX_SHARE]: async () => {
    void scheduleDailyBudgetSettingsSync();
  },
});

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
      deps.errorLog('Settings handler failed', error);
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
    mode_device_targets: async () => handleModeTargetsChange(deps),
    [OPERATING_MODE_SETTING]: async () => handleModeTargetsChange(deps),
    mode_aliases: async () => deps.loadCapacitySettings(),
    capacity_priorities: async () => {
      deps.loadCapacitySettings();
      await rebuildPlanFromSettings(deps, 'capacity_priorities');
    },
    [CONTROLLABLE_DEVICES]: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'Failed to refresh devices after controllable change');
      await rebuildPlanFromSettings(deps, 'controllable_devices');
    },
    [MANAGED_DEVICES]: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'Failed to refresh devices after managed change');
      await rebuildPlanFromSettings(deps, 'managed_devices');
    },
    [EXPERIMENTAL_EV_SUPPORT_ENABLED]: async () => {
      deps.loadCapacitySettings();
      if (!deps.getExperimentalEvSupportEnabled()) {
        deps.disableManagedEvDevices();
      }
      await refreshSnapshotWithLog(deps, 'Failed to refresh devices after EV support change');
      await rebuildPlanFromSettings(deps, EXPERIMENTAL_EV_SUPPORT_ENABLED);
    },
    power_tracker_state: async () => deps.loadPowerTracker(),
    [CAPACITY_LIMIT_KW]: async () => handleCapacityLimitChange(deps),
    [CAPACITY_MARGIN_KW]: async () => handleCapacityLimitChange(deps),
    [CAPACITY_DRY_RUN]: async () => {
      deps.loadCapacitySettings();
      await rebuildPlanFromSettings(deps, 'capacity_dry_run');
    },
    refresh_target_devices_snapshot: async () => {
      await refreshSnapshotWithLog(deps, 'Failed to refresh target devices snapshot');
    },
    refresh_nettleie: async () => {
      try {
        await deps.priceService.refreshGridTariffData(true);
      } catch (error) {
        deps.errorLog('Failed to refresh grid tariff data', error);
      }
    },
    refresh_spot_prices: async () => {
      try {
        await deps.priceService.refreshSpotPrices(true);
      } catch (error) {
        deps.errorLog('Failed to refresh spot prices', error);
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
      await refreshSnapshotWithLog(deps, 'Failed to refresh plan after price optimization settings change');
    },
    [COMBINED_PRICES]: async () => {
      void scheduleDailyBudgetPriceSync();
    },
    [OVERSHOOT_BEHAVIORS]: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'Failed to refresh devices after overshoot behavior change');
      await rebuildPlanFromSettings(deps, OVERSHOOT_BEHAVIORS);
    },
    [PRICE_OPTIMIZATION_ENABLED]: async () => {
      deps.updatePriceOptimizationEnabled(true);
      deps.updateDailyBudgetState({ forcePlanRebuild: true });
      await rebuildPlanFromSettings(deps, 'price_optimization_enabled');
    },
    [DAILY_BUDGET_RESET]: async () => {
      deps.resetDailyBudgetLearning();
      deps.updateDailyBudgetState({ forcePlanRebuild: true });
      deps.homey.settings.set(DAILY_BUDGET_RESET, null);
      await rebuildPlanFromSettings(deps, 'daily_budget_reset');
    },
    debug_logging_enabled: async () => deps.updateDebugLoggingEnabled(true),
    [DEBUG_LOGGING_TOPICS]: async () => deps.updateDebugLoggingEnabled(true),
    settings_ui_log: async () => handleSettingsUiLog(deps),
  };
}

const formatSettingsUiMessage = (entry: SettingsUiLogEntry) => {
  const context = entry.context ? ` (${entry.context})` : '';
  const detail = entry.detail ? ` - ${entry.detail}` : '';
  return `Settings UI${context}: ${entry.message}${detail}`;
};

const handleSettingsUiLog = async (deps: SettingsHandlerDeps): Promise<void> => {
  const raw = deps.homey.settings.get('settings_ui_log') as unknown;
  if (!raw || typeof raw !== 'object') return;
  const entry = raw as SettingsUiLogEntry;
  if (!entry.level || !entry.message) return;

  const message = formatSettingsUiMessage(entry);
  if (entry.level === 'error') {
    deps.errorLog(message, new Error(entry.detail || entry.message));
  } else if (entry.level === 'warn') {
    deps.log(`Warning: ${message}`);
  } else {
    deps.log(message);
  }

  deps.homey.settings.set('settings_ui_log', null);
};

async function handleModeTargetsChange(deps: SettingsHandlerDeps): Promise<void> {
  deps.loadCapacitySettings();
  try {
    await deps.refreshTargetDevicesSnapshot();
    await rebuildPlanFromSettings(deps, 'mode_targets');
  } catch (error) {
    deps.errorLog('Failed to refresh devices after mode target change', error);
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
  deps.updateDailyBudgetState({ forcePlanRebuild: true });
  await rebuildPlanFromSettings(deps, 'capacity_limit_or_margin');
}

async function handleDailyBudgetPriceChange(deps: SettingsHandlerDeps): Promise<void> {
  deps.updateDailyBudgetState({ forcePlanRebuild: true });
  await rebuildPlanFromSettings(deps, 'daily_budget_price');
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

async function refreshSnapshotWithLog(deps: SettingsHandlerDeps, message: string): Promise<void> {
  try {
    await deps.refreshTargetDevicesSnapshot();
  } catch (error) {
    deps.errorLog(message, error);
  }
}
