import type { EvCarAssociations } from '../../../../contracts/src/types.ts';
import {
  SETTINGS_UI_RECOMMENDATION_CARS_PATH,
  SETTINGS_UI_CAR_ASSOCIATION_CONFIRM_PATH,
  SETTINGS_UI_CAR_ASSOCIATION_CLEAR_PATH,
  SETTINGS_UI_DEVICES_PATH,
  type SettingsUiRecommendationCar,
  type SettingsUiCarAssociationConfirmation,
} from '../../../../contracts/src/settingsUiApi.ts';
import {
  hasMatchedAnotherCurrentCharger,
  parseCarAssociationCandidatesRead,
  REMOVED_CAR_LABEL,
} from '../carAssociationCandidates.ts';
import { isEvChargerDevice } from '../deviceKind.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { EV_CAR_ASSOCIATIONS } from '../../../../shared-domain/src/settings/settingsKeys.ts';
import { normalizeEvCarAssociations } from '../../../../shared-domain/src/settings/evCarAssociations.ts';
import { resolveEvChargingStateLabel } from '../../../../shared-domain/src/evChargingStateLabel.ts';
import {
  deviceDetailCarFlowNote,
  deviceDetailCarList,
  deviceDetailCarSection,
  deviceDetailCarStatus,
} from '../dom.ts';
import {
  callApi, getHomeyTimezone, getSetting, getSettingFresh, invalidateApiCacheForAllHomes, sleep,
} from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { isEvObserved } from '../../../../shared-domain/src/evObservedState.ts';
import { isEvPlugStateConnected } from '../../../../shared-domain/src/evPlugState.ts';
import { showToastError } from '../toast.ts';
import { state } from '../state.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';

/**
 * The charger page's car picker: which cars this charger may match, and which
 * one it matched.
 *
 * The backend supplies the eligible cars, just as it does for recommendations.
 * What the user ticks is an ELIGIBILITY set; the association itself
 * is decided by the car-link probe or explicitly confirmed and arrives on the
 * device payload as `associatedCar`.
 */

type CarOption = SettingsUiRecommendationCar;

const runSerializedCarWrite = createSerializedAsyncRunner();
const ASSOCIATION_READ_RETRY_DELAYS_MS = [250, 750] as const;
let associationLoadGeneration = 0;
let confirmationPending = false;

// Cars are fetched lazily on the first charger page. `null` means never loaded.
let carOptions: CarOption[] | null = null;
let carOptionsLoading = false;
let carOptionsUnavailable = false;
// Each car carries its match history, which moves with every plug-in, so the
// list is re-read whenever a charger page opens rather than once per session.
let carOptionsStale = true;
// Bumped by every invalidation, so a read already in flight when a page opens
// does not count as that page's fresh read.
let carOptionsGeneration = 0;

/** Re-read the cars, and their match history, on the next render. */
export const invalidateCarOptions = (): void => {
  carOptionsStale = true;
  carOptionsGeneration += 1;
};

export const supportsCarAssociation = (
  device: SettingsUiDeviceDetailItem | null | undefined,
): boolean => isEvChargerDevice(device);

export const loadEvCarAssociations = async (): Promise<void> => {
  const generation = ++associationLoadGeneration;
  try {
    let value = await getSetting(EV_CAR_ASSOCIATIONS);
    for (const delayMs of ASSOCIATION_READ_RETRY_DELAYS_MS) {
      if (value !== null && value !== undefined) break;
      await sleep(delayMs);
      value = await getSettingFresh(EV_CAR_ASSOCIATIONS);
    }
    // A newer reload or an authoritative unset owns the state now. An older SDK
    // read may still resolve, but it must not restore the map that event replaced.
    if (generation !== associationLoadGeneration) return;
    if (value !== null && value !== undefined
      && (typeof value !== 'object' || Array.isArray(value))) {
      await logSettingsError(
        'Ignoring malformed car associations',
        new TypeError('Invalid car association setting.'),
        'loadEvCarAssociations',
      );
      return;
    }
    if (value === null || value === undefined) {
      // A cold read that stays absent after the grace retries means the key has
      // never been written. Once a trusted map is loaded, absence is a
      // transient SDK failure and must not erase the merge base for the next
      // write. A real deletion arrives through settings.unset and is handled by
      // clearEvCarAssociations.
      if (!state.evCarAssociationsLoaded) {
        state.evCarAssociations = {};
        state.evCarAssociationsLoaded = true;
      }
      return;
    }
    state.evCarAssociations = normalizeEvCarAssociations(value);
    state.evCarAssociationsLoaded = true;
  } catch (error) {
    // Deliberately NOT reset to `{}`: the last-known map is better than none, and
    // an empty one becomes the fallback for the next write, which would persist
    // every charger's cars away on the strength of one failed read.
    await logSettingsError('Failed to load car associations', error, 'loadEvCarAssociations');
  }
};

