// Public entry for device-transport observation accounting. The implementation
// is split across cohesive sibling modules; this file re-exports every symbol
// that external callers consume so import paths stay stable.
export {
    createObservationState,
    type CapabilityObservationSource,
    type DeviceDebugObservedSource,
    type DeviceDebugObservedSources,
    type DeviceTransportObservationState,
} from './observationState';

export {
    getDebugObservedSources,
    recordSnapshotRefreshObservations,
    recordDeviceUpdateObservation,
} from './observationDebugSources';

export { mergeFresherCapabilityObservations } from './observationMerge';

export {
    recordLocalWriteObservation,
    recordSnapshotCapabilityObservations,
    recordCapabilityObservation,
    resolveLatestLocalWriteMs,
} from './observationRecord';
