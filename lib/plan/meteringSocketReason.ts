import type { DeviceStatus } from '../../packages/contracts/src/deviceStatus';
import { formatDisplayDeviceName } from '../../packages/shared-domain/src/displayDeviceName';
import type { DevicePowerSetupRequirement } from '../ports/deviceConfigurationRead';

/** The metering-socket requirements, as the device owner resolves them. */
export type MeteringSocketRequirement = Exclude<DevicePowerSetupRequirement, { kind: 'homey_energy' }>;

/**
 * The Manual card line for a device whose power comes from its assigned
 * metering socket. A listed socket is named even when its Homey name is blank.
 */
export function resolveMeteringSocketReason(requirement: MeteringSocketRequirement): DeviceStatus['reason'] {
  if (requirement.kind === 'metering_socket_unavailable') {
    const text = 'Metering socket unavailable. Choose another power source under External sensors.';
    return { text, tone: 'warning' };
  }
  const name = formatDisplayDeviceName(requirement.socketName) || 'the assigned metering socket';
  return { text: `Waiting for a power reading from ${name}. Check the socket in Homey.`, tone: 'warning' };
}
