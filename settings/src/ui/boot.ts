import {
  emptyState,
  tabs,
  panels,
  refreshButton,
  planRefreshButton,
  resetStatsButton,
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
  debugLoggingEnabledCheckbox,
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
  OPERATING_MODE_SETTING,
} from '../../../settingsKeys';
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
import { refreshPlan, renderPlan, type PlanSnapshot } from './plan';
import { initDeviceDetailHandlers, loadShedBehaviors } from './deviceDetail';
import { state } from './state';

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
  if (tabId === 'plan') {
    refreshPlan().catch(() => {});
  }
  if (tabId === 'price') {
    refreshPrices().catch(() => {});
  }
};

const initRealtimeListeners = () => {
  const homey = getHomeyClient();
  if (!homey || typeof homey.on !== 'function') return;

  homey.on('plan_updated', (plan) => {
    const planPanel = document.querySelector('#plan-panel');
    if (planPanel && !planPanel.classList.contains('hidden')) {
      renderPlan(plan as PlanSnapshot | null);
    }
  });

  homey.on('prices_updated', () => {
    const pricesPanel = document.querySelector('#price-panel');
    if (pricesPanel && !pricesPanel.classList.contains('hidden')) {
      refreshPrices().catch(() => {});
    }
  });

  homey.on('settings.set', (key) => {
    if (key === CAPACITY_LIMIT_KW || key === CAPACITY_MARGIN_KW || key === CAPACITY_DRY_RUN) {
      loadCapacitySettings().catch(() => {});
    }
    if (key === 'device_plan_snapshot') {
      const planPanel = document.querySelector('#plan-panel');
      if (planPanel && !planPanel.classList.contains('hidden')) {
        refreshPlan().catch(() => {});
      }
    }
    if (key === 'combined_prices' || key === 'electricity_prices') {
      const pricesPanel = document.querySelector('#price-panel');
      if (pricesPanel && !pricesPanel.classList.contains('hidden')) {
        refreshPrices().catch(() => {});
      }
    }
    if (key === OPERATING_MODE_SETTING) {
      refreshActiveMode().catch(() => {});
    }
    if (key === 'overshoot_behaviors') {
      loadShedBehaviors().catch(() => {});
    }
  });
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
  planRefreshButton?.addEventListener('click', refreshPlan);
  resetStatsButton?.addEventListener('click', async () => {
    try {
      await setSetting('power_tracker_state', {});
      renderPowerUsage([]);
      await renderPowerStats();
      await showToast('Power stats reset.', 'ok');
    } catch (error) {
      await showToastError(error, 'Failed to reset stats.');
    }
  });
};

const initPriceHandlers = () => {
  const autoSavePriceSettings = async () => {
    try {
      await savePriceSettings();
    } catch (error) {
      await showToastError(error, 'Failed to save price settings.');
    }
  };
  priceAreaSelect?.addEventListener('change', autoSavePriceSettings);
  providerSurchargeInput?.addEventListener('change', autoSavePriceSettings);
  priceThresholdInput?.addEventListener('change', autoSavePriceSettings);
  priceMinDiffInput?.addEventListener('change', autoSavePriceSettings);
  priceSettingsForm?.addEventListener('submit', (event) => event.preventDefault());
  priceRefreshButton?.addEventListener('click', async () => {
    await setSetting('refresh_spot_prices', Date.now());
    await refreshPrices();
  });
  priceOptimizationEnabledCheckbox?.addEventListener('change', async () => {
    await setSetting('price_optimization_enabled', priceOptimizationEnabledCheckbox.checked);
    await showToast(
      priceOptimizationEnabledCheckbox.checked ? 'Price optimization enabled.' : 'Price optimization disabled.',
      'ok',
    );
  });
};

const initNettleieHandlers = () => {
  const autoSaveNettleieSettings = async () => {
    try {
      await saveNettleieSettings();
    } catch (error) {
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
    await setSetting('refresh_nettleie', Date.now());
    await refreshNettleie();
  });
};

const initAdvancedHandlers = () => {
  debugLoggingEnabledCheckbox?.addEventListener('change', async () => {
    await setSetting('debug_logging_enabled', debugLoggingEnabledCheckbox.checked);
    await showToast(
      debugLoggingEnabledCheckbox.checked
        ? 'Debug logging enabled (resets on restart).'
        : 'Debug logging disabled.',
      'ok',
    );
  });
};

const loadInitialData = async () => {
  await refreshDevices();
  const usage = await getPowerUsage();
  renderPowerUsage(usage);
  await renderPowerStats();
  await loadCapacitySettings();
  await loadStaleDataStatus();
  setInterval(() => loadStaleDataStatus(), 30 * 1000);
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

    initRealtimeListeners();
    showTab('devices');

    initOverflowMenu();
    initTabHandlers();
    initDeviceDetailHandlers();
    initModeHandlers();
    initCapacityHandlers();
    initPriceHandlers();
    initNettleieHandlers();
    initAdvancedHandlers();

    await loadInitialData();
  } catch (error) {
    console.error(error);
    await showToastError(error, 'Unable to load settings. Check the console for details.');
  }
};
