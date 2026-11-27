import { supportsTemperatureAdjustments } from './deviceDetail/temperaturePolicy.ts';
import { MAIN_HOME_ID } from '../../../shared-domain/src/settings/settingsKeys.ts';
import { supportsSmartTaskKind } from '../../../shared-domain/src/smartTaskDeviceKind.ts';
import type { SettingsUiDeviceListItem } from './deviceUtils.ts';
import type { MainHomeJobs } from './planHeroSummary.ts';
import { readHomeMembership } from './homeScope.ts';
import { readSetupRespondsToPrices } from './setupPathFacts.ts';
import { hasOpenSmartTask, resolveManagedState, state } from './state.ts';

export type MainHomeDevices =
  | { state: 'loading' | 'unavailable' }
  | { state: 'ready'; devices: readonly SettingsUiDeviceListItem[] };

export const readMainHomeDevices = (): MainHomeDevices => {
  const membership = readHomeMembership();
  if (state.devicesReadState === 'unavailable') return { state: 'unavailable' };
  if (!state.devicesLoaded || membership.state === 'loading') return { state: 'loading' };
  if (membership.state === 'unavailable') return { state: 'unavailable' };
  return {
    state: 'ready',
    devices: state.latestDevices.filter((device) =>
      (membership.membershipByDeviceId[device.id] ?? MAIN_HOME_ID) === MAIN_HOME_ID),
  };
};

/** A battery's own Managed setting determines whether it is in the managed roster. */
export const readMainHomeManagedDevices = (): MainHomeDevices => {
  const read = readMainHomeDevices();
  if (read.state !== 'ready') return read;
  return { state: 'ready', devices: read.devices.filter((device) => resolveManagedState(device.id)) };
};

/**
 * Whether the device's Price-based control acts: it is on, the device has a
 * temperature target, and PELS responds to prices. Nothing is claimed while
 * Respond to prices is still being read.
 */
export const followsPrices = (device: SettingsUiDeviceListItem): boolean => (
  readSetupRespondsToPrices() === true
  && supportsTemperatureAdjustments(device)
  && state.priceOptimizationSettings[device.id]?.enabled === true
);

/** Whether the device can carry a Smart task: a temperature, charging or supported relay energy task. */
export const isSmartTaskCapable = (device: SettingsUiDeviceListItem): boolean => (
  supportsTemperatureAdjustments(device) || device.isEvCharger || supportsSmartTaskKind(device, 'energy')
);

export const countMainHomeJobs = (nowMs: number): MainHomeJobs => {
  const managed = readMainHomeManagedDevices();
  if (managed.state !== 'ready' || readSetupRespondsToPrices() === null) return { state: 'uncounted' };
  return {
    state: 'counted',
    priceFollowingCount: managed.devices.filter(followsPrices).length,
    smartTaskDeviceCount: managed.devices.filter((device) => hasOpenSmartTask(device.id, nowMs)).length,
  };
};
