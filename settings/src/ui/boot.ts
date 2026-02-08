import {
  emptyState,
  tabs,
  panels,
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
  debugLoggingTopicInputs,
} from './dom';
import { getHomeyClient, setSetting, waitForHomey } from './homey';
import { showToast, showToastError } from './toast';
import { refreshDevices, renderDevices } from './devices';
import { getPowerUsage, renderPowerStats, renderPowerUsage } from './power';
import { loadCapacitySettings, loadAdvancedSettings, loadStaleDataStatus, saveCapacitySettings } from './capacity';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  COMBINED_PRICES,
  DAILY_BUDGET_BREAKDOWN_ENABLED,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DEBUG_LOGGING_TOPICS,
  NORWAY_PRICE_MODEL,
  OPERATING_MODE_SETTING,
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_SCHEME,
} from '../../../lib/utils/settingsKeys';
import {
  initModeHandlers,
  loadModeAndPriorities,
  refreshActiveMode,
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
import { refreshPlan, renderPlan, type PlanSnapshot } from './plan';
import { initDeviceDetailHandlers, loadShedBehaviors } from './deviceDetail';
import {
  initAdvancedDeviceCleanupHandlers,
  initAdvancedDeviceLoggerHandlers,
  refreshAdvancedDeviceCleanup,
  refreshAdvancedDeviceLogger,
} from './advanced';
import { state } from './state';
import { flushSettingsLogs, logSettingsError, logSettingsWarn } from './logging';
import { initTooltips } from './tooltips';
import { initDebouncedSaveFlush } from './utils';
import { handleResetStats } from './resetStats';

const showTab = (tabId: string) => {
  tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === tabId;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });
  panels.forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.panel !== tabId);
  });
  if (tabId === 'overview') {
    refreshPlan().catch((error) => {
      void logSettingsError('Failed to refresh plan', error, 'showTab');
    });
  }
  if (tabId === 'price') {
    refreshPrices().catch((error) => {
      void logSettingsError('Failed to refresh prices', error, 'showTab');
    });
  }
  if (tabId === 'usage') {
    refreshPowerData().catch((error) => {
      void logSettingsError('Failed to refresh power data', error, 'showTab');
      void showToastError(error, 'Failed to refresh power data.');
    });
  }
  if (tabId === 'budget') {
    refreshDailyBudgetPlan().catch((error) => {
      void logSettingsError('Failed to refresh daily budget', error, 'showTab');
    });
  }
};

const refreshPlanIfVisible = () => {
  const overviewPanel = document.querySelector('#overview-panel');
  if (!overviewPanel || overviewPanel.classList.contains('hidden')) return;
  refreshPlan().catch((error) => {
    void logSettingsError('Failed to refresh plan', error, 'settings.set');
  });
};

const refreshPricesIfVisible = () => {
  const pricesPanel = document.querySelector('#price-panel');
  if (!pricesPanel || pricesPanel.classList.contains('hidden')) return;
  refreshPrices().catch((error) => {
    void logSettingsError('Failed to refresh prices', error, 'settings.set');
  });
};

const refreshDailyBudgetIfVisible = () => {
  const budgetPanel = document.querySelector('#budget-panel');
  if (!budgetPanel || budgetPanel.classList.contains('hidden')) return;
  refreshDailyBudgetPlan().catch((error) => {
    void logSettingsError('Failed to refresh daily budget', error, 'settings.set');
  });
};

