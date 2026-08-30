import {
  advancedDeviceClearButton,
  advancedDeviceClearUnknownButton,
  advancedDeviceSelect,
  advancedApiDeviceSelect,
  advancedApiDeviceRefreshButton,
  advancedApiDeviceLogButton,
} from './dom.ts';
import { callApi } from './homey.ts';
import { renderDevices } from './devices.ts';
import { renderPriorities } from './modes.ts';
import { renderPriceOptimization } from './priceOptimization.ts';
import { showToast, showToastError } from './toast.ts';
import { logSettingsError } from './logging.ts';
import { state } from './state.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import {
  clearDeviceSettings,
  clearMultipleDeviceSettings,
  resolveDeviceOptionsFromSettings,
  resolveUnknownDeviceIdsFromSettings,
} from './advancedDeviceDataPurge.ts';

type HomeyApiDevice = {
  id: string;
  name: string;
  class?: string;
};

type MaterialSelectOptionElement = HTMLElement & {
  value: string;
  selected: boolean;
  displayText: string;
  typeaheadText: string;
};

// Exported for other dynamic-list pickers (e.g. the whole-home meter select).
export const createSelectOption = (value: string, label: string, selected = false): MaterialSelectOptionElement => {
  const option = document.createElement('md-select-option') as MaterialSelectOptionElement;
  option.value = value;
  option.setAttribute('value', value);
  option.selected = selected;
  // md-select reads `firstSelectedOption.displayText` synchronously while
  // resolving its initial value. By default that getter walks the option's
  // `[slot="headline"]` assignedElements, which are only available after the
  // option's own first render — a race that leaves the closed field blank (the
  // "Device" / "Homey device" pickers showed an empty box on first paint).
  // Setting `displayText`/`typeaheadText` as properties bypasses the slot lookup
  // and guarantees a label on first paint. Mirrors `createModeOption` in modes.ts.
  option.displayText = label;
  option.typeaheadText = label;
  const headline = document.createElement('div');
  headline.slot = 'headline';
  headline.textContent = label;
  option.appendChild(headline);
  return option;
};

let lastAdvancedDeviceOptionsSignature: string | null = null;

const renderAdvancedDeviceOptions = () => {
  if (!advancedDeviceSelect) return;
  const devices = resolveDeviceOptionsFromSettings();
  const unknownIds = resolveUnknownDeviceIdsFromSettings();
  // `devices-updated` fires on every power/state tick, but the device *set*
  // rarely changes. Rebuilding the <md-select> options on every tick closes the
  // menu mid-selection and resets the user's choice, so skip when unchanged.
  // Capture the RAW `device.name` (not the trimmed `formatDisplayDeviceName`
  // label): the transform is pure, so the raw value is the true cache key and a
  // genuine rename still busts the memo. Sort by id so the signature tracks the
  // device *set*, not the settings-map key order — a pure reorder must not bust
  // the memo and close an open menu (the render already sorts by name).
  const signature = JSON.stringify({
    devices: devices
      .map((device) => ({ id: device.id, name: device.name }))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, name }) => [id, name]),
    unknown: [...unknownIds].sort(),
  });
  if (signature === lastAdvancedDeviceOptionsSignature) return;
  lastAdvancedDeviceOptionsSignature = signature;
  advancedDeviceSelect.replaceChildren(
    createSelectOption('', devices.length ? 'Select a device' : 'No devices in settings', true),
  );
  advancedDeviceSelect.disabled = devices.length === 0;
  advancedDeviceSelect.value = '';
  if (advancedDeviceClearButton) {
    advancedDeviceClearButton.disabled = devices.length === 0;
  }
  if (advancedDeviceClearUnknownButton) {
    updateUnknownDevicesButton(unknownIds);
  }

  devices
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((device) => {
      advancedDeviceSelect.appendChild(createSelectOption(device.id, formatDisplayDeviceName(device.name)));
    });
};

const refreshUiAfterDeviceCleanup = () => {
  renderDevices(state.latestDevices);
  renderPriorities(state.latestDevices);
  renderPriceOptimization(state.latestDevices);
  renderAdvancedDeviceOptions();
};

const resolveApiDeviceLabel = (device: HomeyApiDevice) => {
  const { id, name } = device;
  const className = typeof device.class === 'string' ? device.class : '';
  const parts = [`${formatDisplayDeviceName(name)} (${id})`];
  if (className) parts.push(className);
  return parts.join(' · ');
};

const renderApiDeviceOptions = (devices: HomeyApiDevice[]) => {
  if (!advancedApiDeviceSelect) return;
  advancedApiDeviceSelect.replaceChildren(
    createSelectOption('', devices.length ? 'Select a device' : 'No devices available', true),
  );
  advancedApiDeviceSelect.disabled = devices.length === 0;
  advancedApiDeviceSelect.value = '';
  if (advancedApiDeviceLogButton) {
    advancedApiDeviceLogButton.disabled = devices.length === 0;
  }

  devices
    .slice()
    .sort((a, b) => resolveApiDeviceLabel(a).localeCompare(resolveApiDeviceLabel(b)))
    .forEach((device) => {
      advancedApiDeviceSelect.appendChild(createSelectOption(device.id, resolveApiDeviceLabel(device)));
    });
};

