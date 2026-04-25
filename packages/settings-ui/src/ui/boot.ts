import {
  emptyState,
  tabs,
  refreshButton,
  planRefreshButton,
  priceSettingsForm,
  priceSchemeSelect,
  norwayPriceModelSelect,
  priceAreaSelect,
  providerSurchargeInput,
  priceThresholdInput,
  priceMinDiffInput,
  priceRefreshButton,
  priceOptimizationEnabledCheckbox,
  advancedOverviewRedesignEnabledInput,
  advancedOverviewRedesignRow,
  advancedEvSupportEnabledInput,
  gridTariffSettingsForm,
  gridTariffCountySelect,
  gridTariffCompanySelect,
  gridTariffGroupSelect,
  gridTariffRefreshButton,
  capacityForm,
  capacityLimitInput,
  capacityMarginInput,
  capacityDryRunInput,
  powerSourceSelect,
  priorityForm,
} from './dom.ts';
import {
  SETTINGS_UI_BOOTSTRAP_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
  SETTINGS_UI_PRICES_PATH,
  SETTINGS_UI_REFRESH_GRID_TARIFF_PATH,
  SETTINGS_UI_REFRESH_PRICES_PATH,
  type SettingsUiBootstrap,
  type SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  applySettingsPatch,
  callApi,
  primeApiCache,
  setSetting,
  waitForHomey,
} from './homey.ts';
import { showToast, showToastError } from './toast.ts';
import { refreshDevices, renderDevices } from './devices.ts';
import { getPowerUsage, renderPowerStats, renderPowerUsage } from './power.ts';
import { loadCapacitySettings, loadAdvancedSettings, loadStaleDataStatus, saveCapacitySettings } from './capacity.ts';
import {
  DEBUG_LOGGING_TOPICS as DEBUG_LOGGING_TOPICS_SETTING,
  EXPERIMENTAL_EV_SUPPORT_ENABLED,
  PRICE_OPTIMIZATION_ENABLED,
} from '../../../contracts/src/settingsKeys.ts';
import {
  DEBUG_LOGGING_TOPICS as AVAILABLE_DEBUG_LOGGING_TOPICS,
} from '../../../shared-domain/src/utils/debugLogging.ts';
import {
  initModeHandlers,
  loadModeAndPriorities,
  renderModeOptions,
  renderPriorities,
} from './modes.ts';
import {
  loadPriceSettings,
  refreshPrices,
  loadGridTariffSettings,
  refreshGridTariff,
  savePriceSettings,
  saveGridTariffSettings,
  updateGridCompanyOptions,
  updatePriceSchemeUiFromSelection,
} from './prices.ts';
import { loadPriceOptimizationSettings, renderPriceOptimization } from './priceOptimization.ts';
import {
  initDailyBudgetHandlers,
  loadDailyBudgetSettings,
  refreshDailyBudgetPlan,
} from './dailyBudget.ts';
import {
  initDailyBudgetTuningHandlers,
  loadDailyBudgetTuningSettings,
} from './dailyBudgetTuning.ts';
import { initDeviceDetailHandlers, loadShedBehaviors } from './deviceDetail/index.ts';
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
import { createCheckboxField } from './components.ts';
import {
  initRealtimeListeners,
  showTab,
  startStaleDataRefreshInterval,
} from './realtime.ts';
import { refreshPlan } from './plan.ts';
import {
  applySettingsUiVariant,
  applyStoredOverviewRedesignPreference,
  getStoredOverviewRedesignPreference,
  setStoredOverviewRedesignPreference,
} from './uiVariant.ts';

let canToggleOverviewRedesign = false;

const initTabHandlers = () => {
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => showTab((tab as HTMLElement).dataset.tab || 'devices'));
  });
};

const initCapacityHandlers = () => {
  const autoSaveCapacity = async () => {
    try {
      await saveCapacitySettings();
    } catch (error) {
      await logSettingsError('Failed to save capacity settings', error, 'autoSaveCapacity');
      await showToastError(error, 'Failed to save capacity settings.');
    }
  };
  capacityLimitInput?.addEventListener('change', autoSaveCapacity);
  capacityMarginInput?.addEventListener('change', autoSaveCapacity);
  capacityDryRunInput?.addEventListener('change', autoSaveCapacity);
  powerSourceSelect?.addEventListener('change', autoSaveCapacity);
  capacityForm.addEventListener('submit', (event) => event.preventDefault());
  priorityForm?.addEventListener('submit', (event) => {
    event.preventDefault();
  });
  refreshButton.addEventListener('click', () => {
    void refreshDevices();
  });
  planRefreshButton?.addEventListener('click', () => {
    void refreshPlan().catch((error) => {
      void logSettingsError('Failed to refresh plan', error, 'planRefreshButton');
    });
  });
  /* 2-step confirmation logic */
  const resetStatsBtn = document.getElementById('reset-stats-button') as HTMLButtonElement;
  if (resetStatsBtn) {
    resetStatsBtn.addEventListener('click', () => handleResetStats(resetStatsBtn));
  } else {
    void logSettingsWarn('Reset stats button not found', undefined, 'initCapacityHandlers');
  }
};

