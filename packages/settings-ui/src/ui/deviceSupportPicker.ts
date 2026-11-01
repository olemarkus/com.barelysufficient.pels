import type { HomeyDeviceListEntry } from '../../../contracts/src/settingsUi/homeyDevices.ts';
import type { SettingsUiDeviceListItem } from './deviceUtils.ts';
import { getTargetDevices } from './devices.ts';
import { loadHomeyDeviceList } from './homeyDeviceList.ts';
import { logSettingsError } from './logging.ts';
import { state } from './state.ts';
import { openDeviceSupportRequest } from './supportReport.ts';
import {
  renderDeviceSupportPicker,
  type DevicePickerFilter,
  type DevicePickerRead,
  type DevicePickerRow,
} from './views/DeviceSupportPicker.tsx';

type PickerNavigation = {
  openPanel(panel: string): void;
  openDevice(deviceId: string, focus: 'top'): void;
};

let navigation: PickerNavigation | null = null;
let read: DevicePickerRead = { state: 'loading' };
let query = '';
let filter: DevicePickerFilter = 'all';
let refreshSequence = 0;

/**
 * Every Homey device, with where it stands in PELS. A device on Devices is
 * supported; every other Homey device is one PELS does not support.
 */
export const toDevicePickerRows = (
  homeyDevices: readonly HomeyDeviceListEntry[],
  pelsDevices: readonly SettingsUiDeviceListItem[],
): DevicePickerRow[] => {
  const listed = new Map(pelsDevices.map((device) => [device.id, device] as const));
  return homeyDevices.map((device) => {
    const pelsDevice = listed.get(device.id);
    let status: DevicePickerRow['status'] = 'unsupported';
    if (pelsDevice) status = pelsDevice.managed ? 'managed' : 'listed';
    return {
      id: device.id,
      name: device.name,
      zoneName: device.zoneName,
      status,
    };
  });
};

const select = (row: DevicePickerRow): void => {
  if (!navigation) return;
  if (row.status === 'unsupported') {
    openDeviceSupportRequest(row.id, navigation.openPanel);
    return;
  }
  navigation.openPanel('devices');
  navigation.openDevice(row.id, 'top');
};

const paint = (): void => {
  const surface = document.getElementById('device-support-root');
  if (!surface) return;
  renderDeviceSupportPicker(surface, {
    read, query, filter,
    onQuery: (next) => { query = next; paint(); },
    onFilter: (next) => { filter = next; paint(); },
    onSelect: select,
    onRetry: () => { void refreshDeviceSupportPicker(); },
    onShowAll: () => { query = ''; filter = 'all'; paint(); },
  });
};

/**
 * Reads Homey's full device list beside PELS's own. Both are needed to say
 * which devices PELS supports, so either read failing leaves the list
 * unavailable rather than calling every device unsupported.
 */
export const refreshDeviceSupportPicker = async (): Promise<void> => {
  const request = ++refreshSequence;
  if (read.state !== 'ready') read = { state: 'loading' };
  paint();
  try {
    const [homeyDevices, pelsDevices] = await Promise.all([
      loadHomeyDeviceList(),
      state.devicesLoaded ? Promise.resolve(state.latestDevices) : getTargetDevices(),
    ]);
    if (request !== refreshSequence) return;
    // `/homey_devices` answers an empty list when Homey cannot be read; a Homey running PELS has devices.
    read = homeyDevices.length === 0
      ? { state: 'unavailable' } : { state: 'ready', rows: toDevicePickerRows(homeyDevices, pelsDevices) };
  } catch (error) {
    if (request !== refreshSequence) return;
    read = { state: 'unavailable' };
    await logSettingsError('Failed to load Homey devices', error, 'deviceSupportPicker');
  }
  paint();
};

/** Boot supplies navigation so page rendering never imports its own router. */
export const initDeviceSupportPicker = (next: PickerNavigation): void => {
  navigation = next;
};
