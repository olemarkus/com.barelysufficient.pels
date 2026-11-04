import type { TargetPowerReassertionPreparation } from '../deviceAdapter';
import { toCapabilityTimestampMs } from '../managerControl';
import type { HomeyDeviceLike } from '../../utils/types';
import { zaptecInstallationOf } from './session';

/** Zaptec caches the amp target until Homey releases its power control. */
export function prepareZaptecTargetPowerReassertion(
  device: HomeyDeviceLike, afterMs: number, inventory: readonly HomeyDeviceLike[],
): TargetPowerReassertionPreparation {
  const accepted = inventory.find((entry) => entry.id === device.id);
  const capabilities = accepted?.capabilities ?? device.capabilities ?? [];
  const stopCapabilityId = resolveStopCapabilityId(capabilities);
  const stop: TargetPowerReassertionPreparation = { kind: 'stop', write: {
    capabilityId: stopCapabilityId, value: stopCapabilityId === 'target_power' ? 0 : false,
  } };
  if (!accepted) return stop;
  const mode = accepted.capabilitiesObj?.target_power_mode;
  // A reset restores pre-Homey installation current. A sibling, even unmanaged,
  // may be charging on it, so only an exclusive installation can be reset.
  if (!hasExclusiveInstallation(accepted, inventory)
    || !capabilities.includes('target_power_mode') || mode?.setable !== true) return stop;
  if (mode.value === 'device') return { kind: 'ready', resetWrites: [] };
  if (mode.value === 'homey' && hasIndependentStopProof(accepted, stopCapabilityId, afterMs)) {
    return { kind: 'ready', resetWrites: [{ capabilityId: 'target_power_mode', value: 'device' }] };
  }
  return stop;
}

function resolveStopCapabilityId(capabilities: readonly string[]): string {
  if (capabilities.includes('evcharger_charging')) return 'evcharger_charging';
  if (capabilities.includes('charging_button')) return 'charging_button';
  return 'target_power';
}

function hasExclusiveInstallation(device: HomeyDeviceLike, inventory: readonly HomeyDeviceLike[]): boolean {
  const installationId = zaptecInstallationOf(device);
  return installationId !== undefined && !inventory.some((peer) => peer.id !== device.id
    && zaptecInstallationOf(peer) === installationId);
}

function hasIndependentStopProof(device: HomeyDeviceLike, stopCapabilityId: string, afterMs: number): boolean {
  const charging = device.capabilitiesObj?.[stopCapabilityId];
  const power = device.capabilitiesObj?.measure_power;
  const chargingAtMs = toCapabilityTimestampMs(charging?.lastUpdated);
  const powerAtMs = toCapabilityTimestampMs(power?.lastUpdated);
  return device.capabilities?.includes(stopCapabilityId) === true
    && device.capabilities.includes('measure_power')
    && charging?.value === false && power?.value === 0
    && chargingAtMs !== undefined && chargingAtMs > afterMs
    && powerAtMs !== undefined && powerAtMs > afterMs;
}
