import { refreshActivityHistory } from './activityHistory.ts';
import { refreshAdvancedDeviceLogger } from './advanced.ts';
import { panels, tabListEntries, tabs, type MdTabElement } from './dom.ts';
import { SETTINGS_UI_POWER_PATH } from '../../../contracts/src/settingsUiApi.ts';
import { loadCapacitySettings } from './capacity.ts';
import { refreshHomeLimitsOnLimitsPanel } from './homeLimits.ts';
import { refreshHomeScope } from './homeScope.ts';
import { invalidateApiCacheForAllHomes } from './homey.ts';
import { openElectricityPricesView, refreshPriceConfigView } from './priceConfig.ts';
import { refreshDailyBudgetPlan } from './dailyBudget.ts';
import { discardBudgetAdjust, getBudgetAdjustView } from './budgetAdjustController.ts';
import {
  dismissSettingsAdjustOnBudgetTab,
  openBudgetAdjustFromSettings,
  openBudgetWeatherView,
  resetBudgetAdjustReturnTarget,
  showBudgetPlanView,
} from './budgetRedesign.ts';
import { showToast } from './toast.ts';
import { state } from './state.ts';
import { refreshDeadlinesList } from './deadlinesList.ts';
import { paintOverviewIfOwed, resetPlanSurfaceIfScopeChanged } from './plan.ts';
import { refreshHomesOnHomesPanel } from './homesSettings.ts';
import { clearUsageReturnLink } from './usageReturnLink.ts';
import {
  refreshWeatherInsightOnBudgetTab,
  refreshWeatherInsightOnWeatherPanel,
} from './weatherInsight.ts';
import {
  ensureDevicePanelsPainted,
  loadDevicesForOverview,
  loadDevicesOnce,
  refreshOverviewPlan,
  refreshPowerData,
  runLoggedTask,
} from './uiRefreshTasks.ts';
import { loadModeAndPriorities, renderPriorities } from './modes.ts';
import { refreshWebAppLink } from './webAppLink.ts';
import { isDeadlinePlanRoute } from './deadlineUrls.ts';
import {
  SETTINGS_SUB_PANELS,
  isBudgetViewRoute,
  isShellPanel,
  panelFromSearch,
  shellRouteUrl,
} from './shellRoutes.ts';

/**
 * Shell navigation: which panel is visible, which shell-nav entry is lit, and
 * the per-tab work an activation kicks off. Split out of `realtime.ts` (which
 * keeps the realtime event handlers) because the two grow independently —
 * every new sub-page adds a case here, every new push adds a handler there.
 */

// Every Settings sub-page lights the Settings tab.
const REDESIGN_SETTINGS_SECTIONS = new Set<string>(SETTINGS_SUB_PANELS);

const DEVICE_DEPENDENT_TABS = new Set([
  'recommendations',
  'devices',
  'modes',
  'electricity-prices',
  'price-aware-devices',
  'advanced',
]);

const refreshHomeSettingsPanel = (tabId: string): void => {
  if (tabId === 'homes') {
    runLoggedTask(refreshHomesOnHomesPanel(), 'Failed to load meter areas', 'showTab');
    return;
  }
  runLoggedTask(
    refreshHomeScope().then(async (published) => {
      // A published scope change already reloaded this visible panel through
      // its scope subscription (`uiRefreshTasks.ts`); a second reload here
      // would only repeat the same reads. Same rule for Overview and Usage.
      if (published) return;
      await loadModeAndPriorities();
      if (state.devicesLoaded) renderPriorities(state.latestDevices);
    }),
    'Failed to load modes for the selected home',
    'showTab',
  );
};

// Panels whose activation is one logged refresh. Weather refreshes the insight
// picker's validity lines (a no-op while its flag is off); the web app page
// fills in this Homey's link; Advanced loads its Homey device picker, a full
// device list no other page needs, on the first visit instead of every boot.
const SINGLE_REFRESH_PANELS: Record<string, { refresh: () => Promise<void>; failure: string }> = {
  activity: { refresh: refreshActivityHistory, failure: 'Failed to refresh activity history' },
  advanced: { refresh: refreshAdvancedDeviceLogger, failure: 'Failed to load Homey devices' },
  deadlines: { refresh: refreshDeadlinesList, failure: 'Failed to load deadlines list' },
  weather: { refresh: refreshWeatherInsightOnWeatherPanel, failure: 'Failed to refresh weather insight' },
  'web-app': { refresh: refreshWebAppLink, failure: 'Failed to prepare the web app link' },
};

