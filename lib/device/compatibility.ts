import type { TargetPowerSteppedLoadConfig } from '../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../utils/types';
import { normalizeTargetPowerSteppedLoadConfig } from '../utils/targetPowerConfig';

export function applyDeviceCompatibilityMetadata(device: HomeyDeviceLike): HomeyDeviceLike {
  const { settings } = device;
  const ownerUri = normalizeString(settings.pelsCompatibilityOwnerUri);
  const driverId = normalizeString(settings.pelsCompatibilityDriverId);
  if (!ownerUri && !driverId) return device;

  return {
    ...device,
    ...(ownerUri ? { ownerUri } : {}),
    ...(driverId ? { driverId, realDriverId: device.realDriverId ?? device.driverId } : {}),
  };
}

export function resolveDeviceCompatibilityTargetPowerConfig(
  device: HomeyDeviceLike,
): TargetPowerSteppedLoadConfig | undefined {
  const { settings } = device;
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

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
