import type {
  AssociatedCarSnapshot,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import type { TransportControlBindingProbe } from '../../lib/device/transportDeviceSnapshot';
import type { DeviceTransport } from '../../lib/device/deviceTransport';
import { partialDouble } from '../helpers/partialDouble';

/**
 * Adds `getSnapshotByDeviceId` derived from the same backing snapshot source
 * as `getSnapshot`, plus a no-op `dispatchObservedStateForDevice`, so test mocks
 * for `DeviceObservation` / `DeviceTransport` stay in sync with the production
 * interface without each call site having to wire the accessors manually.
 *
 * `dispatchObservedStateForDevice` exists on the live transport so wiring paths
 * that mutate a snapshot in place (e.g. flow-backed freshness sync) can push the
 * change into the observer projection; a default no-op keeps ad-hoc stubs from
 * throwing on that call. A caller that wants to assert on it can pass its own.
 *
 * Use this whenever a test builds an ad-hoc deviceManager stub. Snapshot
 * mutations made through the same backing array are visible to both
 * accessors, matching the live DeviceTransport contract.
 */
export const withGetSnapshotByDeviceId = <T extends { getSnapshot: () => TargetDeviceSnapshot[] }>(
  mock: T,
): T & {
  getSnapshotByDeviceId: (deviceId: string) => (TargetDeviceSnapshot & TransportControlBindingProbe) | undefined;
  getAssociatedCar: (deviceId: string) => AssociatedCarSnapshot | undefined;
  dispatchObservedStateForDevice: (deviceId: string, capabilityId?: string) => void;
  isFlowBackedCapability: (deviceId: string, capabilityId: string) => boolean;
} => ({
  dispatchObservedStateForDevice: () => {},
  getAssociatedCar: () => undefined,
  isFlowBackedCapability: (deviceId, capabilityId) => {
    const snapshot = mock.getSnapshot().find((entry) => entry.id === deviceId) as
      | (TargetDeviceSnapshot & TransportControlBindingProbe)
      | undefined;
    return snapshot?.flowBackedCapabilityIds?.includes(capabilityId) === true;
  },
  ...mock,
  getSnapshotByDeviceId: (deviceId: string) => mock.getSnapshot().find((entry) => entry.id === deviceId) as
    | (TargetDeviceSnapshot & TransportControlBindingProbe)
    | undefined,
});

/**
 * The same enriched stub, widened to `DeviceTransport` for direct assignment to
 * `app.deviceManager`. The members provided are typechecked against the real
 * transport; the rest are absent — see `partialDouble`.
 */
export const deviceTransportDouble = <T extends { getSnapshot: () => TargetDeviceSnapshot[] }>(
  mock: T,
): DeviceTransport => partialDouble<DeviceTransport>(withGetSnapshotByDeviceId(mock));
