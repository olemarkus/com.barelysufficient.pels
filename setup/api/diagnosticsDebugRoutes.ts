import { readPelsHost } from '../../lib/app/pelsHost';
import { listHomeyDevices } from '../../lib/device/homeyDeviceInventory';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import type { HomeyDeviceListEntry } from '../../packages/contracts/src/settingsUi/homeyDevices';
import type { HomeyEnergyMeterEntry } from '../../packages/contracts/src/settingsUi/power';
import {
  getHomeyDevicesForDebugFromApp,
  getHomeyEnergyMetersFromApp,
  logHomeyDeviceForDebugFromApp,
} from '../appDebugHelpers';
import { defineRoutes, type ApiContext } from './defineRoutes';

const hasDeviceId = (device: HomeyDeviceLike): device is HomeyDeviceLike & { id: string } => (
  typeof device.id === 'string'
);

export const diagnosticsDebugRoutes = defineRoutes({
  homey_devices: async ({ homey }: ApiContext): Promise<HomeyDeviceListEntry[]> => {
    const host = readPelsHost(homey);
    if (!host) return [];
    const devices = (await getHomeyDevicesForDebugFromApp(host)).filter(hasDeviceId);
    return listHomeyDevices(devices, host.deviceManager?.getZoneTree() ?? null);
  },
  // Backs both whole-home meter pickers: the meters the Homey Energy live report
  // actually exposes (the same seam a selection is read against), so every pick
  // is guaranteed readable — unlike a capability/class filter over the device list.
  // An unreadable report rejects instead of answering empty, so the pickers can
  // trust an empty list as "this home has no meters".
  homey_energy_meters: async ({ homey }: ApiContext): Promise<HomeyEnergyMeterEntry[]> => {
    const host = readPelsHost(homey);
    if (!host) throw new Error('PELS app not available');
    return getHomeyEnergyMetersFromApp(host);
  },
  log_homey_device: async (
    { homey, body }: ApiContext & { body?: { id?: string } },
  ): Promise<{ ok: boolean; error?: string }> => {
    const host = readPelsHost(homey);
    if (!host) {
      return { ok: false, error: 'LOGGING_NOT_AVAILABLE' };
    }
    const deviceId = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!deviceId) {
      host.error('Homey device log API called without valid device id');
      return { ok: false, error: 'INVALID_DEVICE_ID' };
    }
    const ok = await logHomeyDeviceForDebugFromApp(host, deviceId);
    if (!ok) {
      return { ok: false, error: 'DEVICE_NOT_FOUND' };
    }
    return { ok: true };
  },
});
