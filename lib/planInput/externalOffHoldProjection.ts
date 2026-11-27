import { resolveCurrentOn } from '../observer/observedState';
import type { ObservedCurrentStateInput } from '../observer/observedState';
import type { ProjectedObservedDeviceState } from '../../packages/contracts/src/types';

/** Shared planner/executor resolution for the stored "leave off" posture. */
export const resolveExternalOffHoldActive = (
  readStoredHold: () => boolean,
  device: ObservedCurrentStateInput,
): boolean => (
  device.binaryControl !== undefined
  && !resolveCurrentOn(device)
  && readStoredHold()
);

/** An absent observation preserves the executor's hold conservatively. */
export const isExternalOffHeldForObservedDevice = (
  readStoredHold: () => boolean,
  observed: ProjectedObservedDeviceState | undefined,
): boolean => observed === undefined
  ? readStoredHold()
  : resolveExternalOffHoldActive(readStoredHold, observed);
