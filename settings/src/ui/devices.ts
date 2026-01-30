import type { TargetDeviceSnapshot } from '../../../lib/utils/types';
import { deviceList, emptyState, refreshButton } from './dom';
import { getSetting, pollSetting, setSetting } from './homey';
import { showToast, showToastError } from './toast';
import { resolveManagedState, state } from './state';
import { renderPriorities } from './modes';
import { refreshPlan } from './plan';
import { renderPriceOptimization, savePriceOptimizationSettings } from './priceOptimization';
import { createDeviceRow, createCheckboxLabel } from './components';
import { logSettingsError, logSettingsWarn } from './logging';
import { debouncedSetSetting } from './utils';
import { supportsPowerDevice } from './deviceUtils';

const getTargetDevices = async (): Promise<TargetDeviceSnapshot[]> => {
  const snapshot = await getSetting('target_devices_snapshot');
  if (!Array.isArray(snapshot)) {
    return [];
  }
  return snapshot as TargetDeviceSnapshot[];
};

const DEVICE_CLASS_LABELS: Record<string, string> = {
  airconditioning: 'Air Conditioning',
  airfryer: 'Air Fryer',
  airpurifier: 'Air Purifier',
  airtreatment: 'Air Treatment',
  amplifier: 'Amplifier',
  battery: 'Battery',
  bicycle: 'Bicycle',
  blinds: 'Blinds',
  boiler: 'Boiler',
  bridge: 'Bridge',
  button: 'Button',
  camera: 'Camera',
  car: 'Car',
  coffeemachine: 'Coffee Machine',
  cooktop: 'Cooktop',
  curtain: 'Curtain',
  dehumidifier: 'Dehumidifier',
  diffuser: 'Diffuser',
  dishwasher: 'Dishwasher',
  doorbell: 'Doorbell',
  dryer: 'Dryer',
  evcharger: 'EV Charger',
  fan: 'Fan',
  faucet: 'Faucet',
  fireplace: 'Fireplace',
  freezer: 'Freezer',
  fridge: 'Fridge',
  fridge_and_freezer: 'Fridge and Freezer',
  fryer: 'Fryer',
  gameconsole: 'Game Console',
  garagedoor: 'Garage Door',
  grill: 'Grill',
  heater: 'Heater',
  heatpump: 'Heat Pump',
  homealarm: 'Home Alarm',
  hood: 'Hood',
  humidifier: 'Humidifier',
  kettle: 'Kettle',
  lawnmower: 'Lawn Mower',
  light: 'Light',
  lock: 'Lock',
  mediaplayer: 'Media Player',
  microwave: 'Microwave',
  mop: 'Mop',
  multicooker: 'Multicooker',
  networkrouter: 'Network Router',
  other: 'Other',
  oven: 'Oven',
  oven_and_microwave: 'Oven and Microwave',
  petfeeder: 'Pet Feeder',
  radiator: 'Radiator',
  relay: 'Relay',
  remote: 'Remote',
  scooter: 'Scooter',
  sensor: 'Sensor',
  service: 'Service',
  settopbox: 'Set-top Box',
  shutterblinds: 'Shutter Blinds',
  siren: 'Siren',
  smokealarm: 'Smoke Alarm',
  socket: 'Socket',
  solarpanel: 'Solar Panel',
  speaker: 'Speaker',
  sprinkler: 'Sprinkler',
  sunshade: 'Sunshade',
  thermostat: 'Thermostat',
  tv: 'TV',
  vacuumcleaner: 'Vacuum Cleaner',
  vehicle: 'Vehicle',
  washer: 'Washer',
  washer_and_dryer: 'Washer and Dryer',
  waterheater: 'Water Heater',
  waterpurifier: 'Water Purifier',
  watervalve: 'Water Valve',
  windowcoverings: 'Window Coverings',
};

const CLASS_TITLE_LOWERCASE = new Set(['and', 'of', 'the']);

const toTitleCase = (value: string): string => (
  value.split('_').map((word, index) => {
    if (!word) return word;
    if (index > 0 && CLASS_TITLE_LOWERCASE.has(word)) return word;
    return word[0].toUpperCase() + word.slice(1);
  }).join(' ')
);

