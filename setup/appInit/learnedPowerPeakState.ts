import {
  adoptPersistedLearnedPeaks,
  type LearnedPeaksByDeviceId,
} from '../../lib/device/devicePowerPeak';
import { normalizeError } from '../../lib/utils/errorUtils';
import type { Logger as PinoLogger } from '../../lib/logging/logger';
import type { TimerRegistry } from '../../lib/utils/timerRegistry';
import type { SettingsRepository } from '../settingsRepository';

/** Floor between learned-peak settings writes. See {@link createLearnedPowerPeakState}. */
const PEAK_PERSIST_MIN_INTERVAL_MS = 60_000;

/** Registry name for the single trailing flush. */
const PEAK_TRAILING_FLUSH_TIMER = 'learnedPeakTrailingFlush';

export type LearnedPowerPeakState = {
  /** Restore the learned peaks at boot. */
  load: () => void;
  /** Rate-limited, change-gated write of the learned peaks. */
  persist: () => void;
  /** Shutdown flush: writes a peak the rate limit is still holding. */
  flush: () => void;
};

/**
 * Boot-load and write-back for the learned measured peaks.
 *
 * The store itself is a plain record owned by `PelsApp` and shared with
 * `DeviceTransport`, which mutates it on the ingest path; this owns only when it
 * is read from and written to settings. The max/expiry policy lives in
 * `lib/device/devicePowerPeak.ts`.
 */
export function createLearnedPowerPeakState(params: {
  settingsRepository: SettingsRepository;
  getPeaks: () => LearnedPeaksByDeviceId;
  timers: TimerRegistry;
  getStructuredLogger?: () => PinoLogger | undefined;
}): LearnedPowerPeakState {
  const { settingsRepository, getPeaks, timers, getStructuredLogger } = params;
  let lastPersistMs = 0;
  let lastPersistedSignature = '';
  /**
   * True until a read has told us what is already stored. A write while this
   * stands would replace a record nobody has managed to look at — which on a
   * cold boot is the whole persisted record, because the in-memory store is
   * empty too and there is nothing for a "did it look empty?" heuristic to
   * notice. Lifted only by a resolved read.
   */
  let writeBackSuppressed = true;
  /** The in-memory record may differ from what last reached settings. */
  let dirty = false;
  let loadUnavailableWarned = false;

  /**
   * Read settings into the shared store. Answers whether the read RESOLVED —
   * resolved-and-empty is a real answer here (nothing learned yet) and lifts the
   * suppression exactly like a populated one.
   */
  const readIntoStore = (): boolean => {
    const read = settingsRepository.loadLearnedPeaks();
    if (read.state === 'unavailable') return false;
    const peaks = getPeaks();
    // Merged rather than replaced: this can run long after boot (see the retry
    // in `attemptWrite`), by which point the ingest path holds peaks of its own.
    const adopted = adoptPersistedLearnedPeaks(read.peaks, peaks);
    // In-place: the record is shared by reference with `DeviceTransport`, which
    // took it at construction. Replacing it would leave the transport writing
    // into the old object and this one reading an orphan.
    // eslint-disable-next-line functional/immutable-data -- shared-by-reference store, see above
    for (const key of Object.keys(peaks)) delete peaks[key];
    // eslint-disable-next-line functional/immutable-data -- shared-by-reference store, see above
    Object.assign(peaks, adopted);
    writeBackSuppressed = false;
    return true;
  };

  const write = (nowMs: number): void => {
    const peaks = getPeaks();
    const signature = JSON.stringify(peaks);
    if (signature === lastPersistedSignature) {
      dirty = false;
      return;
    }
    try {
      settingsRepository.saveLearnedPeaks(peaks, nowMs);
    } catch (error) {
      // Bookkeeping deliberately NOT advanced. Marking the attempt as done here
      // is what used to strand the peak for good: the signature check would then
      // skip every later identical attempt, so the one write that failed was
      // also the last one ever tried.
      getStructuredLogger?.()?.error({
        event: 'learned_peaks_write_failed',
        err: normalizeError(error),
      });
      return;
    }
    lastPersistMs = nowMs;
    lastPersistedSignature = signature;
    dirty = false;
  };

  const attemptWrite = (nowMs: number): void => {
    // The boot read may have failed; retry it here, because a learned peak is the
    // only event that reaches this module and so the only chance to find out the
    // key became readable. Still unreadable means still no write.
    if (writeBackSuppressed && !readIntoStore()) return;
    write(nowMs);
  };

  /**
   * One trailing flush for the remainder of the rate-limit window. Without it a
   * peak learned inside the window is simply dropped — nothing re-offers it, so
   * a device that reaches its peak once and then holds steady would never have
   * that peak reach settings.
   */
  const scheduleTrailingFlush = (delayMs: number): void => {
    if (timers.has(PEAK_TRAILING_FLUSH_TIMER)) return;
    const handle = setTimeout(() => {
      timers.clear(PEAK_TRAILING_FLUSH_TIMER);
      if (!dirty) return;
      attemptWrite(Date.now());
    }, Math.max(0, delayMs));
    (handle as { unref?: () => void }).unref?.();
    timers.registerTimeout(PEAK_TRAILING_FLUSH_TIMER, handle);
  };

  return {
    /**
     * Nothing is written back here — the store is written by the ingest path,
     * which prunes on save. An `unavailable` read leaves the in-memory record
     * untouched AND latches the write-back off: skipping only the adoption would
     * still let the next `persist()` clobber the record this read could not see.
     */
    load: () => {
      if (readIntoStore()) return;
      writeBackSuppressed = true;
      if (loadUnavailableWarned) return;
      loadUnavailableWarned = true;
      getStructuredLogger?.()?.warn({
        event: 'learned_peaks_load_unavailable',
        reasonCode: 'settings_read_unavailable',
      });
    },

    /**
     * Driven off the learned-peak mutation itself, and gated twice: not more than
     * once a minute, and only when the record actually differs from what was
     * written. The in-memory record is authoritative within a run, so the write
     * only has to survive the process.
     */
    persist: () => {
      dirty = true;
      const nowMs = Date.now();
      const elapsedMs = nowMs - lastPersistMs;
      if (elapsedMs < PEAK_PERSIST_MIN_INTERVAL_MS) {
        scheduleTrailingFlush(PEAK_PERSIST_MIN_INTERVAL_MS - elapsedMs);
        return;
      }
      attemptWrite(nowMs);
    },

    /**
     * Bypasses the rate limit, for shutdown. A peak learned in the last minute of
     * a run is exactly the one a restart would otherwise lose.
     */
    flush: () => {
      timers.clear(PEAK_TRAILING_FLUSH_TIMER);
      if (!dirty) return;
      attemptWrite(Date.now());
    },
  };
}