const initRealtimeListeners = () => {
  const homey = getHomeyClient();
  if (!homey || typeof homey.on !== 'function') return;

  homey.on('plan_updated', (plan) => {
    const overviewPanel = document.querySelector('#overview-panel');
    if (overviewPanel && !overviewPanel.classList.contains('hidden')) {
      renderPlan(plan as PlanSnapshot | null);
    }
  });

  homey.on('prices_updated', () => {
    const pricesPanel = document.querySelector('#price-panel');
    if (pricesPanel && !pricesPanel.classList.contains('hidden')) {
      refreshPrices().catch((error) => {
        void logSettingsError('Failed to refresh prices', error, 'realtime prices_updated');
      });
    }
  });

  const dailyBudgetRefreshKeys = new Set([
    'daily_budget_enabled',
    'daily_budget_kwh',
    'daily_budget_price_shaping_enabled',
    'daily_budget_reset',
    COMBINED_PRICES,
    PRICE_OPTIMIZATION_ENABLED,
    CAPACITY_LIMIT_KW,
    CAPACITY_MARGIN_KW,
    DAILY_BUDGET_CONTROLLED_WEIGHT,
    DAILY_BUDGET_PRICE_FLEX_SHARE,
    DAILY_BUDGET_BREAKDOWN_ENABLED,
  ]);

  const dailyBudgetSettingsKeys = new Set([
    'daily_budget_enabled',
    'daily_budget_kwh',
    'daily_budget_price_shaping_enabled',
  ]);

  const capacitySettingsKeys = new Set([CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CAPACITY_DRY_RUN]);
  const priceRefreshKeys = new Set([COMBINED_PRICES, 'electricity_prices']);
  const deviceControlKeys = new Set(['managed_devices', 'controllable_devices']);
  const dailyBudgetTuningKeys = new Set([
    DAILY_BUDGET_CONTROLLED_WEIGHT,
    DAILY_BUDGET_PRICE_FLEX_SHARE,
    DAILY_BUDGET_BREAKDOWN_ENABLED,
  ]);

  const handleDailyBudgetSettingsSet = (key: string) => {
    if (!dailyBudgetRefreshKeys.has(key)) return;
    if (dailyBudgetSettingsKeys.has(key)) {
      loadDailyBudgetSettings().catch((error) => {
        void logSettingsError('Failed to load daily budget settings', error, 'settings.set');
      });
    }
    if (dailyBudgetTuningKeys.has(key)) {
      loadDailyBudgetTuningSettings().catch((error) => {
        void logSettingsError('Failed to load daily budget tuning', error, 'settings.set');
      });
    }
    refreshDailyBudgetPlan().catch((error) => {
      void logSettingsError('Failed to refresh daily budget', error, 'settings.set');
    });
  };

  const handleSettingsSet = (key: string) => {
    if (capacitySettingsKeys.has(key)) {
      loadCapacitySettings().catch((error) => {
        void logSettingsError('Failed to load capacity settings', error, 'settings.set');
      });
    }

    if (key === 'device_plan_snapshot') {
      refreshPlanIfVisible();
    }

    if (priceRefreshKeys.has(key)) {
      refreshPricesIfVisible();
    }

    if (
      key === PRICE_SCHEME
      || key === NORWAY_PRICE_MODEL
    ) {
      loadPriceSettings().catch((error) => {
        void logSettingsError('Failed to load price settings', error, 'settings.set');
      });
      refreshPricesIfVisible();
    }

    if (key === OPERATING_MODE_SETTING) {
      refreshActiveMode().catch((error) => {
        void logSettingsError('Failed to refresh active mode', error, 'settings.set');
      });
    }

    if (key === 'overshoot_behaviors') {
      loadShedBehaviors().catch((error) => {
        void logSettingsError('Failed to load shed behaviors', error, 'settings.set');
      });
    }

    if (deviceControlKeys.has(key)) {
      loadModeAndPriorities()
        .then(() => {
          renderPriorities(state.latestDevices);
          renderDevices(state.latestDevices);
          renderPriceOptimization(state.latestDevices);
        })
        .catch((error) => {
          void logSettingsError('Failed to load device control settings', error, 'settings.set');
        });
    }

    if (key === 'power_tracker_state') {
      refreshPowerData().catch((error) => {
        void logSettingsError('Failed to refresh power data', error, 'settings.set');
      });
      refreshDailyBudgetIfVisible();
    }

    handleDailyBudgetSettingsSet(key);
  };

  homey.on('settings.set', handleSettingsSet);
};

const refreshPowerData = async () => {
  const usage = await getPowerUsage();
  renderPowerUsage(usage);
  await renderPowerStats();
};

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
  refreshButton.addEventListener('click', refreshDevices);
  planRefreshButton?.addEventListener('click', () => {
    refreshPlan().catch((error) => {
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
      await setSetting('refresh_spot_prices', Date.now());
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
      await setSetting('refresh_nettleie', Date.now());
      await refreshGridTariff();
    } catch (error) {
      await logSettingsError('Failed to refresh grid tariffs', error, 'gridTariffRefreshButton');
      await showToastError(error, 'Failed to refresh grid tariffs.');
    }
  });
};

const initAdvancedHandlers = () => {
  const saveDebugTopics = async () => {
    try {
      const selected = debugLoggingTopicInputs
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

  debugLoggingTopicInputs.forEach((input) => {
    input.addEventListener('change', () => {
      void saveDebugTopics();
    });
  });

  initAdvancedDeviceCleanupHandlers();
  initAdvancedDeviceLoggerHandlers();
  initDailyBudgetTuningHandlers();
};

const loadInitialData = async () => {
  // Phase 1: Refresh devices (needed for rendering)
  await refreshDevices({ render: false });

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
  await refreshDailyBudgetPlan();

  // Phase 5: Mark initial load complete - enables save operations
  state.initialLoadComplete = true;
  // Re-render devices to enable checkboxes now that load is complete
  renderDevices(state.latestDevices);

  // Set up periodic stale data check
  setInterval(() => {
    void loadStaleDataStatus().catch((error) => {
      void logSettingsError('Failed to refresh stale data status', error, 'staleDataInterval');
    });
  }, 30 * 1000);
};

export const boot = async () => {
  try {
    const found = await waitForHomey(200, 100);
    if (!found) {
      emptyState.hidden = false;
      emptyState.textContent = 'Homey SDK not available. Make sure you are logged in and opened the settings from Homey.';
      await showToast('Homey SDK not available. Check your Homey session/connection.', 'warn');
      return;
    }

    await found.ready();
    await flushSettingsLogs();

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
    initAdvancedHandlers();

    await loadInitialData();

    setInterval(() => {
      const budgetPanel = document.querySelector('#budget-panel');
      if (budgetPanel && !budgetPanel.classList.contains('hidden')) {
        refreshDailyBudgetPlan().catch((error) => {
          void logSettingsError('Failed to refresh daily budget', error, 'dailyBudgetInterval');
        });
      }
    }, 60 * 1000);
  } catch (error) {
    await logSettingsError('Settings UI failed to load', error, 'boot');
    await showToastError(error, 'Unable to load settings. Check Homey logs for details.');
  }
};
