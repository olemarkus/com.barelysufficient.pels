import {
  clearMockHomeyApiDeviceListeners,
  MockDevice,
  MockDriver,
  mockHomeyApiInstance,
  setMockDrivers,
} from './mocks/homey';

describe('mock Homey backend', () => {
  beforeEach(() => {
    clearMockHomeyApiDeviceListeners();
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

    await mockHomeyApiInstance.devices.setCapabilityValue({
      deviceId: 'dev-1',
      capabilityId: 'onoff',
      value: true,
    });

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

    const devices = await mockHomeyApiInstance.devices.getDevices();
    const payload = (devices as Record<string, any>)['dev-1'];
    const capabilityListener = jest.fn();
    const capabilityInstance = payload.makeCapabilityInstance('onoff', capabilityListener);
    const deviceUpdateListener = jest.fn();
    mockHomeyApiInstance.devices.on?.('device.update', deviceUpdateListener);

    device.tapTile();

    expect(capabilityListener).toHaveBeenCalledWith(false);
    expect(deviceUpdateListener).toHaveBeenCalledWith(expect.objectContaining({
      id: 'dev-1',
      capabilitiesObj: expect.objectContaining({
        onoff: expect.objectContaining({ value: false }),
      }),
    }));
    expect(device.getActualCapabilityValue('onoff')).toBe(false);
    await expect(device.getCapabilityValue('onoff')).resolves.toBe(false);

    capabilityInstance.destroy();
    mockHomeyApiInstance.devices.off?.('device.update', deviceUpdateListener);
  });
});