const runTabActivationSideEffects = (tabId: string) => {
  const singleRefresh = SINGLE_REFRESH_PANELS[tabId];
  if (singleRefresh) {
    runLoggedTask(singleRefresh.refresh(), singleRefresh.failure, 'showTab');
    return;
  }
  if (tabId === 'overview') {
    paintOverviewIfOwed();
    // The Overview's cards are device rows, so it needs the device payload —
    // without repainting the hidden device panels, which paint on their own
    // activation.
    loadDevicesForOverview();
    // Scope-aware panel activation hook (multi-home, the Usage pattern below):
    // settle the meter-area roster — and a persisted or just-invalidated area
    // pick — BEFORE resolving which home's plan to read. A roster-refresh
    // failure keeps the last-good scope (abandon-grace) and the refresh runs.
    runLoggedTask(
      refreshHomeScope().then((published) => {
        // The Overview's scope subscription has reset and refreshed it already.
        if (published) return undefined;
        // The scope may have moved while the Overview was HIDDEN (the
        // visible-panel subscription in `uiRefreshTasks.ts` never fired for
        // it): blank the stale home's committed render before the scoped
        // refresh, so the old home's hero/cards never sit under the new
        // home's scope bar. After the roster settles, deliberately — the
        // reconcile itself can move the selection (persisted pick, deleted
        // area), and the check must compare against the scope in force.
        resetPlanSurfaceIfScopeChanged();
        return refreshOverviewPlan();
      }),
      'Failed to refresh plan',
      'showTab',
    );
    return;
  }
  if (tabId === 'electricity-prices' || tabId === 'price-aware-devices') {
    const refresh = tabId === 'electricity-prices' ? openElectricityPricesView() : refreshPriceConfigView();
    runLoggedTask(refresh, 'Failed to refresh prices', 'showTab');
    return;
  }
  if (tabId === 'usage') {
    invalidateApiCacheForAllHomes(SETTINGS_UI_POWER_PATH);
    // Scope-aware panel activation hook (multi-home): refresh the shell's
    // meter-area roster BEFORE the power read, so a persisted area pick (or a
    // just-deleted area's reconcile back to Main) is settled by the time the
    // Usage surface resolves which home to read. A roster-refresh failure
    // keeps the last-good scope (abandon-grace) and the read still runs.
    runLoggedTask(
      refreshHomeScope().then((published) => (published ? undefined : refreshPowerData())),
      'Failed to refresh power data',
      'showTab',
    );
    return;
  }
  if (tabId === 'budget') {
    runLoggedTask(refreshDailyBudgetPlan(), 'Failed to refresh daily budget', 'showTab');
    // Lazy weather-readout fetch: no-op while the flag is off.
    runLoggedTask(refreshWeatherInsightOnBudgetTab(), 'Failed to refresh weather insight', 'showTab');
    return;
  }
  if (tabId === 'limits' || tabId === 'simulation') {
    runLoggedTask(loadCapacitySettings(), 'Failed to load limits and simulation settings', 'showTab');
    // The per-home switcher + meter-area editor live on the Limits panel only.
    if (tabId === 'limits') {
      runLoggedTask(refreshHomeLimitsOnLimitsPanel(), 'Failed to load per-home limits', 'showTab');
    }
    return;
  }
  if (tabId === 'homes' || tabId === 'modes') {
    // Both area-owned settings panels refresh their authoritative home view on
    // open; Modes then reloads its selected area's catalog and filtered rows.
    refreshHomeSettingsPanel(tabId);
    return;
  }
};

const discardBudgetAdjustOnLeave = (nextTabId: string) => {
  if (nextTabId === 'budget') return;
  const onBudget = panels.some(
    (panel) => panel.dataset.panel === 'budget' && !panel.classList.contains('hidden'),
  );
  if (!onBudget) return;
  const { status } = getBudgetAdjustView();
  if (status !== 'clean') {
    // Neutral tone: an expected, recoverable notice — not an error. The
    // explicitly-confirmed Done path discards before navigating and stays
    // silent; this fires only for unconfirmed tab-bar exits.
    void showToast('Discarded unsaved budget changes.');
  }
  discardBudgetAdjust();
  resetBudgetAdjustReturnTarget();
};

// Updates only the shell-nav indicator state (active class, aria-selected,
// md-tabs `activeTabIndex`) without touching panel visibility or running
// `runTabActivationSideEffects`. Used by `deadlinePlanRouter` so a deep-link
// into the plan-detail surface keeps the "Smart tasks" breadcrumb lit on the
// shell-nav even though the visible panel is `#deadline-plan-panel` (a sibling
// of `#deadlines-panel`). Calling the full `showTab('deadlines')` here would
// hide the deadline-plan panel.
export const setActiveTabIndicator = (tabId: string): void => {
  const activeTopLevelTab = REDESIGN_SETTINGS_SECTIONS.has(tabId) ? 'settings' : tabId;
  for (const tab of tabs) {
    const isActive = tab.dataset.tab === activeTopLevelTab;
    tab.classList.toggle('active', isActive);
    tab.toggleAttribute('active', isActive);
    (tab as MdTabElement).active = isActive;
    (tab as MdTabElement).selected = isActive;
    tab.setAttribute('aria-selected', String(isActive));
  }
  for (const { tabList, tabs: tabListTabs } of tabListEntries) {
    const tabIndex = tabListTabs
      .findIndex((tab) => tab.dataset.tab === activeTopLevelTab);
    if (tabIndex >= 0) tabList.activeTabIndex = tabIndex;
  }
};

