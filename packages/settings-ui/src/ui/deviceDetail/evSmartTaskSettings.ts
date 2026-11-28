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
let hasAcceptedSettings = false;
let pendingSettingsLoad: Promise<void> | undefined;
const CAR_CAPACITY_HINT = 'Used for percentage Smart tasks when this car is matched to a charger.';

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

function displayCarCapacity(field: CapacityField, carId: string): void {
  Object.assign(field, { value: state.evSmartTaskSettings[carId]?.usableBatteryKWh?.toString() ?? '' });
  field.setAttribute('supporting-text', CAR_CAPACITY_HINT);
  field.removeAttribute('disabled');
}

function acceptSettings(settings: unknown): void {
  state.evSmartTaskSettings = normalizeEvSmartTaskSettings(settings);
  hasAcceptedSettings = true;
  for (const field of document.querySelectorAll<CapacityField>('[data-car-battery-capacity][disabled]')) {
    const carId = field.dataset.carBatteryCapacity;
    if (carId) displayCarCapacity(field, carId);
  }
}

export const loadEvSmartTaskSettings = (): Promise<void> => {
  pendingSettingsLoad ??= serialize(async () => {
    try { acceptSettings(await readSettings()); } catch { /* Retain the last accepted map. */ }
  }).finally(() => { pendingSettingsLoad = undefined; });
  return pendingSettingsLoad;
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
    await serialize(async () => acceptSettings(await readSettings()));
    if (generation !== renderGeneration) return;
    applyValues(state.evSmartTaskSettings[id]);
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
    acceptSettings(settings);
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
  if (hasAcceptedSettings) displayCarCapacity(field, carId);
  else {
    field.setAttribute('disabled', '');
    field.setAttribute('supporting-text', 'Loading car battery capacity…');
    void loadEvSmartTaskSettings().then(() => {
      if (hasAcceptedSettings && field.hasAttribute('disabled')) displayCarCapacity(field, carId);
      if (field.hasAttribute('disabled')) field.setAttribute('supporting-text', 'Car battery capacity is unavailable.');
    });
  }
  field.addEventListener('change', () => {
    if (field.hasAttribute('disabled')) return;
    const editedValue = field.value;
    const save = async () => saveDeviceSetting(carId, 'usableBatteryKWh', parseCapacity(editedValue));
    void save().catch(async (error: unknown) => {
      await serialize(async () => {
        if (field.value === editedValue) displayCarCapacity(field, carId);
      });
      await showToastError(error, 'Could not save the car’s usable battery capacity.');
    });
  });
  return field;
};

export const initEvSmartTaskSettings = (deps: { getCurrentDetailDeviceId: () => string | null }): void => {
  let editRevision = 0;
  const save = <K extends keyof EvSmartTaskSettings>(key: K, readValue: () => EvSmartTaskSettings[K]): void => {
    const id = deps.getCurrentDetailDeviceId();
    if (!id || id !== renderedDeviceId || row?.hidden !== false) return;
    const revision = ++editRevision;
    const write = async () => saveDeviceSetting(id, key, readValue());
    void write().catch(async (error: unknown) => {
      await serialize(async () => {
        if (renderedDeviceId !== id || deps.getCurrentDetailDeviceId() !== id || revision !== editRevision) return;
        applyValues(state.evSmartTaskSettings[id]);
      });
      await showToastError(error, 'Could not save EV Smart task settings.');
    });
  };
  capacity?.addEventListener('change', () => save('usableBatteryKWh', () => parseCapacity(capacity.value)));
  pause?.addEventListener('change', () => save('pauseOnBatteryDischarge', () => pause.selected ? true : undefined));
};
