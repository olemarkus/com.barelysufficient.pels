import type { DeviceDescriptorRead, ProjectedObservedDeviceState } from './types.js';

/** Local join for a consumer that needs both inventory metadata and observation. */
export type DeviceSurfaces = DeviceDescriptorRead & ProjectedObservedDeviceState;
