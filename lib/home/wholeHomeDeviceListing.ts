/**
 * Which devices the settings UI's whole-home device list offers. Every load
 * is listed. A solar device is never offered as a device. A home battery is
 * listed only as a Main-home member: PELS controls a home battery only in the
 * Main home, so a battery a meter area owns is that area's telemetry, never a
 * managed device the owner could switch.
 *
 * Unknown membership lists no battery: the port not wired yet (the boot
 * window), ownership not settled, or an ownership change not yet committed.
 * Membership then serves a fallback or the previous owner, and a battery shown
 * as Main's on that guess could be switched as one.
 */
import { isHomeBatteryClassKey } from '../../packages/shared-domain/src/batteryOrSolarRole';
import { MAIN_HOME_ID } from './homeConfig';
import type { HomeMembershipPort } from './membership';

type ListedDeviceCandidate = { id: string; isBatteryOrSolar: boolean; deviceClass?: string };

const isSettledMainHomeMember = (membership: HomeMembershipPort | undefined, deviceId: string): boolean => (
  membership !== undefined
  && membership.isOwnershipReady()
  && !membership.hasPendingOwnershipGeneration()
  && membership.getHomeIdForDevice(deviceId) === MAIN_HOME_ID
);

export function isListedWholeHomeDevice(
  membership: HomeMembershipPort | undefined,
  device: ListedDeviceCandidate,
): boolean {
  if (!device.isBatteryOrSolar) return true;
  return isHomeBatteryClassKey(device.deviceClass) && isSettledMainHomeMember(membership, device.id);
}
