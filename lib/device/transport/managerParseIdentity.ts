import type { HomeyDeviceLike } from '../../utils/types';
import { applyDeviceCompatibilityMetadata } from '../compatibility';
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
 * device. Callers must apply `applyDeviceDriverOverride` upstream (which itself
 * stamps `applyDeviceCompatibilityMetadata` before applying the override) so the
 * effective device is propagated through the snapshot pipeline once instead of
 * being re-applied at every layer. The single application sites are:
 *   - `DeviceTransport.refreshSnapshot` (snapshot pipeline)
 *   - `DeviceTransport.handleRealtimeDeviceUpdate` (realtime pipeline)
 *   - `DeviceTransport.parseDeviceListForTests` (test entry point)
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

/**
 * Produces the "effective" device used across the snapshot/realtime parse
 * pipeline: first stamps compatibility metadata
 * (`applyDeviceCompatibilityMetadata`), then applies the per-device driver-id
 * override resolved from `resolveDriverIdOverride` (keyed by the original device
 * id). Folded here from `DeviceTransport` so compatibility + override resolution
 * sit behind one homey-free seam.
 */
export function applyDeviceDriverOverride(
  device: HomeyDeviceLike,
  resolveDriverIdOverride: ((deviceId: string) => string | undefined) | undefined,
): HomeyDeviceLike {
  const compatibleDevice = applyDeviceCompatibilityMetadata(device);
  const driverId = normalizeDriverIdOverride(resolveDriverIdOverride?.(getDeviceId(device)));
  if (!driverId || driverId === compatibleDevice.driverId) return compatibleDevice;
  return {
    ...compatibleDevice,
    driverId,
    realDriverId: compatibleDevice.realDriverId ?? compatibleDevice.driverId,
  };
}

function normalizeDriverIdOverride(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
