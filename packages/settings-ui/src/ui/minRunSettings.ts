import {
  minRunDefaultMinutesInput,
  minRunDefaultRow,
  minRunEnabledInput,
} from './dom.ts';
import { getSetting } from './homey.ts';
import { pushSettingWriteIfChanged } from './settingWrites.ts';
import { logSettingsError } from './logging.ts';
import { showToast, showToastError } from './toast.ts';
import {
  DEFAULT_MIN_RUN_MINUTES,
  DEVICE_MIN_RUN_MINUTES,
  ENERGY_BUDGET_ADMISSION_ENABLED,
} from '../../../contracts/src/settingsKeys.ts';
import { normalizeMinRunMinutesMap } from '../../../shared-domain/src/minRunMinutes.ts';
import { state } from './state.ts';

// Reflect the loaded toggle/default into the Advanced-panel controls and show
// or hide the default-minutes row to match the toggle.
const syncMinRunControls = () => {
  if (minRunEnabledInput) minRunEnabledInput.selected = state.energyBudgetAdmissionEnabled;
  if (minRunDefaultMinutesInput) {
    minRunDefaultMinutesInput.value = state.defaultMinRunMinutes === undefined
      ? ''
      : String(state.defaultMinRunMinutes);
  }
  if (minRunDefaultRow) minRunDefaultRow.hidden = !state.energyBudgetAdmissionEnabled;
};

export const loadMinRunSettings = async () => {
  const [enabledRaw, defaultRaw, deviceMapRaw] = await Promise.all([
    getSetting(ENERGY_BUDGET_ADMISSION_ENABLED),
    getSetting(DEFAULT_MIN_RUN_MINUTES),
    getSetting(DEVICE_MIN_RUN_MINUTES),
  ]);
  state.energyBudgetAdmissionEnabled = enabledRaw === true;
  state.defaultMinRunMinutes = typeof defaultRaw === 'number' && Number.isFinite(defaultRaw) && defaultRaw >= 0
    ? defaultRaw
    : undefined;
  state.deviceMinRunMinutes = normalizeMinRunMinutesMap(deviceMapRaw);
  syncMinRunControls();
};

const readDefaultMinutes = (): number | undefined => {
  const raw = minRunDefaultMinutesInput?.value.trim();
  if (!raw) return undefined;
  // Strict integer parse — reject fractional input ("1.9") instead of truncating.
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const saveMinRunSettings = async () => {
  const enabled = minRunEnabledInput?.selected ?? false;
  const defaultMinutes = readDefaultMinutes();
  // Enabling the feature requires a valid default — enforce in the UI; the
  // runtime tolerates an absent default by falling back to the legacy grace.
  if (enabled && defaultMinutes === undefined) {
    throw new Error('Enter a default minimum run time (minutes) before turning this on.');
  }

  const [currentEnabled, currentDefault] = await Promise.all([
    getSetting(ENERGY_BUDGET_ADMISSION_ENABLED),
    getSetting(DEFAULT_MIN_RUN_MINUTES),
  ]);

  const writes: Array<Promise<void>> = [];
  pushSettingWriteIfChanged(writes, ENERGY_BUDGET_ADMISSION_ENABLED, currentEnabled, enabled);
  // Persist the default whenever one is entered (independent of the toggle) so
  // re-enabling later keeps the value the user typed.
  if (defaultMinutes !== undefined) {
    pushSettingWriteIfChanged(writes, DEFAULT_MIN_RUN_MINUTES, currentDefault, defaultMinutes);
  }
  if (writes.length > 0) await Promise.all(writes);

  state.energyBudgetAdmissionEnabled = enabled;
  if (defaultMinutes !== undefined) state.defaultMinRunMinutes = defaultMinutes;
  syncMinRunControls();
};

const MIN_RUN_SETTINGS_KEYS = new Set<string>([
  ENERGY_BUDGET_ADMISSION_ENABLED,
  DEFAULT_MIN_RUN_MINUTES,
  DEVICE_MIN_RUN_MINUTES,
]);

// Realtime settings.set handler for the min-run keys. No-op for unrelated keys.
// Min-run is a planner input (the anti-cycle hold window), so after reloading
// the settings it re-renders the plan and the device controls (the latter
// re-renders the open device-detail pane) via the injected callbacks. Injecting
// them keeps this module free of the realtime layer's render plumbing.
export const handleMinRunSettingChange = (
  key: string,
  refreshPlan: (context: string) => void,
  refreshDeviceControls: () => void,
): void => {
  if (!MIN_RUN_SETTINGS_KEYS.has(key)) return;
  // Refresh only AFTER the reload resolves — otherwise the plan/device-control
  // re-render races ahead of the updated `state` and renders stale values.
  loadMinRunSettings()
    .then(() => {
      refreshPlan('settings.set');
      refreshDeviceControls();
    })
    .catch((error) => {
      void logSettingsError('Failed to load minimum run time settings', error, 'settings.set');
    });
};

export const initMinRunSettingsHandlers = () => {
  const autoSave = async () => {
    try {
      await saveMinRunSettings();
      await showToast('Minimum run time settings saved.', 'ok');
    } catch (error) {
      await logSettingsError('Failed to save minimum run time settings', error, 'minRunSettings');
      await showToastError(error, 'Failed to save minimum run time settings.');
      // Re-sync controls to the last persisted state so a rejected enable does
      // not leave the toggle visually on.
      syncMinRunControls();
    }
  };

  // Toggle changes reveal/hide the default row immediately, then persist.
  minRunEnabledInput?.addEventListener('change', () => {
    if (minRunDefaultRow) minRunDefaultRow.hidden = !(minRunEnabledInput?.selected ?? false);
    void autoSave();
  });
  minRunDefaultMinutesInput?.addEventListener('change', () => {
    void autoSave();
  });
};
