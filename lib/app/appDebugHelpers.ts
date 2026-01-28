import type { DeviceManager } from '../core/deviceManager';
import { HomeyDeviceLike } from '../utils/types';
import { safeJsonStringify, sanitizeLogValue } from '../utils/logUtils';

export async function getHomeyDevicesForDebug(params: {
  deviceManager: DeviceManager;
  error: (msg: string, err: Error) => void;
}): Promise<HomeyDeviceLike[]> {
  const { deviceManager, error } = params;
  if (!deviceManager) return [];
  try {
    await deviceManager.init();
    return await deviceManager.getDevicesForDebug();
  } catch (err) {
    error('Failed to fetch Homey devices for debug', err as Error);
    return [];
  }
}

export async function logHomeyDeviceForDebug(params: {
  deviceId: string;
  deviceManager: DeviceManager;
  log: (msg: string, metadata?: unknown) => void;
  error: (msg: string, err: Error) => void;
}): Promise<boolean> {
  const { deviceId, deviceManager, log, error } = params;
  if (!deviceId) return false;

  const devices = await getHomeyDevicesForDebug({ deviceManager, error });
  const device = devices.find((entry) => entry.id === deviceId);
  const safeDeviceId = sanitizeLogValue(deviceId);

  if (!device) {
    log('Homey device dump: device not found', { deviceId: safeDeviceId });
    return false;
  }

  const label = device.name || deviceId;
  const safeLabel = sanitizeLogValue(label) || safeDeviceId;
  const deviceJson = safeJsonStringify(device);

  log('Homey device dump', {
    deviceId: safeDeviceId,
    label: safeLabel,
    payload: deviceJson,
  });

  return true;
}
