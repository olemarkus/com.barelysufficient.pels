import {
  advancedDeviceClearButton,
  advancedDeviceClearUnknownButton,
  advancedDeviceSelect,
  advancedApiDeviceSelect,
  advancedApiDeviceRefreshButton,
  advancedApiDeviceLogButton,
} from './dom';
import { callApi, setSetting } from './homey';
import { renderDevices } from './devices';
import { renderPriorities } from './modes';
import { renderPriceOptimization } from './priceOptimization';
import { showToast, showToastError } from './toast';
import { logSettingsError } from './logging';
import { state } from './state';

type HomeyApiDevice = {
  id: string;
  name?: string;
  class?: string;
};

type DeviceOption = {
  id: string;
  name: string;
};

const collectDeviceIdsFromSettings = (): Set<string> => {
  const simpleSettingIds = [
    ...Object.keys(state.controllableMap),
    ...Object.keys(state.managedMap),
    ...Object.keys(state.shedBehaviors),
    ...Object.keys(state.priceOptimizationSettings),
  ];

  const modeMapIds = (modeMap: Record<string, Record<string, number>>) => (
    Object.values(modeMap || {}).flatMap((devices) => Object.keys(devices || {}))
  );

  return new Set([
    ...simpleSettingIds,
    ...modeMapIds(state.capacityPriorities),
    ...modeMapIds(state.modeTargets),
  ]);
};

const resolveDeviceOptionsFromSettings = (): DeviceOption[] => {
  const nameById = new Map<string, string>();
  state.latestDevices.forEach((device) => {
    nameById.set(device.id, device.name || device.id);
  });
  return Array.from(collectDeviceIdsFromSettings()).map((id) => ({
    id,
    name: nameById.get(id) || id,
  }));
};

const resolveUnknownDeviceIdsFromSettings = (): string[] => {
  const knownIds = new Set(state.latestDevices.map((device) => device.id));
  return Array.from(collectDeviceIdsFromSettings()).filter((id) => !knownIds.has(id));
};

const renderAdvancedDeviceOptions = () => {
  if (!advancedDeviceSelect) return;
  const devices = resolveDeviceOptionsFromSettings();
  const unknownIds = resolveUnknownDeviceIdsFromSettings();
  advancedDeviceSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = devices.length ? 'Select a device' : 'No devices in settings';
  advancedDeviceSelect.appendChild(placeholder);
  advancedDeviceSelect.disabled = devices.length === 0;
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
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = device.name;
      advancedDeviceSelect.appendChild(option);
    });
};

const removeDeviceFromModeMap = (
  map: Record<string, Record<string, number>>,
  deviceId: string,
): Record<string, Record<string, number>> => {
  const updated: Record<string, Record<string, number>> = {};
  Object.entries(map).forEach(([mode, devices]) => {
    if (!devices || devices[deviceId] === undefined) {
      updated[mode] = devices;
      return;
    }
    const { [deviceId]: _removed, ...rest } = devices;
    updated[mode] = rest;
  });
  return updated;
};

const removeDeviceIdsFromModeMap = (
  map: Record<string, Record<string, number>>,
  deviceIds: Set<string>,
): Record<string, Record<string, number>> => {
  const updated: Record<string, Record<string, number>> = {};
  Object.entries(map).forEach(([mode, devices]) => {
    if (!devices) {
      updated[mode] = devices;
      return;
    }
    const filtered = Object.fromEntries(
      Object.entries(devices).filter(([deviceId]) => !deviceIds.has(deviceId)),
    );
    updated[mode] = filtered;
  });
  return updated;
};