const setClearButtonBusy = (busy: boolean) => {
  if (!advancedDeviceClearButton) return;
  advancedDeviceClearButton.disabled = busy;
  advancedDeviceClearButton.classList.toggle('is-busy', busy);
  advancedDeviceClearButton.textContent = busy ? 'Clearing...' : 'Clear device data';
};

const getUnknownButtonLabel = (count: number) => (
  count > 0 ? `Clear unknown devices (${count})` : 'Clear unknown devices'
);

const setClearUnknownButtonBusy = (busy: boolean) => {
  if (!advancedDeviceClearUnknownButton) return;
  const count = resolveUnknownDeviceIdsFromSettings().length;
  advancedDeviceClearUnknownButton.disabled = busy || count === 0;
  advancedDeviceClearUnknownButton.classList.toggle('is-busy', busy);
  advancedDeviceClearUnknownButton.textContent = busy ? 'Clearing...' : getUnknownButtonLabel(count);
};

const setApiDeviceButtonsBusy = (busy: boolean) => {
  if (advancedApiDeviceRefreshButton) {
    advancedApiDeviceRefreshButton.disabled = busy;
    advancedApiDeviceRefreshButton.classList.toggle('is-busy', busy);
    advancedApiDeviceRefreshButton.textContent = busy ? 'Loading...' : 'Refresh list';
  }
  if (advancedApiDeviceLogButton) {
    advancedApiDeviceLogButton.disabled = busy || advancedApiDeviceSelect?.disabled === true;
    advancedApiDeviceLogButton.classList.toggle('is-busy', busy);
  }
};

let apiDevicesCache: HomeyApiDevice[] = [];

const fetchHomeyApiDevices = async (): Promise<HomeyApiDevice[]> => {
  const devices = await callApi<HomeyApiDevice[] | null>('GET', '/homey_devices');
  if (!Array.isArray(devices)) return [];
  return devices.filter((device): device is HomeyApiDevice => (
    Boolean(device)
    && typeof device.id === 'string'
    && typeof device.name === 'string'
  ));
};

const refreshApiDevices = async (showSuccessToast = true) => {
  if (!advancedApiDeviceSelect) return;
  try {
    setApiDeviceButtonsBusy(true);
    const devices = await fetchHomeyApiDevices();
    apiDevicesCache = devices;
    renderApiDeviceOptions(devices);
    if (showSuccessToast) {
      await showToast(`Loaded ${devices.length} devices from Homey.`, 'ok');
    }
  } catch (error) {
    await logSettingsError('Failed to load Homey devices', error, 'advancedDeviceLog');
    await showToastError(error, 'Failed to load Homey devices.');
  } finally {
    setApiDeviceButtonsBusy(false);
  }
};

let confirmTimeout: ReturnType<typeof setTimeout> | null = null;
let unknownConfirmTimeout: ReturnType<typeof setTimeout> | null = null;
let devicesUpdatedListenerRegistered = false;
let confirmCleanupRegistered = false;

const resetClearConfirmation = () => {
  if (!advancedDeviceClearButton) return;
  advancedDeviceClearButton.classList.remove('confirming');
  advancedDeviceClearButton.textContent = 'Clear device data';
  if (confirmTimeout) {
    clearTimeout(confirmTimeout);
    confirmTimeout = null;
  }
};

const requestClearConfirmation = () => {
  if (!advancedDeviceClearButton) return;
  advancedDeviceClearButton.classList.add('confirming');
  advancedDeviceClearButton.textContent = 'Tap again to confirm';
  if (confirmTimeout) clearTimeout(confirmTimeout);
  confirmTimeout = setTimeout(() => {
    resetClearConfirmation();
  }, 5000);
};

const resetClearUnknownConfirmation = () => {
  if (!advancedDeviceClearUnknownButton) return;
  advancedDeviceClearUnknownButton.classList.remove('confirming');
  advancedDeviceClearUnknownButton.textContent = getUnknownButtonLabel(resolveUnknownDeviceIdsFromSettings().length);
  if (unknownConfirmTimeout) {
    clearTimeout(unknownConfirmTimeout);
    unknownConfirmTimeout = null;
  }
};

const requestClearUnknownConfirmation = (count: number) => {
  if (!advancedDeviceClearUnknownButton) return;
  advancedDeviceClearUnknownButton.classList.add('confirming');
  advancedDeviceClearUnknownButton.textContent = count > 0
    ? `Tap again to clear ${count}`
    : 'Tap again to confirm';
  if (unknownConfirmTimeout) clearTimeout(unknownConfirmTimeout);
  unknownConfirmTimeout = setTimeout(() => {
    resetClearUnknownConfirmation();
  }, 5000);
};

