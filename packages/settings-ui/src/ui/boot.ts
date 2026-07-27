import { showUsageDayToday } from './usageDayView.ts';
import { syncSettingsHubChips } from './settingsHubChips.ts';
import './materialWeb.ts';
import {
  emptyState,
  refreshButton,
  electricityPricesSurface,
  priceAwareDevicesSurface,
  settingsLimitsForm,
  settingsCapacityLimitInput,
  settingsCapacityMarginInput,
  settingsPowerSourceSelect,
  settingsSimulationModeInput,
  simulationDisableButton,
  type MdSwitchElement,
  priorityForm,
  resetStatsButton,
  tabs,
} from './dom.ts';
import {
  SETTINGS_UI_BOOTSTRAP_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
  SETTINGS_UI_PRICES_PATH,
  type SettingsUiBootstrap,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  applySettingsPatch,
  callApi,
  getSetting,
  primeApiCache,
  setSetting,
  waitForHomey,
} from './homey.ts';
import { showToast, showToastError } from './toast.ts';
import { refreshDevices, renderDevices } from './devices.ts';
import { refreshPowerData } from './uiRefreshTasks.ts';
import {
  loadCapacitySettings,
  loadAdvancedSettings,
  loadStaleDataStatus,
  refreshLimitsValidationHints,
  saveSettingsLimitsSettings,
  saveSimulationModeSettings,
  syncDryRunBannerVisibility,
} from './capacity.ts';
import { initHomeScope, selectHomeScope } from './homeScope.ts';
import { initHomeyEnergyMeterHandlers } from './homeyEnergyMeter.ts';
import {
  DEBUG_LOGGING_TOPICS as DEBUG_LOGGING_TOPICS_SETTING,
  MAIN_HOME_ID,
} from '../../../contracts/src/settingsKeys.ts';
import {
  DEBUG_LOGGING_SCENARIOS,
  type DebugLoggingScenarioId,
  type DebugLoggingTopic,
  isDebugLoggingScenarioId,
  normalizeDebugLoggingTopics,
  scenarioIdsToTopics,
  topicsToScenarioIds,
} from '../../../shared-domain/src/utils/debugLogging.ts';
import { removeLegacyTopicsHint, renderLegacyTopicsHint } from './debugLoggingHint.ts';
import {
  initModeHandlers,
  loadModeAndPriorities,
  renderModeOptions,
  renderPriorities,
} from './modes.ts';
import { initElectricityPricesView, initPriceAwareDevicesView } from './priceConfig.ts';
import {
  initDailyBudgetHandlers,
  refreshDailyBudgetPlan,
  updateBudgetPower,
} from './dailyBudget.ts';
import { loadBudgetAdjust } from './budgetAdjustController.ts';
import {
  dismissSettingsAdjustOnBudgetTab,
  openBudgetAdjustFromSettings,
  openBudgetWeatherView,
  setBudgetAdjustSettingsNavigator,
  setBudgetUsageNavigator,
} from './budgetRedesign.ts';
import { initWeatherInsight } from './weatherInsight.ts';
import {
  initDeviceDetailHandlers,
  loadEvBoostSettings,
  loadShedBehaviors,
  loadTemperatureBoostSettings,
} from './deviceDetail/index.ts';
import { loadDeferredObjectiveSettings } from './deferredObjectiveSettings.ts';
import { loadStarvationRescuableDevices } from './starvationRescue.ts';
import { coerceDeferredObjectiveActivePlans } from './deferredObjectiveActivePlans.ts';
import { loadDeviceControlProfiles } from './deviceControlProfiles.ts';
import {
  initAdvancedDeviceCleanupHandlers,
  initAdvancedDeviceLoggerHandlers,
  refreshAdvancedDeviceLogger,
} from './advanced.ts';
import { state } from './state.ts';
import { flushSettingsLogs, logSettingsError, logSettingsWarn } from './logging.ts';
import {
  markSettingsUi,
  markSettingsUiReady,
  measureSettingsUi,
  resetSettingsUiPerf,
} from './perf.ts';
import { initTooltips } from './tooltips.ts';
import { initDebouncedSaveFlush } from './utils.ts';
import { handleResetStats } from './resetStats.ts';
import { createSwitchField } from './components.ts';
import {
  initRealtimeListeners,
  setActiveTabIndicator,
  showTab,
  startStaleDataRefreshInterval,
} from './realtime.ts';
import {
  mountDeadlinePlan,
  setDeadlinePlanCloseHandler,
  unmountDeadlinePlan,
} from './deadlinePlanMount.ts';
import { initDeadlinePlanRouter } from './deadlinePlanRouter.ts';

