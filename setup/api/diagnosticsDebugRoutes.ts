import { logHomeyDeviceRequest } from '../../lib/app/deviceDebugRequest';
import { readPelsHost, requirePelsHost } from '../../lib/app/pelsHost';
import type { HomeyDeviceListEntry } from '../../packages/contracts/src/settingsUi/homeyDevices';
import type { HomeyEnergyMeterEntry } from '../../packages/contracts/src/settingsUi/power';
import {
  getHomeyEnergyMetersFromApp,
  listHomeyDevicesFromApp,
  logHomeyDeviceForDebugFromApp,
} from '../appDebugHelpers';
import { defineRoutes, type ApiContext } from './defineRoutes';

export const diagnosticsDebugRoutes = defineRoutes({
  homey_devices: async ({ homey }: ApiContext): Promise<HomeyDeviceListEntry[]> => {
    return listHomeyDevicesFromApp(requirePelsHost(homey));
  },
  // Backs both whole-home meter pickers: the meters the Homey Energy live report
  // actually exposes (the same seam a selection is read against), so every pick
  // is guaranteed readable — unlike a capability/class filter over the device list.
  // An unreadable report rejects instead of answering empty, so the pickers can
  // trust an empty list as "this home has no meters".
  homey_energy_meters: async ({ homey }: ApiContext): Promise<HomeyEnergyMeterEntry[]> => {
    return getHomeyEnergyMetersFromApp(requirePelsHost(homey));
  },
  log_homey_device: ({ homey, body }: ApiContext & { body?: unknown }) => (
    logHomeyDeviceRequest(readPelsHost(homey), body, logHomeyDeviceForDebugFromApp)
  ),
});
