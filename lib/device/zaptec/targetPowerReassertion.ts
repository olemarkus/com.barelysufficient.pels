import type { TargetPowerReassertionPreparation } from '../deviceAdapter';
import { toCapabilityTimestampMs } from '../managerControl';
import type { HomeyDeviceLike } from '../../utils/types';
import { zaptecInstallationOf } from './session';

/** Zaptec caches the amp target until Homey releases its power control. */
export function prepareZaptecTargetPowerReassertion(
  device: HomeyDeviceLike, inventory: readonly HomeyDeviceLike[],
): TargetPowerReassertionPreparation {
  const accepted = inventory.find((entry) => entry.id === device.id);
  const capabilities = accepted?.capabilities ?? device.capabilities;
  const stopCapabilityId = resolveStopCapabilityId(capabilities);
  const stop: TargetPowerReassertionPreparation = { kind: 'stop', write: {
    capabilityId: stopCapabilityId, value: stopCapabilityId === 'target_power' ? 0 : false,
  } };
  if (!accepted) return stop;
  const mode = accepted.capabilitiesObj.target_power_mode;
  // A reset restores pre-Homey installation current. A sibling, even unmanaged,
  // may be charging on it, so only an exclusive installation can be reset.
  // Without a reset there is nothing to reclaim: the watt target is written as
  // before, so a stop could never be followed by a resume.
  if (!hasExclusiveInstallation(accepted, inventory)
    || !capabilities.includes('target_power_mode') || mode?.setable !== true) return { kind: 'ready', resetWrites: [] };
  // Only Homey control caches a current. A mode the app never set (null on a
  // charger paired or updated under 1.12) or `device` has nothing to reset.
  if (mode.value !== 'homey') return { kind: 'ready', resetWrites: [] };
  if (isStopped(accepted, stop.write)) {
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

/**
 * The charger's own reports show it stopped and drawing nothing. Zero power is
 * the device's independent evidence: a PELS pause can change the stop
 * capability at once, but the power reading only follows the charger. A charger
 * already stopped before the reclaim began proves it with its existing reports,
 * because Homey republishes nothing for an unchanged value.
 */
function isStopped(device: HomeyDeviceLike, stopWrite: { capabilityId: string; value: unknown }): boolean {
  const stopped = device.capabilitiesObj[stopWrite.capabilityId];
  const power = device.capabilitiesObj.measure_power;
  return stopped !== undefined && Object.is(stopped.value, stopWrite.value) && power?.value === 0
    && toCapabilityTimestampMs(stopped.lastUpdated) !== undefined
    && toCapabilityTimestampMs(power.lastUpdated) !== undefined;
}
