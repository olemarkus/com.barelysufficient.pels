import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import {
  getTemperatureTargetCapability, normalizeTargetCapabilityValue,
} from '../../../packages/shared-domain/src/targetCapabilities';
export { buildBinaryCommandConfirmationSnapshot } from './binaryCommandConfirmationSnapshot';

export function resolveTemperatureTarget(
    snapshot: TransportDeviceSnapshot[],
    deviceId: string,
    desired: number,
): number {
    const device = snapshot.find((entry) => entry.id === deviceId);
    const target = device && getTemperatureTargetCapability(device.targets);
    if (!target) throw new Error(`No temperature target binding for device ${deviceId}`);
    return normalizeTargetCapabilityValue({ target, value: desired });
}
