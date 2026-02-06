import type { DeviceManager } from '../core/deviceManager';
import { HomeyDeviceLike } from '../utils/types';
import { safeJsonStringify, sanitizeLogValue } from '../utils/logUtils';

export async function getHomeyDevicesForDebug(params: {
  deviceManager: DeviceManager;
}): Promise<HomeyDeviceLike[]> {
  const { deviceManager } = params;
  if (!deviceManager) return [];
  return deviceManager.getDevicesForDebug();
}

export async function logHomeyDeviceForDebug(params: {
  deviceId: string;
  deviceManager: DeviceManager;
  log: (msg: string, metadata?: unknown) => void;
  error: (msg: string, err: Error) => void;
}): Promise<boolean> {
  const { deviceId, deviceManager, log, error } = params;
  if (!deviceId) return false;

  let devices: HomeyDeviceLike[] = [];
  try {
    devices = await getHomeyDevicesForDebug({ deviceManager });
  } catch (err) {
    error('Failed to fetch Homey devices for debug', err as Error);
    return false;
  }
  const device = devices.find((entry) => entry.id === deviceId);
  const safeDeviceId = sanitizeLogValue(deviceId);

  if (!device) {
    log('Homey device dump: device not found', { deviceId: safeDeviceId });
    return false;
  }

  const label = device.name || deviceId;
  const safeLabel = sanitizeLogValue(label) || safeDeviceId;
  // Intentionally omit `settings` to avoid leaking sensitive configuration values.
  const { settings: _settings, ...safeDevice } = device;
  const deviceJson = safeJsonStringify(safeDevice);

  log('Homey device dump', {
    deviceId: safeDeviceId,
    label: safeLabel,
    payload: deviceJson,
  });

  return true;
}