const updateUnknownDevicesButton = (unknownIds: string[]) => {
  if (!advancedDeviceClearUnknownButton) return;
  const count = unknownIds.length;
  advancedDeviceClearUnknownButton.disabled = count === 0;
  if (count === 0) {
    resetClearUnknownConfirmation();
    return;
  }
  if (!advancedDeviceClearUnknownButton.classList.contains('confirming')) {
    advancedDeviceClearUnknownButton.textContent = getUnknownButtonLabel(count);
  }
};

const clearAllConfirmTimeouts = () => {
  if (confirmTimeout) {
    clearTimeout(confirmTimeout);
    confirmTimeout = null;
  }
  if (unknownConfirmTimeout) {
    clearTimeout(unknownConfirmTimeout);
    unknownConfirmTimeout = null;
  }
};

const registerConfirmCleanup = () => {
  if (confirmCleanupRegistered) return;
  confirmCleanupRegistered = true;
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('beforeunload', clearAllConfirmTimeouts);
  }
};

export const initAdvancedDeviceCleanupHandlers = () => {
  if (!advancedDeviceClearButton || !advancedDeviceSelect) return;
  if (!devicesUpdatedListenerRegistered) {
    document.addEventListener('devices-updated', () => {
      renderAdvancedDeviceOptions();
    });
    devicesUpdatedListenerRegistered = true;
  }
  registerConfirmCleanup();

  advancedDeviceClearButton.addEventListener('click', async () => {
    const deviceId = advancedDeviceSelect.value;
    if (!deviceId) {
      await showToast('Select a device first.', 'warn');
      return;
    }
    if (!advancedDeviceClearButton.classList.contains('confirming')) {
      requestClearConfirmation();
      return;
    }
    resetClearConfirmation();
    const device = state.latestDevices.find((entry) => entry.id === deviceId);
    const deviceLabel = device ? formatDisplayDeviceName(device.name) : `device ${deviceId}`;

    try {
      setClearButtonBusy(true);
      await clearDeviceSettings(deviceId);
      refreshUiAfterDeviceCleanup();
      await showToast(`Cleared PELS data for ${deviceLabel}.`, 'ok');
    } catch (error) {
      await logSettingsError('Failed to clear device data', error, 'advancedDeviceCleanup');
      await showToastError(error, 'Failed to clear device data.');
    } finally {
      setClearButtonBusy(false);
    }
  });

  advancedDeviceClearUnknownButton?.addEventListener('click', async () => {
    const unknownIds = resolveUnknownDeviceIdsFromSettings();
    if (unknownIds.length === 0) {
      await showToast('No unknown devices to clear.', 'warn');
      return;
    }
    if (!advancedDeviceClearUnknownButton.classList.contains('confirming')) {
      requestClearUnknownConfirmation(unknownIds.length);
      return;
    }
    resetClearUnknownConfirmation();

    try {
      setClearUnknownButtonBusy(true);
      await clearMultipleDeviceSettings(unknownIds);
      refreshUiAfterDeviceCleanup();
      const suffix = unknownIds.length === 1 ? '' : 's';
      await showToast(`Cleared ${unknownIds.length} unknown device${suffix}.`, 'ok');
    } catch (error) {
      await logSettingsError('Failed to clear unknown devices', error, 'advancedDeviceCleanup');
      await showToastError(error, 'Failed to clear unknown devices.');
    } finally {
      setClearUnknownButtonBusy(false);
    }
  });
};

export const refreshAdvancedDeviceCleanup = () => {
  renderAdvancedDeviceOptions();
};

export const initAdvancedDeviceLoggerHandlers = () => {
  if (!advancedApiDeviceSelect || !advancedApiDeviceLogButton) return;

  registerConfirmCleanup();
  advancedApiDeviceRefreshButton?.addEventListener('click', async () => {
    await refreshApiDevices();
  });

  advancedApiDeviceLogButton.addEventListener('click', async () => {
    const deviceId = advancedApiDeviceSelect.value;
    if (!deviceId) {
      await showToast('Select a device first.', 'warn');
      return;
    }
    const device = apiDevicesCache.find((entry) => entry.id === deviceId);
    if (!device) {
      await showToast('Device not found. Refresh the list and try again.', 'warn');
      return;
    }
    const deviceName = formatDisplayDeviceName(device.name);

    try {
      setApiDeviceButtonsBusy(true);
      const result = await callApi<{ ok: boolean; error?: string } | null>(
        'POST',
        '/log_homey_device',
        { id: deviceId },
      );
      if (!result?.ok) {
        throw new Error(result?.error || 'UNABLE_TO_LOG_DEVICE');
      }
      await showToast(`Device payload written to logs for ${deviceName}.`, 'ok');
    } catch (error) {
      await logSettingsError('Failed to log Homey device', error, 'advancedDeviceLog');
      await showToastError(error, 'Failed to log Homey device.');
    } finally {
      setApiDeviceButtonsBusy(false);
    }
  });
};

export const refreshAdvancedDeviceLogger = async () => {
  if (!advancedApiDeviceSelect) return;
  if (apiDevicesCache.length > 0) {
    renderApiDeviceOptions(apiDevicesCache);
    return;
  }
  await refreshApiDevices(false);
};
