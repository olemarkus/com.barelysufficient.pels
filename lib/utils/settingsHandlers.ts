import type { HomeyRuntime } from '../ports/homeyRuntime';
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
  DEVICE_HOME_ASSIGNMENTS,
  EV_BOOST_SETTINGS,
  EXPORT_FIXED,
  EXPORT_PRICE_ENABLED,
  EXPORT_SPOT_FACTOR,
  FLOW_PRICES_TODAY,
  FLOW_PRICES_TOMORROW,
  HOMEY_PRICES_CURRENCY,
  NORWAY_PRICE_MODEL,
  HOMEY_PRICES_TODAY,
  HOMEY_PRICES_TOMORROW,
  HOMES_CONFIG,
  isHomeScopableBaseKey,
  MAIN_HOME_ID,
  MANAGED_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  OVERSHOOT_BEHAVIORS,
  TEMPERATURE_BOOST_SETTINGS,
  OPERATING_MODE_SETTING,
  HOMEY_ENERGY_METER_DEVICE_ID,
  parseHomeScopedSettingsKey,
  POWER_SOURCE,
  POWER_TRACKER_STATE,
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_OPTIMIZATION_SETTINGS,
  PRICE_SCHEME,
  WEATHER_ADVISOR_SETTINGS,
} from './settingsKeys';
import { incPerfCounters } from './perfCounters';
import { getLogger } from '../logging/logger';
import { normalizeError } from './errorUtils';
import {
  createDebouncedSyncScheduler,
  type DebouncedSyncScheduler,
} from './settingsHandlerDebounce';
import { createNoopWriteSkipper } from './settingsWriteDedupe';

const settingsLogger = getLogger('settings');
export type PriceServiceLike = {
  refreshGridTariffData: (forceRefresh?: boolean) => Promise<void>;
  refreshSpotPrices: (forceRefresh?: boolean) => Promise<void>;
  updateCombinedPrices: () => void;
};

export type SettingsHandlerDeps = {
  homey: HomeyRuntime;
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
  /** Synchronous meter-event edge: invalidate any old-selection poll now. */
  onHomeyEnergyMeterObserved?: () => void;
  /** Schedule bounded Main authority repair after an explicit-meter event. */
  onMainMeterSelectionObserved?: () => void;
  /**
   * Synchronously close the shared ownership generation before a homes/pins
   * event waits behind the serialized settings queue.
   */
  onHomeOwnershipConfigurationObserved?: () => void;
  stopFlowPowerSampleFreshnessClock?: () => void;
  syncFlowPowerSampleFreshnessClock?: () => void;
  reloadWeatherAdvisor?: () => void;
  /**
   * Synchronously observe a source settings event before it enters the async
   * settings queue. This closes per-home authorization for the new generation.
   */
  onHomeRuntimePowerSourceObserved?: () => void;
  /**
   * Durably reset and replace per-home meter runtimes for the latest observed
   * source generation. Runs before the Homey Energy poll is restarted.
   */
  onHomeRuntimePowerSourceChanged?: () => void;
  /**
   * Writes to home-suffixed keys (`<base>:<homeId>`, non-main home, see
   * `parseHomeScopedSettingsKey`) route here instead of the exact-key
   * handlers — a `power_tracker_state:<homeId>` write must never reload the
   * main home's power tracker. The multi-home runtime registry provides the
   * consumer; the optional seam remains absent in single-home/test contexts,
   * where the write is ignored.
   * Rejections and throws are contained and logged; they never propagate to
   * the settings `set` listener.
   *
   * Consumer contract: invocations are NOT serialized against the settings
   * handler queue or against homes-config processing, and are NOT deduped —
   * expect high-frequency echoes such as `power_tracker_state:<homeId>`
   * self-persist writes at sample cadence. Treat every call as an idempotent
   * dirty-mark to reconcile against the homes registry, never as an ordered,
   * deduplicated command. An unknown homeId is transient: dirty-mark and
   * reconcile — never a destructive reset, never a dropped write.
   */
  onHomeScopedSettingChanged?: (baseKey: string, homeId: string) => void | Promise<void>;
  /**
   * Recompute the cached device→home membership after a `homes_config` /
   * `device_home_assignments` write (both UNSUFFIXED global keys — ordinary
   * exact-key serialized dispatch, unlike the suffixed hook above). Optional
   * and read-only: when absent the write still persists — membership simply
   * recomputes on the next snapshot refresh.
   */
  recomputeHomeMembership?: () => void;
  /**
   * Reconcile the per-home capacity bundles after a `homes_config` write
   * (create new sub-home runtimes, tear down removed ones). Runs AFTER
   * `recomputeHomeMembership` so a freshly created bundle's first plan input
   * reads the recomputed membership. Optional: when absent the registry
   * still self-reconciles on the next suffixed-write dirty-mark.
   */
  reconcileHomeRuntimes?: () => void;
};

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

// A colon key whose base IS home-scopable but whose suffix the parser rejected
// (`capacity_limit_kw:`, `capacity_limit_kw:main`) dispatches as an ordinary
// exact key — almost certainly an emitter bug, so leave a debug trace first.
const logMalformedHomeSuffix = (key: string): void => {
  const separatorIndex = key.indexOf(':');
  if (separatorIndex === -1 || !isHomeScopableBaseKey(key.slice(0, separatorIndex))) return;
  settingsLogger.debug({ event: 'home_scoped_settings_key_malformed', settingKey: key });
};

