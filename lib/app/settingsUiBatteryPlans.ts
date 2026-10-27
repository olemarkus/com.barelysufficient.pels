import type { SettingsUiDevicesPayload } from '../../packages/contracts/src/settingsUiApi';
import type { PelsHost } from './pelsHost';

/** The whole-home roster already excludes batteries outside Main. */
export const readSettingsUiBatteryPlans = (
  host: PelsHost,
  devices: SettingsUiDevicesPayload['devices'],
): SettingsUiDevicesPayload['continuousBatteryPlans'] => Object.fromEntries(
  devices.filter(device => device.deviceClass === 'battery')
    .map(device => [device.id, host.readContinuousBatteryPlan(device.id)]),
);
