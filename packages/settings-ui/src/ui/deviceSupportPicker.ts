import type { HomeyDeviceListEntry } from '../../../contracts/src/settingsUi/homeyDevices.ts';
import type { SettingsUiDeviceListItem } from './deviceUtils.ts';
import { resolveDeviceClassLabel } from './deviceClassLabels.ts';
import { getTargetDevices } from './devices.ts';
import { loadHomeyDeviceList } from './homeyDeviceList.ts';
import { getChosenWholeHomeMeterId } from './homeyEnergyMeter.ts';
import { settingsPowerSourceSelect } from './dom.ts';
import { logSettingsError } from './logging.ts';
import { state } from './state.ts';
import { openDeviceSupportRequest } from './supportReport.ts';
import {
  renderDeviceSupportPicker,
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
let refreshSequence = 0;

/**
 * Every Homey device, with where it stands in PELS. A device on Devices is
 * supported, and so is the whole-home meter PELS reads power from, which is
 * not a device it controls; every other Homey device is one PELS does not
 * support.
 */
export const toDevicePickerRows = (
  homeyDevices: readonly HomeyDeviceListEntry[],
  pelsDevices: readonly SettingsUiDeviceListItem[],
  wholeHomeMeterId: string | null,
): DevicePickerRow[] => {
  const listed = new Set(pelsDevices.map((device) => device.id));
  return homeyDevices.map((device) => {
    let status: DevicePickerRow['status'] = device.id === wholeHomeMeterId ? 'power_source' : 'unsupported';
    if (listed.has(device.id)) status = 'listed';
    return {
      id: device.id,
      name: device.name,
      zoneName: device.zoneName,
      deviceType: device.class ? resolveDeviceClassLabel(device.class) : null,
      status,
    };
  });
};

/** The whole-home meter PELS reads power from: the chosen one only while Power source is Homey Energy. */
const activeWholeHomeMeterId = (): string | null => (
  settingsPowerSourceSelect?.value === 'homey_energy' ? getChosenWholeHomeMeterId() : null
);

const select = (row: DevicePickerRow): void => {
  // The whole-home meter's row is a settings link to Power source (`data-settings-target`).
  if (!navigation || row.status === 'power_source') return;
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
    read, query,
    onQuery: (next) => { query = next; paint(); },
    onSelect: select,
    onRetry: () => { void refreshDeviceSupportPicker(); },
    onClearSearch: () => { query = ''; paint(); },
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
      ? { state: 'unavailable' }
      : { state: 'ready', rows: toDevicePickerRows(homeyDevices, pelsDevices, activeWholeHomeMeterId()) };
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
