import type Homey from 'homey';
import { readPersistedHomeTracker } from '../lib/power/persistedHomeTracker';
import { POWER_TRACKER_STATE } from '../lib/utils/settingsKeys';

/**
 * Whether a whole-home reading was admitted at or after `sinceMs`: the
 * in-memory tracker for readings since this boot, the tracker's own
 * classified persisted read for readings before it. A suspect persisted read
 * is `unknown` — a transient the adoption must not read as "never".
 */
export const readingsAdmittedSince = (
  settings: Homey.App['homey']['settings'],
  inMemoryLastSampleMs: number | undefined,
  sinceMs: number,
): 'admitted' | 'none' | 'unknown' => {
  if (inMemoryLastSampleMs !== undefined && inMemoryLastSampleMs >= sinceMs) return 'admitted';
  const persisted = readPersistedHomeTracker(settings, POWER_TRACKER_STATE);
  if (persisted.state === 'suspect') return 'unknown';
  if (persisted.state === 'unwritten') return 'none';
  const last = persisted.value.lastTimestamp;
  return last !== undefined && last >= sinceMs ? 'admitted' : 'none';
};
