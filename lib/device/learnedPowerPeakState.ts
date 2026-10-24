import {
  adoptPersistedLearnedPeaks,
  pruneExpiredLearnedPeaks,
  type LearnedPeaksByDeviceId,
} from './devicePowerPeak';
import { normalizeError } from '../utils/errorUtils';
import type { Logger as PinoLogger } from '../logging/logger';
import type { TimerRegistry } from '../utils/timerRegistry';
import { scheduleLegacyImportRetry } from '../store/legacySettingsImport';
import type { LearnedPowerPeakStore } from './learnedPowerPeakStore';

/** Registry name for the owed legacy import's retry. */
const LEGACY_IMPORT_RETRY_TIMER = 'learnedPeakLegacyImportRetry';

export type LearnedPowerPeakState = {
  /** Restore the learned peaks at boot. */
  load: () => void;
  /** Write the learned peaks through to the store. */
  persist: () => void;
};

/**
 * Boot-load and write-through for the learned measured peaks.
 *
 * The store itself is a plain record owned by `PelsApp` and shared with
 * `DeviceTransport`, which mutates it on the ingest path; this owns only when it
 * is read from and written to the userdata store. The max/expiry policy lives in
 * `lib/device/devicePowerPeak.ts`.
 *
 * Every change is written as it happens: the store diffs one row per device, so
 * a write costs what changed and nothing is buffered for a restart to lose.
 *
 * A legacy settings import the boot could not finish is retried on every write
 * and once a minute (`LearnedPowerPeakStore.settleLegacyImport`): a home whose
 * running devices sit steady at their peaks learns nothing new for hours, and
 * until the import lands the imported peaks of the devices that are off are
 * missing from the expected-power ladder.
 */
export function createLearnedPowerPeakState(params: {
  getStore: () => LearnedPowerPeakStore;
  getPeaks: () => LearnedPeaksByDeviceId;
  timers: TimerRegistry;
  getStructuredLogger: () => PinoLogger;
}): LearnedPowerPeakState {
  const { getStore, getPeaks, timers, getStructuredLogger } = params;
  /**
   * False until a read has told us what is stored. A write before it would make
   * the store hold exactly the in-memory record, deleting every row this run has
   * not seen draw power yet — on a cold boot, all of them.
   */
  let read = false;
  /** True until the store says the legacy import has settled. */
  let importOwed = true;
  /** One error line per run: an unopened store fails every read the same way. */
  let loadFailureLogged = false;

  /* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
  const readIntoStore = (): boolean => {
    let persisted: LearnedPeaksByDeviceId;
    try {
      persisted = getStore().read();
    } catch (error) {
      if (!loadFailureLogged) {
        loadFailureLogged = true;
        getStructuredLogger().error({ event: 'learned_peaks_load_failed', err: normalizeError(error) });
      }
      return false;
    }
    const peaks = getPeaks();
    // Merged rather than replaced: a failed boot read is retried from the first
    // write, and a late legacy import is read from the minute it lands, by which
    // point the ingest path holds peaks of its own.
    const adopted = adoptPersistedLearnedPeaks(persisted, peaks);
    // In-place: the record is shared by reference with `DeviceTransport`, which
    // took it at construction. Replacing it would leave the transport writing
    // into the old object and this one reading an orphan.
    for (const key of Object.keys(peaks)) delete peaks[key];
    Object.assign(peaks, adopted);
    read = true;
    return true;
  };
  /* eslint-enable functional/immutable-data */

  /** One more attempt at an owed legacy import; a store that is not open is the read's to say. */
  const settleImport = (): void => {
    if (!importOwed) return;
    let store: LearnedPowerPeakStore;
    try {
      store = getStore();
    } catch {
      return;
    }
    if (store.settleLegacyImport() === 'pending') {
      scheduleLegacyImportRetry(timers, LEGACY_IMPORT_RETRY_TIMER, retryImport);
      return;
    }
    importOwed = false;
    // The import may have written peaks this record has not seen, and a write
    // makes the store hold exactly the record: read them in before the next one.
    read = false;
  };

  const retryImport = (): void => {
    settleImport();
    if (!importOwed && !read) readIntoStore();
  };

  return {
    /** The legacy import is settled first, so the read sees what it brought. */
    load: () => {
      settleImport();
      readIntoStore();
    },

    /**
     * Prunes entries whose window has closed on the way out, so the store does
     * not accumulate devices that left the home years ago.
     */
    persist: () => {
      settleImport();
      if (!read && !readIntoStore()) return;
      try {
        getStore().write(pruneExpiredLearnedPeaks(getPeaks(), Date.now()));
      } catch (error) {
        // The record stays in memory, and the next write carries it too: the diff
        // base is what the database last committed.
        getStructuredLogger().error({ event: 'learned_peaks_write_failed', err: normalizeError(error) });
      }
    },
  };
}
