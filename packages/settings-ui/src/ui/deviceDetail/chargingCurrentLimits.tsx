import { render } from 'preact';
import type { EvChargingCurrentLimitsMap, EvChargingCurrentLimits } from '../../../../contracts/src/types.ts';
import type { SettingsUiRecommendationCar } from '../../../../contracts/src/settingsUi/carLink.ts';
import {
  isEvChargingCurrentLimitsMap, normalizeEvChargingCurrentLimitsMap,
} from '../../../../shared-domain/src/settings/evChargingCurrentLimits.ts';
import { EV_CAR_CURRENT_LIMITS, EV_CHARGER_CURRENT_LIMITS } from '../../../../shared-domain/src/settings/settingsKeys.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import { getSetting, getSettingFresh, coldStartReadRetryDelays, sleep } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { state } from '../state.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { appliesChargingCurrentLimits, getEffectiveControlModel } from '../deviceControlProfiles.ts';
import { isEvChargerDevice } from '../deviceKind.ts';
import { ChargingCurrentLimitsView } from '../views/ChargingCurrentLimits.tsx';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';

type CurrentLimitsKey = typeof EV_CAR_CURRENT_LIMITS | typeof EV_CHARGER_CURRENT_LIMITS;
const runSerializedLimitsWrite = createSerializedAsyncRunner();
const loadGeneration: Record<CurrentLimitsKey, number> = { [EV_CAR_CURRENT_LIMITS]: 0, [EV_CHARGER_CURRENT_LIMITS]: 0 };
const loadFailed: Record<CurrentLimitsKey, boolean> = { [EV_CAR_CURRENT_LIMITS]: false, [EV_CHARGER_CURRENT_LIMITS]: false };
const currentMap = (key: CurrentLimitsKey): EvChargingCurrentLimitsMap => (
  key === EV_CAR_CURRENT_LIMITS ? state.evCarCurrentLimits : state.evChargerCurrentLimits
);
const isLoaded = (key: CurrentLimitsKey): boolean => (
  key === EV_CAR_CURRENT_LIMITS ? state.evCarCurrentLimitsLoaded : state.evChargerCurrentLimitsLoaded
);
const acceptMap = (key: CurrentLimitsKey, limits: EvChargingCurrentLimitsMap): void => {
  if (key === EV_CAR_CURRENT_LIMITS) {
    state.evCarCurrentLimits = limits;
    state.evCarCurrentLimitsLoaded = true;
  } else {
    state.evChargerCurrentLimits = limits;
    state.evChargerCurrentLimitsLoaded = true;
  }
};

async function loadCurrentLimits(key: CurrentLimitsKey): Promise<void> {
  const generation = ++loadGeneration[key];
  try {
    let value = await getSetting(key);
    for (const delayMs of coldStartReadRetryDelays(key, [250, 750])) {
      if (value !== null && value !== undefined) break;
      await sleep(delayMs);
      value = await getSettingFresh(key);
    }
    if (generation !== loadGeneration[key]) return;
    if (value === null || value === undefined) {
      loadFailed[key] = false;
      if (!isLoaded(key)) acceptMap(key, {});
      return;
    }
    if (!isEvChargingCurrentLimitsMap(value)) throw new TypeError('Invalid charging current limits setting.');
    loadFailed[key] = false;
    acceptMap(key, normalizeEvChargingCurrentLimitsMap(value));
  } catch (error) {
    if (generation === loadGeneration[key]) loadFailed[key] = true;
    await logSettingsError('Failed to load charging current limits', error, 'loadCurrentLimits');
  }
}

function clearCurrentLimits(key: CurrentLimitsKey): void {
  loadGeneration[key] += 1;
  loadFailed[key] = false;
  acceptMap(key, {});
}

export const loadEvCarCurrentLimits = (): Promise<void> => loadCurrentLimits(EV_CAR_CURRENT_LIMITS);
export const loadEvChargerCurrentLimits = (): Promise<void> => loadCurrentLimits(EV_CHARGER_CURRENT_LIMITS);
export const clearEvCarCurrentLimits = (): void => clearCurrentLimits(EV_CAR_CURRENT_LIMITS);
export const clearEvChargerCurrentLimits = (): void => clearCurrentLimits(EV_CHARGER_CURRENT_LIMITS);

