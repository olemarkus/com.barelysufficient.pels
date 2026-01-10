import type { TargetDeviceSnapshot } from '../../../lib/utils/types';
import { deviceList, emptyState, refreshButton } from './dom';
import { getSetting, pollSetting, setSetting } from './homey';
import { showToast, showToastError } from './toast';
import { resolveManagedState, state } from './state';
import { renderPriorities } from './modes';
import { refreshPlan } from './plan';
import { renderPriceOptimization, savePriceOptimizationSettings } from './prices';
import { createDeviceRow, createCheckboxLabel } from './components';
import { logSettingsError } from './logging';

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

const setBusy = (busy: boolean) => {
  state.isBusy = busy;
  refreshButton.disabled = busy;
};

const buildDeviceRowItem = (device: TargetDeviceSnapshot): HTMLElement => {
  const supportsTemperature = supportsTemperatureDevice(device);
  const managedCheckbox = createCheckboxLabel({
    title: 'Managed by PELS',
    checked: resolveManagedState(device.id),
    onChange: async (checked) => {
      state.managedMap[device.id] = checked;
      try {
        await setSetting('managed_devices', state.managedMap);
        renderDevices(state.latestDevices);
        renderPriorities(state.latestDevices);
        renderPriceOptimization(state.latestDevices);
      } catch (error) {
        await logSettingsError('Failed to update managed device', error, 'device list');
        await showToastError(error, 'Failed to update managed devices.');
      }
    },
  });

  const ctrlCheckbox = createCheckboxLabel({
    title: 'Capacity-based control',
    checked: state.controllableMap[device.id] === true,
    onChange: async (checked) => {
      state.controllableMap[device.id] = checked;
      try {
        await setSetting('controllable_devices', state.controllableMap);
      } catch (error) {
        await logSettingsError('Failed to update controllable device', error, 'device list');
        await showToastError(error, 'Failed to update controllable devices.');
      }
    },
  });

  const priceOptCheckbox = createCheckboxLabel({
    title: supportsTemperature ? 'Price-based control' : 'Price-based control (temperature devices only)',
    checked: supportsTemperature && state.priceOptimizationSettings[device.id]?.enabled === true,
    disabled: !supportsTemperature,
    onChange: async (checked) => {
      if (!state.priceOptimizationSettings[device.id]) {
        state.priceOptimizationSettings[device.id] = { enabled: false, cheapDelta: 5, expensiveDelta: -5 };
      }
      state.priceOptimizationSettings[device.id].enabled = checked;
      try {
        await savePriceOptimizationSettings();
        renderPriceOptimization(state.latestDevices);
      } catch (error) {
        await logSettingsError('Failed to update price optimization settings', error, 'device list');
        await showToastError(error, 'Failed to update price optimization settings.');
      }
    },
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

export const refreshDevices = async () => {
  if (state.isBusy) return;
  setBusy(true);
  try {
    await setSetting('refresh_target_devices_snapshot', Date.now());
    await pollSetting('target_devices_snapshot', 10, 300);

    const devices = await getTargetDevices();
    state.latestDevices = devices;
    renderDevices(devices);
    renderPriorities(devices);
    renderPriceOptimization(devices);
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
