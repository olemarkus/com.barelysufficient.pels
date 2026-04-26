import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import { deviceList, emptyState, refreshButton } from './dom.ts';
import {
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_REFRESH_DEVICES_PATH,
  type SettingsUiDevicesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import { callApi, getApiReadModel, invalidateApiCache, primeApiCache } from './homey.ts';
import { showToast, showToastError } from './toast.ts';
import { resolveManagedState, state } from './state.ts';
import { renderPriorities } from './modes.ts';
import { refreshPlan } from './plan.ts';
import { renderPriceOptimization, savePriceOptimizationSettings } from './priceOptimization.ts';
import { createDeviceRow, createCheckboxLabel } from './components.ts';
import { logSettingsError, logSettingsWarn } from './logging.ts';
import { debouncedSetSetting } from './utils.ts';
import { setTooltip } from './tooltips.ts';
import {
  supportsManagedDevice,
  supportsPowerDevice,
  supportsTemperatureDevice,
  isGrayStateDevice,
  requiresNativeWiringForActivation,
} from './deviceUtils.ts';

export const getTargetDevices = async (): Promise<TargetDeviceSnapshot[]> => {
  const payload = await getApiReadModel<SettingsUiDevicesPayload>(SETTINGS_UI_DEVICES_PATH);
  return Array.isArray(payload?.devices) ? payload.devices : [];
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

const getManagedTitle = (
  isLoadingComplete: boolean,
  supportsManage: boolean,
  nativeWiringRequired: boolean,
): string => {
  if (!isLoadingComplete) return 'Loading...';
  if (nativeWiringRequired) {
    return 'Managed by PELS (open the device page and enable built-in device control first)';
  }
  if (!supportsManage) return 'Managed by PELS (requires a temperature target or power capability)';
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
  isManaged: boolean;
}): string => {
  const {
    isLoadingComplete,
    supportsTemperature,
    isManaged,
  } = params;
  if (!isLoadingComplete) return 'Loading...';
  if (!supportsTemperature) return 'Price-based control (temperature devices only)';
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

const buildStateChip = (label: string, title: string): HTMLElement => {
  const chip = document.createElement('span');
  chip.className = 'chip chip--neutral device-row__state-chip';
  chip.textContent = label;
  setTooltip(chip, title);
  return chip;
};

const buildDeviceAvailabilityChip = (device: TargetDeviceSnapshot): HTMLElement | null => {
  if (!isGrayStateDevice(device)) return null;
  return buildStateChip(
    device.available === false ? 'Unavailable' : 'Unknown',
    device.available === false
      ? 'Device is currently unavailable in Homey.'
      : 'Device state is unknown.',
  );
};

const buildBudgetExemptChip = (device: TargetDeviceSnapshot): HTMLElement | null => {
  if (state.budgetExemptMap[device.id] !== true && device.budgetExempt !== true) return null;
  return buildStateChip('Budget exempt', 'This device is excluded from daily budget limits.');
};

const buildFlowBackedChip = (device: TargetDeviceSnapshot): HTMLElement | null => {
  if (device.flowBacked !== true) return null;
  return buildStateChip(
    'Flow-backed',
    'PELS is using flow-reported state to support this existing Homey device.',
  );
};

const appendDeviceStateChips = (container: HTMLElement, device: TargetDeviceSnapshot) => {
  const chips = [
    buildDeviceAvailabilityChip(device),
    buildFlowBackedChip(device),
    buildBudgetExemptChip(device),
  ];
  chips.forEach((chip) => {
    if (chip) container.appendChild(chip);
  });
};

const resolveDeviceManageability = (device: TargetDeviceSnapshot) => {
  const supportsTemperature = supportsTemperatureDevice(device);
  const supportsPower = supportsPowerDevice(device);
  const supportsManage = supportsManagedDevice(supportsPower, supportsTemperature);
  const nativeWiringRequired = requiresNativeWiringForActivation(device);
  const canManage = supportsManage && !nativeWiringRequired;
  return {
    supportsTemperature,
    supportsPower,
    supportsManage,
    nativeWiringRequired,
    canManage,
    isManaged: canManage && resolveManagedState(device.id),
  };
};

const buildDeviceRowItem = (device: TargetDeviceSnapshot): HTMLElement => {
  const manageability = resolveDeviceManageability(device);
  const isLoadingComplete = state.initialLoadComplete;

  const managedCheckbox = createCheckboxLabel({
    title: getManagedTitle(
      isLoadingComplete,
      manageability.supportsManage,
      manageability.nativeWiringRequired,
    ),
    checked: manageability.isManaged,
    disabled: !isLoadingComplete || !manageability.canManage,
    onChange: buildManagedToggleHandler(device.id),
  });

  const ctrlCheckbox = createCheckboxLabel({
    title: getCapacityTitle({
      isLoadingComplete,
      supportsPower: manageability.supportsPower,
      isManaged: manageability.isManaged,
    }),
    checked: manageability.supportsPower && state.controllableMap[device.id] === true,
    disabled: !isLoadingComplete || !manageability.supportsPower || !manageability.isManaged,
    onChange: buildControllableToggleHandler(device.id),
  });

  const priceOptCheckbox = createCheckboxLabel({
    title: getPriceTitle({
      isLoadingComplete,
      supportsTemperature: manageability.supportsTemperature,
      isManaged: manageability.isManaged,
    }),
    checked: manageability.supportsTemperature
      && manageability.isManaged
      && state.priceOptimizationSettings[device.id]?.enabled === true,
    disabled: !isLoadingComplete || !manageability.supportsTemperature || !manageability.isManaged,
    onChange: buildPriceToggleHandler(device.id),
  });

  const row = createDeviceRow({
    id: device.id,
    name: device.name,
    className: 'control-row',
    controls: [managedCheckbox, ctrlCheckbox, priceOptCheckbox],
    onClick: () => {
      const openEvent = new CustomEvent('open-device-detail', { detail: { deviceId: device.id } });
      document.dispatchEvent(openEvent);
    },
  });

  const nameWrap = row.querySelector<HTMLElement>('.device-row__name');
  if (!nameWrap) return row;
  const nameText = document.createElement('span');
  nameText.className = 'device-row__title';
  nameText.textContent = device.name;

  nameWrap.replaceChildren(nameText);
  appendDeviceStateChips(nameWrap, device);
  return row;
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
    const loadingNotice = document.createElement('li');
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
    const header = document.createElement('li');
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
    const response = await callApi<SettingsUiDevicesPayload>('POST', SETTINGS_UI_REFRESH_DEVICES_PATH, {});
    const hasDevices = Array.isArray(response?.devices);
    if (hasDevices) {
      primeApiCache(SETTINGS_UI_DEVICES_PATH, { devices: response.devices });
    } else {
      invalidateApiCache(SETTINGS_UI_DEVICES_PATH);
    }

    const devices = hasDevices ? response.devices : await getTargetDevices();
    state.latestDevices = devices;
    state.devicesLoaded = true;
    if (shouldRender) {
      renderDevices(devices);
      renderPriorities(devices);
      renderPriceOptimization(devices);
    }
    const devicesUpdated = new CustomEvent('devices-updated', { detail: { devices } });
    document.dispatchEvent(devicesUpdated);
    invalidateApiCache(SETTINGS_UI_PLAN_PATH);
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
