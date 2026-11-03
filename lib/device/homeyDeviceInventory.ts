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
 * The full inventory read from the transport: the devices Homey lists now,
 * named by the zone tree the transport last fetched (none before its first).
 */
export const readHomeyDeviceList = async (
  transport: Pick<DeviceTransportPort, 'getDevicesForDebug' | 'getZoneTree'>,
): Promise<HomeyDeviceListEntry[]> => listHomeyDevices(await transport.getDevicesForDebug(), transport.getZoneTree());
