import {
  clearMockSdkDeviceListeners,
  MockDevice,
  MockDriver,
  mockHomeyInstance,
  setMockDrivers,
} from './mocks/homey';

describe('mock Homey backend', () => {
  beforeEach(() => {
    clearMockSdkDeviceListeners();
    setMockDrivers({});
  });

  it('can accept a write while keeping the API-visible state stale', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['onoff', 'target_temperature']);
    device.setApiCapabilityValue('onoff', false);
    device.configureCapabilityBehavior('onoff', {
      onApiWrite: {
        updateActual: true,
        updateApi: false,
        emitCapabilityEvent: false,
        emitDeviceUpdate: false,
      },
    });
    setMockDrivers({
      driverA: new MockDriver('driverA', [device]),
    });

    await mockHomeyInstance.api.put(
      'manager/devices/device/dev-1/capability/onoff',
      { value: true },
    );

    expect(device.getSetCapabilityValue('onoff')).toBe(true);
    expect(device.getActualCapabilityValue('onoff')).toBe(true);
    await expect(device.getCapabilityValue('onoff')).resolves.toBe(false);

    device.syncActualToApi('onoff');
    await expect(device.getCapabilityValue('onoff')).resolves.toBe(true);
  });

  it('can simulate an external tile toggle with realtime capability and device.update', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['onoff', 'measure_power']);
    device.setActualCapabilityValue('onoff', true, {
      updateApi: true,
      emitCapabilityEvent: false,
      emitDeviceUpdate: false,
    });
    setMockDrivers({
      driverA: new MockDriver('driverA', [device]),
    });

    const devices = await mockHomeyInstance.api.get('manager/devices') as Record<string, any>;
    const payload = devices['dev-1'];
    const capabilityListener = jest.fn();
    const capabilityInstance = payload.makeCapabilityInstance('onoff', capabilityListener);

    const sdkDevicesApi = mockHomeyInstance.api.getApi('homey:manager:devices');
    const realtimeListener = jest.fn();
    sdkDevicesApi.on('realtime', realtimeListener);

    device.tapTile();

    expect(capabilityListener).toHaveBeenCalledWith(false);
    expect(realtimeListener).toHaveBeenCalledWith('device.update', expect.objectContaining({
      id: 'dev-1',
      capabilitiesObj: expect.objectContaining({
        onoff: expect.objectContaining({ value: false }),
      }),
    }));
    expect(device.getActualCapabilityValue('onoff')).toBe(false);
    await expect(device.getCapabilityValue('onoff')).resolves.toBe(false);

    capabilityInstance.destroy();
    sdkDevicesApi.off('realtime', realtimeListener);
  });
});
