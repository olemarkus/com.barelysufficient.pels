import type { HomeyDeviceListEntry } from '../../packages/contracts/src/settingsUi/homeyDevices';
import type { HomeyDeviceLike } from '../utils/types';
import type { ZoneTree } from './transport/managerZones';
import type { DeviceTransportPort } from './deviceTransport';
import { resolveZoneId } from './transport/managerHelpers';
import { hasPowerCapability } from './transport/managerParse';

const readCapabilityIds = (device: HomeyDeviceLike): string[] => (
  Array.isArray(device.capabilities)
    ? device.capabilities.filter((capability): capability is string => typeof capability === 'string')
    : []
);

/** A zone's name as the zone tree holds it; `undefined` before the tree holds the zone. */
const zoneNameOf = (zoneTree: ZoneTree | null, zoneId: string | undefined): string | undefined => {
  const name = zoneId === undefined ? undefined : zoneTree?.[zoneId]?.name;
  return typeof name === 'string' && name ? name : undefined;
};

/** A device's `zoneName`, present only once the zone tree holds its zone. */
export const zoneNameField = (zoneTree: ZoneTree | null, zoneId: string | undefined): { zoneName?: string } => {
  const zoneName = zoneNameOf(zoneTree, zoneId);
  return zoneName ? { zoneName } : {};
};

/**
 * Every Homey device, PELS-listed or not, as the full-inventory pickers show
 * it. The zone name comes from the transport's zone tree: the local Web API
 * names a device's zone only by id.
 */
const pickerEntry = (device: HomeyDeviceLike) => {
  const capabilities = readCapabilityIds(device);
  return {
    id: device.id,
    name: device.name,
    class: device.class,
    zoneId: resolveZoneId(device),
    hasTemperature: capabilities.includes('measure_temperature'),
    hasPower: hasPowerCapability(capabilities),
  };
};

export async function readHomeyDeviceList(
  transport: Pick<DeviceTransportPort, 'readDeviceInventory' | 'getZoneTree'>,
): Promise<HomeyDeviceListEntry[]> {
  const entries = await transport.readDeviceInventory(async (devices) => {
    const rows: ReturnType<typeof pickerEntry>[] = [];
    // eslint-disable-next-line functional/immutable-data -- Only compact picker fields survive each entry.
    for await (const device of devices) rows.push(pickerEntry(device));
    return rows;
  });
  const zones = transport.getZoneTree();
  return entries.map(({ zoneId, ...entry }) => ({ ...entry, zoneName: zoneNameOf(zones, zoneId) ?? null }));
}

/** The dump's first source is the normal transport inventory. Retain just its first matching device. */
export function readInventoryDevice(transport: Pick<DeviceTransportPort, 'readDeviceInventory'>, id: string) {
  return transport.readDeviceInventory(async (devices) => {
    let match: HomeyDeviceLike | undefined;
    for await (const device of devices) {
      if (device.id === id) match ??= device;
    }
    return match;
  });
}
