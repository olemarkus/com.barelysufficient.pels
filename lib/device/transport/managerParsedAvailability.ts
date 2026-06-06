import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../../utils/types';
import { getIsAvailable } from './managerHelpers';

export function resolveAvailable(
    controlCapabilityId: TargetDeviceSnapshot['controlCapabilityId'],
    hasTrustedControlState: boolean,
    steppedLoadProfile: TargetDeviceSnapshot['steppedLoadProfile'],
    device: HomeyDeviceLike,
): boolean {
    if (
        controlCapabilityId !== undefined
        && !hasTrustedControlState
        && steppedLoadProfile?.model !== 'stepped_load'
    ) return false;
    return getIsAvailable(device);
}
