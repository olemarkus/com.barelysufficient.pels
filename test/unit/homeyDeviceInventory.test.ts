import { describe, expect, it } from 'vitest';
import { listHomeyDevices, readHomeyDeviceList } from '../../lib/device/homeyDeviceInventory';
import { describeHomeyDeviceForSupport } from '../../lib/diagnostics/homeyDeviceSupportSection';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';

describe('Homey device inventory', () => {
  it('names each zone from the zone tree and leaves an unknown zone unnamed', () => {
    const devices: HomeyDeviceLike[] = [
      { ...HOMEY_DEVICE_FIELDS, id: 'relay', name: 'Relay', class: 'light', zone: 'z2', capabilities: ['onoff', 'meter_power'] },
      { ...HOMEY_DEVICE_FIELDS, id: 'sensor', name: 'Sensor', zone: 'gone', capabilities: ['measure_temperature'] },
    ];
    expect(listHomeyDevices(devices, { z2: { id: 'z2', name: 'Basement', parent: null } })).toEqual([
      { id: 'relay', name: 'Relay', class: 'light', zoneName: 'Basement', hasTemperature: false, hasPower: true },
      { id: 'sensor', name: 'Sensor', class: 'other', zoneName: null, hasTemperature: true, hasPower: false },
    ]);
    expect(listHomeyDevices(devices, null).map((entry) => entry.zoneName)).toEqual([null, null]);
  });

  it('reads the devices and the zone tree from the transport together', async () => {
    const transport = {
      getDevicesForDebug: async (): Promise<HomeyDeviceLike[]> => [{ ...HOMEY_DEVICE_FIELDS, id: 'relay', name: 'Relay', zone: 'z2' }],
      getZoneTree: () => ({ z2: { id: 'z2', name: 'Basement', parent: null } }),
    };
    await expect(readHomeyDeviceList(transport)).resolves.toEqual([
      { id: 'relay', name: 'Relay', class: 'other', zoneName: 'Basement', hasTemperature: false, hasPower: false },
    ]);
    await expect(readHomeyDeviceList({ ...transport, getZoneTree: () => null })).resolves
      .toMatchObject([{ id: 'relay', zoneName: null }]);
  });

  it('bounds what a vendor payload can put into a support request', () => {
    const section = describeHomeyDeviceForSupport({ ...HOMEY_DEVICE_FIELDS,
      id: 'odd', name: 'Odd device', capabilities: ['status', 'measure_power'],
      capabilitiesObj: {
        status: { value: 'x'.repeat(500) },
        measure_power: { value: Number.NaN, units: 'W' },
      },
      energyObj: { approximation: { usageOn: 3000, nested: { deeper: { deepest: { tooDeep: 1 } } } } },
    });
    const capabilities = section.values.capabilities as Record<string, { value: unknown }>;
    expect(capabilities.status.value).toBe(`${'x'.repeat(200)}…`);
    expect(capabilities.measure_power).toEqual({ value: null, units: 'W' });
    expect(section.values.energy).toEqual({ approximation: { usageOn: 3000, nested: { deeper: null } } });
  });
});
