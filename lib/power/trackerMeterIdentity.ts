/**
 * A meter area's tracker is BOUND to its configured meter: the identity is
 * stamped on every persisted state, and history recorded against another
 * meter keeps its accounting but loses its freshness latch when the area is
 * (re)bound. This module owns that policy over the tracker store — preparing
 * a stored tracker for the meter a new runtime will consume, and the
 * freshness reset a homes-config commit performs first, with the rollback
 * that commit needs when its own write does not land.
 *
 * Everything here reads and writes the store only; an area that has no rows
 * yet carries its identity in memory until its first ordinary persist.
 */
import type { PowerTrackerMeterIdentity, PowerTrackerState } from './trackerTypes';
import type { HomeId } from '../utils/settingsKeys';
import type { TrackerStore } from './trackerStore';

export const powerTrackerMeterIdentityMatches = (
  actual: PowerTrackerMeterIdentity | undefined,
  expected: PowerTrackerMeterIdentity,
): boolean => (
  actual?.powerSource === expected.powerSource
  && actual.meterDeviceId === expected.meterDeviceId
);

const withoutFreshness = (
  state: PowerTrackerState,
  meterIdentity?: PowerTrackerMeterIdentity,
): PowerTrackerState => ({
  ...state,
  ...(meterIdentity === undefined ? {} : { meterIdentity }),
  lastTimestamp: undefined,
  lastPowerW: undefined,
});

export type PreparedTrackerState =
  | { ok: true; state: PowerTrackerState }
  | { ok: false };

/**
 * Resolve one area's tracker against the meter identity a new runtime will
 * consume. A matching tracker retains its freshness; a mismatched one adopts
 * the expected identity while clearing only its freshness latch, persisted
 * before the runtime is built so a restart cannot rehydrate the old latch.
 */
export const prepareTrackerForMeter = (
  store: TrackerStore,
  homeId: HomeId,
  meterIdentity: PowerTrackerMeterIdentity,
  onFailure: (error: Error) => void,
): PreparedTrackerState => {
  let stored: PowerTrackerState | null;
  try {
    stored = store.load(homeId);
  } catch (error) {
    onFailure(new Error(`failed to read the tracker store for ${homeId}`, { cause: error }));
    return { ok: false };
  }
  if (stored === null) return { ok: true, state: { meterIdentity } };
  if (powerTrackerMeterIdentityMatches(stored.meterIdentity, meterIdentity)) return { ok: true, state: stored };
  const state = withoutFreshness(stored, meterIdentity);
  try {
    store.save(homeId, state);
    return { ok: true, state };
  } catch (error) {
    onFailure(new Error(`failed to persist the meter identity for ${homeId}`, { cause: error }));
    return { ok: false };
  }
};

export type TrackerFreshnessFailure = {
  phase: 'tracker_read' | 'tracker_reset' | 'tracker_restore';
  homeId: HomeId;
  error: Error;
};

export type TrackerFreshnessReset =
  | { state: 'prepared'; rollback: () => boolean }
  | { state: 'unavailable' };

/**
 * Clear one home's freshness latch ahead of a homes-config commit, keeping a
 * typed rollback for the case where that commit provably did not land. A
 * store transaction that throws has rolled itself back, so a failed reset
 * needs no compensation of its own.
 */
export const beginTrackerFreshnessReset = (
  store: TrackerStore,
  homeId: HomeId,
  meterIdentity: PowerTrackerMeterIdentity | undefined,
  onFailure: (failure: TrackerFreshnessFailure) => void,
): TrackerFreshnessReset => {
  let before: PowerTrackerState | null;
  try {
    before = store.load(homeId);
  } catch (error) {
    onFailure({
      phase: 'tracker_read',
      homeId,
      error: new Error(`failed to read the tracker store for ${homeId}`, { cause: error }),
    });
    return { state: 'unavailable' };
  }
  if (before === null) return { state: 'prepared', rollback: () => true };
  const reset = withoutFreshness(before, meterIdentity);
  try {
    store.save(homeId, reset);
  } catch (error) {
    onFailure({
      phase: 'tracker_reset',
      homeId,
      error: new Error(`failed to persist the freshness reset for ${homeId}`, { cause: error }),
    });
    return { state: 'unavailable' };
  }
  return {
    state: 'prepared',
    rollback: () => {
      try {
        store.save(homeId, before);
        return true;
      } catch (error) {
        onFailure({
          phase: 'tracker_restore',
          homeId,
          error: new Error(`failed to restore the tracker for ${homeId}`, { cause: error }),
        });
        return false;
      }
    },
  };
};
