import { resolveCurrentOn } from '../observer/observedState';
import type { ObservedCurrentStateInput } from '../observer/observedState';
import type { ProjectedObservedDeviceState } from '../../packages/contracts/src/types';

/** Shared planner/executor resolution for the stored "leave off" posture. */
export const resolveExternalOffHoldActive = (
  isHeld: boolean,
  device: ObservedCurrentStateInput,
): boolean => (
  device.binaryControl !== undefined
  && isHeld
  && !resolveCurrentOn(device)
);

/** An absent observation preserves the executor's hold conservatively. */
export const isExternalOffHeldForObservedDevice = (
  isHeld: boolean,
  observed: ProjectedObservedDeviceState | undefined,
): boolean => observed === undefined
  ? isHeld
  : resolveExternalOffHoldActive(isHeld, observed);
