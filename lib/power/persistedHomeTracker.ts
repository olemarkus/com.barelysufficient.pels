/**
 * Reading, classifying and freshness-resetting one home's PERSISTED power
 * tracker — in the userdata store, with the legacy `homey.settings` blob as
 * the one-time source the store is filled from.
 *
 * The legacy blob is the power layer's own state, so its classification lives
 * here rather than beside the wiring that happens to call it: an unwritten
 * key, a key the list vouches for that still reads empty, and a malformed
 * value are three different answers, and only this module is allowed to
 * decide which one a raw read is. Callers receive `unwritten | present |
 * suspect` and never see the SDK's absence shapes. That read is made only
 * while the store holds no rows for the home; once it does, settings are
 * never consulted again and the key is unset.
 *
 * The settings boundary arrives as a flat `TrackerSettingsPort`; the Homey
 * `homey.settings` object is passed in by the wiring layer.
 */
import type {
  PowerTrackerMeterIdentity,
  PowerTrackerState,
} from './trackerTypes';
import {
  isPlausiblePowerTrackerState,
  sanitizePowerTrackerSolarFields,
} from '../utils/appTypeGuards';
import {
  POWER_TRACKER_STATE,
  homeScopedSettingsKey,
  type HomeId,
} from '../utils/settingsKeys';
import type { TrackerStore } from './trackerStore';

export type TrackerSettingsPort = {
  get(key: string): unknown;
  getKeys(): string[];
  unset(key: string): void;
};

export type PersistedHomeTrackerReadResult =
  | { state: 'unwritten' }
  | { state: 'present'; value: PowerTrackerState }
  | { state: 'suspect' };

type TrackerSafetyFailure = (error: Error) => void;

export type PersistedHomeTrackerFreshnessFailure = {
  phase: 'tracker_read' | 'tracker_reset' | 'tracker_restore';
  settingKey: string;
  error: Error;
};

export type PersistedHomeTrackerFreshnessReset =
  | { state: 'prepared'; rollback: () => boolean }
  | { state: 'unavailable' };

export const readPersistedHomeTracker = (
  settings: TrackerSettingsPort,
  trackerKey: string,
): PersistedHomeTrackerReadResult => {
  try {
    const raw = settings.get(trackerKey);
    if (raw === undefined || raw === null) {
      const keys = settings.getKeys();
      if (keys.length === 0) {
        return { state: 'suspect' };
      }
      const keyExists = keys.includes(trackerKey);
      return keyExists
        ? { state: 'suspect' }
        : { state: 'unwritten' };
    }
    const sanitized = sanitizePowerTrackerSolarFields(raw);
    return isPlausiblePowerTrackerState(sanitized)
      ? { state: 'present', value: sanitized }
      : { state: 'suspect' };
  } catch {
    return { state: 'suspect' };
  }
};

/**
 * Retire the legacy key once the store holds the home's tracker. Best-effort:
 * an SDK write that throws leaves a blob behind that the next boot unsets
 * again, and nothing reads it in between.
 */
export const unsetLegacyHomeTracker = (settings: TrackerSettingsPort, trackerKey: string): void => {
  try {
    const present = settings.get(trackerKey);
    if (present !== null && present !== undefined) settings.unset(trackerKey);
  } catch {
    /* retried on the next boot */
  }
};

export const powerTrackerMeterIdentityMatches = (
  actual: PowerTrackerMeterIdentity | undefined,
  expected: PowerTrackerMeterIdentity,
): boolean => (
  actual?.powerSource === expected.powerSource
  && actual.meterDeviceId === expected.meterDeviceId
);

const buildFreshnessReset = (
  state: PowerTrackerState,
  meterIdentity?: PowerTrackerMeterIdentity,
): PowerTrackerState => ({
  ...state,
  ...(meterIdentity === undefined ? {} : { meterIdentity }),
  lastTimestamp: undefined,
  lastPowerW: undefined,
});

/**
 * The durable tracker of one home, from the store or — while the store is
 * empty for it — the legacy blob. A legacy value is imported into the store
 * and its key unset before it is returned, so every caller downstream may
 * treat the store as the truth.
 */
export type DurableHomeTrackerRead =
  | { state: 'unwritten' }
  | { state: 'present'; value: PowerTrackerState }
  | { state: 'suspect' };

export const readDurableHomeTracker = (
  store: TrackerStore,
  settings: TrackerSettingsPort,
  homeId: HomeId,
): DurableHomeTrackerRead => {
  const stored = store.load(homeId);
  const trackerKey = homeScopedSettingsKey(POWER_TRACKER_STATE, homeId);
  if (stored !== null) {
    unsetLegacyHomeTracker(settings, trackerKey);
    return { state: 'present', value: stored };
  }
  const legacy = readPersistedHomeTracker(settings, trackerKey);
  if (legacy.state !== 'present') return legacy;
  store.save(homeId, legacy.value, null);
  unsetLegacyHomeTracker(settings, trackerKey);
  return legacy;
};

