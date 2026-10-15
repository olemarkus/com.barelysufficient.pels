import type { HomeyEnergyMeterEntry } from '../../packages/contracts/src/settingsUiApi';
import type { HomeyDeviceLike } from '../utils/types';
import { fetchLiveMeterItems } from './transport/managerFetch';
import { isPickableMeterItem, resolveDeviceClassKey } from './transport/managerHelpers';

/**
 * Resolve meter-picker entries from Homey's live report and device inventory.
 * Read failures reject instead of presenting an empty picker. A cumulative
 * meter absent from the inventory remains identifiable by its report ID.
 */
export async function readHomeyEnergyMeters(
  readDevices: () => Promise<HomeyDeviceLike[]>,
): Promise<HomeyEnergyMeterEntry[]> {
  const items = await fetchLiveMeterItems();
  const devices = (await readDevices())
    .filter((device): device is HomeyDeviceLike & { id: string } => typeof device.id === 'string');
  if (devices.length === 0) throw new Error('Homey device list unavailable');
  const nameById = new Map(devices.map((device) => [device.id, device.name] as const));
  const classById = new Map(devices.map((device) => (
    [device.id, resolveDeviceClassKey(device) ?? device.class] as const
  )));
  return items
    .filter((item) => isPickableMeterItem({
      isCumulativeItem: item.type === 'cumulative',
      deviceClass: classById.get(item.id),
    }))
    .map((item) => ({ id: item.id, name: nameById.get(item.id) ?? item.id }));
}