export const clearEvCarAssociations = (): void => {
  associationLoadGeneration += 1;
  state.evCarAssociations = {};
  state.evCarAssociationsLoaded = true;
};

const ensureCarsLoaded = async (render: () => void): Promise<void> => {
  // An empty result remains retryable on the next panel open instead of leaving
  // the picker empty for the whole WebView session after a transient blip.
  if (carOptionsLoading) return;
  if (!carOptionsStale && carOptions !== null && carOptions.length > 0) return;
  carOptionsLoading = true;
  const generation = carOptionsGeneration;
  let invalidatedInFlight = false;
  try {
    const read = parseCarAssociationCandidatesRead(
      await callApi<unknown>('GET', SETTINGS_UI_RECOMMENDATION_CARS_PATH),
    );
    if (read.state === 'unavailable') throw new Error('Car candidates are unavailable.');
    carOptions = read.cars;
    invalidatedInFlight = generation !== carOptionsGeneration;
    carOptionsStale = invalidatedInFlight;
    carOptionsUnavailable = false;
    render();
  } catch (error) {
    // A failed re-read keeps the rows already on screen, still stale, so their
    // match history is not shown; only a picker that never loaded reports the
    // failure.
    carOptionsUnavailable = carOptions === null;
    render();
    await logSettingsError('Failed to load cars for the charger car picker', error, 'carAssociation');
  } finally {
    carOptionsLoading = false;
  }
  // A page opened while this read was in flight gets its own fresh read.
  if (invalidatedInFlight) render();
};

/**
 * The ticked ids that no longer match a known car — kept visible so a car
 * removed from Homey can still be un-ticked, rather than leaving an invisible
 * entry the user cannot clear.
 */
const orphanedCarIds = (ticked: readonly string[], known: CarOption[]): CarOption[] => ticked
  .filter((carId) => !known.some((car) => car.id === carId))
  .map((carId) => ({ id: carId, name: REMOVED_CAR_LABEL, matchHistory: { state: 'resolved', chargerMatches: [] } }));

const tickedCarIds = (deviceId: string): readonly string[] => (
  state.evCarAssociations[deviceId]?.carIds ?? []
);

