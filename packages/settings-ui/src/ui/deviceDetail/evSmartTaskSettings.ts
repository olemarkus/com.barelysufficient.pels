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
type CapacityField = HTMLElement & { value: string };
const capacity = document.querySelector<CapacityField>('#device-detail-ev-usable-battery');
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

const saveDeviceSetting = async <K extends keyof EvSmartTaskSettings>(
  id: string,
  key: K,
  value: EvSmartTaskSettings[K],
): Promise<void> => {
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

const parseCapacity = (value: string): number | undefined => {
  const text = value.trim().replace(',', '.');
  if (text === '') return undefined;
  const capacityKWh = Number(text);
  if (!/^\d+(?:\.\d+)?$/.test(text) || !isUsableEvBatteryCapacity(capacityKWh)) {
    throw new Error('Enter a usable battery capacity from 5 to 250 kWh.');
  }
  return capacityKWh;
};

export const createCarCapacityField = (carId: string, carName: string): HTMLElement => {
  const field = document.createElement('md-filled-text-field') as CapacityField;
  field.dataset.carBatteryCapacity = carId;
  field.setAttribute('label', 'Usable car battery capacity');
  field.setAttribute('aria-label', `Usable battery capacity for ${carName}`);
  field.setAttribute('type', 'text');
  field.setAttribute('inputmode', 'decimal');
  field.setAttribute('suffix-text', 'kWh');
  field.setAttribute('supporting-text', 'Used for percentage Smart tasks when this car is matched to a charger.');
  const restore = () => { field.value = state.evSmartTaskSettings[carId]?.usableBatteryKWh?.toString() ?? ''; };
  restore();
  field.addEventListener('change', () => {
    const save = async () => saveDeviceSetting(carId, 'usableBatteryKWh', parseCapacity(field.value));
    void save().catch(async (error: unknown) => {
      restore();
      await showToastError(error, 'Could not save the car’s usable battery capacity.');
    });
  });
  return field;
};

export const initEvSmartTaskSettings = (deps: { getCurrentDetailDeviceId: () => string | null }): void => {
  const save = async <K extends keyof EvSmartTaskSettings>(key: K, value: EvSmartTaskSettings[K]): Promise<void> => {
    const id = deps.getCurrentDetailDeviceId();
    if (!id || id !== renderedDeviceId || row?.hidden !== false) return;
    await saveDeviceSetting(id, key, value);
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
    const saveCapacity = async () => save('usableBatteryKWh', parseCapacity(capacity.value));
    void saveCapacity().catch(recover);
  });
  pause?.addEventListener('change', () => {
    void save('pauseOnBatteryDischarge', pause.selected ? true : undefined).catch(recover);
  });
};