/**
 * `persisted` is what the store holds for the home after preparation — the
 * diff base the controller's first save must be computed against, so a prune
 * or a dropped bucket deletes its rows instead of leaving them to resurrect on
 * the next boot. `null` when nothing durable exists yet.
 */
export type PreparedHomeTrackerState =
  | { ok: true; state: PowerTrackerState; persisted: PowerTrackerState | null }
  | { ok: false };

/**
 * Resolve one sub-home tracker against the meter identity a new runtime will
 * consume. A matching tracker retains its freshness; a legacy/mismatched one
 * atomically adopts the expected identity while clearing only its freshness
 * latch. Suspect reads are never replaced with `{}`.
 */
export function preparePersistedHomeTrackerForMeter(params: {
  store: TrackerStore;
  settings: TrackerSettingsPort;
  homeId: HomeId;
  meterIdentity: PowerTrackerMeterIdentity;
  onFailure: TrackerSafetyFailure;
}): PreparedHomeTrackerState {
  const {
    store, settings, homeId, meterIdentity, onFailure,
  } = params;
  let read: DurableHomeTrackerRead;
  try {
    read = readDurableHomeTracker(store, settings, homeId);
  } catch (error) {
    onFailure(new Error(`failed to read the tracker store for ${homeId}`, { cause: error }));
    return { ok: false };
  }
  if (read.state === 'suspect') {
    onFailure(new Error(`tracker state is unavailable for ${homeId}`));
    return { ok: false };
  }
  if (read.state === 'unwritten') {
    // No durable freshness exists to clear. Carry identity in memory; the
    // first ordinary tracker persist will establish it atomically with state.
    return { ok: true, state: { meterIdentity }, persisted: null };
  }
  if (powerTrackerMeterIdentityMatches(read.value.meterIdentity, meterIdentity)) {
    return { ok: true, state: read.value, persisted: read.value };
  }
  const state = buildFreshnessReset(read.value, meterIdentity);
  try {
    store.save(homeId, state, read.value);
    return { ok: true, state, persisted: state };
  } catch (error) {
    onFailure(new Error(`failed to persist meter identity for ${homeId}`, {
      cause: error,
    }));
    return { ok: false };
  }
}

export function resetPersistedHomeTrackerFreshness(params: {
  store: TrackerStore;
  settings: TrackerSettingsPort;
  homeId: HomeId;
  meterIdentity?: PowerTrackerMeterIdentity;
  onFailure: TrackerSafetyFailure;
}): boolean {
  const {
    store, settings, homeId, meterIdentity, onFailure,
  } = params;
  return beginPersistedHomeTrackerFreshnessReset({
    store,
    settings,
    homeId,
    meterIdentity,
    onFailure: (failure) => onFailure(failure.error),
  }).state === 'prepared';
}

/**
 * Prepare one tracker reset while retaining a typed rollback for a following
 * homes-config commit. Raw settings absence/errors are fully classified here;
 * callers receive only `prepared` or semantic `unavailable`.
 */
export function beginPersistedHomeTrackerFreshnessReset(params: {
  store: TrackerStore;
  settings: TrackerSettingsPort;
  homeId: HomeId;
  meterIdentity?: PowerTrackerMeterIdentity;
  onFailure: (failure: PersistedHomeTrackerFreshnessFailure) => void;
}): PersistedHomeTrackerFreshnessReset {
  const {
    store, settings, homeId, meterIdentity, onFailure,
  } = params;
  const trackerKey = homeScopedSettingsKey(POWER_TRACKER_STATE, homeId);
  let read: DurableHomeTrackerRead;
  try {
    read = readDurableHomeTracker(store, settings, homeId);
  } catch (error) {
    onFailure({
      phase: 'tracker_read',
      settingKey: trackerKey,
      error: new Error(`failed to read the tracker store for ${homeId}`, { cause: error }),
    });
    return { state: 'unavailable' };
  }
  if (read.state === 'suspect') {
    onFailure({
      phase: 'tracker_read',
      settingKey: trackerKey,
      error: new Error(`tracker state is unavailable for ${trackerKey}`),
    });
    return { state: 'unavailable' };
  }
  if (read.state === 'unwritten') {
    return { state: 'prepared', rollback: () => true };
  }
  const before = read.value;
  const reset = buildFreshnessReset(before, meterIdentity);
  try {
    store.save(homeId, reset, before);
  } catch (error) {
    // A store transaction that throws has rolled back: nothing to compensate.
    onFailure({
      phase: 'tracker_reset',
      settingKey: trackerKey,
      error: new Error(`failed to persist tracker freshness reset for ${homeId}`, { cause: error }),
    });
    return { state: 'unavailable' };
  }
  return {
    state: 'prepared',
    rollback: () => {
      try {
        store.save(homeId, before, reset);
        return true;
      } catch (error) {
        onFailure({
          phase: 'tracker_restore',
          settingKey: trackerKey,
          error: new Error(`failed to restore tracker state for ${homeId}`, { cause: error }),
        });
        return false;
      }
    },
  };
}
