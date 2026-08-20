import {
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
} from '../../../contracts/src/settingsUiApi.ts';
import { getTargetDevices, renderDevices } from './devices.ts';
import { loadStaleDataStatus } from './capacity.ts';
import { refreshHomeBadges } from './homeBadges.ts';
import { refreshHomeScopeAndNotify, subscribeToHomeScope } from './homeScope.ts';
import { invalidateApiCache, invalidateApiCacheForAllHomes } from './homey.ts';
import { loadModeAndPriorities, renderPriorities } from './modes.ts';
import { refreshOverviewPlanWithRescueGate } from './overviewRescueGate.ts';
import { refreshPriceConfigView, updatePriceConfigDevices } from './priceConfig.ts';
import { refreshDailyBudgetPlan } from './dailyBudget.ts';
import { refreshPlan, resetPlanSurfaceForScopeChange } from './plan.ts';
import { refreshAdvancedDeviceCleanup } from './advanced.ts';
import {
  getPowerUsageFromRead,
  markUsagePanelPendingForScopeChange,
  renderPowerStatsFromRead,
  renderPowerUsage,
} from './power.ts';
import { readUsagePower } from './usagePowerRead.ts';
import { state } from './state.ts';
import { logSettingsError } from './logging.ts';

/**
 * The refresh actions the settings-UI shell's three drivers — the realtime
 * event handlers, the tab-activation hooks, and the `settings.set` router —
 * all invoke. They live here rather than in `realtime.ts` so those three
 * modules can be separate without importing each other in a cycle.
 *
 * Panel-visibility gating stays with the action (not the caller): a refresh
 * that paints a hidden panel is pure cost, and the tab-activation path fetches
 * on open anyway.
 */

const POWER_USAGE_REALTIME_REFRESH_MIN_INTERVAL_MS = 30 * 1000;

let lastPowerUsageRefreshStartedAt = 0;

// Monotonic run id for the Usage repaint. Its callers overlap freely — a rapid
// Main→area scope pick starts a second run while the first is still awaiting,
// and the older run's late completion would repaint over the newer one's.
// Each run stamps itself and every paint is gated on still being the latest
// run — the `rosterGeneration` precedent in `homeScope.ts`.
let powerRefreshGeneration = 0;

/** Run a fire-and-forget task, routing any rejection to the app log. */
export const runLoggedTask = (task: Promise<unknown>, message: string, context: string) => {
  task.catch((error) => {
    void logSettingsError(message, error, context);
  });
};

export const isPanelVisible = (selector: string): boolean => {
  const panel = document.querySelector(selector);
  return Boolean(panel && !panel.classList.contains('hidden'));
};

export const refreshPlanForUi = (context: string) => {
  invalidateApiCacheForAllHomes(SETTINGS_UI_PLAN_PATH);
  runLoggedTask(refreshPlan(), 'Failed to refresh plan', context);
};

// A selected meter area's own freshness path (multi-home): its suffixed
// `pels_status:<id>` / `capacity_dry_run:<id>` writes repaint an OPEN
// Overview from the area's scoped reads (the caller already invalidated the
// scoped cache entries). Visible-only, unlike `refreshPlanForUi`: these keys
// fire on every area plan commit, and repainting a hidden panel is pure cost —
// the Overview activation hook refetches on open anyway.
export const refreshOverviewPlanIfVisible = (context: string) => {
  if (!isPanelVisible('#overview-panel')) return;
  runLoggedTask(refreshPlan(), 'Failed to refresh plan', context);
};

export const refreshPricesIfVisible = (context: string) => {
  if (!isPanelVisible('#electricity-prices-panel') && !isPanelVisible('#price-aware-devices-panel')) return;
  runLoggedTask(refreshPriceConfigView(), 'Failed to refresh prices', context);
};

export const refreshDailyBudgetIfVisible = (context: string) => {
  if (!isPanelVisible('#budget-panel')) return;
  runLoggedTask(refreshDailyBudgetPlan(), 'Failed to refresh daily budget', context);
};

export const refreshStaleDataStatus = (context: string) => {
  runLoggedTask(loadStaleDataStatus(), 'Failed to refresh stale data status', context);
};

export const refreshPowerData = async () => {
  lastPowerUsageRefreshStartedAt = Date.now();
  powerRefreshGeneration += 1;
  const generation = powerRefreshGeneration;
  const isCurrentRun = () => generation === powerRefreshGeneration;
  // One discriminated read owns the complete Usage refresh. In particular, an
  // unavailable Main read must not be flattened to an empty hourly list and
  // then masked by a second successful stats read.
  const read = await readUsagePower();
  // A newer run started while this read was in flight; its answer owns the
  // panel. Dropping the whole completion keeps every Usage surface on the
  // same selected-home generation.
  if (!isCurrentRun()) return;
  if (read.state === 'served') {
    renderPowerUsage(getPowerUsageFromRead(read));
  }
  await renderPowerStatsFromRead(read, isCurrentRun);
};

export const refreshPowerDataIfVisible = (
  context: string,
  options: { force?: boolean; invalidateBeforeRefresh?: boolean } = {},
) => {
  if (!isPanelVisible('#usage-panel')) return;
  const now = Date.now();
  if (!options.force && now - lastPowerUsageRefreshStartedAt < POWER_USAGE_REALTIME_REFRESH_MIN_INTERVAL_MS) {
    return;
  }
  if (options.invalidateBeforeRefresh) {
    invalidateApiCacheForAllHomes(SETTINGS_UI_POWER_PATH);
  }
  runLoggedTask(refreshPowerData(), 'Failed to refresh power data', context);
};

