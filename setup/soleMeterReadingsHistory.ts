import type Homey from 'homey';
import { readDurableHomeTracker } from '../lib/power/persistedHomeTracker';
import type { TrackerStore } from '../lib/power/trackerStore';
import { MAIN_HOME_ID } from '../lib/utils/settingsKeys';

/**
 * Whether a whole-home reading was admitted at or after `sinceMs`: the
 * in-memory tracker for readings since this boot, the durable tracker — as the
 * power layer resolves it, store first — for readings before it. A suspect
 * durable read is `unknown`, a transient the adoption must not read as "never".
 */
export const readingsAdmittedSince = (
  trackerStore: TrackerStore,
  settings: Homey.App['homey']['settings'],
  inMemoryLastSampleMs: number | undefined,
  sinceMs: number,
): 'admitted' | 'none' | 'unknown' => {
  if (inMemoryLastSampleMs !== undefined && inMemoryLastSampleMs >= sinceMs) return 'admitted';
  let durable: ReturnType<typeof readDurableHomeTracker>;
  try {
    durable = readDurableHomeTracker(trackerStore, settings, MAIN_HOME_ID);
  } catch {
    return 'unknown';
  }
  if (durable.state === 'suspect') return 'unknown';
  if (durable.state === 'unwritten') return 'none';
  const last = durable.value.lastTimestamp;
  return last !== undefined && last >= sinceMs ? 'admitted' : 'none';
};
