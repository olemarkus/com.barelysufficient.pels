/**
 * Observer-owned freshness resolution. See notes/state-management/README.md
 * ("Trust Order By Question") for the rules this enforces.
 *
 * A snapshot whose latest trusted observation is older than
 * STALE_DEVICE_OBSERVATION_MS — or which never had a trusted observation at all —
 * is reported as stale here. Consumers downstream of the Observer must not
 * re-derive freshness; they read the boolean (later: typed evidence) that this
 * module produces.
 */
export const STALE_DEVICE_OBSERVATION_MS = 40 * 60 * 1000;

type DeviceObservationLike = {
  lastFreshDataMs?: number;
  lastLocalWriteMs?: number;
};

export function getLatestDeviceObservationMs(device: DeviceObservationLike): number | undefined {
  if (typeof device.lastFreshDataMs === 'number' && device.lastFreshDataMs > 0) {
    return device.lastFreshDataMs;
  }
  return undefined;
}

export function isDeviceObservationStale(
  device: DeviceObservationLike,
  nowMs: number = Date.now(),
): boolean {
  const latestObservationMs = getLatestDeviceObservationMs(device);
  if (latestObservationMs === undefined) return true;
  return (nowMs - latestObservationMs) >= STALE_DEVICE_OBSERVATION_MS;
}

/**
 * Narrower predicate for the snapshot-refresh fallback: only true when a prior
 * observation exists but has aged past the threshold. A device that has never
 * produced a trusted observation returns false here, because re-fetching its
 * snapshot will not change that — it would otherwise trap the refresh loop in
 * a permanent refresh-and-log cycle.
 */
export function isDeviceObservationStaleByAge(
  device: DeviceObservationLike,
  nowMs: number = Date.now(),
): boolean {
  const latestObservationMs = getLatestDeviceObservationMs(device);
  if (latestObservationMs === undefined) return false;
  return (nowMs - latestObservationMs) >= STALE_DEVICE_OBSERVATION_MS;
}
