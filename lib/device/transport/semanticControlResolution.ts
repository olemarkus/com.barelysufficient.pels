import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { normalizeTargetCapabilityValue } from '../../utils/targetCapabilities';
export { buildBinaryCommandConfirmationSnapshot } from './binaryCommandConfirmationSnapshot';

export function resolveTemperatureTarget(
    snapshot: TransportDeviceSnapshot[],
    deviceId: string,
    desired: number,
): number {
    const target = snapshot.find((entry) => entry.id === deviceId)
        ?.targets.find((entry) => entry.id.startsWith('target_temperature'));
    if (!target) throw new Error(`No temperature target binding for device ${deviceId}`);
    return normalizeTargetCapabilityValue({ target, value: desired });
}