// `showTab` only STARTS the target panel's async scope work (a Main-only deep
// link switches scope first, and the panel's activation hook re-reads the
// roster and re-renders), so the promised control can stay hidden for several
// frames after the click handler returns. Scrolling immediately would anchor
// against a hidden element and leave the user at the panel top, so poll
// visibility across frames, bounded so a typo'd selector or a removed control
// degrades to landing at the panel top instead of polling forever.
const SETTINGS_ANCHOR_SCROLL_FRAMES = 60;
const scrollSettingsAnchorWhenVisible = (selector: string, attempt = 0): void => {
  let element: Element | null;
  try {
    element = document.querySelector(selector);
  } catch (error) {
    void logSettingsError('Invalid settings anchor selector', error, 'settingsAnchor');
    return;
  }
  if (element instanceof HTMLElement && element.offsetParent !== null) {
    element.scrollIntoView({ block: 'center' });
    return;
  }
  if (attempt >= SETTINGS_ANCHOR_SCROLL_FRAMES) return;
  requestAnimationFrame(() => scrollSettingsAnchorWhenVisible(selector, attempt + 1));
};

const initTabHandlers = () => {
  // The Budget header's Done button navigates back to Settings through
  // showTab so the leave path (draft discard, referrer reset, toast) stays
  // identical to a tab-bar exit.
  setBudgetAdjustSettingsNavigator(() => showTab('settings'));
  setBudgetUsageNavigator(() => {
    // The recourse answers "what used the energy TODAY" — reset a lingering
    // Yesterday selection before the jump.
    showUsageDayToday();
    // The daily budget is a Main-home constraint (multi-home keeps budgets
    // whole-home), so the destination must show Main's history — a lingering
    // meter-area selection could never explain the overage. Same scope-first
    // precedent as the `data-settings-home-scope` deep links below.
    selectHomeScope(MAIN_HOME_ID);
    showTab('usage');
  });
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const tabId = (tab as HTMLElement).dataset.tab || 'devices';
      // A real Budget-tab tap must leave any settings-referred Daily-budget
      // editor (opened via the budget-adjust deep-link, which keeps the
      // Settings indicator lit) and land on the normal Budget overview.
      // showTab('budget') can't do this alone: discardBudgetAdjustOnLeave
      // early-returns for nextTabId 'budget', so the adjust sub-view + its
      // "back to Settings" exit would persist under a now-Budget-lit tab.
      if (tabId === 'budget' && dismissSettingsAdjustOnBudgetTab()) {
        // Mirror the notice a sibling tab-bar exit shows on an unconfirmed
        // discard (discardBudgetAdjustOnLeave in realtime.ts).
        void showToast('Discarded unsaved budget changes.');
      }
      showTab(tabId);
    });
  });
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const trigger = event.target.closest<HTMLElement>('[data-settings-target]');
    const target = trigger?.dataset.settingsTarget;
    if (!target) return;
    // 'budget-adjust' is a virtual target: it matches no data-panel, and
    // letting it reach showTab would hide every panel. Open the Budget tab
    // with the Adjust view active and a Settings return target instead.
    // Keep the "Settings" tab indicator lit (the Daily budget editor is a
    // Settings sub-page, exactly like its eight `.pels-appbar` siblings), so
    // opening it doesn't read as a teleport to a different tab — the same
    // sibling-panel indicator trick the deadline-plan deep-link uses.
    if (target === 'budget-adjust') {
      openBudgetAdjustFromSettings();
      showTab('budget');
      setActiveTabIndicator('settings');
      return;
    }
    // 'budget-weather' is the same kind of virtual target: open the Budget
    // tab with the Weather insight detail view active (deep-link parity).
    if (target === 'budget-weather') {
      openBudgetWeatherView();
      showTab('budget');
      return;
    }
    // Some deep links promise a control that only exists in the Main home's
    // scope (Power source, the whole-home meter). Following one while a meter
    // area is selected would land the user on a page whose promised target is
    // hidden, so the link names the scope it needs and we switch first.
    if (trigger.dataset.settingsHomeScope === MAIN_HOME_ID) selectHomeScope(MAIN_HOME_ID);
    showTab(target);
    // Optional deep-link anchor: land on the field the trigger promised, not
    // the top of the target panel (e.g. the no-data banner's "Choose power
    // source" scrolls the Power source select into view on Limits & safety).
    // The selector is repo-authored markup; guard anyway so a typo degrades to
    // landing at the panel top instead of an uncaught DOMException.
    const anchor = trigger.dataset.settingsAnchor;
    if (anchor) scrollSettingsAnchorWhenVisible(anchor);
  });
  // Track the shown panel so the global simulation banner can suppress itself on
  // the Simulation-mode settings page (its own toggle is the single control
  // there). `showTab` already emits `pels:tab-shown`, so this stays off the
  // realtime module's line ceiling.
  document.addEventListener('pels:tab-shown', (event) => {
    const tabId = (event as CustomEvent<{ tabId?: string }>).detail?.tabId;
    // Coerce at the boundary: always overwrite `activePanel` (empty string on a
    // missing/non-string id) so a stale `'simulation'` can never stick and keep
    // the banner hidden after navigating away.
    state.activePanel = typeof tabId === 'string' ? tabId : '';
    syncDryRunBannerVisibility();
  });
};

