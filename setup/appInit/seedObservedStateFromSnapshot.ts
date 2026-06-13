import { projectObservedState } from '../../lib/device/observedStateProjection';
import type { ObservedDeviceState, TargetDeviceSnapshot } from '../../packages/contracts/src/types';

/**
 * Project a raw cached device snapshot to the observed-state seed values for the
 * boot/hot-plug seed of the observed-state projection
 * (`ObservedDeviceStateProjection.seedMissing`).
 *
 * The observed-state projection is fed by the dispatcher PUSH (per-capability
 * deltas + full-refresh batches), so it is EMPTY for a device until that
 * device's first observation lands — the cold-start window. A reader hitting it
 * then (the settings-UI EV chip via `getObservedEvChargingState`, or
 * `toPlanDevice`'s freshness) would otherwise get generic copy / a snapshot
 * fallback for cycle 1.
 *
 * The seed source MUST be the RAW cached snapshot (`deviceManager.getSnapshot()`)
 * — NOT `latestTargetSnapshot`, which re-decorates and is O(n^2)/re-entrant-unsafe
 * per `createPlanService`. The raw snapshot physically carries the observed
 * cluster + `lastFreshDataMs`/`lastLocalWriteMs` (transport writes them), so each
 * `projectObservedState` projection is the device's real plug-state/freshness,
 * not a placeholder. `projectObservedState` is pure, so building the seed never
 * re-enters the device manager; `seedMissing` then fills only empty slots and
 * never clobbers a recorded observation (a later dispatcher event always
 * supersedes a seq-less seed).
 */
export function toObservedStateSeed(
  snapshot: TargetDeviceSnapshot[] | undefined,
): ObservedDeviceState[] {
  if (!snapshot || snapshot.length === 0) return [];
  return snapshot.map((device) => projectObservedState(device));
}
