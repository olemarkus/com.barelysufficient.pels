/**
 * A by-id device reader over a test fixture, for doubles of the production deps
 * that take one (`AppDeviceControlHelpers.getDeviceSnapshot`).
 *
 * The list is read on every call, so a spec that mutates its fixture between
 * calls — or rebuilds it per call — behaves exactly as it did when the dep took
 * the whole list and the code under test did the `.find` itself.
 */
export const snapshotById = <T extends { id: string }>(
  read: () => readonly T[],
) => (deviceId: string): T | undefined => read().find((device) => device.id === deviceId);
