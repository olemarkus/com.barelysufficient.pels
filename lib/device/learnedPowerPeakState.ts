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

/** Registry name for the minute retry of an owed legacy import or the read after it. */
const CATCH_UP_TIMER = 'learnedPeakLegacyImportRetry';

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
 * A legacy settings import the boot could not finish, and a read that failed,
 * are retried on every write and once a minute
 * (`LearnedPowerPeakStore.settleLegacyImport`): a home whose running devices
 * sit steady at their peaks learns nothing new for hours, and until the import
 * is read in the imported peaks of the devices that are off are missing from
 * the expected-power ladder.
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
  /** A change has not reached the store, because no read had yet told us what it holds. */
  let writeOwed = false;
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
    // Merged rather than replaced: a failed read is retried from the next write,
    // and the read after a legacy import also each minute until it lands, by
    // which point the ingest path holds peaks of its own.
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

  /**
   * One more attempt at an owed legacy import. `false` when the store is not
   * open (before the boot step that opens it, or after teardown closed it),
   * which arranges no retry: the next write tries again.
   */
  const settleImport = (): boolean => {
    let store: LearnedPowerPeakStore;
    try {
      store = getStore();
    } catch {
      return false;
    }
    if (importOwed && store.settleLegacyImport() === 'settled') {
      importOwed = false;
      // The import may have written peaks this record has not seen, and a
      // write makes the store hold exactly the record: read them in first.
      read = false;
    }
    return true;
  };

  const write = (): void => {
    try {
      getStore().write(pruneExpiredLearnedPeaks(getPeaks(), Date.now()));
    } catch (error) {
      // The record stays in memory, and the next write carries it too: the diff
      // base is what the database last committed.
      getStructuredLogger().error({ event: 'learned_peaks_write_failed', err: normalizeError(error) });
    }
  };

  /**
   * Settle an owed import, read in what the store holds, write a change that
   * waited for that read, and come back in a minute while the import is owed
   * or the read has not landed. The one retry for every step, so a retry
   * queued for one never stands in for another.
   */
  const catchUp = (): void => {
    const reachable = settleImport();
    if (!read) readIntoStore();
    if (read && writeOwed) {
      writeOwed = false;
      write();
    }
    if (reachable && (importOwed || !read)) scheduleLegacyImportRetry(timers, CATCH_UP_TIMER, catchUp);
  };

  return {
    /** The legacy import is settled first, so the boot read sees what it brought. */
    load: catchUp,

    /**
     * Prunes entries whose window has closed on the way out, so the store does
     * not accumulate devices that left the home years ago.
     */
    persist: () => {
      writeOwed = true;
      catchUp();
    },
  };
}