export function createSettingsHandler(deps: SettingsHandlerDeps): SettingsHandler {
  const dailyBudgetPriceSyncScheduler = createDailyBudgetPriceSyncScheduler(deps);
  const dailyBudgetSettingsSyncScheduler = createDailyBudgetSettingsSyncScheduler(deps);
  const handlers = buildSettingsHandlers(
    deps,
    () => dailyBudgetPriceSyncScheduler.schedule(),
    () => dailyBudgetSettingsSyncScheduler.schedule(),
  );

  const { shouldSkipNoopWrite, markProcessedWrite } = createNoopWriteSkipper(
    (key) => deps.homey.settings.get(key) as unknown,
  );

  let queue = Promise.resolve();
  const handler = (async (key: string) => {
    // Load-bearing synchronous edge: an async function executes through its
    // first await immediately, so rapid un-awaited POWER_SOURCE events cannot
    // collapse back to the original value before the registry observes them.
    if (key === POWER_SOURCE) deps.onHomeRuntimePowerSourceObserved?.();
    if (key === HOMEY_ENERGY_METER_DEVICE_ID) {
      deps.onHomeyEnergyMeterObserved?.();
      deps.onMainMeterSelectionObserved?.();
    }
    if (key === HOMES_CONFIG || key === DEVICE_HOME_ASSIGNMENTS) {
      deps.onHomeOwnershipConfigurationObserved?.();
    }
    const scoped = parseHomeScopedSettingsKey(key);
    if (scoped.homeId !== MAIN_HOME_ID) {
      // Non-main-home write: route to the hook only. Falling through would run
      // the main home's handler for the base key (e.g. reload main's power
      // tracker for `power_tracker_state:<homeId>`), which must never happen.
      // Awaiting inside the try contains async-hook rejections too — the
      // settings `set` listener at the SDK seam must never see one.
      try {
        await deps.onHomeScopedSettingChanged?.(scoped.baseKey, scoped.homeId);
      } catch (error) {
        settingsLogger.error({
          event: 'home_scoped_settings_hook_failed',
          settingKey: key,
          err: normalizeError(error),
        });
      }
      return;
    }
    logMalformedHomeSuffix(key);
    // `scoped.homeId === MAIN_HOME_ID` implies `scoped.baseKey === key`, so
    // main-home dispatch below stays exact-key and byte-identical to before.
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
    [POWER_TRACKER_STATE]: async () => deps.loadPowerTracker(),
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
    [EXPORT_PRICE_ENABLED]: async () => refreshPriceDerivedState(deps),
    [EXPORT_SPOT_FACTOR]: async () => refreshPriceDerivedState(deps),
    [EXPORT_FIXED]: async () => refreshPriceDerivedState(deps),
    [PRICE_OPTIMIZATION_SETTINGS]: async () => {
      deps.loadPriceOptimizationSettings();
      await refreshSnapshotWithLog(deps, 'price_optimization_settings_change');
    },
    [COMBINED_PRICES]: async () => {
      void scheduleDailyBudgetPriceSync();
    },
    [POWER_SOURCE]: async () => handlePowerSourceChange(deps),
    [HOMEY_ENERGY_METER_DEVICE_ID]: async () => handleHomeyEnergyMeterChange(deps),
    [PRICE_OPTIMIZATION_ENABLED]: async () => {
      deps.updatePriceOptimizationEnabled(true);
      deps.updateDailyBudgetState(FORCE_DAILY_BUDGET_STATE_PERSIST);
      await rebuildPlanFromSettings(deps, 'price_optimization_enabled');
    },
  };
}

function buildMiscSettingsHandlers(deps: SettingsHandlerDeps): SettingsHandlerMap {
  return {
    // Multi-home registry/pin writes: recompute the membership cache, then
    // reconcile the per-home capacity bundles (R7b) — membership first so a
    // freshly created bundle's plan input reads the new device partition.
    // Still deliberately NO snapshot refresh here; membership's own
    // change-gated invalidation covers the main plan.
    [HOMES_CONFIG]: async () => {
      deps.recomputeHomeMembership?.();
      deps.reconcileHomeRuntimes?.();
    },
    [DEVICE_HOME_ASSIGNMENTS]: async () => {
      deps.recomputeHomeMembership?.();
    },
    [DAILY_BUDGET_RESET]: async () => {
      deps.resetDailyBudgetLearning();
      deps.updateDailyBudgetState(FORCE_DAILY_BUDGET_STATE_PERSIST);
      deps.homey.settings.set(DAILY_BUDGET_RESET, null);
      await rebuildPlanFromSettings(deps, 'daily_budget_reset');
    },
    debug_logging_enabled: async () => deps.updateDebugLoggingEnabled(true),
    [DEBUG_LOGGING_TOPICS]: async () => deps.updateDebugLoggingEnabled(true),
    [WEATHER_ADVISOR_SETTINGS]: async () => deps.reloadWeatherAdvisor?.(),
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

async function handleHomeyEnergyMeterChange(deps: SettingsHandlerDeps): Promise<void> {
  settingsLogger.info({ event: 'homey_energy_meter_changed' });
  // The meter id is read fresh per poll, so no restart is strictly required —
  // but restart's immediate pollNow() surfaces the new meter's reading within
  // seconds instead of up to 10s. No-ops unless the source is homey_energy.
  deps.restartHomeyEnergyPoll?.();
  await rebuildPlanFromSettings(deps, 'homey_energy_meter');
}

async function handlePowerSourceChange(deps: SettingsHandlerDeps): Promise<void> {
  settingsLogger.info({ event: 'power_source_changed' });
  deps.onHomeRuntimePowerSourceChanged?.();
  deps.restartHomeyEnergyPoll?.();
  deps.stopFlowPowerSampleFreshnessClock?.();
  deps.syncFlowPowerSampleFreshnessClock?.();
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