const resolveDeviceClassLabel = (deviceClass?: string): string => {
  const key = (deviceClass || 'other').trim().toLowerCase();
  if (!key) return DEVICE_CLASS_LABELS.other;
  return DEVICE_CLASS_LABELS[key] || toTitleCase(key);
};

const supportsTemperatureDevice = (device: TargetDeviceSnapshot): boolean => (
  device.deviceType === 'temperature' || (device.targets?.length ?? 0) > 0
);

const getManagedTitle = (isLoadingComplete: boolean, supportsPower: boolean): string => {
  if (!isLoadingComplete) return 'Loading...';
  if (!supportsPower) return 'Managed by PELS (requires power measurement or configured load)';
  return 'Managed by PELS';
};

const getCapacityTitle = (params: {
  isLoadingComplete: boolean;
  supportsPower: boolean;
  isManaged: boolean;
}): string => {
  const { isLoadingComplete, supportsPower, isManaged } = params;
  if (!isLoadingComplete) return 'Loading...';
  if (!supportsPower) return 'Capacity-based control (requires power measurement or configured load)';
  if (isManaged) return 'Capacity-based control';
  return 'Capacity-based control (requires Managed by PELS)';
};

const getPriceTitle = (params: {
  isLoadingComplete: boolean;
  supportsTemperature: boolean;
  supportsPower: boolean;
  isManaged: boolean;
}): string => {
  const {
    isLoadingComplete,
    supportsTemperature,
    supportsPower,
    isManaged,
  } = params;
  if (!isLoadingComplete) return 'Loading...';
  if (!supportsTemperature) return 'Price-based control (temperature devices only)';
  if (!supportsPower) return 'Price-based control (requires power measurement or configured load)';
  if (isManaged) return 'Price-based control';
  return 'Price-based control (requires Managed by PELS)';
};

const setBusy = (busy: boolean) => {
  state.isBusy = busy;
  refreshButton.disabled = busy;
};

const withInitialLoadGuard = (
  actionLabel: string,
  handler: (checked: boolean) => Promise<void>,
) => async (checked: boolean) => {
  if (!state.initialLoadComplete) {
    await logSettingsWarn(`Blocked ${actionLabel} toggle during initial load`, undefined, 'device list');
    return;
  }
  await handler(checked);
};

const buildManagedToggleHandler = (deviceId: string) => withInitialLoadGuard('managed', async (checked) => {
  // Optimistic UI: update state immediately
  state.managedMap[deviceId] = checked;
  renderDevices(state.latestDevices);
  renderPriorities(state.latestDevices);
  renderPriceOptimization(state.latestDevices);
  // Debounced save: coalesces rapid toggles into single save
  try {
    await debouncedSetSetting('managed_devices', () => ({ ...state.managedMap }));
  } catch (error) {
    await logSettingsError('Failed to update managed device', error, 'device list');
    await showToastError(error, 'Failed to update managed devices.');
  }
});

const buildControllableToggleHandler = (deviceId: string) => withInitialLoadGuard('controllable', async (checked) => {
  // Optimistic UI: update state immediately
  state.controllableMap[deviceId] = checked;
  // Debounced save: coalesces rapid toggles into single save
  try {
    await debouncedSetSetting('controllable_devices', () => ({ ...state.controllableMap }));
  } catch (error) {
    await logSettingsError('Failed to update controllable device', error, 'device list');
    await showToastError(error, 'Failed to update controllable devices.');
  }
});

const buildPriceToggleHandler = (deviceId: string) => withInitialLoadGuard('price opt', async (checked) => {
  if (!state.priceOptimizationSettings[deviceId]) {
    state.priceOptimizationSettings[deviceId] = { enabled: false, cheapDelta: 5, expensiveDelta: -5 };
  }
  state.priceOptimizationSettings[deviceId].enabled = checked;
  try {
    await savePriceOptimizationSettings();
    renderPriceOptimization(state.latestDevices);
  } catch (error) {
    await logSettingsError('Failed to update price optimization settings', error, 'device list');
    await showToastError(error, 'Failed to update price optimization settings.');
  }
});