const clearDeviceSettings = async (deviceId: string) => {
  const nextControllableMap = { ...state.controllableMap };
  const nextManagedMap = { ...state.managedMap };
  const nextShedBehaviors = { ...state.shedBehaviors };
  const nextPriceOptimization = { ...state.priceOptimizationSettings };
  delete nextControllableMap[deviceId];
  delete nextManagedMap[deviceId];
  delete nextShedBehaviors[deviceId];
  delete nextPriceOptimization[deviceId];
  const nextCapacityPriorities = removeDeviceFromModeMap(state.capacityPriorities, deviceId);
  const nextModeTargets = removeDeviceFromModeMap(state.modeTargets, deviceId);

  await Promise.all([
    setSetting('controllable_devices', nextControllableMap),
    setSetting('managed_devices', nextManagedMap),
    setSetting('overshoot_behaviors', nextShedBehaviors),
    setSetting('price_optimization_settings', nextPriceOptimization),
    setSetting('capacity_priorities', nextCapacityPriorities),
    setSetting('mode_device_targets', nextModeTargets),
  ]);

  state.controllableMap = nextControllableMap;
  state.managedMap = nextManagedMap;
  state.shedBehaviors = nextShedBehaviors;
  state.priceOptimizationSettings = nextPriceOptimization;
  state.capacityPriorities = nextCapacityPriorities;
  state.modeTargets = nextModeTargets;
};

const clearMultipleDeviceSettings = async (deviceIds: string[]) => {
  const ids = new Set(deviceIds);
  const nextControllableMap = { ...state.controllableMap };
  const nextManagedMap = { ...state.managedMap };
  const nextShedBehaviors = { ...state.shedBehaviors };
  const nextPriceOptimization = { ...state.priceOptimizationSettings };
  deviceIds.forEach((deviceId) => {
    delete nextControllableMap[deviceId];
    delete nextManagedMap[deviceId];
    delete nextShedBehaviors[deviceId];
    delete nextPriceOptimization[deviceId];
  });
  const nextCapacityPriorities = removeDeviceIdsFromModeMap(state.capacityPriorities, ids);
  const nextModeTargets = removeDeviceIdsFromModeMap(state.modeTargets, ids);

  await Promise.all([
    setSetting('controllable_devices', nextControllableMap),
    setSetting('managed_devices', nextManagedMap),
    setSetting('overshoot_behaviors', nextShedBehaviors),
    setSetting('price_optimization_settings', nextPriceOptimization),
    setSetting('capacity_priorities', nextCapacityPriorities),
    setSetting('mode_device_targets', nextModeTargets),
  ]);

  state.controllableMap = nextControllableMap;
  state.managedMap = nextManagedMap;
  state.shedBehaviors = nextShedBehaviors;
  state.priceOptimizationSettings = nextPriceOptimization;
  state.capacityPriorities = nextCapacityPriorities;
  state.modeTargets = nextModeTargets;
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
  const parts = [name || id || 'Unknown device'];
  if (className) parts.push(className);
  return parts.join(' · ');
};

const renderApiDeviceOptions = (devices: HomeyApiDevice[]) => {
  if (!advancedApiDeviceSelect) return;
  advancedApiDeviceSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = devices.length ? 'Select a device' : 'No devices available';
  advancedApiDeviceSelect.appendChild(placeholder);
  advancedApiDeviceSelect.disabled = devices.length === 0;
  if (advancedApiDeviceLogButton) {
    advancedApiDeviceLogButton.disabled = devices.length === 0;
  }

  devices
    .slice()
    .sort((a, b) => resolveApiDeviceLabel(a).localeCompare(resolveApiDeviceLabel(b)))
    .forEach((device) => {
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = resolveApiDeviceLabel(device);
      advancedApiDeviceSelect.appendChild(option);
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
  return devices.filter((device) => device && typeof device.id === 'string');
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
  advancedDeviceClearButton.textContent = 'Click again to confirm';
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
    ? `Click again to clear ${count}`
    : 'Click again to confirm';
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
    const deviceName = device?.name || deviceId;

    try {
      setClearButtonBusy(true);
      await clearDeviceSettings(deviceId);
      refreshUiAfterDeviceCleanup();
      await showToast(`Cleared PELS data for ${deviceName}.`, 'ok');
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
    const deviceName = device.name || device.id;

    try {
      setApiDeviceButtonsBusy(true);
      const result = await callApi<{ ok: boolean; error?: string } | null>('POST', '/log_homey_device', { id: deviceId });
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
