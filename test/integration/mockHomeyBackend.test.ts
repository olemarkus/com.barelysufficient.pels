import Homey from 'homey';
import {
  MockDevice,
  MockDriver,
  mockHomeyInstance,
  setMockDrivers,
} from '../mocks/homey';
import { createDeviceLiveFeed } from '../../lib/device/liveFeed';
import { getLogger } from '../../lib/logging/logger';
import { connectLiveFeed, settleLiveFeed } from '../helpers/liveFeedSocketHarness';

describe('mock Homey backend', () => {
  beforeEach(() => {
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

  it('pushes an external tile toggle to a connected live feed as a capability frame and a device.update', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['onoff', 'measure_power']);
    device.setActualCapabilityValue('onoff', true, {
      updateApi: true,
      emitCapabilityEvent: false,
      emitDeviceUpdate: false,
    });
    setMockDrivers({
      driverA: new MockDriver('driverA', [device]),
    });
    connectLiveFeed();
    const onDeviceUpdate = vi.fn();
    const onCapabilityUpdate = vi.fn();
    const feed = createDeviceLiveFeed({
      homey: new Homey.App(),
      logger: { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('mock-backend-test') },
      callbacks: { onDeviceUpdate, onCapabilityUpdate },
    });
    await feed.start();
    feed.updateTrackedDevices(['dev-1']);
    await settleLiveFeed();

    try {
      device.tapTile();

      expect(onCapabilityUpdate).toHaveBeenCalledWith('dev-1', 'onoff', false);
      expect(onDeviceUpdate).toHaveBeenCalledWith(expect.objectContaining({
        id: 'dev-1',
        capabilitiesObj: expect.objectContaining({
          onoff: expect.objectContaining({ value: false }),
        }),
      }));
      expect(device.getActualCapabilityValue('onoff')).toBe(false);
      await expect(device.getCapabilityValue('onoff')).resolves.toBe(false);
    } finally {
      await feed.stop();
    }
  });
});