const positionCarStatus = (confirmed: boolean): void => {
  if (!deviceDetailCarList || !deviceDetailCarStatus) return;
  deviceDetailCarList.insertAdjacentElement(confirmed ? 'afterend' : 'beforebegin', deviceDetailCarStatus);
  deviceDetailCarStatus.classList.toggle('detail-car-status--secondary', confirmed);
};

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
  const confirmation = device.carConfirmation;
  const confirmed = confirmation && ticked.includes(confirmation.carId);
  positionCarStatus(Boolean(confirmed));
  if (confirmed) {
    const reportedState = associated
      ? `Car app reports: ${resolveEvChargingStateLabel(associated.chargingState)}`
      : 'Car app unavailable';
    const rowUnavailable = carOptionsUnavailable || !carOptions?.some((car) => car.id === confirmation.carId);
    deviceDetailCarStatus.textContent = rowUnavailable
      ? `${formatDisplayDeviceName(confirmation.carName)} · confirmed for this connection · ${reportedState}`
      : reportedState;
    return;
  }
  if (associated) {
    deviceDetailCarStatus.textContent = `${formatDisplayDeviceName(associated.carName)} · `
      + `Car reports: ${resolveEvChargingStateLabel(associated.chargingState)}`;
    return;
  }
  if (!device.available) {
    deviceDetailCarStatus.textContent = 'Charger unavailable';
    return;
  }
  deviceDetailCarStatus.textContent = isConnectedCharger(device)
    ? 'Waiting to identify the connected car'
    : 'No car connected';
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
  deviceDetailCarFlowNote.hidden = ticked.length === 0 || !isConnectedCharger(device);
  deviceDetailCarFlowNote.classList.remove('field__hint--alert');
  if (deviceDetailCarFlowNote.hidden) {
    deviceDetailCarFlowNote.textContent = '';
    return;
  }

  const decorated = device.associatedCar;
  const matched = decorated && ticked.includes(decorated.carId) ? decorated : undefined;
  const hasBatteryLevel = matched !== undefined
    && typeof matched.socPct === 'number'
    && Number.isFinite(matched.socPct);
  deviceDetailCarFlowNote.classList.toggle('field__hint--alert', !hasBatteryLevel);
  if (device.carConfirmation && ticked.includes(device.carConfirmation.carId) && !device.carConfirmation.available) {
    deviceDetailCarFlowNote.textContent = 'The confirmed car is unavailable. '
      + 'Battery level will return when its app reconnects.';
    return;
  }
  if (device.carConfirmation && hasBatteryLevel) {
    deviceDetailCarFlowNote.hidden = true;
    deviceDetailCarFlowNote.textContent = '';
    return;
  }
  if (!matched) {
    deviceDetailCarFlowNote.textContent = 'Until a car is matched, this charger has no battery level. '
      + 'Confirm which selected car is connected to use its battery level for this connection. '
      + "While a car is selected, PELS ignores both the Flow card that reports the level "
      + "and the charger's own reading.";
    return;
  }
  deviceDetailCarFlowNote.textContent = hasBatteryLevel
    ? `Battery level comes from ${formatDisplayDeviceName(matched.carName)}.`
    : `${formatDisplayDeviceName(matched.carName)} is matched but has not reported a battery level. `
      + 'Charge boost and Smart tasks cannot use it yet.';
};

const lastMatchToCharger = (
  history: Extract<CarOption['matchHistory'], { state: 'resolved' }>,
  chargerId: string,
): number | undefined => (
  history.chargerMatches.find((match) => match.chargerId === chargerId)?.lastMatchedAtMs
);

const formatMatchDate = (ms: number): string => new Intl.DateTimeFormat('en-GB', {
  timeZone: getHomeyTimezone(),
  day: 'numeric',
  month: 'short',
}).format(new Date(ms));

/** The chargers in the device list; a match to any other is to a retired charger. */
const currentChargerIds = (): ReadonlySet<string> => new Set(
  state.latestDevices.filter(isEvChargerDevice).map((device) => device.id),
);

/**
 * No hint while the history is unreadable or the list awaits its re-read:
 * silence beats a wrong "not matched".
 */
const matchHint = (car: CarOption, charger: SettingsUiDeviceDetailItem): string | null => {
  // The car on this charger now: it is matched even before its first match is recorded.
  if (charger.associatedCar?.carId === car.id) return 'Matched to this charger now';
  if (carOptionsStale || car.matchHistory.state === 'unavailable') return null;
  const chargerId = charger.id;
  const lastMatchedAtMs = lastMatchToCharger(car.matchHistory, chargerId);
  if (lastMatchedAtMs !== undefined) return `Last matched to this charger on ${formatMatchDate(lastMatchedAtMs)}`;
  // "yet" promises a match that a car charging on another charger will not bring.
  return hasMatchedAnotherCurrentCharger(car.matchHistory, chargerId, currentChargerIds())
    ? 'Not matched to this charger'
    : 'Not matched to this charger yet';
};

