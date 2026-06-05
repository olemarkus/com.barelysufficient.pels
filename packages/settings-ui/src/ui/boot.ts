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
import { getPowerUsage, renderPowerStats, renderPowerUsage } from './power.ts';
import {
  loadCapacitySettings,
  loadAdvancedSettings,
  loadStaleDataStatus,
  refreshLimitsValidationHints,
  saveSettingsLimitsSettings,
  saveSimulationModeSettings,
} from './capacity.ts';
import {
  DEBUG_LOGGING_TOPICS as DEBUG_LOGGING_TOPICS_SETTING,
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
  showTab,
  startStaleDataRefreshInterval,
} from './realtime.ts';
import {
  mountDeadlinePlan,
  setDeadlinePlanCloseHandler,
  unmountDeadlinePlan,
} from './deadlinePlanMount.ts';
import { initDeadlinePlanRouter } from './deadlinePlanRouter.ts';

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

const initLimitsAndSimulationHandlers = () => {
  const autoSaveSettingsLimits = async () => {
    try {
      await saveSettingsLimitsSettings();
    } catch (error) {
      await logSettingsError('Failed to save limits and safety settings', error, 'autoSaveSettingsLimits');
      await showToastError(error, 'Failed to save limits and safety settings.');
    }
  };
  settingsCapacityLimitInput?.addEventListener('input', refreshLimitsValidationHints);
  settingsCapacityMarginInput?.addEventListener('input', refreshLimitsValidationHints);
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
  const [usage] = await Promise.all([
    getPowerUsage(),
    loadCapacitySettings(),
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

const initializeBootHandlers = (_bootstrap: SettingsUiBootstrap | null) => {
  initTooltips();
  initDebouncedSaveFlush();
  initRealtimeListeners();
  showTab('overview');
  initTabHandlers();
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
    initializeBootHandlers(bootstrap);
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
