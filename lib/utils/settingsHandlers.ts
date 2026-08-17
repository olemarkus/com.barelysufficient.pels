import type { HomeyRuntime } from '../ports/homeyRuntime';
import type { DailyBudgetUpdateStateOptions } from '../dailyBudget/dailyBudgetTypes';
import type { SettingsUiLogEntry } from '../../packages/contracts/src/types';
import {
  BUDGET_EXEMPT_DEVICES,
  RESPECT_EXTERNAL_OFF_DEVICES,
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  COMBINED_PRICES,
  CONTROLLABLE_DEVICES,
  DEVICE_CONTROL_PROFILES,
  DEVICE_COMMUNICATION_MODELS,
  DEVICE_DRIVER_OVERRIDES,
  DEVICE_EXPECTED_POWER_OVERRIDES,
  DEVICE_TARGET_POWER_CONFIGS,
  DEVICE_TARGET_POWER_REACHABILITY,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DAILY_BUDGET_RESET,
  DEBUG_LOGGING_TOPICS,
  DEVICE_HOME_ASSIGNMENTS,
  EV_BOOST_SETTINGS,
  EV_CAR_ASSOCIATIONS,
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
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
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
   * Re-read the "Leave off until turned on again" opt-in and release any hold
   * whose device is no longer opted in. Returns the released device ids.
   */
  releaseDeOptedExternalOffHolds?: () => string[];
  /**
   * Adopt the persisted manual expected-power figures into the live map the
   * runtime resolves against. The map is otherwise loaded only at boot, so a
   * settings-UI write to `DEVICE_EXPECTED_POWER_OVERRIDES` needs this to take
   * effect without a restart.
   *
   * REQUIRED, unlike the optional hooks above: absence is not a state a caller
   * can be in — an unwired seam here means the write silently does nothing
   * until the next restart, which is precisely the bug this closes.
   */
  reloadExpectedPowerOverrides: () => void;
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
  /** Synchronously publish the latest validated temperature-command policy before queueing. */
  onTemperatureControlPolicyObserved?: () => void;
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
  /** Rebuild pre-migration area followers after a Main catalog write. */
  rebuildHomeRuntimePlansForModeChange?: () => void;
  /** Rebuild every live sub-home after a global per-device control policy changes. */
  rebuildAllHomeRuntimePlansForDeviceControlChange?: () => void;
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
    if (key === TEMPERATURE_CONTROL_DISABLED_DEVICES) {
      deps.onTemperatureControlPolicyObserved?.();
    }
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

/**
 * Keys whose change must RE-PARSE the device snapshot before the plan rebuild,
 * because each one changes how a device parses — its control profile, its
 * native wiring, its driver identity — rather than only how the planner reads an
 * already-parsed device. Rebuilding the plan alone
 * would replan against the previous parse.
 *
 * The reason strings are the established log vocabulary for these changes and
 * are load-bearing for log review; keep them verbatim when adding a key.
 */
const SNAPSHOT_REPARSE_SETTINGS: readonly (readonly [string, string])[] = [
  [CONTROLLABLE_DEVICES, 'controllable_devices_change'],
  [MANAGED_DEVICES, 'managed_devices_change'],
  [NATIVE_EV_WIRING_DEVICES, 'native_ev_wiring_change'],
  [DEVICE_DRIVER_OVERRIDES, 'device_driver_override_change'],
  [DEVICE_CONTROL_PROFILES, 'device_control_profile_change'],
  [DEVICE_TARGET_POWER_CONFIGS, 'device_target_power_change'],
  [DEVICE_TARGET_POWER_REACHABILITY, 'device_target_power_reachability_change'],
  [DEVICE_COMMUNICATION_MODELS, 'device_communication_model_change'],
];

function buildSnapshotReparseHandlers(deps: SettingsHandlerDeps): SettingsHandlerMap {
  return Object.fromEntries(SNAPSHOT_REPARSE_SETTINGS.map(([key, reason]) => [key, async () => {
    deps.loadCapacitySettings();
    await refreshSnapshotWithLog(deps, reason);
    await rebuildPlanFromSettings(deps, key);
  }]));
}

function buildCapacitySettingsHandlers(deps: SettingsHandlerDeps): SettingsHandlerMap {
  return {
    mode_device_targets: async () => handleModeTargetsChange(deps),
    [OPERATING_MODE_SETTING]: async () => handleModeTargetsChange(deps),
    mode_aliases: async () => {
      deps.loadCapacitySettings();
      // Initialized meter areas own their aliases; this only keeps a legacy
      // follower coherent until marker-last migration succeeds.
      deps.rebuildHomeRuntimePlansForModeChange?.();
    },
    capacity_priorities: async () => {
      deps.loadCapacitySettings();
      await rebuildPlanFromSettings(deps, 'capacity_priorities');
      // Initialized meter areas own their priorities; fan out only to a
      // pre-migration follower.
      deps.rebuildHomeRuntimePlansForModeChange?.();
    },
    ...buildSnapshotReparseHandlers(deps),
    // Reload only. The car eligibility set is read at the association's read
    // boundary (`lib/device/transport/carAssociation.ts`), so nothing needs
    // re-parsing or replanning — the next read resolves against the new set.
    [EV_CAR_ASSOCIATIONS]: async () => { deps.loadCapacitySettings(); },
    [TEMPERATURE_CONTROL_DISABLED_DEVICES]: async () => {
      // Load synchronously before the first await: every actuator reads this
      // live map at its final setup-layer fence, so an already-queued target or
      // step continuation loses authority immediately when this handler starts.
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'temperature_control_disabled_change');
      await rebuildPlanFromSettings(deps, TEMPERATURE_CONTROL_DISABLED_DEVICES);
      // The setting is global and applies to every initialized meter-area
      // runtime, not only legacy areas that still follow Main's mode catalog.
      deps.rebuildAllHomeRuntimePlansForDeviceControlChange?.();
    },
    [BUDGET_EXEMPT_DEVICES]: async () => {
      deps.loadCapacitySettings();
      await refreshSnapshotWithLog(deps, 'budget_exemption_change');
      deps.updateDailyBudgetState(FORCE_DAILY_BUDGET_STATE_PERSIST);
      await rebuildPlanFromSettings(deps, BUDGET_EXEMPT_DEVICES);
    },
    [RESPECT_EXTERNAL_OFF_DEVICES]: async () => {
      // Clear holds for de-opted devices BEFORE the rebuild, so the same rebuild
      // that observes the new config also sees those devices manageable again.
      deps.releaseDeOptedExternalOffHolds?.();
      // No snapshot refresh: the opt-in changes neither which devices are
      // fetched nor how they parse. It is read live at detection time, and
      // `externalOffHoldActive` is re-resolved from the cached snapshot by the
      // rebuild below.
      await rebuildPlanFromSettings(deps, RESPECT_EXTERNAL_OFF_DEVICES);
    },
    [DEVICE_EXPECTED_POWER_OVERRIDES]: async () => {
      // Reload FIRST: expected power is resolved during the device parse
      // (`lib/device/devicePowerEstimate.ts`) from the in-memory override map,
      // so a snapshot refreshed before the adoption would re-parse against the
      // figure the owner just replaced.
      deps.reloadExpectedPowerOverrides();
      await refreshSnapshotWithLog(deps, 'expected_power_override_change');
      await rebuildPlanFromSettings(deps, DEVICE_EXPECTED_POWER_OVERRIDES);
      // The override map is global and keyed on device, not on meter area, so a
      // device assigned to a sub-home is replanned by that home's runtime and
      // not by the rebuild above. Without this fan-out it would keep sizing
      // against the figure the owner just replaced until the next restart.
      deps.rebuildAllHomeRuntimePlansForDeviceControlChange?.();
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
      // The global behavior map is also read by every sub-home plan. This is
      // especially important when a deferred temperature-only-device seed
      // finally succeeds: a silent/Flow-backed area may have no later meter
      // event to replace its previously committed turn_off default.
      deps.rebuildHomeRuntimePlansForModeChange?.();
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
      // The active area-meter roster may have changed: restart the weather
      // collector so its start()-time meter-scope reconcile can invalidate the
      // learned energy signature (`lib/weather/weatherCollector.ts`). A
      // scope-neutral write (rename, zone move) restarts but forgets nothing.
      deps.reloadWeatherAdvisor?.();
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
  // After the snapshot refresh (bundles read the same `latestTargetSnapshot`),
  // so a sub-home's rebuild sees fresh device state alongside the new targets.
  deps.rebuildHomeRuntimePlansForModeChange?.();
}

async function handleCapacityLimitChange(deps: SettingsHandlerDeps): Promise<void> {
  deps.loadCapacitySettings();
  const { marginKw } = deps.getCapacitySettings();
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
  // Main's measured scope changed with its meter: restart the weather
  // collector so its start()-time meter-scope reconcile can invalidate the
  // learned energy signature (`lib/weather/weatherCollector.ts`).
  deps.reloadWeatherAdvisor?.();
  await rebuildPlanFromSettings(deps, 'homey_energy_meter');
}

async function handlePowerSourceChange(deps: SettingsHandlerDeps): Promise<void> {
  settingsLogger.info({ event: 'power_source_changed' });
  deps.onHomeRuntimePowerSourceChanged?.();
  deps.restartHomeyEnergyPoll?.();
  deps.stopFlowPowerSampleFreshnessClock?.();
  deps.syncFlowPowerSampleFreshnessClock?.();
  // Flow and Homey Energy are different producers of the power-tracker
  // history the weather insight's kWh layer consumes, so the source is part
  // of the meter-scope fingerprint: restart the collector so its start()-time
  // reconcile can invalidate the learned energy signature
  // (`lib/weather/weatherCollector.ts`).
  deps.reloadWeatherAdvisor?.();
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
