/** Device state for Flow cards, joined with the inventory metadata they select by. */
import type {
  DeviceDescriptorRead,
  ProjectedObservedDeviceState,
} from '../../packages/contracts/src/types';

export type FlowDeviceRead = DeviceDescriptorRead & ProjectedObservedDeviceState;

export const readFlowDevices = (
  descriptors: readonly DeviceDescriptorRead[],
  getObservedRecord: (deviceId: string) => ProjectedObservedDeviceState | undefined,
): FlowDeviceRead[] => descriptors.flatMap((descriptor) => {
  const observed = getObservedRecord(descriptor.id);
  if (!observed) return [];
  const { steppedLoadProfile: _observedProfile, ...state } = observed;
  return [{ ...descriptor, ...state }];
});
