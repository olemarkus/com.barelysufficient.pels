import type { EvCarAssociations } from '../../../../contracts/src/types.ts';
import { isEvChargerDevice } from '../deviceKind.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { EV_CAR_ASSOCIATIONS } from '../../../../contracts/src/settingsKeys.ts';
import { normalizeEvCarAssociations } from '../../../../contracts/src/evCarAssociations.ts';
import { resolveEvChargingStateLabel } from '../../../../shared-domain/src/planSteppedCardText.ts';
import {
  deviceDetailCarFlowNote,
  deviceDetailCarList,
  deviceDetailCarSection,
  deviceDetailCarStatus,
} from '../dom.ts';
import { callApi, getSetting } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { state } from '../state.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';

/**
 * The charger page's car picker: which cars this charger may match, and which
 * one it matched.
 *
 * The list is a plain Homey device enumeration — PELS stores nothing about cars
 * it has seen. What the user ticks is an ELIGIBILITY set; the association itself
 * is decided by the car-link probe from a coincident plug-in and arrives on the
 * device payload as `associatedCar`.
 */

type CarOption = { id: string; name: string };

const runSerializedCarWrite = createSerializedAsyncRunner();

// Cars are fetched lazily on the first charger page. `null` means never loaded.
let carOptions: CarOption[] | null = null;
let carOptionsLoading = false;
// An empty result is rendered (so the user sees WHY there are no cars) but not
// treated as settled, so the next panel open re-fetches. Caching it would leave
// the picker empty for the whole WebView session after one transient blip.
let carOptionsRetryable = false;

export const supportsCarAssociation = (
  device: SettingsUiDeviceDetailItem | null | undefined,
): boolean => isEvChargerDevice(device);

export const loadEvCarAssociations = async (): Promise<void> => {
  try {
    state.evCarAssociations = normalizeEvCarAssociations(await getSetting(EV_CAR_ASSOCIATIONS));
  } catch (error) {
    // Deliberately NOT reset to `{}`: the last-known map is better than none, and
    // an empty one becomes the fallback for the next write, which would persist
    // every charger's cars away on the strength of one failed read.
    await logSettingsError('Failed to load car associations', error, 'loadEvCarAssociations');
  }
};

type HomeyDeviceEntry = {
  id: string;
  name: string;
  class?: string;
  hasCarAssociationSupport?: boolean;
};

/**
 * Only cars that publish BOTH capabilities the probe reads are offered. A car
 * missing them can never be matched or contribute a battery level, and offering
 * one would be offering a tick that does nothing.
 */
const toCarOptions = (devices: readonly unknown[]): CarOption[] => devices
  .filter((entry): entry is HomeyDeviceEntry => (
    // The response crosses an API boundary, so shape-guard before reading it:
    // one malformed entry must not throw and take the whole picker with it.
    typeof entry === 'object' && entry !== null
    && typeof (entry as HomeyDeviceEntry).id === 'string'
    && typeof (entry as HomeyDeviceEntry).name === 'string'
    && (entry as HomeyDeviceEntry).class === 'car'
    && (entry as HomeyDeviceEntry).hasCarAssociationSupport === true
  ))
  .map((device) => ({ id: device.id, name: device.name }));

const ensureCarsLoaded = async (render: () => void): Promise<void> => {
  if ((carOptions !== null && !carOptionsRetryable) || carOptionsLoading) return;
  carOptionsLoading = true;
  try {
    const devices = await callApi<HomeyDeviceEntry[] | null>('GET', '/homey_devices');
    const payload = Array.isArray(devices) ? devices : [];
    carOptions = toCarOptions(payload);
    // Retry on the next open when the result was empty — that is what a backend
    // still wiring up looks like — but render it meanwhile so the user gets the
    // explicit "no cars found" hint rather than a permanent spinner.
    carOptionsRetryable = carOptions.length === 0;
    render();
  } catch (error) {
    await logSettingsError('Failed to load cars for the charger car picker', error, 'carAssociation');
  } finally {
    carOptionsLoading = false;
  }
};

/**
 * The ticked ids that no longer match a known car — kept visible so a car
 * removed from Homey can still be un-ticked, rather than leaving an invisible
 * entry the user cannot clear.
 */
const orphanedCarIds = (ticked: readonly string[], known: CarOption[]): CarOption[] => ticked
  .filter((carId) => !known.some((car) => car.id === carId))
  .map((carId) => ({ id: carId, name: 'Removed car' }));

const tickedCarIds = (deviceId: string): readonly string[] => (
  state.evCarAssociations[deviceId]?.carIds ?? []
);

const renderStatus = (device: SettingsUiDeviceDetailItem, ticked: readonly string[]): void => {
  if (!deviceDetailCarStatus) return;
  // Only while it is still ticked: the payload decoration lags a write by one
  // poll, and naming a car the user just removed reads as the write failing.
  const decorated = device.associatedCar;
  const associated = decorated && ticked.includes(decorated.carId) ? decorated : undefined;
  deviceDetailCarStatus.hidden = ticked.length === 0;
  if (ticked.length === 0) {
    deviceDetailCarStatus.textContent = '';
    return;
  }
  if (associated) {
    const stateLabel = resolveEvChargingStateLabel(associated.chargingState);
    const level = typeof associated.socPct === 'number' && Number.isFinite(associated.socPct)
      ? `${Math.round(associated.socPct)} %`
      : null;
    deviceDetailCarStatus.textContent = [formatDisplayDeviceName(associated.carName), stateLabel, level]
      .filter((part): part is string => part !== null)
      .join(' · ');
    return;
  }
  // Ticked but unmatched. Deliberately not "no car": PELS matches a car a minute
  // or two after it plugs in, so claiming absence during that window would be
  // wrong as often as it was right.
  deviceDetailCarStatus.textContent = 'Waiting to match a car';
};