const showPanel = (tabId: string) => {
  if (tabId !== 'usage') clearUsageReturnLink();
  discardBudgetAdjustOnLeave(tabId);
  setActiveTabIndicator(tabId);
  panels.forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.panel !== tabId);
  });
  // Notify charts so they can resize against the now-visible panel width.
  // ResizeObserver alone does not reliably fire when a parent flips from
  // `display:none` → visible, leaving SVG widths stuck at the 480 px fallback.
  document.dispatchEvent(new CustomEvent('pels:tab-shown', { detail: { tabId } }));
  runTabActivationSideEffects(tabId);
  if (DEVICE_DEPENDENT_TABS.has(tabId)) {
    // The Overview may have loaded the payload already (its cards are device
    // rows), and `loadDevicesOnce` short-circuits once loaded — so an opening
    // device panel repaints from the store instead of being left empty.
    if (!state.devicesLoaded && !state.devicesLoading) loadDevicesOnce();
    else ensureDevicePanelsPainted();
  }
};

// The route on screen: a panel id, or a Budget view route that shares the
// Budget panel (see shellRoutes.ts). Back and Forward compare against it.
let currentRouteId = 'overview';

// Leaving a Budget view route for the plain Budget page closes the view, as a
// Budget-tab tap does for the editor (with the same unsaved-changes notice).
const closeBudgetViewFor = (nextRouteId: string) => {
  if (nextRouteId !== 'budget') return;
  if (currentRouteId === 'budget-adjust' && dismissSettingsAdjustOnBudgetTab()) {
    void showToast('Discarded unsaved budget changes.');
  } else if (currentRouteId === 'budget-weather') {
    showBudgetPlanView();
  }
};

// Shows a route without touching history: the router's renderer. A Budget
// view route opens its view on the Budget panel; the Daily budget editor keeps
// the Settings tab lit, as the Settings page it is.
export const renderPanel = (routeId: string) => {
  closeBudgetViewFor(routeId);
  currentRouteId = routeId;
  if (!isBudgetViewRoute(routeId)) {
    showPanel(routeId);
    return;
  }
  if (routeId === 'budget-adjust') {
    openBudgetAdjustFromSettings();
    showPanel('budget');
    setActiveTabIndicator('settings');
    return;
  }
  openBudgetWeatherView();
  showPanel('budget');
};

// History entries record the page they came from, so an app-bar back arrow
// can step back instead of piling a new entry on top.
type ShellHistoryState = { pelsShellPanel: string; pelsFrom: string };

const readShellHistoryState = (): ShellHistoryState | null => {
  const entry: unknown = window.history.state;
  if (typeof entry !== 'object' || entry === null) return null;
  const { pelsShellPanel, pelsFrom } = entry as Partial<ShellHistoryState>;
  return typeof pelsShellPanel === 'string' && typeof pelsFrom === 'string' ? { pelsShellPanel, pelsFrom } : null;
};

/**
 * Navigates to a panel: a shell page gets its own history entry and URL
 * (`?page=…`, see shellRoutes.ts), so Back, Forward, reload and links reach
 * it. A panel already named by the URL is only shown.
 */
export const showTab = (tabId: string) => {
  if (isShellPanel(tabId) && panelFromSearch(window.location.search) !== tabId) {
    const entry: ShellHistoryState = { pelsShellPanel: tabId, pelsFrom: currentRouteId };
    window.history.pushState(entry, '', shellRouteUrl(tabId, window.location));
  }
  renderPanel(tabId);
};

// Shows a panel in place of the current history entry, for a page that
// replaces another (a closed Smart task landing on its fallback tab).
export const replaceTab = (tabId: string) => {
  if (isShellPanel(tabId)) {
    const entry: ShellHistoryState = { pelsShellPanel: tabId, pelsFrom: readShellHistoryState()?.pelsFrom ?? '' };
    window.history.replaceState(entry, '', shellRouteUrl(tabId, window.location));
  }
  renderPanel(tabId);
};

// An app-bar back arrow: step back when this page was opened from its parent,
// so the history matches what the arrow did; otherwise open the parent.
export const navigateBackTo = (parentId: string) => {
  if (readShellHistoryState()?.pelsFrom === parentId) {
    window.history.back();
    return;
  }
  showTab(parentId);
};

// The panel the page opens on: the one its URL names, else the Overview.
export const initialShellPanel = (): string => panelFromSearch(window.location.search) ?? 'overview';

const isDeadlinePlanShown = (): boolean => (
  document.getElementById('deadline-plan-panel')?.classList.contains('hidden') === false
);

// Back and Forward show the page the URL names. The Smart task router owns its
// own routes and closes its panel itself; an entry for the page already shown
// (the device detail overlay's) changes nothing.
export const initShellRouter = () => {
  window.addEventListener('popstate', () => {
    if (isDeadlinePlanRoute(window.location.search) || isDeadlinePlanShown()) return;
    const routeId = panelFromSearch(window.location.search) ?? 'overview';
    if (routeId === currentRouteId) return;
    renderPanel(routeId);
  });
};
