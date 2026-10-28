import type { DeviceOperatingPowerRange, SteppedLoadDescriptorProbe } from '../../packages/contracts/src/types';
import { getSteppedLoadLowestActiveStep } from '../../packages/shared-domain/src/deviceControlProfiles';

/** Resolve the owner's operating ceiling against the physical ladder once. */
export function resolveOperatingPowerRange(device: SteppedLoadDescriptorProbe): DeviceOperatingPowerRange {
  const ceilingW = device.targetPowerConfig?.max;
  if (ceilingW === undefined) return 'usable';
  const minimum = device.steppedLoadProfile && getSteppedLoadLowestActiveStep(device.steppedLoadProfile);
  return minimum && ceilingW < minimum.planningPowerW ? 'below_minimum' : 'usable';
}