const renderCarRows = (device: SettingsUiDeviceDetailItem, ticked: readonly string[]): void => {
  if (!deviceDetailCarList) return;
  deviceDetailCarList.replaceChildren();

  if (carOptions === null || carOptionsUnavailable) {
    deviceDetailCarList.append(hint(carOptionsUnavailable
      ? 'Could not load cars. Open this device again to retry.'
      : 'Looking for cars…'));
    return;
  }
  const deviceId = device.id;
  const orphans = orphanedCarIds(ticked, carOptions);
  const rows = [...carOptions, ...orphans];
  if (rows.length === 0) {
    deviceDetailCarList.append(hint(
      'No cars found. A car app that reports charging state and battery level will show up here.',
    ));
    return;
  }
  for (const car of rows) {
    deviceDetailCarList.append(carRow(device, car, ticked.includes(car.id), !orphans.includes(car)));
    if (ticked.includes(car.id) && !orphans.includes(car) && device.available && isConnectedCharger(device)
      && device.carConfirmation?.carId !== car.id) {
      const button = document.createElement('md-outlined-button');
      button.textContent = 'Confirm connected car';
      button.setAttribute('aria-label', `Confirm ${formatDisplayDeviceName(car.name)} as the connected car`);
      button.className = 'detail-car-confirm';
      button.toggleAttribute('disabled', confirmationPending);
      button.addEventListener('click', () => { void updateConfirmation(deviceId, car.id); });
      deviceDetailCarList.append(button);
    }

  }
};

const hint = (text: string): HTMLElement => {
  const element = document.createElement('small');
  element.className = 'field__hint';
  element.textContent = text;
  return element;
};

const carRow = (
  device: SettingsUiDeviceDetailItem, car: CarOption, checked: boolean, known: boolean,
): HTMLElement => {
  const deviceId = device.id;
  const row = document.createElement('label');
  row.className = 'md-switch-row detail-car-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.dataset.carId = car.id;
  input.addEventListener('change', () => {
    void runSerializedCarWrite(() => writeAssociation(deviceId, car.id, input.checked));
  });
  const content = document.createElement('span');
  content.className = 'md-switch-row__content';
  const label = document.createElement('span');
  label.className = 'md-switch-row__label pels-text-settings-label';
  const confirmed = device.carConfirmation?.carId === car.id && checked;
  label.textContent = formatDisplayDeviceName(car.name)
    + (confirmed ? ' · confirmed for this connection' : '');
  content.append(label);
  // A removed car has no history to show; its row exists only so it can be cleared.
  const matchText = known ? matchHint(car, device) : null;
  if (!confirmed && matchText !== null) content.append(hint(matchText));
  row.append(input, content);
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
      document.dispatchEvent(new Event('ev-car-associations-updated'));
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
  renderCarRows(device, ticked);
  if (device.carConfirmation && ticked.includes(device.carConfirmation.carId)) {
    const button = document.createElement('md-outlined-button');
    button.textContent = 'Clear confirmation';
    button.className = 'detail-car-clear';
    button.toggleAttribute('disabled', confirmationPending);
    button.addEventListener('click', () => { void updateConfirmation(device.id); });
    deviceDetailCarList?.append(button);
  }
  renderStatus(device, ticked);
  renderFlowNote(device, ticked);
};

const isConnectedCharger = (device: SettingsUiDeviceDetailItem): boolean => (
  isEvObserved(device) && isEvPlugStateConnected(device.evChargingState)
);

const updateConfirmation = async (chargerId: string, carId?: string): Promise<void> => {
  if (confirmationPending) return;
  confirmationPending = true;
  renderCarAssociation(currentDevice);
  try {
    const { carConfirmation, associatedCar, stateOfCharge } = await callApi<SettingsUiCarAssociationConfirmation>(
      'POST', carId ? SETTINGS_UI_CAR_ASSOCIATION_CONFIRM_PATH : SETTINGS_UI_CAR_ASSOCIATION_CLEAR_PATH,
      carId ? { chargerId, carId } : { chargerId },
    );
    invalidateApiCacheForAllHomes(SETTINGS_UI_DEVICES_PATH);
    state.latestDevices = state.latestDevices.map((device) => (
      device.id === chargerId ? { ...device, carConfirmation, associatedCar, stateOfCharge } : device
    ));
    if (currentDevice?.id === chargerId) {
      currentDevice = { ...currentDevice, carConfirmation, associatedCar, stateOfCharge };
    }
    document.dispatchEvent(new CustomEvent('devices-updated', { detail: { devices: state.latestDevices } }));
  } catch (error) {
    await logSettingsError('Failed to update the car confirmation', error, 'carAssociation');
    await showToastError(error, carId ? 'Could not confirm the connected car.' : 'Could not clear the confirmation.');
  } finally {
    confirmationPending = false;
    renderCarAssociation(currentDevice);
  }
};
