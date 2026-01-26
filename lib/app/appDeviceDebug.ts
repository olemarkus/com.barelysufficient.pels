import type { DeviceManager } from '../core/deviceManager';
import type { HomeyDeviceLike } from '../utils/types';
import { safeJsonStringify, sanitizeLogValue } from '../utils/logUtils';

export async function getHomeyDevicesForDebug(params: {
  deviceManager?: DeviceManager;
  error: (message: string, error: Error) => void;
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
  getDevicesForDebug: () => Promise<HomeyDeviceLike[]>;
  log: (message: string, data?: Record<string, unknown>) => void;
}): Promise<boolean> {
  const { deviceId, getDevicesForDebug, log } = params;
  if (!deviceId) return false;
  const devices = await getDevicesForDebug();
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
