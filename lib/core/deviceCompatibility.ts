import type {
  HomeyDeviceLike,
  TargetPowerSteppedLoadConfig,
} from '../utils/types';
import { normalizeTargetPowerSteppedLoadConfig } from '../utils/targetPowerConfig';

type UnknownRecord = Record<string, unknown>;

export function applyDeviceCompatibilityMetadata(device: HomeyDeviceLike): HomeyDeviceLike {
  const settings = getSettings(device);
  const ownerUri = normalizeString(settings?.pelsCompatibilityOwnerUri);
  const driverId = normalizeString(settings?.pelsCompatibilityDriverId);
  if (!ownerUri && !driverId) return device;

  return {
    ...device,
    ...(ownerUri ? { ownerUri } : {}),
    ...(driverId ? { driverId, realDriverId: device.realDriverId ?? device.driverId } : {}),
    driver: {
      ...device.driver,
      ...(ownerUri ? { owner_uri: ownerUri } : {}),
      ...(driverId ? { id: driverId } : {}),
    },
  };
}

export function resolveDeviceCompatibilityTargetPowerConfig(
  device: HomeyDeviceLike,
): TargetPowerSteppedLoadConfig | undefined {
  const settings = getSettings(device);
  if (!settings) return undefined;
  return normalizeTargetPowerSteppedLoadConfig(settings.pelsCompatibilityTargetPower)
    ?? normalizeTargetPowerSteppedLoadConfig({
      preset: settings.pelsCompatibilityTargetPowerPreset,
      min: settings.pelsCompatibilityTargetPowerMin,
      max: settings.pelsCompatibilityTargetPowerMax,
      step: settings.pelsCompatibilityTargetPowerStep,
      excludeMin: settings.pelsCompatibilityTargetPowerExcludeMin,
      excludeMax: settings.pelsCompatibilityTargetPowerExcludeMax,
    });
}

function getSettings(device: HomeyDeviceLike): UnknownRecord | undefined {
  return device.settings && typeof device.settings === 'object'
    ? device.settings as UnknownRecord
    : undefined;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
