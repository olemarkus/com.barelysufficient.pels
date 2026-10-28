import {
  PLAN_STATUS_PUBLISHED_EVENT,
  POWER_TRACKER_PERSISTED_EVENT,
  DEFERRED_OBJECTIVE_ACTIVE_PLANS_UPDATED_EVENT,
} from '../../../shared-domain/src/settings/settingsKeys.ts';
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
import { refreshHomeBadgesAndRepaint } from './devices.ts';
import { refreshAfterSetupRecommendations, refreshCarInventory } from './recommendations.ts';
import { logSettingsWarn } from './logging.ts';
import { applyPlanRescueGate } from './starvationRescue.ts';
import {
  createSettingsSetHandler,
  createSettingsUnsetHandler,
  handlePlanStatusPublished,
  handlePowerTrackerPersisted,
  handleDeferredObjectiveActivePlansUpdated,
} from './settingsChangeRouter.ts';
import {
  isPanelVisible,
  loadDevicesOnce,
  loadDevicesForOverview,
  refreshDevicesForUi,
  refreshOverviewOnStatusPoll,
  refreshDailyBudgetIfVisible,
  refreshPowerDataIfVisible,
  refreshPricesIfVisible,
  refreshCurrentPriceIfVisible,
  refreshStaleDataStatus,
  runLoggedTask,
} from './uiRefreshTasks.ts';
import { liveStatusOrNull, resolvePowerStatusRead } from './powerStatusRead.ts';

/**
 * The WebView's realtime subscriptions: the six `homey.on(...)` pushes the app
 * emits (plan / prices / devices / power / tracker persisted / status
 * published) plus the periodic stale-data poll.
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
  // next read; its own freshness signals are the suffixed `settings.set` stream
  // the `plan_status_published` and `power_tracker_persisted` pushes, both
  // routed in `settingsChangeRouter.ts`.
  invalidateApiCacheForScopedHomes(SETTINGS_UI_PLAN_PATH);
  primeApiCache(SETTINGS_UI_PLAN_PATH, { plan: parsedPlan });
  invalidateApiCache(SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH);
  // The device-log payload is recorded backend-side on the same plan pass, so
  // invalidate it here. Otherwise `getApiReadModel` keeps returning the stale
  // cached payload and the open activity-log view never picks up new entries.
  invalidateApiCache(SETTINGS_UI_DEVICE_LOG_PATH);
  document.dispatchEvent(new CustomEvent('plan-updated', { detail: { plan: parsedPlan } }));
  // The plan carries the "Let it run now" chip's gate (`rescuableDeviceIds`),
  // so the chip tracks the live starvation state with each push and needs no
  // read of its own. Applied while the Overview is hidden too: a rescue created
  // from it stays hidden only until a plan stops listing the device, and that
  // plan may arrive while the owner is elsewhere.
  applyPlanRescueGate(parsedPlan?.rescuableDeviceIds ?? []);
  if (!isPanelVisible('#overview-panel')) return;
  renderPlan(parsedPlan);
};

const handlePricesUpdated = () => {
  invalidateApiCache(SETTINGS_UI_PRICES_PATH);
  refreshPricesIfVisible('realtime prices_updated');
  // Prices arriving can finish price setup (Homey Energy had none until now),
  // and change what the price suggestion can say PELS already has.
  runLoggedTask(refreshAfterSetupRecommendations(), 'Failed to refresh setup suggestions after new prices', 'realtime');
  // The daily-budget chart draws the combined prices too. They live in the
  // app's price cache now, not a settings key, so this push is their only
  // change signal.
  refreshDailyBudgetIfVisible('realtime prices_updated');
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
  // The runtime's device snapshot changed. The setup suggestions' car list (and
  // each car's charger matches) is read from it, and meter-area membership can
  // have moved with a Homey zone change, which writes no setting.
  runLoggedTask(refreshCarInventory(), 'Failed to refresh cars for setup suggestions', 'realtime devices_updated');
  refreshHomeBadgesAndRepaint();
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
    // reading a null tracker on most opens (`refreshOverviewPlan` reads this
    // cache) until the 30 s periodic refetch healed it. Consumers
    // that need a FRESH tracker already invalidate before refetching (see
    // refreshPowerDataIfVisible and the usage-tab activation hook).
    const pushedReadings = classifyPowerReadingsFact(payload?.readings);
    updateApiCache<SettingsUiPowerPayload>(SETTINGS_UI_POWER_PATH, {
      status: statusRead,
      ...(pushedReadings !== null ? { readings: pushedReadings } : {}),
    }, {
      tracker: {},
      readings: { state: 'never' },
      capacityPeak: { state: 'unavailable' },
      capacityScalars: { state: 'unavailable' },
      hardCapConfiguration: { state: 'unavailable' },
    });
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
  homey.on(POWER_TRACKER_PERSISTED_EVENT, handlePowerTrackerPersisted);
  homey.on(PLAN_STATUS_PUBLISHED_EVENT, handlePlanStatusPublished);
  homey.on(DEFERRED_OBJECTIVE_ACTIVE_PLANS_UPDATED_EVENT, handleDeferredObjectiveActivePlansUpdated);
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
    // Shares the status read above rather than sending its own.
    refreshOverviewOnStatusPoll('periodicRefresh');
    refreshCurrentPriceIfVisible();
    if (isPanelVisible('#overview-panel')) {
      // The Overview's cards are device rows. A device load that failed is
      // retried on this cadence; a loaded list is kept current by the
      // `devices_updated` push, and a card's draw comes from the plan.
      loadDevicesForOverview();
    }
  }, 30 * 1000);
};