const buildDeviceRowItem = (device: TargetDeviceSnapshot): HTMLElement => {
  const supportsTemperature = supportsTemperatureDevice(device);
  const supportsPower = supportsPowerDevice(device);
  const isManaged = supportsPower && resolveManagedState(device.id);
  const isLoadingComplete = state.initialLoadComplete;

  const managedCheckbox = createCheckboxLabel({
    title: getManagedTitle(isLoadingComplete, supportsPower),
    checked: supportsPower && isManaged,
    disabled: !isLoadingComplete || !supportsPower,
    onChange: buildManagedToggleHandler(device.id),
  });

  const ctrlCheckbox = createCheckboxLabel({
    title: getCapacityTitle({ isLoadingComplete, supportsPower, isManaged }),
    checked: supportsPower && state.controllableMap[device.id] === true,
    disabled: !isLoadingComplete || !supportsPower || !isManaged,
    onChange: buildControllableToggleHandler(device.id),
  });

  const priceOptCheckbox = createCheckboxLabel({
    title: getPriceTitle({
      isLoadingComplete,
      supportsTemperature,
      supportsPower,
      isManaged,
    }),
    checked: supportsTemperature && supportsPower && state.priceOptimizationSettings[device.id]?.enabled === true,
    disabled: !isLoadingComplete || !supportsTemperature || !supportsPower || !isManaged,
    onChange: buildPriceToggleHandler(device.id),
  });

  return createDeviceRow({
    id: device.id,
    name: device.name,
    className: 'control-row',
    controls: [managedCheckbox, ctrlCheckbox, priceOptCheckbox],
    onClick: () => {
      const openEvent = new CustomEvent('open-device-detail', { detail: { deviceId: device.id } });
      document.dispatchEvent(openEvent);
    },
  });
};

export const renderDevices = (devices: TargetDeviceSnapshot[]) => {
  deviceList.replaceChildren();
  if (!devices.length) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  // Show loading notice if initial load is still in progress
  if (!state.initialLoadComplete) {
    const loadingNotice = document.createElement('div');
    loadingNotice.className = 'device-loading-notice';
    loadingNotice.textContent = 'Loading device settings...';
    deviceList.appendChild(loadingNotice);
  }

  const groups = new Map<string, TargetDeviceSnapshot[]>();
  devices.forEach((device) => {
    const key = (device.deviceClass || 'other').trim().toLowerCase() || 'other';
    const bucket = groups.get(key) || [];
    bucket.push(device);
    groups.set(key, bucket);
  });

  const sortedGroups = Array.from(groups.entries())
    .map(([key, items]) => ({
      key,
      label: resolveDeviceClassLabel(key),
      devices: items.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const fragment = document.createDocumentFragment();
  sortedGroups.forEach((group) => {
    const header = document.createElement('div');
    header.className = 'device-group-header';
    header.textContent = group.label;
    fragment.appendChild(header);
    group.devices.forEach((device) => {
      fragment.appendChild(buildDeviceRowItem(device));
    });
  });

  deviceList.appendChild(fragment);
};

export const refreshDevices = async (options?: { render?: boolean }) => {
  if (state.isBusy) return;
  setBusy(true);
  const shouldRender = options?.render ?? true;
  try {
    await setSetting('refresh_target_devices_snapshot', Date.now());
    await pollSetting('target_devices_snapshot', 10, 300);

    const devices = await getTargetDevices();
    state.latestDevices = devices;
    if (shouldRender) {
      renderDevices(devices);
      renderPriorities(devices);
      renderPriceOptimization(devices);
    }
    const devicesUpdated = new CustomEvent('devices-updated', { detail: { devices } });
    document.dispatchEvent(devicesUpdated);
    await refreshPlan();
  } catch (error) {
    await logSettingsError('Failed to refresh devices', error, 'refreshDevices');
    const message = error instanceof Error && error.message
      ? error.message
      : 'Unable to load devices. Check Homey logs for details.';
    await showToast(message, 'warn');
  } finally {
    setBusy(false);
  }
};
