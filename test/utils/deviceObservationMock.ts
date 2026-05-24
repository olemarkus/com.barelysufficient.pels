import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

/**
 * Adds `getSnapshotByDeviceId` derived from the same backing snapshot source
 * as `getSnapshot`, so test mocks for `DeviceObservation` stay in sync with
 * the production interface without each call site having to wire both
 * accessors manually.
 *
 * Use this whenever a test builds an ad-hoc deviceManager stub. Snapshot
 * mutations made through the same backing array are visible to both
 * accessors, matching the live DeviceManager contract.
 */
export const withGetSnapshotByDeviceId = <T extends { getSnapshot: () => TargetDeviceSnapshot[] }>(
  mock: T,
): T & { getSnapshotByDeviceId: (deviceId: string) => TargetDeviceSnapshot | undefined } => ({
  ...mock,
  getSnapshotByDeviceId: (deviceId: string) => mock.getSnapshot().find((entry) => entry.id === deviceId),
});
