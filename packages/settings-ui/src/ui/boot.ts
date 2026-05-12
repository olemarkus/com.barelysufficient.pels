import './materialWeb.ts';
import {
  emptyState,
  tabs,
  refreshButton,
  electricityPricesSurface,
  priceAwareDevicesSurface,
  advancedOverviewRedesignEnabledInput,
  advancedOverviewRedesignRow,
  advancedEvSupportEnabledInput,
  capacityForm,
  capacityLimitInput,
  capacityMarginInput,
  capacityDryRunInput,
  powerSourceSelect,
  settingsLimitsForm,
  settingsCapacityLimitInput,
  settingsCapacityMarginInput,
  settingsPowerSourceSelect,
  settingsSimulationModeInput,
  simulationDisableButton,
  type MdCheckboxElement,
  priorityForm,
  resetStatsButton,
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
  primeApiCache,
  setSetting,
  waitForHomey,
} from './homey.ts';
import { showToast, showToastError } from './toast.ts';
import { refreshDevices, renderDevices } from './devices.ts';
import { getPowerUsage, renderPowerStats, renderPowerUsage } from './power.ts';
import {
  loadCapacitySettings,
  loadAdvancedSettings,
  loadStaleDataStatus,
  saveCapacitySettings,
  saveSettingsLimitsSettings,
  saveSimulationModeSettings,
} from './capacity.ts';
import {
  DEBUG_LOGGING_TOPICS as DEBUG_LOGGING_TOPICS_SETTING,
  EXPERIMENTAL_EV_SUPPORT_ENABLED,
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
import { initElectricityPricesView, initPriceAwareDevicesView } from './priceConfig.ts';
import {
  initDailyBudgetHandlers,
  loadDailyBudgetSettings,
  refreshDailyBudgetPlan,
} from './dailyBudget.ts';
import { loadBudgetAdjust } from './budgetAdjustController.ts';
import {
  initDailyBudgetTuningHandlers,
  loadDailyBudgetTuningSettings,
} from './dailyBudgetTuning.ts';
import {
  initDeviceDetailHandlers,
  loadEvBoostSettings,
  loadShedBehaviors,
  loadTemperatureBoostSettings,
} from './deviceDetail/index.ts';
import { loadDeferredObjectiveSettings } from './deferredObjectiveSettings.ts';
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
import {
  isDeadlinePlanPage,
  mountDeadlinePlan,
} from './deadlinePlanMount.ts';

let canToggleOverviewRedesign = false;

const initTabHandlers = () => {
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => showTab((tab as HTMLElement).dataset.tab || 'devices'));
  });
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const trigger = event.target.closest<HTMLElement>('[data-settings-target]');
    if (trigger?.dataset.settingsTarget) showTab(trigger.dataset.settingsTarget);
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
  const autoSaveSettingsLimits = async () => {
    try {
      await saveSettingsLimitsSettings();
    } catch (error) {
      await logSettingsError('Failed to save limits and safety settings', error, 'autoSaveSettingsLimits');
      await showToastError(error, 'Failed to save limits and safety settings.');
    }
  };
  settingsCapacityLimitInput?.addEventListener('change', autoSaveSettingsLimits);
  settingsCapacityMarginInput?.addEventListener('change', autoSaveSettingsLimits);
  settingsPowerSourceSelect?.addEventListener('change', autoSaveSettingsLimits);
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
  /* 2-step confirmation logic */
  if (resetStatsButton) {
    resetStatsButton.addEventListener('click', () => handleResetStats(resetStatsButton));
  } else {
    void logSettingsWarn('Reset stats button not found', undefined, 'initCapacityHandlers');
  }
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
      const inputs = Array.from(document.querySelectorAll<MdCheckboxElement>('[data-debug-topic]'));
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

  document.querySelectorAll<MdCheckboxElement>('[data-debug-topic]').forEach((input) => {
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
      // Re-render device-dependent lists so the just-revealed shell's
      // container is populated; otherwise users who viewed Devices before
      // toggling see a blank panel until reload.
      if (state.devicesLoaded) {
        renderDevices(state.latestDevices);
        renderPriorities(state.latestDevices);
      }
      showTab('advanced');
      await refreshPlan();
      await showToast(
        enabled ? 'New UI enabled.' : 'New UI disabled.',
        'ok',
      );
    } catch (error) {
      await logSettingsError(
        'Failed to update new UI preference',
        error,
        'advancedOverviewRedesignEnabledInput',
      );
      await showToastError(error, 'Failed to update new UI preference.');
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
  state.canToggleOverviewRedesign = canToggleOverviewRedesign;
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
    loadBudgetAdjust(),
    loadStaleDataStatus(),
    loadDeviceControlProfiles(),
    loadShedBehaviors(),
    loadTemperatureBoostSettings(),
    loadEvBoostSettings(),
    loadDeferredObjectiveSettings(),
    loadAdvancedSettings(),
  ]);

  // Phase 3: Render everything once with all state populated
  // Device-dependent renders (renderPriorities, renderDevices)
  // are deferred to first tab open via lazy loading in showTab().
  renderPowerUsage(usage);
  await renderPowerStats();
  renderModeOptions();
  await refreshAdvancedDeviceLogger();
  await refreshDailyBudgetPlan(bootstrap?.dailyBudget);

  // Phase 4: Mark initial load complete - enables save operations
  state.initialLoadComplete = true;
  // If devices were loaded mid-boot (user visited a device tab before loadInitialData finished),
  // re-render all device-dependent views so checkboxes are enabled and the loading notice is cleared.
  if (state.devicesLoaded) {
    renderDevices(state.latestDevices);
    renderPriorities(state.latestDevices);
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
  if (electricityPricesSurface) {
    void initElectricityPricesView(electricityPricesSurface);
  }
  if (priceAwareDevicesSurface) {
    void initPriceAwareDevicesView(priceAwareDevicesSurface);
  }
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
    if (isDeadlinePlanPage()) {
      const found = await waitForHomey(200, 100);
      if (found) {
        await found.ready();
        await flushSettingsLogs();
      }
      await mountDeadlinePlan();
      markSettingsUiReady();
      return;
    }

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
