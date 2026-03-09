import { EventEmitter } from 'events';
import {
  HOMEY_DEVICE_UPDATE_EVENT,
} from '../lib/core/deviceManager';
import { syncRealtimeDeviceUpdateListener } from '../lib/core/deviceManagerRuntime';

describe('deviceManagerRuntime', () => {
  it('keeps device.update listener state attached when off is unsupported', async () => {
    const devicesEmitter = new EventEmitter();
    devicesEmitter.setMaxListeners(0);
    const devicesApi = {
      connect: jest.fn().mockResolvedValue(undefined),
      on: devicesEmitter.on.bind(devicesEmitter),
    };
    const logger = {
      debug: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
    };
    const listener = jest.fn();
    const trackedDevice = { id: 'dev1', name: 'Heater' };

    const attachedAfterEnable = await syncRealtimeDeviceUpdateListener({
      devicesApi,
      attached: false,
      devices: [trackedDevice],
      shouldTrackRealtimeDevice: () => true,
      listener,
      eventName: HOMEY_DEVICE_UPDATE_EVENT,
      logger,
    });
    expect(attachedAfterEnable).toBe(true);
    expect(devicesEmitter.listenerCount(HOMEY_DEVICE_UPDATE_EVENT)).toBe(1);

    const attachedAfterDisable = await syncRealtimeDeviceUpdateListener({
      devicesApi,
      attached: attachedAfterEnable,
      devices: [],
      shouldTrackRealtimeDevice: () => true,
      listener,
      eventName: HOMEY_DEVICE_UPDATE_EVENT,
      logger,
    });
    expect(attachedAfterDisable).toBe(true);
    expect(devicesEmitter.listenerCount(HOMEY_DEVICE_UPDATE_EVENT)).toBe(1);

    const attachedAfterReenable = await syncRealtimeDeviceUpdateListener({
      devicesApi,
      attached: attachedAfterDisable,
      devices: [trackedDevice],
      shouldTrackRealtimeDevice: () => true,
      listener,
      eventName: HOMEY_DEVICE_UPDATE_EVENT,
      logger,
    });
    expect(attachedAfterReenable).toBe(true);
    expect(devicesEmitter.listenerCount(HOMEY_DEVICE_UPDATE_EVENT)).toBe(1);
    expect(devicesApi.connect).toHaveBeenCalledTimes(1);
  });
});
