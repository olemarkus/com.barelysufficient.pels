import { MAIN_HOME_ID } from '../../../shared-domain/src/settings/settingsKeys.ts';
import { supportsSmartTaskKind } from '../../../shared-domain/src/smartTaskDeviceKind.ts';
import { supportsTemperatureControlDevice, type SettingsUiDeviceListItem } from './deviceUtils.ts';
import { readHomeMembership } from './homeScope.ts';
import { readSetupRespondsToPrices } from './setupPathFacts.ts';
import { hasOpenSmartTask, state } from './state.ts';

/** The devices PELS manages in the Main home: the ones setup configures and the Overview counts. */
export type MainHomeManagedDevices =
  | { state: 'loading' | 'unavailable' }
  | { state: 'ready'; devices: readonly SettingsUiDeviceListItem[] };

export const readMainHomeManagedDevices = (): MainHomeManagedDevices => {
  const membership = readHomeMembership();
  if (!state.devicesLoaded || membership.state === 'loading') return { state: 'loading' };
  if (membership.state === 'unavailable') return { state: 'unavailable' };
  return {
    state: 'ready',
    devices: state.latestDevices.filter((device) => state.managedMap[device.id] === true
      && (membership.membershipByDeviceId[device.id] ?? MAIN_HOME_ID) === MAIN_HOME_ID),
  };
};

/**
 * Whether the device's Price-based control acts: it is on, the device has a
 * temperature target, and PELS responds to prices. A Respond to prices still
 * being read does not hold it back.
 */
export const followsPrices = (device: SettingsUiDeviceListItem): boolean => (
  readSetupRespondsToPrices() !== false
  && supportsTemperatureControlDevice(device)
  && state.priceOptimizationSettings[device.id]?.enabled === true
);

/** Whether the device can carry a Smart task: a temperature, charging or supported relay energy task. */
export const isSmartTaskCapable = (device: SettingsUiDeviceListItem): boolean => (
  supportsTemperatureControlDevice(device) || device.isEvCharger || supportsSmartTaskKind(device, 'energy')
);

/** What PELS does for the Main home besides holding a limit, as the Overview states it. */
export type MainHomeJobCounts = { priceFollowingCount: number; smartTaskDeviceCount: number };

export const countMainHomeJobs = (nowMs: number): MainHomeJobCounts => {
  const managed = readMainHomeManagedDevices();
  if (managed.state !== 'ready') return { priceFollowingCount: 0, smartTaskDeviceCount: 0 };
  return {
    priceFollowingCount: managed.devices.filter(followsPrices).length,
    smartTaskDeviceCount: managed.devices.filter((device) => hasOpenSmartTask(device.id, nowMs)).length,
  };
};
