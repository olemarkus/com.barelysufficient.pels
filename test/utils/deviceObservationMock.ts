import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

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
  getSnapshotByDeviceId: (deviceId: string) => TargetDeviceSnapshot | undefined;
  dispatchObservedStateForDevice: (deviceId: string, capabilityId?: string) => void;
} => ({
  dispatchObservedStateForDevice: () => {},
  ...mock,
  getSnapshotByDeviceId: (deviceId: string) => mock.getSnapshot().find((entry) => entry.id === deviceId),
});
