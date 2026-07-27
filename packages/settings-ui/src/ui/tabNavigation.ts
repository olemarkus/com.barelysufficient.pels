import { panels, tabListEntries, tabs, type MdTabElement } from './dom.ts';
import { SETTINGS_UI_POWER_PATH } from '../../../contracts/src/settingsUiApi.ts';
import { loadCapacitySettings } from './capacity.ts';
import { refreshHomeLimitsOnLimitsPanel } from './homeLimits.ts';
import { invalidateApiCacheForAllHomes } from './homey.ts';
import { refreshPriceConfigView } from './priceConfig.ts';
import { refreshDailyBudgetPlan } from './dailyBudget.ts';
import { discardBudgetAdjust, getBudgetAdjustView } from './budgetAdjustController.ts';
import { resetBudgetAdjustReturnTarget } from './budgetRedesign.ts';
import { showToast } from './toast.ts';
import { state } from './state.ts';
import { refreshDeadlinesList } from './deadlinesList.ts';
import { refreshOverviewPlanWithRescueGate } from './overviewRescueGate.ts';
import { refreshHomesOnHomesPanel } from './homesSettings.ts';
import { clearUsageReturnLink } from './usageReturnLink.ts';
import {
  refreshWeatherInsightOnBudgetTab,
  refreshWeatherInsightOnWeatherPanel,
} from './weatherInsight.ts';
import { loadDevicesOnce, refreshPowerData, runLoggedTask } from './uiRefreshTasks.ts';

/**
 * Shell navigation: which panel is visible, which shell-nav entry is lit, and
 * the per-tab work an activation kicks off. Split out of `realtime.ts` (which
 * keeps the realtime event handlers) because the two grow independently —
 * every new sub-page adds a case here, every new push adds a handler there.
 */

const REDESIGN_SETTINGS_SECTIONS = new Set([
  'limits',
  'devices',
  'modes',
  'electricity-prices',
  'price-aware-devices',
  'weather',
  'simulation',
  'advanced',
]);

const DEVICE_DEPENDENT_TABS = new Set([
  'devices',
  'modes',
  'electricity-prices',
  'price-aware-devices',
  'advanced',
]);

const runTabActivationSideEffects = (tabId: string) => {
  if (tabId === 'overview') {
    document.dispatchEvent(new Event('overview-tab-activated'));
    runLoggedTask(refreshOverviewPlanWithRescueGate(), 'Failed to refresh plan', 'showTab');
    return;
  }
  if (tabId === 'electricity-prices' || tabId === 'price-aware-devices') {
    runLoggedTask(refreshPriceConfigView(), 'Failed to refresh prices', 'showTab');
    return;
  }
  if (tabId === 'usage') {
    invalidateApiCacheForAllHomes(SETTINGS_UI_POWER_PATH);
    runLoggedTask(refreshPowerData(), 'Failed to refresh power data', 'showTab');
    return;
  }
  if (tabId === 'budget') {
    runLoggedTask(refreshDailyBudgetPlan(), 'Failed to refresh daily budget', 'showTab');
    // Lazy weather-readout fetch: no-op while the flag is off.
    runLoggedTask(refreshWeatherInsightOnBudgetTab(), 'Failed to refresh weather insight', 'showTab');
    return;
  }
  if (tabId === 'deadlines') {
    runLoggedTask(refreshDeadlinesList(), 'Failed to load deadlines list', 'showTab');
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
  if (tabId === 'homes') {
    // Refetch ui_homes on every open so edits never start from a stale list.
    runLoggedTask(refreshHomesOnHomesPanel(), 'Failed to load meter areas', 'showTab');
    return;
  }
  if (tabId === 'weather') {
    // Refresh the Weather insight picker validity lines when its sub-page opens;
    // no-op while the flag is off.
    runLoggedTask(refreshWeatherInsightOnWeatherPanel(), 'Failed to refresh weather insight', 'showTab');
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

export const showTab = (tabId: string) => {
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
  if (DEVICE_DEPENDENT_TABS.has(tabId) && !state.devicesLoaded && !state.devicesLoading) {
    loadDevicesOnce();
  }
};
