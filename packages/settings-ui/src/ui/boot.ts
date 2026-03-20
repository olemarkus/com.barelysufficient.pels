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
  priorityForm,
} from './dom';
import {
  SETTINGS_UI_BOOTSTRAP_PATH,
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
  SETTINGS_UI_PRICES_PATH,
  SETTINGS_UI_REFRESH_GRID_TARIFF_PATH,
  SETTINGS_UI_REFRESH_PRICES_PATH,
  type SettingsUiBootstrap,
  type SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi';
import {
  applySettingsPatch,
  callApi,
  primeApiCache,
  setSetting,
  waitForHomey,
} from './homey';
import { showToast, showToastError } from './toast';
import { getTargetDevices, refreshDevices, renderDevices } from './devices';
import { getPowerUsage, renderPowerStats, renderPowerUsage } from './power';
import { loadCapacitySettings, loadAdvancedSettings, loadStaleDataStatus, saveCapacitySettings } from './capacity';
import {
  DEBUG_LOGGING_TOPICS,
  EXPERIMENTAL_EV_SUPPORT_ENABLED,
  PRICE_OPTIMIZATION_ENABLED,
} from '../../../contracts/src/settingsKeys';
import {
  initModeHandlers,
  loadModeAndPriorities,
  renderModeOptions,
  renderPriorities,
} from './modes';
import {
  loadPriceSettings,
  refreshPrices,
  loadGridTariffSettings,
  refreshGridTariff,
  savePriceSettings,
  saveGridTariffSettings,
  updateGridCompanyOptions,
  updatePriceSchemeUiFromSelection,
} from './prices';
import { loadPriceOptimizationSettings, renderPriceOptimization } from './priceOptimization';
import {
  initDailyBudgetHandlers,
  loadDailyBudgetSettings,
  refreshDailyBudgetPlan,
} from './dailyBudget';
import {
  initDailyBudgetTuningHandlers,
  loadDailyBudgetTuningSettings,
} from './dailyBudgetTuning';
import { initDeviceDetailHandlers, loadShedBehaviors } from './deviceDetail';
import { loadDeviceControlProfiles } from './deviceControlProfiles';
import {
  initAdvancedDeviceCleanupHandlers,
  initAdvancedDeviceLoggerHandlers,
  refreshAdvancedDeviceCleanup,
  refreshAdvancedDeviceLogger,
} from './advanced';
import { state } from './state';
import { flushSettingsLogs, logSettingsError, logSettingsWarn } from './logging';
import {
  markSettingsUi,
  markSettingsUiReady,
  measureSettingsUi,
  resetSettingsUiPerf,
} from './perf';
import { initTooltips } from './tooltips';
import { initDebouncedSaveFlush } from './utils';
import { handleResetStats } from './resetStats';
import { createCheckboxField } from './components';
import {
  initRealtimeListeners,
  refreshPlanForUi,
  showTab,
  startStaleDataRefreshInterval,
} from './realtime';

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
  capacityForm.addEventListener('submit', (event) => event.preventDefault());
  priorityForm?.addEventListener('submit', (event) => {
    event.preventDefault();
  });
  refreshButton.addEventListener('click', () => {
    void refreshDevices();
  });
  planRefreshButton?.addEventListener('click', () => {
    refreshPlanForUi('planRefreshButton');
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

const DEBUG_TOPICS: Array<{ topic: string; label: string; hint: string }> = [
  { topic: 'plan', label: 'Plan engine', hint: 'Shedding, restore, and soft-limit decisions.' },
  {
    topic: 'diagnostics',
    label: 'Device diagnostics',
    hint: 'Per-device starvation, hysteresis, penalty, and diagnostics persistence.',
  },
  { topic: 'price', label: 'Price optimization', hint: 'Spot prices, tariffs, and price shaping.' },
  { topic: 'daily_budget', label: 'Daily budget', hint: 'Daily plan and rollover.' },
  { topic: 'devices', label: 'Devices', hint: 'Device snapshots and Homey API interactions.' },
  {
    topic: 'settings',
    label: 'Settings',
    hint: 'Settings checks and updates, including expected power flow cards.',
  },
  { topic: 'perf', label: 'Performance', hint: 'Hotpath counters and timings.' },
];

const initDebugLoggingCheckboxes = () => {
  const mount = document.getElementById('debug-logging-checkboxes');
  if (!mount) return;
  DEBUG_TOPICS.forEach(({ topic, label, hint }) => {
    const { element, input } = createCheckboxField({ id: `debug-topic-${topic}`, label, hint });
    input.dataset.debugTopic = topic;
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
      await setSetting(DEBUG_LOGGING_TOPICS, selected);
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
    primeApiCache(SETTINGS_UI_DEVICES_PATH, { devices: bootstrap.devices ?? [] });
    primeApiCache(SETTINGS_UI_PLAN_PATH, { plan: bootstrap.plan ?? null });
    primeApiCache(SETTINGS_UI_POWER_PATH, bootstrap.power);
    primeApiCache(SETTINGS_UI_PRICES_PATH, bootstrap.prices);
    return bootstrap;
  } catch {
    return null;
  }
};

const loadInitialData = async (bootstrap: SettingsUiBootstrap | null) => {
  // Phase 1: Load the device read model without forcing a live refresh during boot.
  state.latestDevices = await getTargetDevices();

  // Phase 2: Load mode/priorities FIRST to populate managedMap before any rendering
  // This prevents the race condition where users see empty checkboxes
  await loadModeAndPriorities();

  // Phase 3: Load remaining settings in parallel for faster load time
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

  // Phase 4: Render everything once with all state populated
  renderPowerUsage(usage);
  await renderPowerStats();
  renderModeOptions();
  renderPriorities(state.latestDevices);
  renderDevices(state.latestDevices);
  renderPriceOptimization(state.latestDevices);
  refreshAdvancedDeviceCleanup();
  await refreshAdvancedDeviceLogger();
  await refreshPrices();
  await refreshGridTariff();
  await refreshDailyBudgetPlan(bootstrap?.dailyBudget);

  // Phase 5: Mark initial load complete - enables save operations
  state.initialLoadComplete = true;
  // Re-render devices to enable checkboxes now that load is complete
  renderDevices(state.latestDevices);
};

const initializeBootHandlers = () => {
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
    initializeBootHandlers();
    await loadInitialData(bootstrap);
    startStaleDataRefreshInterval();
    markBootComplete();
    startDailyBudgetRefreshInterval();
  } catch (error) {
    await logSettingsError('Settings UI failed to load', error, 'boot');
    await showToastError(error, 'Unable to load settings. Check Homey logs for details.');
  }
};