function showLoading(container: HTMLElement, key: CurrentLimitsKey): boolean {
  if (isLoaded(key)) return false;
  render(<p class="field__hint">{loadFailed[key]
    ? 'Could not load charging current limits. Open this device again to retry.'
    : 'Loading charging current limits…'}</p>, container);
  return true;
}

/** A car override follows that car; without one, the editor shows this charger's default. */
export function renderCarCurrentLimits(
  container: HTMLElement,
  car: SettingsUiRecommendationCar,
  charger: SettingsUiDeviceDetailItem,
  refresh: () => void,
): void {
  if (showLoading(container, EV_CAR_CURRENT_LIMITS)) return;
  const saved = state.evCarCurrentLimits[car.id];
  if (!saved && showLoading(container, EV_CHARGER_CURRENT_LIMITS)) return;
  const limits = saved ?? state.evChargerCurrentLimits[charger.id] ?? { minA: 6, maxA: 32 };
  render(<ChargingCurrentLimitsView key={`car:${car.id}:${saved ? 'saved' : 'default'}:${limits.minA}:${limits.maxA}`}
    scope="car" subjectId={car.id} subjectName={formatDisplayDeviceName(car.name)} limits={limits}
    hasSavedLimits={saved !== undefined} appliesHere={appliesChargingCurrentLimits(charger)}
    onSave={(next) => persistCurrentLimits(EV_CAR_CURRENT_LIMITS, car.id, next, refresh)}
    onReset={() => persistCurrentLimits(EV_CAR_CURRENT_LIMITS, car.id, null, refresh)} />, container);
}

export function renderChargerCurrentLimits(device: SettingsUiDeviceDetailItem, refresh: () => void): void {
  const container = document.getElementById('device-detail-charger-current-limits');
  if (!container) return;
  const visible = isEvChargerDevice(device) && state.managedMap[device.id] === true
    && getEffectiveControlModel(device) === 'stepped_load' && appliesChargingCurrentLimits(device);
  container.hidden = !visible;
  if (!visible) { render(null, container); return; }
  if (showLoading(container, EV_CHARGER_CURRENT_LIMITS)) return;
  const saved = state.evChargerCurrentLimits[device.id];
  const limits = saved ?? { minA: 6, maxA: 32 };
  render(<ChargingCurrentLimitsView key={`charger:${device.id}:${saved ? 'saved' : 'default'}:${limits.minA}:${limits.maxA}`}
    scope="charger" subjectId={device.id} subjectName={formatDisplayDeviceName(device.name)} limits={limits}
    hasSavedLimits={saved !== undefined}
    onSave={(next) => persistCurrentLimits(EV_CHARGER_CURRENT_LIMITS, device.id, next, refresh)}
    onReset={() => persistCurrentLimits(EV_CHARGER_CURRENT_LIMITS, device.id, null, refresh)} />, container);
}

function persistCurrentLimits(
  key: CurrentLimitsKey,
  deviceId: string,
  limits: EvChargingCurrentLimits | null,
  refresh: () => void,
): Promise<boolean> {
  return runSerializedLimitsWrite(async () => {
    const saved = await writeFreshSetting<EvChargingCurrentLimitsMap>({
      key,
      context: 'charging current limits',
      logMessage: 'Failed to save charging current limits',
      toastMessage: 'Charging current limits could not be saved. Try again.',
      fallbackValue: currentMap(key),
      readFresh: (value) => isEvChargingCurrentLimitsMap(value) ? normalizeEvChargingCurrentLimitsMap(value) : null,
      mutate: (current) => {
        const next = { ...current };
        if (limits) next[deviceId] = limits;
        else delete next[deviceId];
        return next;
      },
      commit: (next) => {
        loadGeneration[key] += 1;
        loadFailed[key] = false;
        acceptMap(key, next);
        refresh();
      },
    });
    return saved !== null;
  });
}