const initLimitsAndSimulationHandlers = () => {
  const autoSaveSettingsLimits = async (options?: { includePowerSource?: boolean }) => {
    try {
      await saveSettingsLimitsSettings(options);
    } catch (error) {
      await logSettingsError('Failed to save limits and safety settings', error, 'autoSaveSettingsLimits');
      await showToastError(error, 'Failed to save limits and safety settings.');
    }
  };
  settingsCapacityLimitInput?.addEventListener('input', refreshLimitsValidationHints);
  settingsCapacityMarginInput?.addEventListener('input', refreshLimitsValidationHints);
  settingsCapacityLimitInput?.addEventListener('change', () => autoSaveSettingsLimits());
  settingsCapacityMarginInput?.addEventListener('change', () => autoSaveSettingsLimits());
  // Only the select's own change may carry power_source into the save — see
  // the persist guard in saveCapacitySettingsPatch.
  settingsPowerSourceSelect?.addEventListener('change', () => autoSaveSettingsLimits({ includePowerSource: true }));
  // The meter select persists itself (its options load lazily, so routing it
  // through the bulk limits save could write an empty value before they load).
  initHomeyEnergyMeterHandlers();
  settingsLimitsForm?.addEventListener('submit', (event) => event.preventDefault());
  settingsSimulationModeInput?.addEventListener('change', async () => {
    try {
      await saveSimulationModeSettings();
    } catch (error) {
      await logSettingsError('Failed to save simulation mode setting', error, 'settingsSimulationModeInput');
      await showToastError(error, 'Failed to save simulation mode setting.');
    }
  });
  simulationDisableButton?.addEventListener('click', async () => {
    try {
      await saveSimulationModeSettings(false);
    } catch (error) {
      await logSettingsError('Failed to turn off simulation mode', error, 'simulationDisableButton');
      await showToastError(error, 'Failed to turn off simulation mode.');
    }
  });
  priorityForm?.addEventListener('submit', (event) => {
    event.preventDefault();
  });
  refreshButton.addEventListener('click', () => {
    void refreshDevices();
  });
  if (resetStatsButton) {
    resetStatsButton.addEventListener('click', () => handleResetStats(resetStatsButton));
  } else {
    void logSettingsWarn('Reset stats button not found', undefined, 'initLimitsAndSimulationHandlers');
  }
};


const initDebugLoggingSwitches = () => {
  const mount = document.getElementById('debug-logging-checkboxes');
  if (!mount) return;
  mount.replaceChildren();
  removeLegacyTopicsHint();
  DEBUG_LOGGING_SCENARIOS.forEach(({ id, label, description }) => {
    const { element, input } = createSwitchField({
      id: `debug-scenario-${id}`,
      label,
      hint: description,
    });
    input.dataset.debugScenario = id;
    mount.appendChild(element);
  });
};

const readSelectedScenarioIds = (): DebugLoggingScenarioId[] => {
  const inputs = Array.from(document.querySelectorAll<MdSwitchElement>('[data-debug-scenario]'));
  const ids: DebugLoggingScenarioId[] = [];
  inputs.forEach((input) => {
    if (!input.selected) return;
    const raw = input.dataset.debugScenario;
    if (isDebugLoggingScenarioId(raw)) ids.push(raw);
  });
  return ids;
};

const readPersistedUnmatchedTopics = async (): Promise<DebugLoggingTopic[]> => {
  const raw = await getSetting(DEBUG_LOGGING_TOPICS_SETTING);
  const topics = normalizeDebugLoggingTopics(raw);
  return topicsToScenarioIds(topics).unmatched;
};

