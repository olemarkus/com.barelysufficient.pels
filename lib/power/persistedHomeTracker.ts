/**
 * Reading, classifying and freshness-resetting one home's PERSISTED power
 * tracker.
 *
 * The blob is the power layer's own state, so its classification lives here
 * rather than beside the wiring that happens to call it: an unwritten key, a
 * key the list vouches for that still reads empty, and a malformed value are
 * three different answers, and only this module is allowed to decide which one
 * a raw read is. Callers receive `unwritten | present | suspect` and never see
 * the SDK's absence shapes.
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

export type TrackerSettingsPort = {
  get(key: string): unknown;
  getKeys(): string[];
  set(key: string, value: unknown): void;
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

const writeFreshnessReset = (params: {
  settings: TrackerSettingsPort;
  trackerKey: string;
  state: PowerTrackerState;
  meterIdentity?: PowerTrackerMeterIdentity;
  onFailure: TrackerSafetyFailure;
}): boolean => {
  const { settings, trackerKey, state, meterIdentity, onFailure } = params;
  try {
    settings.set(trackerKey, buildFreshnessReset(state, meterIdentity));
    return true;
  } catch (error) {
    onFailure(new Error(`failed to persist tracker freshness reset for ${trackerKey}`, {
      cause: error,
    }));
    return false;
  }
};

const restoreTrackerState = (params: {
  settings: TrackerSettingsPort;
  trackerKey: string;
  state: PowerTrackerState;
  onFailure: TrackerSafetyFailure;
}): boolean => {
  const {
    settings, trackerKey, state, onFailure,
  } = params;
  try {
    settings.set(trackerKey, state);
    return true;
  } catch (error) {
    onFailure(new Error(`failed to restore tracker state for ${trackerKey}`, {
      cause: error,
    }));
    return false;
  }
};

export type PreparedHomeTrackerState =
  | { ok: true; state: PowerTrackerState }
  | { ok: false };

/**
 * Resolve one sub-home tracker against the meter identity a new runtime will
 * consume. A matching tracker retains its freshness; a legacy/mismatched one
 * atomically adopts the expected identity while clearing only its freshness
 * latch. Suspect reads are never replaced with `{}`.
 */
export function preparePersistedHomeTrackerForMeter(params: {
  settings: TrackerSettingsPort;
  homeId: HomeId;
  meterIdentity: PowerTrackerMeterIdentity;
  onFailure: TrackerSafetyFailure;
}): PreparedHomeTrackerState {
  const {
    settings, homeId, meterIdentity, onFailure,
  } = params;
  const trackerKey = homeScopedSettingsKey(POWER_TRACKER_STATE, homeId);
  const read = readPersistedHomeTracker(settings, trackerKey);
  if (read.state === 'suspect') {
    onFailure(new Error(`tracker state is unavailable for ${trackerKey}`));
    return { ok: false };
  }
  if (read.state === 'unwritten') {
    // No durable freshness exists to clear. Carry identity in memory; the
    // first ordinary tracker persist will establish it atomically with state.
    return { ok: true, state: { meterIdentity } };
  }
  if (powerTrackerMeterIdentityMatches(read.value.meterIdentity, meterIdentity)) {
    return { ok: true, state: read.value };
  }
  const state = buildFreshnessReset(read.value, meterIdentity);
  try {
    settings.set(trackerKey, state);
    return { ok: true, state };
  } catch (error) {
    onFailure(new Error(`failed to persist meter identity for ${trackerKey}`, {
      cause: error,
    }));
    return { ok: false };
  }
}

export function resetPersistedHomeTrackerFreshnessInSettings(params: {
  settings: TrackerSettingsPort;
  homeId: HomeId;
  meterIdentity?: PowerTrackerMeterIdentity;
  onFailure: TrackerSafetyFailure;
}): boolean {
  const {
    settings, homeId, meterIdentity, onFailure,
  } = params;
  return beginPersistedHomeTrackerFreshnessResetInSettings({
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
export function beginPersistedHomeTrackerFreshnessResetInSettings(params: {
  settings: TrackerSettingsPort;
  homeId: HomeId;
  meterIdentity?: PowerTrackerMeterIdentity;
  onFailure: (failure: PersistedHomeTrackerFreshnessFailure) => void;
}): PersistedHomeTrackerFreshnessReset {
  const {
    settings, homeId, meterIdentity, onFailure,
  } = params;
  const trackerKey = homeScopedSettingsKey(POWER_TRACKER_STATE, homeId);
  const read = readPersistedHomeTracker(settings, trackerKey);
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
  const reset = writeFreshnessReset({
    settings,
    trackerKey,
    state: read.value,
    meterIdentity,
    onFailure: (error) => onFailure({
      phase: 'tracker_reset',
      settingKey: trackerKey,
      error,
    }),
  });
  if (!reset) {
    // A throwing SDK write has uncertain commit semantics. Compensate with the
    // typed pre-reset state; even when that restore also fails, the caller
    // remains unavailable and never commits the accompanying config.
    restoreTrackerState({
      settings,
      trackerKey,
      state: read.value,
      onFailure: (error) => onFailure({
        phase: 'tracker_restore',
        settingKey: trackerKey,
        error,
      }),
    });
    return { state: 'unavailable' };
  }
  return {
    state: 'prepared',
    rollback: () => restoreTrackerState({
      settings,
      trackerKey,
      state: read.value,
      onFailure: (error) => onFailure({
        phase: 'tracker_restore',
        settingKey: trackerKey,
        error,
      }),
    }),
  };
}
