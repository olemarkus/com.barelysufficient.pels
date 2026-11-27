import type { HomeyEnergyMeterEntry } from '../../packages/contracts/src/settingsUi/power';
import type { DeviceTransportPort } from './deviceTransport';
import { fetchLiveMeterItems } from './transport/managerFetch';
import { isPickableMeterItem, resolveDeviceClassKey } from './transport/managerHelpers';

/**
 * Resolve meter-picker entries from Homey's live report and device inventory.
 * Read failures reject instead of presenting an empty picker. A cumulative
 * meter absent from the inventory remains identifiable by its report ID.
 */
export async function readHomeyEnergyMeters(
  transport: Pick<DeviceTransportPort, 'readDeviceInventory'>,
): Promise<HomeyEnergyMeterEntry[]> {
  const items = await fetchLiveMeterItems();
  const needed = new Set(items.map((item) => item.id));
  const meters = await transport.readDeviceInventory(async (devices) => {
    const candidates = new Map<string, { name: string; deviceClass: string }>();
    let hasDevice = false;
    for await (const device of devices) {
      hasDevice = true;
      if (needed.has(device.id)) {
        candidates.set(device.id, { name: device.name, deviceClass: resolveDeviceClassKey(device) ?? device.class });
      }
    }
    return { hasDevice, candidates };
  });
  if (!meters.hasDevice) throw new Error('Homey device list unavailable');
  return items
    .filter((item) => isPickableMeterItem({
      isCumulativeItem: item.type === 'cumulative',
      deviceClass: meters.candidates.get(item.id)?.deviceClass,
    }))
    .map((item) => ({ id: item.id, name: meters.candidates.get(item.id)?.name ?? item.id }));
}
