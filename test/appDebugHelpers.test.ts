import type { DeviceManager } from '../lib/core/deviceManager';
import type { HomeyDeviceLike } from '../lib/utils/types';
import { logHomeyDeviceForDebug } from '../lib/app/appDebugHelpers';

const buildDeviceManager = (params: {
  devices?: HomeyDeviceLike[];
  homeyApi?: unknown;
} = {}): DeviceManager => {
  const { devices = [], homeyApi = {} } = params;
  return {
    getDevicesForDebug: jest.fn().mockResolvedValue(devices),
    getHomeyApi: jest.fn().mockReturnValue(homeyApi),
  } as unknown as DeviceManager;
};

const findLogPayload = (logger: jest.Mock, message: string): unknown => {
  const call = logger.mock.calls.find(([entry]) => entry === message);
  return call ? call[1] : undefined;
};

describe('appDebugHelpers logHomeyDeviceForDebug', () => {
  it('logs list entry, getDevice detail, and settings object when APIs are available', async () => {
    const device: HomeyDeviceLike = {
      id: 'dev-1',
      name: 'Kitchen Socket',
      capabilities: ['onoff'],
      capabilitiesObj: { onoff: { value: false } },
      settings: { load: 12.5 },
      energyObj: null,
    };
    const getDevice = jest.fn().mockResolvedValue({
      id: 'dev-1',
      settings: {
        energy_value_on: 12.5,
        energy_value_off: 0,
      },
      energyObj: { W: 0 },
    });
    const getDeviceSettingsObj = jest.fn().mockResolvedValue({
      usageOn: 12.5,
      usageOff: 0,
    });
    const deviceManager = buildDeviceManager({
      devices: [device],
      homeyApi: { devices: { getDevice, getDeviceSettingsObj } },
    });
    const log = jest.fn();
    const error = jest.fn();

    const ok = await logHomeyDeviceForDebug({
      deviceId: 'dev-1',
      deviceManager,
      log,
      error,
    });

    expect(ok).toBe(true);
    expect(getDevice).toHaveBeenCalledWith({ id: 'dev-1' });
    expect(getDeviceSettingsObj).toHaveBeenCalledWith({ id: 'dev-1' });
    expect(error).not.toHaveBeenCalled();

    const dumpPayload = findLogPayload(log, 'Homey device dump') as { payload?: string } | undefined;
    expect(dumpPayload?.payload).toBeDefined();
    expect(JSON.parse(dumpPayload?.payload ?? '{}')).toHaveProperty('settings');

    const listSettingsPayload = findLogPayload(log, 'Homey device settings (from list entry)') as { payload?: string } | undefined;
    expect(listSettingsPayload?.payload).toBeDefined();
    expect(JSON.parse(listSettingsPayload?.payload ?? '{}')).toEqual({ load: 12.5 });

    const detailSettingsPayload = findLogPayload(log, 'Homey device settings (from getDevice)') as { payload?: string } | undefined;
    expect(detailSettingsPayload?.payload).toBeDefined();
    expect(JSON.parse(detailSettingsPayload?.payload ?? '{}')).toEqual({
      energy_value_on: 12.5,
      energy_value_off: 0,
    });

    const settingsPayload = findLogPayload(log, 'Homey device settings object') as { payload?: string } | undefined;
    expect(settingsPayload?.payload).toBeDefined();
    expect(JSON.parse(settingsPayload?.payload ?? '{}')).toEqual({
      usageOn: 12.5,
      usageOff: 0,
    });
  });

  it('logs settings object as unavailable when getDeviceSettingsObj is missing', async () => {
    const device: HomeyDeviceLike = {
      id: 'dev-1',
      name: 'Kitchen Socket',
      capabilities: ['onoff'],
      capabilitiesObj: { onoff: { value: false } },
      energyObj: null,
    };
    const deviceManager = buildDeviceManager({
      devices: [device],
      homeyApi: { devices: {} },
    });
    const log = jest.fn();
    const error = jest.fn();

    const ok = await logHomeyDeviceForDebug({
      deviceId: 'dev-1',
      deviceManager,
      log,
      error,
    });

    expect(ok).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(findLogPayload(log, 'Homey device detail: not available')).toEqual({
      deviceId: 'dev-1',
      label: 'Kitchen Socket',
    });
    expect(findLogPayload(log, 'Homey device settings (from getDevice): not available')).toEqual({
      deviceId: 'dev-1',
      label: 'Kitchen Socket',
    });
    expect(findLogPayload(log, 'Homey device settings object: not available')).toEqual({
      deviceId: 'dev-1',
      label: 'Kitchen Socket',
    });
  });

  it('logs settings object debug failures and continues', async () => {
    const device: HomeyDeviceLike = {
      id: 'dev-1',
      name: 'Kitchen Socket',
      capabilities: ['onoff'],
      capabilitiesObj: { onoff: { value: false } },
      energyObj: null,
    };
    const getDeviceSettingsObj = jest.fn().mockRejectedValue(new Error('boom'));
    const deviceManager = buildDeviceManager({
      devices: [device],
      homeyApi: { devices: { getDeviceSettingsObj } },
    });
    const log = jest.fn();
    const error = jest.fn();

    const ok = await logHomeyDeviceForDebug({
      deviceId: 'dev-1',
      deviceManager,
      log,
      error,
    });

    expect(ok).toBe(true);
    expect(error).toHaveBeenCalledWith('Homey device settings object debug failed', expect.any(Error));
    expect(findLogPayload(log, 'Homey device dump')).toBeDefined();
  });

  it('logs getDevice debug failures and still logs settings object', async () => {
    const device: HomeyDeviceLike = {
      id: 'dev-1',
      name: 'Kitchen Socket',
      capabilities: ['onoff'],
      capabilitiesObj: { onoff: { value: false } },
      energyObj: null,
    };
    const getDevice = jest.fn().mockRejectedValue(new Error('detail boom'));
    const getDeviceSettingsObj = jest.fn().mockResolvedValue({
      usageOn: 12.5,
      usageOff: 0,
    });
    const deviceManager = buildDeviceManager({
      devices: [device],
      homeyApi: { devices: { getDevice, getDeviceSettingsObj } },
    });
    const log = jest.fn();
    const error = jest.fn();

    const ok = await logHomeyDeviceForDebug({
      deviceId: 'dev-1',
      deviceManager,
      log,
      error,
    });

    expect(ok).toBe(true);
    expect(error).toHaveBeenCalledWith('Homey device detail debug failed', expect.any(Error));
    const settingsPayload = findLogPayload(log, 'Homey device settings object') as { payload?: string } | undefined;
    expect(settingsPayload?.payload).toBeDefined();
    expect(JSON.parse(settingsPayload?.payload ?? '{}')).toEqual({
      usageOn: 12.5,
      usageOff: 0,
    });
  });
});
