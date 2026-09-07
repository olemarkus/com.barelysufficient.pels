/**
 * The tracker used to persist as one JSON blob under `homey.settings`
 * (`power_tracker_state`, `power_tracker_state:<homeId>`). It persists to the
 * userdata store now, and the blob is never read again — but an install that
 * upgrades still carries it, and the SDK ships the whole settings object to
 * core on every write of any key, so the dead blob keeps costing until it is
 * gone. This is the one place that names the legacy key: unset it at boot.
 *
 * No history is imported from it, by ruling: the tracker's history is
 * regenerable. The store first ships in the release that carries this file,
 * so every install upgrading from the previous release loses the day's
 * hourly buckets and the daily totals behind the budget pace — accepted, and
 * said in the release notes. Delete this module once no install older than
 * that release can still be upgraded.
 */
import { POWER_TRACKER_STATE } from '../utils/settingsKeys';

export type LegacySettingsKeys = {
  getKeys(): string[];
  unset(key: string): void;
};

const isLegacyTrackerKey = (key: string): boolean => (
  key === POWER_TRACKER_STATE || key.startsWith(`${POWER_TRACKER_STATE}:`)
);

/** Unset every legacy tracker key; answers how many went. Best-effort: a throwing SDK is retried next boot. */
export const unsetLegacyPowerTrackerKeys = (settings: LegacySettingsKeys): number => {
  let removed = 0;
  try {
    for (const key of settings.getKeys()) {
      if (!isLegacyTrackerKey(key)) continue;
      settings.unset(key);
      removed += 1;
    }
  } catch {
    /* retried on the next boot */
  }
  return removed;
};
