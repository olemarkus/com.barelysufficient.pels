import type Homey from 'homey';
import type { DeviceManager } from '../core/deviceManager';
import type { TargetDeviceSnapshot } from '../utils/types';

export const restoreCachedTargetSnapshotForApp = (params: {
  homey: Homey.App['homey'];
  deviceManager: DeviceManager;
  logDebug: (...args: unknown[]) => void;
}): boolean => {
  const {
    homey,
    deviceManager,
    logDebug,
  } = params;
  const cached = homey.settings.get('target_devices_snapshot') as unknown;
  if (!Array.isArray(cached) || cached.length === 0) return false;
  const isValidSnapshot = cached.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as { id?: unknown; capabilities?: unknown };
    return typeof record.id === 'string' && Array.isArray(record.capabilities);
  });
  if (!isValidSnapshot) return false;
  deviceManager.setSnapshot(cached as TargetDeviceSnapshot[]);
  logDebug(`Loaded cached target snapshot (${cached.length} devices)`);
  return true;
};
