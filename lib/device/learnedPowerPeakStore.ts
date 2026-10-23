/**
 * The learned measured peaks in the userdata database: their repository and
 * the one-shot import of the legacy `device_power_peaks` settings blob.
 *
 * Learned data lives there by ruling (`notes/settings-key-ownership.md`
 * § "Which store a key lives in"): one row per device, diffed, so a learned
 * peak rewrites that device's row and nothing else, and a write costs the
 * bytes written. That is why the peaks are written through as they change,
 * with no rate limit or shutdown flush: a settings write shipped the whole
 * settings object to Homey, this one ships one row.
 */
import { getLogger } from '../logging/logger';
import type { SettingsPort } from '../ports/homeyRuntime';
import { createJsonRowTable } from '../store/jsonRowTable';
import {
  hasLegacyImportMark,
  importLegacySettingsKey,
  isLegacySettingsKeyListed,
  type MarkedLegacyImport,
  writeLegacyImportMark,
} from '../store/legacySettingsImport';
import type { UserdataDatabase } from '../store/userdataDatabase';
import { normalizeError } from '../utils/errorUtils';
import { DEVICE_POWER_PEAKS } from '../utils/settingsKeys';
import {
  adoptPersistedLearnedPeaks,
  parseLearnedPeaks,
  type LearnedPeak,
  type LearnedPeaksByDeviceId,
} from './devicePowerPeak';

const moduleLogger = getLogger('device/learned-power-peak-store');

/**
 * The peaks' rows: one per device, its peak as JSON. A row that does not read
 * as a peak is deleted as read (`lib/store/jsonRowTable.ts`).
 */
export type LearnedPowerPeakRepository = MarkedLegacyImport<LearnedPeaksByDeviceId> & {
  /** What the store holds; no devices when it holds none. Throws only on I/O. */
  read(): LearnedPeaksByDeviceId;
  /** Persist `peaks`, touching only the devices that differ from what the store holds. */
  write(peaks: LearnedPeaksByDeviceId): void;
};

/** One stored row as a peak: the same entry rule the settings blob was read with. */
const acceptPeakRow = (value: unknown, deviceId: string): LearnedPeak | undefined => (
  parseLearnedPeaks({ [deviceId]: value })[deviceId]
);

export const createLearnedPowerPeakRepository = (db: UserdataDatabase): LearnedPowerPeakRepository => {
  const devices = createJsonRowTable<LearnedPeak>(db, 'device_power_peaks', ['device_id', 'peak_json'], acceptPeakRow);
  const writeDevices = (peaks: LearnedPeaksByDeviceId): void => devices.write(new Map(Object.entries(peaks)));
  return {
    read: () => Object.fromEntries(db.transaction(() => devices.read())),
    write: (peaks) => db.transaction(() => writeDevices(peaks)),
    hasImportedLegacy: () => hasLegacyImportMark(db, DEVICE_POWER_PEAKS),
    writeLegacyImport: (peaks) => db.transaction(() => {
      writeDevices(peaks);
      writeLegacyImportMark(db, DEVICE_POWER_PEAKS);
    }),
  };
};

/**
 * The one-shot import of the legacy `device_power_peaks` settings blob into
 * the store, run at boot before the store is read. Rules and their reasons:
 * `lib/store/legacySettingsImport.ts`. A peak is written from an empty boot, so
 * "the store holds rows" never retires the key: the blob goes under what the
 * store holds instead, each device decided by the standing-peak policy
 * (`adoptPersistedLearnedPeaks`). Only the import's own mark retires it: an
 * import whose unset failed must not merge the blob again, which would bring
 * back a device pruned since. A blob that is not a record, or whose every entry
 * is malformed, holds nothing usable and keeps its key; an empty record is a
 * real answer (everything aged out) and imports as nothing.
 */
export const importLegacyLearnedPowerPeaks = (
  settings: SettingsPort,
  repository: LearnedPowerPeakRepository,
): void => {
  if (isLegacySettingsKeyListed(settings, DEVICE_POWER_PEAKS) !== true) return;
  const result = importLegacySettingsKey(settings, DEVICE_POWER_PEAKS, {
    holds: () => repository.hasImportedLegacy(),
    adopt: (raw) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
      const legacy = parseLearnedPeaks(raw);
      if (Object.keys(raw).length > 0 && Object.keys(legacy).length === 0) return false;
      repository.writeLegacyImport(adoptPersistedLearnedPeaks(legacy, repository.read()));
      return true;
    },
  });
  if (result.outcome === 'imported') {
    moduleLogger.info({ event: 'legacy_learned_power_peaks_imported' });
  } else if (result.outcome === 'retired') {
    moduleLogger.info({ event: 'legacy_learned_power_peaks_key_retired', reason: result.reason });
  } else {
    moduleLogger.warn({
      event: 'legacy_learned_power_peaks_import_deferred',
      reason: result.reason,
      ...(result.error === undefined ? {} : { err: normalizeError(result.error) }),
    });
  }
};
