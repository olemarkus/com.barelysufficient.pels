import type { HomeyDeviceLike } from '../../utils/types';
import {
  getDeviceId,
  resolveDeviceClassKey,
  resolveDeviceLabel,
} from './managerHelpers';

export type ParsedDeviceIdentity = {
  deviceId: string;
  effectiveDevice: HomeyDeviceLike;
  deviceClassKey: string;
  deviceLabel: string;
};

/**
 * Resolves identity fields (id, deviceClassKey, label) from an already-effective
 * device. Callers must apply `applyDeviceCompatibilityMetadata` and
 * `applyDeviceDriverOverride` upstream (see `DeviceManager.applyDeviceDriverOverride`)
 * so the override is propagated through the snapshot pipeline once instead of
 * being re-applied at every layer. The single application sites are:
 *   - `DeviceManager.refreshSnapshot` (snapshot pipeline)
 *   - `DeviceManager.handleRealtimeDeviceUpdate` (realtime pipeline)
 *   - `DeviceManager.parseDeviceListForTests` (test entry point)
 */
export function resolveParseDeviceIdentity(params: {
  device: HomeyDeviceLike;
}): ParsedDeviceIdentity | null {
  const { device } = params;
  const deviceId = getDeviceId(device);
  const deviceClassKey = resolveDeviceClassKey(device);
  return deviceClassKey
    ? {
      deviceId,
      effectiveDevice: device,
      deviceClassKey,
      deviceLabel: resolveDeviceLabel(device, deviceId),
    }
    : null;
}

export function applyDeviceDriverOverride(
  device: HomeyDeviceLike,
  driverIdOverride: string | undefined,
): HomeyDeviceLike {
  const driverId = normalizeDriverIdOverride(driverIdOverride);
  if (!driverId || driverId === device.driverId) return device;
  return {
    ...device,
    driverId,
    realDriverId: device.realDriverId ?? device.driverId,
  };
}

function normalizeDriverIdOverride(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
