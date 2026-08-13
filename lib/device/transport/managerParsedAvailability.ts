import type { SteppedLoadProfile } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import { getIsAvailable } from './managerHelpers';

export function resolveAvailable(
    binaryCapabilityId: TransportDeviceSnapshot['binaryCapabilityId'],
    hasTrustedControlState: boolean,
    steppedLoadProfile: SteppedLoadProfile | undefined,
    device: HomeyDeviceLike,
): boolean {
    if (
        binaryCapabilityId !== undefined
        && !hasTrustedControlState
        && steppedLoadProfile === undefined
    ) return false;
    return getIsAvailable(device);
}
