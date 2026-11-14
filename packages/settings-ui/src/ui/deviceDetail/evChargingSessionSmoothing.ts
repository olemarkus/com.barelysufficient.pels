import {
  isEvChargingSessionSmoothingSettings,
  normalizeEvChargingSessionSmoothingSettings,
  type EvChargingSessionSmoothingSettings,
} from '../../../../shared-domain/src/settings/evChargingSessionSmoothing.ts';
import { EV_CHARGING_SESSION_SMOOTHING } from '../../../../shared-domain/src/settings/settingsKeys.ts';
import { SETTINGS_UI_BOOTSTRAP_PATH } from '../../../../contracts/src/settingsUi/paths.ts';
import { asUnknownRecord, isUnknownRecord } from '../../../../shared-domain/src/recordGuards.ts';
import { callApi, getSetting, getSettingFresh, setSetting } from '../homey.ts';
import { isEvChargerDevice } from '../deviceKind.ts';
import { logSettingsError } from '../logging.ts';
import { showToast, showToastError } from '../toast.ts';
import { state, type SettingsUiDeviceView } from '../state.ts';
import { createSerializedAsyncRunner } from './settingsWrite.ts';
import { isDeviceSmartTaskCandidate } from './smartTaskBox.ts';
import { getPricesReadModel } from '../prices.ts';

const row = document.querySelector<HTMLElement>('#device-detail-charging-session-smoothing');
const toggle = document.querySelector<HTMLElement & { selected: boolean; disabled: boolean }>(
  '#device-detail-charging-session-smoothing-enabled',
);
const serialize = createSerializedAsyncRunner();
let renderGeneration = 0;
let resolvedVisibility: { deviceId: string; visible: boolean } | null = null;

export const loadEvChargingSessionSmoothingSettings = async (): Promise<void> => {
  try {
    const raw = await getSetting(EV_CHARGING_SESSION_SMOOTHING);
    if (isUnknownRecord(raw)) {
      state.evChargingSessionSmoothingSettings = normalizeEvChargingSessionSmoothingSettings(raw);
    }
  } catch (error) {
    await logSettingsError('Failed to load charging session settings', error, 'loadEvChargingSessionSmoothingSettings');
  }
};

const supportsSessionSmoothing = (device: SettingsUiDeviceView | null): device is SettingsUiDeviceView => (
  isEvChargerDevice(device) && device !== null && state.managedMap[device.id] === true
    && (state.evChargingSessionSmoothingSettings[device.id] === true || isDeviceSmartTaskCandidate(device.id))
);

export const renderEvChargingSessionSmoothing = async (device: SettingsUiDeviceView | null): Promise<void> => {
  const generation = ++renderGeneration;
  if (!row || !toggle) return;
  if (resolvedVisibility?.deviceId !== device?.id) {
    row.hidden = true;
    resolvedVisibility = null;
  }
  if (!supportsSessionSmoothing(device)) {
    row.hidden = true;
    resolvedVisibility = null;
    return;
  }
  let visible = false;
  try {
    const { priceTimeline } = await getPricesReadModel();
    visible = priceTimeline.state === 'ready' && priceTimeline.periods.some((period) => period.durationMinutes === 15);
  } catch { /* Unavailable prices offer no charging continuity control. */ }
  if (generation !== renderGeneration) return;
  resolvedVisibility = { deviceId: device.id, visible };
  row.hidden = !visible;
  if (!visible) return;
  toggle.selected = state.evChargingSessionSmoothingSettings[device.id] === true;
  toggle.disabled = false;
};

/** A null WebView read needs fresh owner evidence of absence, never a page snapshot. */
const readWritableSettings = async (): Promise<EvChargingSessionSmoothingSettings> => {
  let raw = await getSettingFresh(EV_CHARGING_SESSION_SMOOTHING);
  if (raw == null) {
    const bootstrap = asUnknownRecord(await callApi<unknown>('GET', SETTINGS_UI_BOOTSTRAP_PATH));
    raw = asUnknownRecord(bootstrap?.settings)?.[EV_CHARGING_SESSION_SMOOTHING];
  }
  if (!isEvChargingSessionSmoothingSettings(raw)) {
    throw new Error('Charging session settings could not be read. Try again.');
  }
  return normalizeEvChargingSessionSmoothingSettings(raw);
};

type HandlerDeps = {
  getCurrentDetailDeviceId: () => string | null;
  refreshOpenDeviceDetail: () => void;
};

export const initEvChargingSessionSmoothingHandlers = (deps: HandlerDeps): void => {
  document.addEventListener('device-smart-task-candidates-changed', deps.refreshOpenDeviceDetail);
  document.addEventListener('prices-updated', deps.refreshOpenDeviceDetail);
  toggle?.addEventListener('change', async () => {
    const deviceId = deps.getCurrentDetailDeviceId();
    if (!deviceId || !toggle || state.managedMap[deviceId] !== true) return;
    if (resolvedVisibility?.deviceId !== deviceId || !resolvedVisibility.visible || row?.hidden !== false) return;
    if (state.evChargingSessionSmoothingSettings[deviceId] !== true && !isDeviceSmartTaskCandidate(deviceId)) return;
    const enabled = toggle.selected;
    await serialize(async () => {
      try {
        const next = await readWritableSettings();
        if (enabled) next[deviceId] = true;
        else delete next[deviceId];
        await setSetting(EV_CHARGING_SESSION_SMOOTHING, next);
        state.evChargingSessionSmoothingSettings = next;
        await showToast('Saved', 'ok', { durationMs: 1500 });
      } catch (error) {
        await logSettingsError('Failed to save charging session settings', error, 'device detail');
        await showToastError(error, 'Failed to save charging session settings.');
      }
      deps.refreshOpenDeviceDetail();
    });
  });
};
