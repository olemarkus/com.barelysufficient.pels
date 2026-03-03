import type Homey from 'homey';
import type { DeviceManager } from '../core/deviceManager';
import type { TargetDeviceSnapshot } from '../utils/types';

export const restoreCachedTargetSnapshotForApp = (params: {
  homey: Homey.App['homey'];
  deviceManager: DeviceManager;
  logDebug: (...args: unknown[]) => void;
  filterEntry?: (entry: TargetDeviceSnapshot) => boolean;
}): boolean => {
  const {
    homey,
    deviceManager,
    logDebug,
    filterEntry,
  } = params;
  const cached = homey.settings.get('target_devices_snapshot') as unknown;
  if (!Array.isArray(cached) || cached.length === 0) return false;
  const isValidSnapshot = cached.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as { id?: unknown; capabilities?: unknown };
    return typeof record.id === 'string' && Array.isArray(record.capabilities);
  });
  if (!isValidSnapshot) return false;
  const filtered = (cached as TargetDeviceSnapshot[]).filter((entry) => (
    typeof filterEntry === 'function' ? filterEntry(entry) : true
  ));
  if (filtered.length === 0) return false;
  deviceManager.setSnapshot(filtered);
  logDebug(`Loaded cached target snapshot (${filtered.length} devices)`);
  return true;
};
