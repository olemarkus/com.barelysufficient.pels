import type { TrackerStore } from './trackerStore';
import { MAIN_HOME_ID } from '../utils/settingsKeys';

/**
 * Whether a whole-home reading was admitted at or after `sinceMs`: the
 * in-memory tracker for readings since this boot, the stored tracker for
 * readings before it. A store that cannot be read is `unknown`, a transient
 * the sole-meter adoption must not read as "never". The power layer owns
 * this classification; the wiring only connects it to the adoption.
 */
export const readingsAdmittedSince = (
  trackerStore: TrackerStore,
  inMemoryLastSampleMs: number | undefined,
  sinceMs: number,
): 'admitted' | 'none' | 'unknown' => {
  if (inMemoryLastSampleMs !== undefined && inMemoryLastSampleMs >= sinceMs) return 'admitted';
  let stored;
  try {
    stored = trackerStore.load(MAIN_HOME_ID);
  } catch {
    return 'unknown';
  }
  if (stored === null) return 'none';
  const last = stored.lastTimestamp;
  return last !== undefined && last >= sinceMs ? 'admitted' : 'none';
};
