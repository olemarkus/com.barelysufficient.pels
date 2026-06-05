/**
 * Observer-owned freshness resolution. See notes/state-management/README.md
 * ("Trust Order By Question") for the rules this enforces.
 *
 * Two distinctions matter to downstream consumers:
 *
 *  - **fresh** — a trusted observation arrived within
 *    `STALE_DEVICE_OBSERVATION_MS`.
 *  - **stale** — a trusted observation exists but has aged past the threshold.
 *    Many Homey drivers only advance per-capability `lastUpdated` on value
 *    change, so a perfectly working thermostat steady at setpoint can sit in
 *    `stale` indefinitely. Consumers that credit known load should still do
 *    so for `stale` (the device is most likely still in its last-seen state),
 *    while consumers that need a freshly confirmed value should keep gating.
 *  - **unknown** — no trusted observation has ever arrived. The previous
 *    `isDeviceObservationStale` collapsed this into "stale", which trapped
 *    snapshot-refresh loops and over-conservatively gated never-reported
 *    devices out of restore/coordination paths.
 *
 * Consumers downstream of the Observer must not re-derive freshness; they read
 * the flat enum/boolean values this module produces.
 */
import type { ObservedDeviceState } from '../../packages/contracts/src/types';

export const STALE_DEVICE_OBSERVATION_MS = 40 * 60 * 1000;

export type DeviceObservationFreshness = 'fresh' | 'stale' | 'unknown';

// The freshness timestamps this module reasons about are the observed surface of
// the device snapshot, so the input narrows to that canonical type rather than a
// hand-rolled shape (see notes/state-management/snapshot-decomposition.md).
type DeviceObservationLike = Pick<ObservedDeviceState, 'lastFreshDataMs' | 'lastLocalWriteMs'>;

export function getLatestDeviceObservationMs(device: DeviceObservationLike): number | undefined {
  if (typeof device.lastFreshDataMs === 'number' && device.lastFreshDataMs > 0) {
    return device.lastFreshDataMs;
  }
  return undefined;
}

/**
 * Producer-side tri-state resolution. Consumers should prefer this over the
 * boolean predicates when their behavior differs between "never observed" and
 * "observed once, now aged out". `isDeviceObservationStale` collapses `unknown`
 * into `stale` for backward-compat consumers that treat both conservatively.
 */
export function getDeviceObservationFreshness(
  device: DeviceObservationLike,
  nowMs: number = Date.now(),
): DeviceObservationFreshness {
  const latestObservationMs = getLatestDeviceObservationMs(device);
  if (latestObservationMs === undefined) return 'unknown';
  return (nowMs - latestObservationMs) >= STALE_DEVICE_OBSERVATION_MS ? 'stale' : 'fresh';
}

export function isDeviceObservationStale(
  device: DeviceObservationLike,
  nowMs: number = Date.now(),
): boolean {
  return getDeviceObservationFreshness(device, nowMs) !== 'fresh';
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
  return getDeviceObservationFreshness(device, nowMs) === 'stale';
}
