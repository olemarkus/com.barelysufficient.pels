import type {
  SettingsUiObjectiveProfile,
  SettingsUiPowerTracker,
} from '../../packages/contracts/src/powerTrackerTypes';
import type { SettingsUiCapacityPeak, SettingsUiPowerReadings } from '../../packages/contracts/src/settingsUiApi';
import { hasPowerMeasurement, resolveDisplayedPowerUpdateMs } from './lastTotalPower';
import type { PowerTrackerState } from './trackerTypes';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Hours of the split and per-device hourly families the WebView receives.
 * The day view shows today or yesterday (up to 49 local hours back across a
 * DST change); a smart task's deadline is at most 36 h out
 * (`MAX_DEADLINE_HORIZON_MS`), and its page is still read for a while after.
 */
export const SETTINGS_UI_RECENT_HOURS = 72;

export const projectCapacityPeakForUi = (peakKw: number | null): SettingsUiCapacityPeak => (
  peakKw === null ? { state: 'no_completed_quarter' } : { state: 'recorded', peakKw }
);

// Local accumulators: this runs on every WebView read of the power payload,
// so the cut families are built in place, not through entries/fromEntries pairs.
/* eslint-disable functional/immutable-data -- see above */
/**
 * The entries of an hourly family whose UTC-hour key is at or after the
 * cutoff. The keys are ISO strings of one format and length, so they order
 * as strings and no key is parsed.
 */
const recentHours = (
  family: Record<string, number> | undefined,
  cutoffIso: string,
): Record<string, number> | undefined => {
  if (family === undefined) return undefined;
  const recent: Record<string, number> = {};
  for (const key of Object.keys(family)) {
    if (key >= cutoffIso) recent[key] = family[key] as number;
  }
  return recent;
};

const recentDeviceHours = (
  families: Record<string, Record<string, number>> | undefined,
  cutoffIso: string,
): Record<string, Record<string, number>> | undefined => {
  if (families === undefined) return undefined;
  const recent: Record<string, Record<string, number>> = {};
  for (const deviceId of Object.keys(families)) {
    const hours = recentHours(families[deviceId], cutoffIso);
    if (hours !== undefined) recent[deviceId] = hours;
  }
  return recent;
};

const projectObjectiveProfiles = (
  profiles: PowerTrackerState['objectiveProfiles'],
): Record<string, SettingsUiObjectiveProfile> | undefined => {
  if (profiles === undefined) return undefined;
  const projected: Record<string, SettingsUiObjectiveProfile> = {};
  for (const deviceId of Object.keys(profiles)) {
    const stat = profiles[deviceId]?.kwhPerUnit;
    projected[deviceId] = stat === undefined
      ? {}
      : { kwhPerUnit: { mean: stat.mean, confidence: stat.confidence } };
  }
  return projected;
};
/* eslint-enable functional/immutable-data */

/**
 * The usage history the settings WebView draws, built field by field from the
 * tracker. See `SettingsUiPowerTracker` for which families the page reads and
 * over which window; `nowMs` anchors the recent-hours cut. The families that
 * are passed whole are passed by reference, since the payload is serialised
 * as soon as it is built.
 */
export const projectPowerTrackerForUi = (tracker: PowerTrackerState, nowMs: number): SettingsUiPowerTracker => {
  const cutoffIso = new Date(nowMs - SETTINGS_UI_RECENT_HOURS * HOUR_MS).toISOString();
  return {
    lastPowerW: tracker.lastPowerW,
    lastGenerationW: tracker.lastGenerationW,
    lastTimestamp: tracker.lastTimestamp,
    buckets: tracker.buckets,
    hourlySampleCounts: tracker.hourlySampleCounts,
    unreliablePeriods: tracker.unreliablePeriods,
    controlledBuckets: recentHours(tracker.controlledBuckets, cutoffIso),
    uncontrolledBuckets: recentHours(tracker.uncontrolledBuckets, cutoffIso),
    dailyTotals: tracker.dailyTotals,
    hourlyAverages: tracker.hourlyAverages,
    generationBuckets: tracker.generationBuckets,
    exportBuckets: tracker.exportBuckets,
    exportDailyTotals: tracker.exportDailyTotals,
    deviceBuckets: recentDeviceHours(tracker.deviceBuckets, cutoffIso),
    objectiveProfiles: projectObjectiveProfiles(tracker.objectiveProfiles),
  };
};

/**
 * The readings fact, for the pull and the push alike: a measurement is
 * latched (`hasPowerMeasurement`), and its stamp is the displayed
 * power-update stamp (`resolveDisplayedPowerUpdateMs`). A meter whose driver
 * keeps repeating one value while the home's metered load moves therefore
 * reads as having sent nothing new. The UI never re-derives this from
 * tracker fields or persisted-blob fallbacks.
 */
export const resolvePowerReadingsForUi = (tracker: PowerTrackerState): SettingsUiPowerReadings => {
  const lastPowerUpdateMs = resolveDisplayedPowerUpdateMs(tracker);
  return hasPowerMeasurement(tracker) && lastPowerUpdateMs !== undefined
    ? { state: 'received', lastPowerUpdateMs }
    : { state: 'never' };
};
