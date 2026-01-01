import {
  emptyState,
  tabs,
  panels,
  refreshButton,
  planRefreshButton,
  priceSettingsForm,
  priceAreaSelect,
  providerSurchargeInput,
  priceThresholdInput,
  priceMinDiffInput,
  priceRefreshButton,
  priceOptimizationEnabledCheckbox,
  nettleieSettingsForm,
  nettleieFylkeSelect,
  nettleieCompanySelect,
  nettleieTariffgruppeSelect,
  nettleieRefreshButton,
  capacityForm,
  capacityLimitInput,
  capacityMarginInput,
  capacityDryRunInput,
  priorityForm,
  debugLoggingTopicInputs,
} from './dom';
import { getHomeyClient, getSetting, setSetting, waitForHomey } from './homey';
import { showToast, showToastError } from './toast';
import { refreshDevices, renderDevices } from './devices';
import { getPowerUsage, renderPowerStats, renderPowerUsage, PowerTracker } from './power';
import { getHourBucketKey } from '../../../lib/utils/dateUtils';
import { loadCapacitySettings, loadAdvancedSettings, loadStaleDataStatus, saveCapacitySettings } from './capacity';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  DEBUG_LOGGING_TOPICS,
  OPERATING_MODE_SETTING,
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
  loadNettleieSettings,
  refreshNettleie,
  savePriceSettings,
  saveNettleieSettings,
  updateGridCompanyOptions,
  loadPriceOptimizationSettings,
  renderPriceOptimization,
} from './prices';
import {
  initDailyBudgetHandlers,
  loadDailyBudgetSettings,
  refreshDailyBudgetPlan,
} from './dailyBudget';
import { refreshPlan, renderPlan, type PlanSnapshot } from './plan';
import { initDeviceDetailHandlers, loadShedBehaviors } from './deviceDetail';
import { state } from './state';
import { flushSettingsLogs, logSettingsError, logSettingsInfo, logSettingsWarn } from './logging';
import { initTouchSupport } from './touch';

const showTab = (tabId: string) => {
  const overflowMenu = document.querySelector('.tab-overflow-menu') as HTMLElement;
  const overflowToggle = document.querySelector('.tab-overflow-toggle') as HTMLButtonElement;
  if (overflowMenu) overflowMenu.hidden = true;
  if (overflowToggle) overflowToggle.setAttribute('aria-expanded', 'false');

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

const initRealtimeListeners = () => {
  const homey = getHomeyClient();
  if (!homey || typeof homey.on !== 'function') return;

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
    'combined_prices',
    'price_optimization_enabled',
    CAPACITY_LIMIT_KW,
    CAPACITY_MARGIN_KW,
  ]);

  const dailyBudgetSettingsKeys = new Set([
    'daily_budget_enabled',
    'daily_budget_kwh',
    'daily_budget_price_shaping_enabled',
  ]);

  const handleSettingsSet = (key: string) => {
    if (key === CAPACITY_LIMIT_KW || key === CAPACITY_MARGIN_KW || key === CAPACITY_DRY_RUN) {
      loadCapacitySettings().catch((error) => {
        void logSettingsError('Failed to load capacity settings', error, 'settings.set');
      });
    }

    if (key === 'device_plan_snapshot') {
      refreshPlanIfVisible();
    }

    if (key === 'combined_prices' || key === 'electricity_prices') {
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

    if (key === 'managed_devices' || key === 'controllable_devices') {
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

    if (dailyBudgetRefreshKeys.has(key)) {
      if (dailyBudgetSettingsKeys.has(key)) {
        loadDailyBudgetSettings().catch((error) => {
          void logSettingsError('Failed to load daily budget settings', error, 'settings.set');
        });
      }
      refreshDailyBudgetPlan().catch((error) => {
        void logSettingsError('Failed to refresh daily budget', error, 'settings.set');
      });
    }
  };

  homey.on('settings.set', handleSettingsSet);
};

const refreshPowerData = async () => {
  const usage = await getPowerUsage();
  renderPowerUsage(usage);
  await renderPowerStats();
};

const initOverflowMenu = () => {
  const overflowToggle = document.querySelector('.tab-overflow-toggle') as HTMLButtonElement;
  const overflowMenu = document.querySelector('.tab-overflow-menu') as HTMLElement;
  if (!overflowToggle || !overflowMenu) return;

  overflowToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const isExpanded = overflowToggle.getAttribute('aria-expanded') === 'true';
    overflowToggle.setAttribute('aria-expanded', String(!isExpanded));
    overflowMenu.hidden = isExpanded;
  });
  document.addEventListener('click', () => {
    overflowToggle.setAttribute('aria-expanded', 'false');
    overflowMenu.hidden = true;
  });
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

let resetTimeout: ReturnType<typeof setTimeout> | null = null;


