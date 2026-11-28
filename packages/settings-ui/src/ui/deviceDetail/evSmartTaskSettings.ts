import { SETTINGS_UI_BOOTSTRAP_PATH } from '../../../../contracts/src/settingsUi/paths.ts';
import { asUnknownRecord } from '../../../../shared-domain/src/recordGuards.ts';
import {
  EV_SMART_TASK_SETTINGS,
  isUsableEvBatteryCapacity,
  normalizeEvSmartTaskSettings,
  type EvSmartTaskSettings,
} from '../../../../shared-domain/src/settings/evSmartTaskSettings.ts';
import { isEvChargerDevice } from '../deviceKind.ts';
import { callApi, getSettingFresh, setSetting } from '../homey.ts';
import { state, type SettingsUiDeviceView } from '../state.ts';
import { showToastError } from '../toast.ts';
import { createSerializedAsyncRunner } from './settingsWrite.ts';

const row = document.querySelector<HTMLElement>('#device-detail-ev-smart-task-settings');
const capacity = document.querySelector<HTMLElement & { value: string }>('#device-detail-ev-usable-battery');
const pause = document.querySelector<HTMLElement & { selected: boolean }>('#device-detail-ev-pause-on-discharge');
const serialize = createSerializedAsyncRunner();
let renderedDeviceId: string | null = null;
let renderGeneration = 0;

const readSettings = async () => {
  let value = await getSettingFresh(EV_SMART_TASK_SETTINGS);
  if (value == null) {
    const bootstrap = asUnknownRecord(await callApi<unknown>('GET', SETTINGS_UI_BOOTSTRAP_PATH));
    value = asUnknownRecord(bootstrap?.settings)?.[EV_SMART_TASK_SETTINGS];
  }
  const settings = asUnknownRecord(value);
  if (!settings) throw new Error('EV Smart task settings could not be read.');
  return { ...settings };
};

export const resetEvSmartTaskSettings = (): void => {
  renderedDeviceId = null;
  renderGeneration += 1;
  if (row) row.hidden = true;
};

export const loadEvSmartTaskSettings = async (): Promise<void> => {
  try {
    state.evSmartTaskSettings = normalizeEvSmartTaskSettings(await readSettings());
  } catch { /* Retain the last accepted map. */ }
};

const applyValues = (settings: EvSmartTaskSettings | undefined): void => {
  if (capacity) capacity.value = settings?.usableBatteryKWh?.toString() ?? '';
  if (pause) pause.selected = settings?.pauseOnBatteryDischarge === true;
};

export const renderEvSmartTaskSettings = async (device: SettingsUiDeviceView | null): Promise<void> => {
  const generation = ++renderGeneration;
  if (!row) return;
  const id = device && isEvChargerDevice(device) && state.managedMap[device.id] === true ? device.id : null;
  if (id !== renderedDeviceId) {
    row.hidden = true;
    renderedDeviceId = null;
  }
  if (id === null) {
    renderedDeviceId = null;
    return;
  }
  // A power update can refresh the device page while the capacity field is being edited.
  if (id === renderedDeviceId) return;
  try {
    const settings = normalizeEvSmartTaskSettings(await readSettings())[id];
    if (generation !== renderGeneration) return;
    applyValues(settings);
    renderedDeviceId = id;
    row.hidden = false;
  } catch {
    if (generation === renderGeneration) row.hidden = true;
  }
};

export const initEvSmartTaskSettings = (deps: { getCurrentDetailDeviceId: () => string | null }): void => {
  const save = async <
    K extends keyof EvSmartTaskSettings,
  >(key: K, value: EvSmartTaskSettings[K]): Promise<void> => {
    const id = deps.getCurrentDetailDeviceId();
    if (!id || id !== renderedDeviceId || row?.hidden !== false) return;
    await serialize(async () => {
      const settings = await readSettings();
      const next = { ...asUnknownRecord(settings[id]) };
      if (value === undefined) delete next[key];
      else next[key] = value;
      if (Object.keys(next).length > 0) settings[id] = next;
      else delete settings[id];
      await setSetting(EV_SMART_TASK_SETTINGS, settings);
      state.evSmartTaskSettings = normalizeEvSmartTaskSettings(settings);
    });
  };
  const recover = async (error: unknown) => {
    if (renderedDeviceId === deps.getCurrentDetailDeviceId() && renderedDeviceId !== null) {
      try {
        const id = renderedDeviceId;
        const settings = normalizeEvSmartTaskSettings(await readSettings())[id];
        if (id === renderedDeviceId) applyValues(settings);
      } catch { /* Keep the last visible values if settings are unavailable. */ }
    }
    await showToastError(error, 'Could not save EV Smart task settings.');
  };
  capacity?.addEventListener('change', () => {
    const text = capacity.value.trim().replace(',', '.');
    const value = text === '' ? undefined : Number(text);
    if (value !== undefined && (!/^\d+(?:\.\d+)?$/.test(text) || !isUsableEvBatteryCapacity(value))) {
      void recover(new Error('Enter a usable battery capacity from 5 to 250 kWh.'));
      return;
    }
    void save('usableBatteryKWh', value).catch(recover);
  });
  pause?.addEventListener('change', () => {
    void save('pauseOnBatteryDischarge', pause.selected ? true : undefined).catch(recover);
  });
};