const initAdvancedHandlers = () => {
  let saveQueue: Promise<void> = Promise.resolve();
  const saveDebugTopics = (): Promise<void> => {
    saveQueue = saveQueue.then(async () => {
      try {
        const scenarioIds = readSelectedScenarioIds();
        const scenarioTopics = scenarioIdsToTopics(scenarioIds);
        const carriedLegacyTopics = await readPersistedUnmatchedTopics();
        const merged: DebugLoggingTopic[] = [...scenarioTopics];
        carriedLegacyTopics.forEach((topic) => {
          if (!merged.includes(topic)) merged.push(topic);
        });
        await setSetting(DEBUG_LOGGING_TOPICS_SETTING, merged);
        await setSetting('debug_logging_enabled', merged.length > 0);
        const mount = document.getElementById('debug-logging-checkboxes');
        if (mount) {
          const { unmatched } = topicsToScenarioIds(merged);
          renderLegacyTopicsHint(mount, unmatched);
        }
        await showToast(
          merged.length ? 'Debug logging updated.' : 'Debug logging disabled.',
          'ok',
        );
      } catch (error) {
        await logSettingsError('Failed to update debug logging setting', error, 'debugLoggingScenarios');
        await showToastError(error, 'Failed to update debug logging setting.');
      }
    }).catch(() => {});
    return saveQueue;
  };

  document.querySelectorAll<MdSwitchElement>('[data-debug-scenario]').forEach((input) => {
    input.addEventListener('change', () => {
      void saveDebugTopics();
    });
  });

  initAdvancedDeviceCleanupHandlers();
  initAdvancedDeviceLoggerHandlers();
};

const loadBootstrapData = async (): Promise<SettingsUiBootstrap | null> => {
  try {
    const bootstrap = await callApi<SettingsUiBootstrap>('GET', SETTINGS_UI_BOOTSTRAP_PATH);
    if (!bootstrap || typeof bootstrap !== 'object') {
      return null;
    }
    if (bootstrap?.settings && typeof bootstrap.settings === 'object') {
      applySettingsPatch(bootstrap.settings);
    }
    primeApiCache(SETTINGS_UI_PLAN_PATH, { plan: bootstrap.plan ?? null });
    primeApiCache(SETTINGS_UI_POWER_PATH, bootstrap.power);
    // Seed the Budget price-level chip from cached power status so the chip
    // is visible on first render. Without this it stays hidden until the
    // first `power_updated` realtime push lands (gh-address-comments review
    // on PR #884; chatgpt-codex finding).
    updateBudgetPower(bootstrap.power?.status ?? null);
    primeApiCache(SETTINGS_UI_PRICES_PATH, bootstrap.prices);
    // Persist active plans so device cards can read EV schedule state without
    // re-fetching the full bootstrap on every render cycle. Realtime replans
    // refresh this same state via `reloadDeferredObjectiveActivePlans` on the
    // `deferred_objective_active_plans` settings event; both paths funnel
    // through the shared shape guard so the seed and the re-read can't drift.
    state.deferredObjectiveActivePlans = coerceDeferredObjectiveActivePlans(
      bootstrap.deferredObjectiveActivePlans,
    );
    return bootstrap;
  } catch {
    return null;
  }
};

