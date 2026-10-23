import {
  adoptPersistedLearnedPeaks,
  pruneExpiredLearnedPeaks,
  type LearnedPeaksByDeviceId,
} from './devicePowerPeak';
import { normalizeError } from '../utils/errorUtils';
import type { Logger as PinoLogger } from '../logging/logger';
import type { LearnedPowerPeakRepository } from './learnedPowerPeakStore';

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
 */
export function createLearnedPowerPeakState(params: {
  getRepository: () => LearnedPowerPeakRepository;
  getPeaks: () => LearnedPeaksByDeviceId;
  getStructuredLogger: () => PinoLogger;
}): LearnedPowerPeakState {
  const { getRepository, getPeaks, getStructuredLogger } = params;
  /**
   * False until a read has told us what is stored. A write before it would make
   * the store hold exactly the in-memory record, deleting every row this run has
   * not seen draw power yet — on a cold boot, all of them.
   */
  let read = false;
  /** One error line per run: an unopened store fails every read the same way. */
  let loadFailureLogged = false;

  /* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
  const readIntoStore = (): boolean => {
    let persisted: LearnedPeaksByDeviceId;
    try {
      persisted = getRepository().read();
    } catch (error) {
      if (!loadFailureLogged) {
        loadFailureLogged = true;
        getStructuredLogger().error({ event: 'learned_peaks_load_failed', err: normalizeError(error) });
      }
      return false;
    }
    const peaks = getPeaks();
    // Merged rather than replaced: a failed boot read is retried from the first
    // write, by which point the ingest path holds peaks of its own.
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

  return {
    load: () => { readIntoStore(); },

    /**
     * Prunes entries whose window has closed on the way out, so the store does
     * not accumulate devices that left the home years ago.
     */
    persist: () => {
      if (!read && !readIntoStore()) return;
      try {
        getRepository().write(pruneExpiredLearnedPeaks(getPeaks(), Date.now()));
      } catch (error) {
        // The record stays in memory, and the next write carries it too: the diff
        // base is what the database last committed.
        getStructuredLogger().error({ event: 'learned_peaks_write_failed', err: normalizeError(error) });
      }
    },
  };
}
