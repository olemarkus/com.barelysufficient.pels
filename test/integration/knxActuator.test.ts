import type Homey from 'homey';
import { DeviceControlSettings } from '../../lib/device/deviceControlSettings';
import { getLogger } from '../../lib/logging/logger';
import { CONTROLLABLE_DEVICES, MANAGED_DEVICES } from '../../lib/utils/settingsKeys';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { emitCapability } from '../helpers/liveFeedSocketHarness';
import { mockHomeyInstance } from '../mocks/homey';

const logger: Logger = { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('devices') };

const actuator = (): HomeyDeviceLike => ({
  id: 'knx-actuator',
  name: 'KNX actuator',
  class: 'light',
  driverId: 'homey:app:org.knx:knx_light',
  settings: { energy_value_on: 2000, energy_value_off: 0 },
  capabilities: ['onoff'],
  capabilitiesObj: {
    onoff: { value: true, setable: true, lastUpdated: new Date(Date.now() - 1000).toISOString() },
  },
  available: true,
  ready: true,
});

test.each([false, true])('requires explicit management when another device is managed: %s', async (otherManaged) => {
  const saved = new Map<string, unknown>([
    [MANAGED_DEVICES, otherManaged ? { other: true } : {}],
    [CONTROLLABLE_DEVICES, {}],
  ]);
  const owner = new DeviceControlSettings({ get: (key) => saved.get(key), getKeys: () => [...saved.keys()] });
  owner.reload();
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger, {
    settings: {
      isManaged: (id) => owner.isManaged(id),
      isControllable: (id) => owner.isControllable(id),
      isManagedFilterActive: () => owner.isManagedFilterActive(),
    },
  });
  try {
    await seedTransportDevices(transport, [actuator()]);
    const visible = [...transport.getSnapshot(), ...transport.getUiPickerDevices()];
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      id: 'knx-actuator', deviceClass: 'socket', deviceType: 'onoff', managed: false, controllable: false,
    });
    saved.set(MANAGED_DEVICES, { 'knx-actuator': true });
    saved.set(CONTROLLABLE_DEVICES, { 'knx-actuator': true });
    owner.reload();
    const [selected] = await seedTransportDevices(transport, [actuator()]);
    expect(selected).toMatchObject({ managed: true, controllable: true });
    expect(transport.deviceConfigurationStore.get('knx-actuator')).toMatchObject({ controlModel: 'binary_power' });
    expect(transport.getUiPickerDevices()).toEqual([]);
  } finally {
    transport.destroy();
  }
});

test('uses native onoff commands and observed status for a KNX binary actuator', async () => {
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);
  const device = actuator();
  const put = vi.spyOn(mockHomeyInstance.api, 'put').mockResolvedValue(undefined);
  const triggerFlow = vi.fn();
  try {
    await initWithLiveFeed(transport);
    const [snapshot] = await seedTransportDevices(transport, [device]);
    expect(snapshot).toMatchObject({
      deviceClass: 'socket', deviceType: 'onoff', binaryControllable: true,
      binaryCapabilityId: 'onoff', binaryControl: { on: true }, targets: [],
    });
    expect(snapshot?.measuredPowerKw).toBeUndefined();
    expect(transport.deviceConfigurationStore.get(device.id)).toMatchObject({ controlModel: 'binary_power' });
    expect(device.class).toBe('light');

    await transport.requestBinaryControl(device.id, false, triggerFlow);
    expect(put).toHaveBeenCalledWith('manager/devices/device/knx-actuator/capability/onoff', { value: false });
    expect(triggerFlow).not.toHaveBeenCalled();
    expect(transport.getSnapshotByDeviceId(device.id)?.binaryControl).toEqual({ on: true });

    await emitCapability(device.id, 'onoff', false);
    expect(transport.getSnapshotByDeviceId(device.id)?.binaryControl).toEqual({ on: false });
  } finally {
    transport.destroy();
    put.mockRestore();
  }
});

test('does not admit other lights, KNX dimmers, switch remotes, or a driver without onoff', async () => {
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);
  const devices: HomeyDeviceLike[] = [
    { ...actuator(), id: 'other-light', driverId: 'homey:app:other:light' },
    { ...actuator(), id: 'knx-dimmer', driverId: 'homey:app:org.knx:knx_dimmer' },
    { ...actuator(), id: 'knx-switch', driverId: 'homey:app:org.knx:knx_switch', class: 'remote' },
    { ...actuator(), id: 'knx-no-switch', capabilities: [], capabilitiesObj: {} },
  ];
  try {
    expect(await seedTransportDevices(transport, devices)).toEqual([]);
    expect(transport.getUiPickerDevices()).toEqual([]);
  } finally {
    transport.destroy();
  }
});