const initPriceHandlers = () => {
  const autoSavePriceSettings = async () => {
    try {
      await savePriceSettings();
    } catch (error) {
      await logSettingsError('Failed to save price settings', error, 'autoSavePriceSettings');
      await showToastError(error, 'Failed to save price settings.');
    }
  };
  priceSchemeSelect?.addEventListener('change', () => {
    updatePriceSchemeUiFromSelection();
    void autoSavePriceSettings();
  });
  norwayPriceModelSelect?.addEventListener('change', () => {
    updatePriceSchemeUiFromSelection();
    void autoSavePriceSettings();
  });
  priceAreaSelect?.addEventListener('change', autoSavePriceSettings);
  providerSurchargeInput?.addEventListener('change', autoSavePriceSettings);
  priceThresholdInput?.addEventListener('change', autoSavePriceSettings);
  priceMinDiffInput?.addEventListener('change', autoSavePriceSettings);
  priceSettingsForm?.addEventListener('submit', (event) => event.preventDefault());
  priceRefreshButton?.addEventListener('click', async () => {
    try {
      const response = await callApi<SettingsUiPricesPayload>('POST', SETTINGS_UI_REFRESH_PRICES_PATH, {});
      primeApiCache(SETTINGS_UI_PRICES_PATH, response);
      await refreshPrices();
    } catch (error) {
      await logSettingsError('Failed to refresh spot prices', error, 'priceRefreshButton');
      await showToastError(error, 'Failed to refresh spot prices.');
    }
  });
  priceOptimizationEnabledCheckbox?.addEventListener('change', async () => {
    try {
      await setSetting(PRICE_OPTIMIZATION_ENABLED, priceOptimizationEnabledCheckbox.checked);
      await showToast(
        priceOptimizationEnabledCheckbox.checked ? 'Price optimization enabled.' : 'Price optimization disabled.',
        'ok',
      );
    } catch (error) {
      await logSettingsError('Failed to update price optimization setting', error, 'priceOptimizationEnabledCheckbox');
      await showToastError(error, 'Failed to update price optimization setting.');
    }
  });
};

const initGridTariffHandlers = () => {
  const autoSaveGridTariffSettings = async () => {
    try {
      await saveGridTariffSettings();
    } catch (error) {
      await logSettingsError('Failed to save grid tariff settings', error, 'autoSaveGridTariffSettings');
      await showToastError(error, 'Failed to save grid tariff settings.');
    }
  };
  gridTariffCompanySelect?.addEventListener('change', autoSaveGridTariffSettings);
  gridTariffGroupSelect?.addEventListener('change', autoSaveGridTariffSettings);
  gridTariffSettingsForm?.addEventListener('submit', (event) => event.preventDefault());
  gridTariffCountySelect?.addEventListener('change', () => {
    updateGridCompanyOptions(gridTariffCountySelect.value);
  });
  gridTariffRefreshButton?.addEventListener('click', async () => {
    try {
      const response = await callApi<SettingsUiPricesPayload>('POST', SETTINGS_UI_REFRESH_GRID_TARIFF_PATH, {});
      primeApiCache(SETTINGS_UI_PRICES_PATH, response);
      await refreshGridTariff();
    } catch (error) {
      await logSettingsError('Failed to refresh grid tariffs', error, 'gridTariffRefreshButton');
      await showToastError(error, 'Failed to refresh grid tariffs.');
    }
  });
};

const initDebugLoggingCheckboxes = () => {
  const mount = document.getElementById('debug-logging-checkboxes');
  if (!mount) return;
  mount.replaceChildren();
  AVAILABLE_DEBUG_LOGGING_TOPICS.forEach(({ id, label, description }) => {
    const { element, input } = createCheckboxField({ id: `debug-topic-${id}`, label, hint: description });
    input.dataset.debugTopic = id;
    mount.appendChild(element);
  });
};