// Follow the shell's home scope on the Usage panel (registered at import time,
// the `homeLimits.ts` precedent): a pick from the global bar repaints the
// visible Usage surface from the newly selected home's own read, immediately —
// no throttle, since the user just asked for a different home. Off-panel picks
// skip the READ (the Usage activation hook re-reads the scope on the next
// open) but still invalidate what is on the panel — see below.
subscribeToHomeScope(() => {
  // Pending state FIRST, before the refresh is even started: the scope chip has
  // already flipped to the new home's name, and the panel below it still holds
  // the previous home's numbers. Hiding them until the new home's run owns a
  // complete paint is what keeps the name and the figures the same home's.
  markUsagePanelPendingForScopeChange();
  if (!isPanelVisible('#usage-panel')) return;
  runLoggedTask(refreshPowerData(), 'Failed to refresh power data', 'homeScope');
});

// The Overview's twin subscription. Blank to the skeleton FIRST: the previous
// home's hero and cards must never sit under the just-picked home's name while
// the scoped read is in flight — a wrong home's numbers labelled with the new
// one is worse than a moment of loading shimmer.
subscribeToHomeScope(() => {
  if (!isPanelVisible('#overview-panel')) return;
  resetPlanSurfaceForScopeChange();
  runLoggedTask(refreshOverviewPlanWithRescueGate(), 'Failed to refresh plan', 'homeScope');
});

subscribeToHomeScope(() => {
  if (!isPanelVisible('#modes-panel')) return;
  runLoggedTask(loadModeAndPriorities().then(() => {
    if (state.devicesLoaded) renderPriorities(state.latestDevices);
  }), 'Failed to load modes for the selected home', 'homeScope');
});

const renderLatestDevices = (devices: Awaited<ReturnType<typeof getTargetDevices>>) => {
  state.latestDevices = devices;
  renderPriorities(devices);
  renderDevices(devices);
  updatePriceConfigDevices(devices);
  refreshAdvancedDeviceCleanup();
  // The Overview's cards are DEVICE rows, so a new device list is a reason to
  // repaint it — the plan alone no longer determines what it shows. Without
  // this, a device list that arrives after the plan leaves the Overview blank
  // until the next plan or power event, which on a flow-powered install can be
  // an unbounded wait.
  refreshOverviewPlanIfVisible('devicesUpdated');
  document.dispatchEvent(new CustomEvent('devices-updated', { detail: { devices } }));
};

/**
 * Loads the device payload for the OVERVIEW without repainting anything else.
 *
 * The Overview needs `state.latestDevices` because its cards are device rows
 * now, but it does not need the Devices list, the priority rows, or the
 * price-optimization list painted — those panels are hidden, and painting them
 * from here made their DOM appear at boot, before the settings those rows read
 * had loaded. Each device panel still paints on its own activation
 * (`ensureDevicePanelsPainted`), which is where it always did.
 */
export const loadDevicesForOverview = () => {
  if (state.devicesLoaded || state.devicesLoading) return;
  state.devicesLoading = true;
  getTargetDevices()
    .then((devices) => {
      state.devicesLoaded = true;
      state.latestDevices = devices;
      refreshOverviewPlanIfVisible('overviewDeviceLoad');
    })
    .catch((error) => {
      void logSettingsError('Failed to load devices', error, 'loadDevicesForOverview');
    })
    .finally(() => {
      state.devicesLoading = false;
    });
};

/**
 * A device panel is opening and the payload is already in the store — repaint
 * from it. Needed because the Overview may have loaded the devices first, and
 * `loadDevicesOnce` short-circuits once they are loaded, which would otherwise
 * leave the opening panel empty.
 */
export const ensureDevicePanelsPainted = () => {
  if (!state.devicesLoaded) return;
  renderLatestDevices(state.latestDevices);
};

export const loadDevicesOnce = () => {
  state.devicesLoading = true;
  getTargetDevices()
    .then((devices) => {
      state.devicesLoaded = true;
      renderLatestDevices(devices);
    })
    .catch((error) => {
      void logSettingsError('Failed to load devices', error, 'loadDevicesOnce');
    })
    .finally(() => {
      state.devicesLoading = false;
    });
};

export const refreshDevicesForUi = () => {
  invalidateApiCacheForAllHomes(SETTINGS_UI_DEVICES_PATH);
  invalidateApiCache(SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH);
  if (!state.devicesLoaded || state.devicesLoading) return;
  getTargetDevices()
    .then((devices) => renderLatestDevices(devices))
    .catch((error) => {
      void logSettingsError('Failed to refresh devices', error, 'settings.set');
    });
};

/**
 * Meter areas changed (`homes_config`): refetch the home-badge membership and
 * repaint the two lists that carry badges. The device payload itself is
 * unaffected, so this deliberately does NOT refetch `/ui_devices` — without it
 * the badges would keep naming the pre-edit areas for the rest of the session
 * (`loadDevicesOnce` only ever runs once).
 */
export const refreshHomeBadgesForUi = (context: string) => {
  runLoggedTask(Promise.all([refreshHomeScopeAndNotify(), refreshHomeBadges()]).then(() => {
    if (!state.devicesLoaded) return;
    renderLatestDevices(state.latestDevices);
  }), 'Failed to refresh meter area badges', context);
};

export const refreshModeAndDeviceControls = () => {
  loadModeAndPriorities()
    .then(() => {
      if (!state.devicesLoaded) return;
      // The canonical "devices changed, refresh every surface" pass, rather than
      // the subset this used to hand-roll. It also emits `devices-updated`, which
      // is what refreshes an OPEN detail panel — re-rendering the list does not
      // touch it, so a change made in another WebView (or via the Homey API)
      // otherwise left the panel's switches asserting the old configuration for
      // the rest of the session.
      renderLatestDevices(state.latestDevices);
    })
    .catch((error) => {
      void logSettingsError('Failed to load device control settings', error, 'settings.set');
    });
};
