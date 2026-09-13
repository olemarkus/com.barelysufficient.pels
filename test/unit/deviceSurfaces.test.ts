import { describe, expect, it } from 'vitest';
import { joinDeviceSurfaces, projectDeviceSurfaces } from '../../lib/device/deviceSurfaces';
import type {
  DeviceDescriptorRead,
  ProjectedObservedDeviceState,
} from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';

// What this module owns is the JOIN and the untracked-device projection. Reading
// devices out of the transport belongs to `deviceReads`, and is specced there.

const descriptor = (id: string, name = id): DeviceDescriptorRead => ({
  id,
  name,
  deviceClass: 'heater',
  capabilities: ['onoff'],
  expectedPowerKw: 2,
  expectedPowerSource: 'manual',
});

const observed = (id: string): ProjectedObservedDeviceState => ({
  id,
  name: `${id} (observed)`,
  targets: [],
  binaryControl: { on: true },
  available: true,
  measuredPowerKw: 1.5,
});

describe('joinDeviceSurfaces', () => {
  it('carries both surfaces, identity from the descriptor', () => {
    const joined = joinDeviceSurfaces(descriptor('a', 'Heater'), observed('a'));
    expect(joined).toEqual({
      id: 'a',
      // Identity is the transport's: a rename arrives as a device.update with no
      // observed change, which the projection is not told about. (The fixture
      // names differ only to make the order visible.)
      name: 'Heater',
      deviceClass: 'heater',
      capabilities: ['onoff'],
      expectedPowerKw: 2,
      expectedPowerSource: 'manual',
      targets: [],
      binaryControl: { on: true },
      available: true,
      measuredPowerKw: 1.5,
    });
  });
});

describe('projectDeviceSurfaces', () => {
  it('bounds an untracked (picker) device to the two declared surfaces', () => {
    const parsed = {
      ...descriptor('p'),
      ...observed('p'),
      binaryCapabilityId: 'onoff',
      flowBackedCapabilityIds: ['onoff'],
    } as unknown as TransportDeviceSnapshot;
    const [surfaces] = projectDeviceSurfaces([parsed]);
    expect(Object.keys(surfaces!).sort()).toEqual([
      'available', 'binaryControl', 'capabilities', 'deviceClass', 'expectedPowerKw',
      'expectedPowerSource', 'id', 'measuredPowerKw', 'name', 'targets',
    ]);
    expect(surfaces).not.toBe(parsed);
    expect(projectDeviceSurfaces([])).toEqual([]);
  });
});
