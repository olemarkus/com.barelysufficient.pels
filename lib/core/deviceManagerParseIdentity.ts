import type { HomeyDeviceLike } from '../utils/types';
import type { DeviceManagerParseProviders } from './deviceManagerParseDevice';
import {
  getDeviceId,
  resolveDeviceClassKey,
  resolveDeviceLabel,
} from './deviceManagerHelpers';
import { applyDeviceCompatibilityMetadata } from './deviceCompatibility';

export type ParsedDeviceIdentity = {
  deviceId: string;
  effectiveDevice: HomeyDeviceLike;
  deviceClassKey: string;
  deviceLabel: string;
};

export function resolveParseDeviceIdentity(params: {
  device: HomeyDeviceLike;
  providers: DeviceManagerParseProviders;
}): ParsedDeviceIdentity | null {
  const { device, providers } = params;
  const deviceId = getDeviceId(device);
  const compatibleDevice = applyDeviceCompatibilityMetadata(device);
  const effectiveDevice = applyDeviceDriverOverride(
    compatibleDevice,
    providers.getDeviceDriverIdOverride?.(deviceId),
  );
  const deviceClassKey = resolveDeviceClassKey({
    device: effectiveDevice,
    experimentalEvSupportEnabled: providers.getExperimentalEvSupportEnabled?.() === true,
  });
  return deviceClassKey
    ? {
      deviceId,
      effectiveDevice,
      deviceClassKey,
      deviceLabel: resolveDeviceLabel(effectiveDevice, deviceId),
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