const initAdvancedHandlers = () => {
  const saveDebugTopics = async () => {
    try {
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('[data-debug-topic]'));
      const selected = inputs
        .filter((input) => input.checked && typeof input.dataset.debugTopic === 'string')
        .map((input) => input.dataset.debugTopic as string);
      await setSetting(DEBUG_LOGGING_TOPICS_SETTING, selected);
      await setSetting('debug_logging_enabled', selected.length > 0);
      await showToast(
        selected.length ? 'Debug logging updated.' : 'Debug logging disabled.',
        'ok',
      );
    } catch (error) {
      await logSettingsError('Failed to update debug logging setting', error, 'debugLoggingTopics');
      await showToastError(error, 'Failed to update debug logging setting.');
    }
  };

  document.querySelectorAll<HTMLInputElement>('[data-debug-topic]').forEach((input) => {
    input.addEventListener('change', () => {
      void saveDebugTopics();
    });
  });

  advancedEvSupportEnabledInput?.addEventListener('change', async () => {
    try {
      await setSetting(EXPERIMENTAL_EV_SUPPORT_ENABLED, advancedEvSupportEnabledInput.checked);
      await showToast(
        advancedEvSupportEnabledInput.checked
          ? 'EV charger support enabled.'
          : 'EV charger support disabled. Managed EV chargers were set to unmanaged.',
        'ok',
      );
    } catch (error) {
      await logSettingsError('Failed to update EV charger support setting', error, 'advancedEvSupportEnabledInput');
      await showToastError(error, 'Failed to update EV charger support setting.');
    }
  });

  advancedOverviewRedesignEnabledInput?.addEventListener('change', async () => {
    try {
      if (!canToggleOverviewRedesign) {
        advancedOverviewRedesignEnabledInput.checked = getStoredOverviewRedesignPreference();
        applyStoredOverviewRedesignPreference(false);
        return;
      }
      const enabled = advancedOverviewRedesignEnabledInput.checked;
      setStoredOverviewRedesignPreference(enabled);
      applySettingsUiVariant(enabled ? 'redesign' : 'legacy');
      await refreshPlan();
      await showToast(
        enabled ? 'Overview redesign enabled.' : 'Overview redesign disabled.',
        'ok',
      );
    } catch (error) {
      await logSettingsError(
        'Failed to update Overview redesign preference',
        error,
        'advancedOverviewRedesignEnabledInput',
      );
      await showToastError(error, 'Failed to update Overview redesign preference.');
    }
  });

  initAdvancedDeviceCleanupHandlers();
  initAdvancedDeviceLoggerHandlers();
  initDailyBudgetTuningHandlers();
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
    primeApiCache(SETTINGS_UI_PRICES_PATH, bootstrap.prices);
    return bootstrap;
  } catch {
    return null;
  }
};

const applyOverviewRedesignBootstrap = (bootstrap: SettingsUiBootstrap | null) => {
  canToggleOverviewRedesign = bootstrap?.featureAccess?.canToggleOverviewRedesign === true;
  if (advancedOverviewRedesignRow) {
    advancedOverviewRedesignRow.hidden = !canToggleOverviewRedesign;
  }
  if (advancedOverviewRedesignEnabledInput) {
    advancedOverviewRedesignEnabledInput.checked = getStoredOverviewRedesignPreference();
  }
  applyStoredOverviewRedesignPreference(canToggleOverviewRedesign);
};

const loadInitialData = async (bootstrap: SettingsUiBootstrap | null) => {
  // Phase 1: Load mode/priorities FIRST to populate managedMap before any rendering
  // This prevents the race condition where users see empty checkboxes
  await loadModeAndPriorities();

  // Phase 2: Load remaining settings in parallel for faster load time
  const [usage] = await Promise.all([
    getPowerUsage(),
    loadCapacitySettings(),
    loadDailyBudgetSettings(),
    loadDailyBudgetTuningSettings(),
    loadStaleDataStatus(),
    loadDeviceControlProfiles(),
    loadShedBehaviors(),
    loadPriceOptimizationSettings(),
    loadPriceSettings(),
    loadGridTariffSettings(),
    loadAdvancedSettings(),
  ]);

  // Phase 3: Render everything once with all state populated
  // Device-dependent renders (renderPriorities, renderDevices, renderPriceOptimization)
  // are deferred to first tab open via lazy loading in showTab().
  renderPowerUsage(usage);
  await renderPowerStats();
  renderModeOptions();
  await refreshAdvancedDeviceLogger();
  await refreshPrices();
  await refreshGridTariff();
  await refreshDailyBudgetPlan(bootstrap?.dailyBudget);

  // Phase 4: Mark initial load complete - enables save operations
  state.initialLoadComplete = true;
  // If devices were loaded mid-boot (user visited a device tab before loadInitialData finished),
  // re-render all device-dependent views so checkboxes are enabled and the loading notice is cleared.
  if (state.devicesLoaded) {
    renderDevices(state.latestDevices);
    renderPriorities(state.latestDevices);
    renderPriceOptimization(state.latestDevices);
  }
};

const initializeBootHandlers = (bootstrap: SettingsUiBootstrap | null) => {
  applyOverviewRedesignBootstrap(bootstrap);
  initTooltips();
  initDebouncedSaveFlush();
  initRealtimeListeners();
  showTab('overview');
  initTabHandlers();
  initDeviceDetailHandlers();
  initModeHandlers();
  initCapacityHandlers();
  initDailyBudgetHandlers();
  initPriceHandlers();
  initGridTariffHandlers();
  initDebugLoggingCheckboxes();
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
    initializeBootHandlers(bootstrap);
    await loadInitialData(bootstrap);
    startStaleDataRefreshInterval();
    markBootComplete();
    startDailyBudgetRefreshInterval();
  } catch (error) {
    await logSettingsError('Settings UI failed to load', error, 'boot');
    await showToastError(error, 'Unable to load settings. Check Homey logs for details.');
  }
};
