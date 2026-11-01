import type { HomeyDeviceListEntry } from '../../packages/contracts/src/settingsUi/homeyDevices';
import type { HomeyDeviceLike } from '../utils/types';
import type { DeviceTransportPort } from './deviceTransport';
import type { ZoneTree } from './transport/managerZones';
import { resolveZoneId } from './transport/managerHelpers';
import { hasPowerCapability } from './transport/managerParse';

const readCapabilityIds = (device: HomeyDeviceLike): string[] => (
  Array.isArray(device.capabilities)
    ? device.capabilities.filter((capability): capability is string => typeof capability === 'string')
    : []
);

/**
 * Every Homey device, PELS-listed or not, as the full-inventory pickers show
 * it. The zone name comes from the transport's zone tree: the local Web API
 * names a device's zone only by id.
 */
export const listHomeyDevices = (
  devices: readonly HomeyDeviceLike[],
  zoneTree: ZoneTree | null,
): HomeyDeviceListEntry[] => devices.map((device) => {
  const capabilities = readCapabilityIds(device);
  const zoneId = resolveZoneId(device);
  const zoneName = zoneId === undefined ? undefined : zoneTree?.[zoneId]?.name;
  return {
    id: device.id,
    name: device.name,
    ...(typeof device.class === 'string' ? { class: device.class } : {}),
    zoneName: typeof zoneName === 'string' && zoneName ? zoneName : null,
    hasTemperature: capabilities.includes('measure_temperature'),
    hasPower: hasPowerCapability(capabilities),
  };
});

/**
 * Every Homey device, read fresh from Homey and listed with the transport's
 * zone names. A failed read rejects rather than answering empty, so an empty
 * list means the hub has no devices.
 */
export const readHomeyDeviceInventory = async (
  transport: Pick<DeviceTransportPort, 'getDevicesForDebug' | 'getZoneTree'>,
): Promise<HomeyDeviceListEntry[]> => {
  // The list crosses the SDK boundary, so an entry without an id is dropped.
  const devices = (await transport.getDevicesForDebug()).filter((device) => typeof device.id === 'string');
  return listHomeyDevices(devices, transport.getZoneTree());
};
