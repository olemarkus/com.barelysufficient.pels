import { readPelsHost } from '../../lib/app/pelsHost';
import { appNotReadyError } from '../../lib/app/settingsUiReadiness';
import { readHomeyDeviceInventory } from '../../lib/device/homeyDeviceInventory';
import { answerDeviceDumpRequest, type DeviceDumpReply } from '../../lib/diagnostics/deviceDumpRequest';
import type { HomeyDeviceListEntry } from '../../packages/contracts/src/settingsUi/homeyDevices';
import type { HomeyEnergyMeterEntry } from '../../packages/contracts/src/settingsUi/power';
import { getHomeyEnergyMetersFromApp, logHomeyDeviceForDebugFromApp } from '../appDebugHelpers';
import { defineRoutes, type ApiContext } from './defineRoutes';

// Each read needs the device transport. Until it is wired the routes answer the
// settings UI's starting error, never an empty list: an empty list is a real
// answer the pickers would trust ("this home has no devices").
export const diagnosticsDebugRoutes = defineRoutes({
  // `lib/device` owns the read and the listing the device pickers filter on.
  homey_devices: ({ homey }: ApiContext): Promise<HomeyDeviceListEntry[]> => {
    const transport = readPelsHost(homey)?.deviceManager;
    if (!transport) throw appNotReadyError('Homey devices');
    return readHomeyDeviceInventory(transport);
  },
  // Backs both whole-home meter pickers: the meters the Homey Energy live report
  // actually exposes (the same seam a selection is read against), so every pick
  // is guaranteed readable — unlike a capability/class filter over the device list.
  // An unreadable report rejects instead of answering empty, so the pickers can
  // trust an empty list as "this home has no meters".
  homey_energy_meters: ({ homey }: ApiContext): Promise<HomeyEnergyMeterEntry[]> => {
    const host = readPelsHost(homey);
    if (!host?.deviceManager) throw appNotReadyError('Homey energy meters');
    return getHomeyEnergyMetersFromApp(host);
  },
  // `lib/diagnostics` validates the request and answers it.
  log_homey_device: ({ homey, body }: ApiContext & { body?: unknown }): Promise<DeviceDumpReply> => {
    const host = readPelsHost(homey);
    if (!host?.deviceManager) throw appNotReadyError('Device logging');
    return answerDeviceDumpRequest(body, (deviceId) => logHomeyDeviceForDebugFromApp(host, deviceId));
  },
});
