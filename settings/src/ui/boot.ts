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
  debugLoggingEnabledCheckbox,
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
    refreshPlan().catch(() => { });
  }
  if (tabId === 'price') {
    refreshPrices().catch((err) => console.error('Failed to refresh prices:', err));
  }
  if (tabId === 'power') {
    refreshPowerData().catch((error) => {
      showToastError(error, 'Failed to refresh power data.');
    });
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
      refreshPrices().catch(() => { });
    }
  });

  homey.on('settings.set', handleSettingsUpdate);
};

const handleCapacityUpdate = () => {
  loadCapacitySettings().catch(() => { });
};

const handlePlanUpdate = () => {
  const planPanel = document.querySelector('#plan-panel');
  if (planPanel && !planPanel.classList.contains('hidden')) {
    refreshPlan().catch(() => { });
  }
};

const handlePriceUpdate = () => {
  const pricesPanel = document.querySelector('#price-panel');
  if (pricesPanel && !pricesPanel.classList.contains('hidden')) {
    refreshPrices().catch(() => { });
  }
};

const handlePowerUpdate = () => {
  const powerPanel = document.querySelector('#power-panel');
  if (powerPanel && !powerPanel.classList.contains('hidden')) {
    refreshPowerData().catch((error) => {
      showToastError(error, 'Failed to refresh power data.');
    });
  }
};

const refreshPowerData = async () => {
  const usage = await getPowerUsage();
  renderPowerUsage(usage);
  await renderPowerStats();
};

const handleSettingsUpdate = (key: string) => {
  switch (key) {
    case CAPACITY_LIMIT_KW:
    case CAPACITY_MARGIN_KW:
    case CAPACITY_DRY_RUN:
      handleCapacityUpdate();
      break;
    case 'device_plan_snapshot':
      handlePlanUpdate();
      break;
    case 'combined_prices':
    case 'electricity_prices':
      handlePriceUpdate();
      break;
    case OPERATING_MODE_SETTING:
      refreshActiveMode().catch(() => { });
      break;
    case 'overshoot_behaviors':
      loadShedBehaviors().catch(() => { });
      break;
    case 'power_tracker_state':
      handlePowerUpdate();
      break;
    default:
      break;
  }
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
  /* 2-step confirmation logic */
  const resetStatsBtn = document.getElementById('reset-stats-button') as HTMLButtonElement;
  if (resetStatsBtn) {
    resetStatsBtn.addEventListener('click', () => handleResetStats(resetStatsBtn));
  } else {
    console.error('Reset stats button not found');
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
    console.log('Reset stats: requesting confirmation');
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
  console.log('Reset stats: checked and confirmed');
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
    console.log('Reset complete');
  } catch (error) {
    console.error('Reset failed:', error);
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