/**
 * What the note says depends on whether a car is actually matched, because the
 * two states are opposite news.
 *
 * Matched: where the level comes from, stated calmly. Ticked but unmatched: the
 * charger has NO battery level at all right now — adoption switches on with the
 * tick, not with the match — so saying "PELS now takes the level from the car"
 * there would contradict the status line above it and Setup's "Not reported"
 * below it, on one screen.
 *
 * Both sources are named. An owner whose charger publishes its own level would
 * otherwise read a Flow-card-only warning, conclude it does not apply, and lose
 * a working readout at the exact moment they act.
 */
const renderFlowNote = (device: SettingsUiDeviceDetailItem, ticked: readonly string[]): void => {
  if (!deviceDetailCarFlowNote) return;
  deviceDetailCarFlowNote.hidden = ticked.length === 0;
  if (ticked.length === 0) return;

  const matched = device.associatedCar;
  deviceDetailCarFlowNote.classList.toggle('field__hint--alert', matched === undefined);
  deviceDetailCarFlowNote.textContent = matched
    ? `Battery level comes from ${formatDisplayDeviceName(matched.carName)}.`
    : 'Until a car is matched this charger has no battery level: while a car is ticked, '
      + 'both the Flow card that reports it and the charger\'s own reading are ignored.';
};

const renderCarRows = (deviceId: string, ticked: readonly string[]): void => {
  if (!deviceDetailCarList) return;
  deviceDetailCarList.replaceChildren();

  if (carOptions === null) {
    deviceDetailCarList.append(hint('Looking for cars…'));
    return;
  }
  const rows = [...carOptions, ...orphanedCarIds(ticked, carOptions)];
  if (rows.length === 0) {
    deviceDetailCarList.append(hint(
      'No cars found. A car app that reports charging state and battery level will show up here.',
    ));
    return;
  }
  for (const car of rows) {
    deviceDetailCarList.append(carRow(deviceId, car, ticked.includes(car.id)));
  }
};

const hint = (text: string): HTMLElement => {
  const element = document.createElement('small');
  element.className = 'field__hint';
  element.textContent = text;
  return element;
};

const carRow = (deviceId: string, car: CarOption, checked: boolean): HTMLElement => {
  const row = document.createElement('label');
  row.className = 'md-switch-row detail-car-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.dataset.carId = car.id;
  input.addEventListener('change', () => {
    void runSerializedCarWrite(() => writeAssociation(deviceId, car.id, input.checked));
  });
  const label = document.createElement('span');
  label.className = 'md-switch-row__label pels-text-settings-label';
  label.textContent = formatDisplayDeviceName(car.name);
  row.append(input, label);
  return row;
};

const writeAssociation = async (deviceId: string, carId: string, ticked: boolean): Promise<void> => {
  await writeFreshSetting<EvCarAssociations>({
    key: EV_CAR_ASSOCIATIONS,
    context: 'device detail',
    logMessage: 'Failed to update the charger car list',
    toastMessage: 'Failed to update the car list.',
    // The live map, never `{}` — a transient null read would otherwise erase
    // every other charger's cars.
    fallbackValue: state.evCarAssociations,
    // Normalize only a real object; anything else returns null so the helper
    // falls back to the live map rather than treating a transient bad read as
    // "no charger has any cars".
    readFresh: (value) => (value && typeof value === 'object' && !Array.isArray(value)
      ? normalizeEvCarAssociations(value)
      : null),
    mutate: (current) => {
      const currentIds = current[deviceId]?.carIds ?? [];
      const nextIds = ticked
        ? [...new Set([...currentIds, carId])]
        : currentIds.filter((id) => id !== carId);
      const next = { ...current };
      // An empty set is indistinguishable from "off", so the entry goes away
      // rather than persisting as a configured-but-empty charger.
      if (nextIds.length === 0) delete next[deviceId];
      else next[deviceId] = { carIds: nextIds };
      return next;
    },
    commit: (next) => {
      state.evCarAssociations = next;
      renderCarAssociation(getRenderDevice());
    },
    rollback: () => renderCarAssociation(getRenderDevice()),
  });
};

// The device the section is currently rendered for, so a write can re-render
// without the caller threading it back through.
let currentDevice: SettingsUiDeviceDetailItem | null = null;
const getRenderDevice = (): SettingsUiDeviceDetailItem | null => currentDevice;

export const renderCarAssociation = (device: SettingsUiDeviceDetailItem | null): void => {
  if (!deviceDetailCarSection) return;
  currentDevice = device;
  const visible = supportsCarAssociation(device);
  deviceDetailCarSection.hidden = !visible;
  if (!visible || !device) return;

  void ensureCarsLoaded(() => renderCarAssociation(currentDevice));

  const ticked = tickedCarIds(device.id);
  renderCarRows(device.id, ticked);
  renderStatus(device, ticked);
  renderFlowNote(device, ticked);
};