const calculateResetState = (currentState: PowerTracker): PowerTracker => {
  const currentHourKey = getHourBucketKey();

  const newBuckets: Record<string, number> = {};
  if (currentState.buckets && currentState.buckets[currentHourKey] !== undefined) {
    newBuckets[currentHourKey] = currentState.buckets[currentHourKey];
  }

  const newBudgets: Record<string, number> = {};
  if (currentState.hourlyBudgets && currentState.hourlyBudgets[currentHourKey] !== undefined) {
    newBudgets[currentHourKey] = currentState.hourlyBudgets[currentHourKey];
  }

  return {
    ...currentState,
    buckets: newBuckets,
    hourlyBudgets: newBudgets,
    dailyTotals: {},
    hourlyAverages: {},
    unreliablePeriods: [],
  };
};

const handleResetStats = async (btn: HTMLButtonElement) => {
  // Step 1: Request Confirmation
  if (!btn.classList.contains('confirming')) {
    await logSettingsInfo('Reset stats confirmation requested', 'handleResetStats');
    const b = btn;
    b.textContent = '⚠️ Click again to confirm reset';
    b.classList.add('confirming');
    b.style.color = 'var(--homey-red, #f44336)'; // Visual feedback

    if (resetTimeout) clearTimeout(resetTimeout);
    resetTimeout = setTimeout(() => {
      const el = btn;
      el.textContent = 'Reset all stats';
      el.classList.remove('confirming');
      el.style.color = '';
      resetTimeout = null;
    }, 5000); // 5 seconds to confirm
    return;
  }

  // Step 2: Execute Reset
  await logSettingsInfo('Reset stats confirmed', 'handleResetStats');
  if (resetTimeout) clearTimeout(resetTimeout);
  const b = btn;
  b.textContent = 'Resetting...';

  try {
    const currentState = (await getSetting('power_tracker_state') as PowerTracker) || {};
    const newState = calculateResetState(currentState);

    await setSetting('power_tracker_state', newState);

    // Refresh UI
    renderPowerUsage(Object.entries(newState.buckets || {}).map(([hour, kWh]) => ({
      hour: new Date(hour),
      kWh,
      budgetKWh: (newState.hourlyBudgets || {})[hour],
    })));
    await renderPowerStats();
    await showToast('Power stats reset (current hour preserved).', 'ok');
    await logSettingsInfo('Reset stats completed', 'handleResetStats');
  } catch (error) {
    await logSettingsError('Reset stats failed', error, 'handleResetStats');
    await showToastError(error, 'Failed to reset stats.');
  } finally {
    const el = btn;
    el.textContent = 'Reset all stats';
    el.classList.remove('confirming');
    el.style.color = '';
    resetTimeout = null;
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
      await setSetting('price_optimization_enabled', priceOptimizationEnabledCheckbox.checked);
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

const initNettleieHandlers = () => {
  const autoSaveNettleieSettings = async () => {
    try {
      await saveNettleieSettings();
    } catch (error) {
      await logSettingsError('Failed to save grid tariff settings', error, 'autoSaveNettleieSettings');
      await showToastError(error, 'Failed to save grid tariff settings.');
    }
  };
  nettleieCompanySelect?.addEventListener('change', autoSaveNettleieSettings);
  nettleieTariffgruppeSelect?.addEventListener('change', autoSaveNettleieSettings);
  nettleieSettingsForm?.addEventListener('submit', (event) => event.preventDefault());
  nettleieFylkeSelect?.addEventListener('change', () => {
    updateGridCompanyOptions(nettleieFylkeSelect.value);
  });
  nettleieRefreshButton?.addEventListener('click', async () => {
    try {
      await setSetting('refresh_nettleie', Date.now());
      await refreshNettleie();
    } catch (error) {
      await logSettingsError('Failed to refresh grid tariffs', error, 'nettleieRefreshButton');
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
};

const loadInitialData = async () => {
  await refreshDevices();
  const usage = await getPowerUsage();
  renderPowerUsage(usage);
  await renderPowerStats();
  await loadCapacitySettings();
  await loadDailyBudgetSettings();
  await loadStaleDataStatus();
  setInterval(() => {
    void loadStaleDataStatus().catch((error) => {
      void logSettingsError('Failed to refresh stale data status', error, 'staleDataInterval');
    });
  }, 30 * 1000);
  await loadModeAndPriorities();
  await loadShedBehaviors();
  await loadPriceOptimizationSettings();
  renderModeOptions();
  renderPriorities(state.latestDevices);
  renderDevices(state.latestDevices);
  renderPriceOptimization(state.latestDevices);
  await loadPriceSettings();
  await refreshPrices();
  await loadNettleieSettings();
  await refreshNettleie();
  await refreshDailyBudgetPlan();
  await loadAdvancedSettings();
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

    // Initialize touch support early so CSS classes are available
    initTouchSupport();

    initRealtimeListeners();
    showTab('overview');

    initOverflowMenu();
    initTabHandlers();
    initDeviceDetailHandlers();
    initModeHandlers();
    initCapacityHandlers();
    initDailyBudgetHandlers();
    initPriceHandlers();
    initNettleieHandlers();
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