const loadInitialData = async (bootstrap: SettingsUiBootstrap | null) => {
  // Phase 1: Load mode/priorities FIRST to populate managedMap before any rendering
  // This prevents the race condition where users see empty checkboxes
  await loadModeAndPriorities();

  // Phase 2: Load remaining settings in parallel for faster load time
  await Promise.all([
    loadCapacitySettings(),
    loadBudgetAdjust(),
    loadStaleDataStatus(),
    loadDeviceControlProfiles(),
    loadShedBehaviors(),
    loadTemperatureBoostSettings(),
    loadEvBoostSettings(),
    loadDeferredObjectiveSettings(),
    loadStarvationRescuableDevices(),
    loadAdvancedSettings(),
    initWeatherInsight(),
  ]);
  // Hub exception chips need the loads above (dry-run state, budget setting,
  // power/price payloads) — one sync after the parallel phase settles.
  syncSettingsHubChips();

  // Phase 3: Render everything once with all state populated
  // Device-dependent renders (renderPriorities, renderDevices)
  // are deferred to first tab open via lazy loading in showTab().
  //
  // Budget payload before the first power-stats render: the Usage tab's
  // daily-history chart sources its budget overlay from the active
  // daily-budget payload (`activeDailyBudget.ts`), so the mark line and
  // readout context are present from first paint.
  await refreshDailyBudgetPlan(bootstrap?.dailyBudget);
  // The bootstrap Usage paint goes through the generation-fenced refresh, not
  // a directly captured read: handlers are interactive before this point, so a
  // scope pick made mid-boot has already painted the picked home via its own
  // `refreshPowerData` run — a separately captured Main payload rendered here
  // would overwrite that home's hourly chart with Main's entries while the
  // stats pass recomputes the hero for the picked scope, mixing two homes on
  // one panel. Routing through the same entry re-reads under the CURRENT
  // scope, and a pick landing mid-flight supersedes this run instead of racing
  // it.
  await refreshPowerData();
  renderModeOptions();
  await refreshAdvancedDeviceLogger();

  // Phase 4: Mark initial load complete - enables save operations
  state.initialLoadComplete = true;
  // If devices were loaded mid-boot (user visited a device tab before loadInitialData finished),
  // re-render all device-dependent views so checkboxes are enabled and the loading notice is cleared.
  if (state.devicesLoaded) {
    renderDevices(state.latestDevices);
    renderPriorities(state.latestDevices);
  }
};

const initializeBootHandlers = () => {
  initTooltips();
  initDebouncedSaveFlush();
  initRealtimeListeners();
  showTab('overview');
  initTabHandlers();
  // After initTabHandlers: the scope bar's visibility depends on the shown
  // panel, and that handler is what updates `state.activePanel` for the
  // `pels:tab-shown` event both listeners receive.
  initHomeScope();
  initDeviceDetailHandlers();
  initModeHandlers();
  initLimitsAndSimulationHandlers();
  initDailyBudgetHandlers();
  if (electricityPricesSurface) {
    void initElectricityPricesView(electricityPricesSurface);
  }
  if (priceAwareDevicesSurface) {
    void initPriceAwareDevicesView(priceAwareDevicesSurface);
  }
  initDebugLoggingSwitches();
  initAdvancedHandlers();
  markSettingsUi('boot:handlers-ready');
};

const markBootComplete = () => {
  markSettingsUi('boot:data-loaded');
  measureSettingsUi('boot:homey-ready', 'boot:start', 'boot:homey-ready');
  measureSettingsUi('boot:bootstrap', 'boot:homey-ready', 'boot:bootstrap-loaded');
  measureSettingsUi('boot:handlers', 'boot:bootstrap-loaded', 'boot:handlers-ready');
  measureSettingsUi('boot:data-load', 'boot:handlers-ready', 'boot:data-loaded');
  measureSettingsUi('boot:total', 'boot:start', 'boot:data-loaded');
  markSettingsUiReady();
};

const startDailyBudgetRefreshInterval = () => {
  setInterval(() => {
    const budgetPanel = document.querySelector('#budget-panel');
    if (!budgetPanel || budgetPanel.classList.contains('hidden')) return;
    refreshDailyBudgetPlan().catch((error) => {
      void logSettingsError('Failed to refresh daily budget', error, 'dailyBudgetInterval');
    });
  }, 60 * 1000);
};

const prepareHomeySdk = async () => {
  const found = await waitForHomey(200, 100);
  if (found) {
    await found.ready();
    await flushSettingsLogs();
    markSettingsUi('boot:homey-ready');
    return true;
  }
  emptyState.hidden = false;
  emptyState.textContent = 'Homey SDK not available. Make sure you are logged in and opened the settings from Homey.';
  await showToast('Homey SDK not available. Check your Homey session/connection.', 'warn');
  return false;
};

export const boot = async () => {
  resetSettingsUiPerf();
  markSettingsUi('boot:start');
  try {
    const hasHomey = await prepareHomeySdk();
    if (!hasHomey) {
      return;
    }
    const bootstrap = await loadBootstrapData();
    markSettingsUi('boot:bootstrap-loaded');
    initializeBootHandlers();
    await loadInitialData(bootstrap);
    initDeadlinePlanRouter({
      mount: mountDeadlinePlan,
      unmount: unmountDeadlinePlan,
      setCloseHandler: setDeadlinePlanCloseHandler,
    });
    startStaleDataRefreshInterval();
    markBootComplete();
    startDailyBudgetRefreshInterval();
  } catch (error) {
    await logSettingsError('Settings UI failed to load', error, 'boot');
    await showToastError(error, 'Unable to load settings. Check Homey logs for details.');
  }
};
