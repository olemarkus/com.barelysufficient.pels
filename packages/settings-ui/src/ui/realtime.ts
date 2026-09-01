import { syncSettingsHubChips } from './settingsHubChips.ts';
import { classifyPowerReadingsFact } from '../../../shared-domain/src/powerReadingsBanner.ts';
import {
  SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH,
  SETTINGS_UI_DEVICE_LOG_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
  SETTINGS_UI_PRICES_PATH,
  type SettingsUiPowerPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import { updateStaleDataStatusFromPowerPayload } from './capacity.ts';
import {
  getHomeyClient,
  invalidateApiCache,
  invalidateApiCacheForAllHomes,
  invalidateApiCacheForScopedHomes,
  primeApiCache,
  updateApiCache,
} from './homey.ts';
import { updateBudgetPower } from './dailyBudget.ts';
import {
  parsePlanSnapshot,
  renderPlan,
  updatePlanPower,
  updatePlanPrices,
} from './plan.ts';
import { state } from './state.ts';
import { logSettingsWarn } from './logging.ts';
import { repaintOverviewWithRescueGate } from './overviewRescueGate.ts';
import { createSettingsSetHandler, createSettingsUnsetHandler } from './settingsChangeRouter.ts';
import {
  isPanelVisible,
  loadDevicesOnce,
  loadDevicesForOverview,
  refreshDevicesForUi,
  refreshPlanForUi,
  refreshPowerDataIfVisible,
  refreshPricesIfVisible,
  refreshStaleDataStatus,
  runLoggedTask,
} from './uiRefreshTasks.ts';
import { liveStatusOrNull, resolvePowerStatusRead } from './powerStatusRead.ts';

/**
 * The WebView's realtime subscriptions: the four `homey.on(...)` pushes the app
 * emits (plan / prices / devices / power) plus the periodic stale-data poll.
 * The `settings.set` key routing lives in `settingsChangeRouter.ts` and the
 * shell's tab navigation in `tabNavigation.ts`; both are re-exported here so
 * existing importers (`boot.ts`, `deadlinePlanRouter.ts`) keep one entry point.
 */

export { setActiveTabIndicator, showTab } from './tabNavigation.ts';

const handlePlanUpdated = (plan: unknown) => {
  const parsedPlan = parsePlanSnapshot(plan);
  if (parsedPlan === null && plan !== null && plan !== undefined) {
    void logSettingsWarn(
      'Ignoring malformed realtime plan update',
      undefined,
      'plan_updated',
    );
    return;
  }
  // `plan_updated` is the MAIN home's stream and stays that way: only the main
  // plan service drives it (`lib/plan/planServiceDeps.ts`, `homeScope.ts`).
  // Widening it would repaint Main's Overview from a sub-home's device set in a
  // Homey-cached stale WebView. So the push re-seeds the bare entry only, and
  // the sub-home entries it cannot speak for are dropped rather than left to
  // serve a plan from before this rebuild. A selected sub-home refetches on its
  // next read; its own freshness signal is the suffixed `settings.set` stream
  // (`pels_status:<homeId>`), routed in `settingsChangeRouter.ts`.
  invalidateApiCacheForScopedHomes(SETTINGS_UI_PLAN_PATH);
  primeApiCache(SETTINGS_UI_PLAN_PATH, { plan: parsedPlan });
  invalidateApiCache(SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH);
  // The device-log payload is recorded backend-side on the same plan pass, so
  // invalidate it here. Otherwise `getApiReadModel` keeps returning the stale
  // cached payload and the open activity-log view never picks up new entries.
  invalidateApiCache(SETTINGS_UI_DEVICE_LOG_PATH);
  document.dispatchEvent(new CustomEvent('plan-updated', { detail: { plan: parsedPlan } }));
  if (!isPanelVisible('#overview-panel')) return;
  // Refresh the rescuable-device set so the "Let it run now" chip's gate tracks
  // the live starvation state (a device that just entered / left
  // starvation, gained / lost a smart task, or learned its target). Overview-only
  // so it never fetches while the user is on another tab. The guarded repaint
  // follows the fetch so the chip appears / disappears once it loads, but only if
  // this plan is still current (`overviewRescueGate` sequence-guards it so a slow
  // older fetch can't roll the Overview back over a newer plan). The synchronous
  // `renderPlan` below always paints the freshest plan immediately.
  runLoggedTask(
    repaintOverviewWithRescueGate(
      parsedPlan,
      () => isPanelVisible('#overview-panel'),
    ),
    'Failed to refresh rescuable devices',
    'plan_updated',
  );
  renderPlan(parsedPlan);
};

const handlePricesUpdated = () => {
  invalidateApiCache(SETTINGS_UI_PRICES_PATH);
  refreshPricesIfVisible('realtime prices_updated');
  // Fresh prices can clear (or raise) the hub's `Awaiting prices` chip.
  syncSettingsHubChips();
  // The overview hero anticipation subline ("Cheapest hour ahead …") depends on
  // cached prices. Keep it in sync with realtime price updates without forcing a
  // plan re-fetch — the cached plan snapshot is still current. Skip the fetch
  // when the overview is hidden; switching to it triggers refreshPlanForUi and
  // pulls fresh prices alongside the plan.
  if (!isPanelVisible('#overview-panel')) return;
  runLoggedTask(
    updatePlanPrices(),
    'Failed to refresh overview prices',
    'realtime prices_updated',
  );
};

const handleDevicesUpdated = () => {
  refreshDevicesForUi();
  // The power payload carries the home-level `hasManagedSolarDevice` gate for
  // the Usage Solar card, so a device-list change (PV added/removed) must
  // refetch it — otherwise the card's gathering state waits for the next
  // manual Usage-tab open.
  refreshPowerDataIfVisible('realtime devices_updated', {
    force: true,
    invalidateBeforeRefresh: true,
  });
};

const handlePowerUpdated = (power: unknown) => {
  const payload = power as SettingsUiPowerPayload;
  // Classify the pushed status ONCE at this seam; a malformed push is the
  // client's own `read_failed`, never a live status.
  const statusRead = resolvePowerStatusRead(payload?.status);
  const liveStatus = liveStatusOrNull(statusRead);
  const hasFullTracker = Boolean(payload?.tracker && typeof payload.tracker === 'object');
  // Main's stream, like `plan_updated` — never widened. Drop the sub-home
  // entries this push does not refresh; the bare entry is seeded/patched below.
  invalidateApiCacheForScopedHomes(SETTINGS_UI_POWER_PATH);
  if (hasFullTracker) {
    primeApiCache(SETTINGS_UI_POWER_PATH, { ...payload, status: statusRead });
  } else {
    // Status-only push: patch status/heartbeat and PRESERVE the cached
    // tracker (and hasManagedSolarDevice). Every runtime `power_updated` push
    // is status-only (`emitSettingsUiPowerUpdatedForApp` sends tracker:null),
    // so stomping the tracker here left the Overview's "Solar now" subline
    // reading a null tracker on most opens (`refreshOverviewPlanWithRescueGate`
    // reads this cache) until the 30 s periodic refetch healed it. Consumers
    // that need a FRESH tracker already invalidate before refetching (see
    // refreshPowerDataIfVisible and the usage-tab activation hook).
    const pushedReadings = classifyPowerReadingsFact(payload?.readings);
    updateApiCache<SettingsUiPowerPayload>(SETTINGS_UI_POWER_PATH, {
      status: statusRead,
      ...(pushedReadings !== null ? { readings: pushedReadings } : {}),
    }, { tracker: {}, readings: { state: 'never' } });
  }
  // Only a full-tracker push refreshes the hero's "Solar now" triple; a
  // status-only push keeps the cached one (the resolver's staleness gate
  // retires it on its own).
  updatePlanPower(hasFullTracker ? payload.tracker : undefined);
  updateBudgetPower(liveStatus);
  // The hub's `Awaiting prices` chip reads the price level this push just
  // primed into the power cache — cheap idempotent DOM sync.
  syncSettingsHubChips();
  updateStaleDataStatusFromPowerPayload(payload ? { ...payload, status: statusRead } : null);
  refreshPowerDataIfVisible('realtime power_updated', {
    force: hasFullTracker,
    invalidateBeforeRefresh: !hasFullTracker,
  });
};

// The Homey bridge hands event arguments in as `unknown[]`. Both settings events carry the
// changed settings key as their first argument; anything else is not a key we can route, so
// it is dropped here at the seam rather than defended against inside the router — which keeps
// its `(key: string)` signature and stays free of provenance checks. Logged rather than
// swallowed, like the malformed-payload drop in `handlePlanUpdated`: a settings event without
// a key means the bridge broke its contract, and nothing downstream would ever say so.
const withSettingsKey = (event: string, route: (key: string) => void) => (...args: unknown[]): void => {
  const [key] = args;
  if (typeof key !== 'string') {
    void logSettingsWarn('Ignoring a settings event with no settings key', undefined, event);
    return;
  }
  route(key);
};

export const initRealtimeListeners = () => {
  const homey = getHomeyClient();
  if (!homey || typeof homey.on !== 'function') return;

  homey.on('plan_updated', handlePlanUpdated);
  homey.on('prices_updated', handlePricesUpdated);
  homey.on('devices_updated', handleDevicesUpdated);
  homey.on('power_updated', handlePowerUpdated);
  homey.on('settings.set', withSettingsKey('settings.set', createSettingsSetHandler()));
  homey.on('settings.unset', withSettingsKey('settings.unset', createSettingsUnsetHandler()));

  document.addEventListener('request-load-devices', () => {
    if (!state.devicesLoaded && !state.devicesLoading) {
      loadDevicesOnce();
    }
  });
};

export const startStaleDataRefreshInterval = () => {
  setInterval(() => {
    invalidateApiCacheForAllHomes(SETTINGS_UI_POWER_PATH);
    refreshStaleDataStatus('staleDataInterval');
    if (isPanelVisible('#overview-panel')) {
      refreshPlanForUi('periodicRefresh');
      // The Overview's cards are device rows, so the device payload is on this
      // surface's critical path and shares its cadence. `/ui_devices` resolves
      // observed state per read, so this is what makes a card's draw and
      // availability current rather than whatever the last device poll parsed.
      loadDevicesForOverview();
    }
  }, 30 * 1000);
};
