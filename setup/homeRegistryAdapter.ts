import type Homey from 'homey';
import {
  HomeStoreWriteRefusedError,
  isPlausibleDeviceHomeAssignmentsBlob,
  isPlausibleHomesConfigBlob,
  normalizeDeviceHomeAssignments,
  normalizeHomesConfig,
  type DeviceHomeAssignments,
  type DeviceHomeAssignmentsStore,
  type HomeConfig,
  type HomeStoreReadResult,
  type HomesStore,
} from '../lib/home/homeConfig';
import {
  DEVICE_HOME_ASSIGNMENTS,
  DEVICE_HOME_ASSIGNMENTS_INITIALIZED,
  HOMES_CONFIG,
  HOMES_CONFIG_INITIALIZED,
} from '../lib/utils/settingsKeys';

type SettingsReadResult = { value: unknown; threw: false } | { value: undefined; threw: true };

// Homey SDK reads can transiently fail; a throw must classify the read
// 'suspect' (persisted truth unknown), never 'unwritten' (write permission).
const readKey = (homey: Homey.App['homey'], key: string): SettingsReadResult => {
  try {
    return { value: homey.settings.get(key) as unknown, threw: false };
  } catch {
    return { value: undefined, threw: true };
  }
};

// Marker classification is conservative: only a CLEAN absent (undefined/null)
// means never-written. A malformed marker value (present but not exactly
// `true`) or a thrown read counts as marker-PRESENT — junk in the marker key
// must never grant write permission via 'unwritten' (mirrors the calibration
// precedent, lib/device/devicePowerCalibrationStore.ts).
const readMarker = (homey: Homey.App['homey'], markerKey: string): boolean => {
  try {
    const value = homey.settings.get(markerKey) as unknown;
    return value !== undefined && value !== null;
  } catch {
    return true;
  }
};

// Best-effort, READ-path only (the marker backfill below): a failed backfill
// self-heals on the next plausible read. The WRITE path never uses this —
// write() must establish the marker durably or surface the failure.
const writeMarkerBestEffort = (homey: Homey.App['homey'], markerKey: string): void => {
  try {
    homey.settings.set(markerKey, true);
  } catch {
    // Swallowed — see above.
  }
};

// Shared read classification for both home stores (the wipe-hazard guard):
//   read threw         → suspect (cannot tell; never grants a write)
//   plausible blob     → present (+ backfill a missing marker, so a pre-marker
//                        or manually-PUT blob re-arms transient-miss detection)
//   absent, no marker  → unwritten (true fresh install)
//   absent, marker set → suspect (transient SDK miss, not fresh)
//   junk (implausible) → suspect regardless of marker (calibration precedent:
//                        malformed is always cautious)
// The whole classification is insured: a throwing accessor on the blob (a
// hostile getter/Proxy) or a future normalizer bug must never escape the
// discriminated contract — any throw classifies 'suspect'.
const classifyRead = <T>(params: {
  homey: Homey.App['homey'];
  key: string;
  markerKey: string;
  isPlausible: (raw: unknown) => boolean;
  normalize: (raw: unknown) => T;
}): HomeStoreReadResult<T> => {
  const { homey, key, markerKey, isPlausible, normalize } = params;
  try {
    const raw = readKey(homey, key);
    if (raw.threw) return { state: 'suspect' };
    if (isPlausible(raw.value)) {
      if (!readMarker(homey, markerKey)) writeMarkerBestEffort(homey, markerKey);
      return { state: 'present', value: normalize(raw.value) };
    }
    const absent = raw.value === undefined || raw.value === null;
    if (absent && !readMarker(homey, markerKey)) return { state: 'unwritten' };
    return { state: 'suspect' };
  } catch {
    return { state: 'suspect' };
  }
};

// Shared write path: refuse an implausible payload (persisting it would only
// self-classify 'suspect' on the next read — the caller gets the typed
// refusal instead, and nothing is persisted), then persist MARKER-FIRST, then
// the value. Both sets propagate failures. Ordering is load-bearing:
// value-first would let a failed marker write leave a persisted value with no
// marker — a later transient value miss then reads 'unwritten' and re-opens
// exactly the wipe window the marker exists to close (the read-path backfill
// only heals after a successful read). Marker-first fails conservative: a
// failed value write leaves marker-present + old/absent value, which reads
// 'suspect' (or present-with-the-old-value) — never 'unwritten'.
const writeClassified = (params: {
  homey: Homey.App['homey'];
  key: string;
  markerKey: string;
  isPlausible: (raw: unknown) => boolean;
  value: unknown;
}): void => {
  const { homey, key, markerKey, isPlausible, value } = params;
  if (!isPlausible(value)) throw new HomeStoreWriteRefusedError(key);
  homey.settings.set(markerKey, true);
  homey.settings.set(key, value);
};

/**
 * Builds the {@link HomesStore}: the sole owner of the `homey.settings`
 * read/write for the `homes_config` key and its written-before marker
 * (`homes_config_initialized`). Reads classify at the boundary
 * (unwritten / present / suspect — see {@link HomeStoreReadResult}); writes
 * refuse implausible payloads ({@link HomeStoreWriteRefusedError}), then
 * replace the whole value and establish the marker before reporting success.
 * Used by membership, settings, migration, and the per-home runtime registry.
 */
export const createHomesStore = (homey: Homey.App['homey']): HomesStore => ({
  read(): HomeStoreReadResult<HomeConfig> {
    return classifyRead({
      homey,
      key: HOMES_CONFIG,
      markerKey: HOMES_CONFIG_INITIALIZED,
      isPlausible: isPlausibleHomesConfigBlob,
      normalize: normalizeHomesConfig,
    });
  },
  write(config: HomeConfig): void {
    writeClassified({
      homey,
      key: HOMES_CONFIG,
      markerKey: HOMES_CONFIG_INITIALIZED,
      isPlausible: isPlausibleHomesConfigBlob,
      value: config,
    });
  },
});

/**
 * Builds the {@link DeviceHomeAssignmentsStore}: the sole owner of the
 * `homey.settings` read/write for the `device_home_assignments` key and its
 * written-before marker (`device_home_assignments_initialized`). Reads
 * classify at the boundary (unwritten / present / suspect — see
 * {@link HomeStoreReadResult}); writes refuse implausible payloads
 * ({@link HomeStoreWriteRefusedError}), then replace the whole value and
 * establish the marker before reporting success. Used by membership to load
 * explicit device pins for runtime ownership.
 */
export const createDeviceHomeAssignmentsStore = (
  homey: Homey.App['homey'],
): DeviceHomeAssignmentsStore => ({
  read(): HomeStoreReadResult<DeviceHomeAssignments> {
    return classifyRead({
      homey,
      key: DEVICE_HOME_ASSIGNMENTS,
      markerKey: DEVICE_HOME_ASSIGNMENTS_INITIALIZED,
      isPlausible: isPlausibleDeviceHomeAssignmentsBlob,
      normalize: normalizeDeviceHomeAssignments,
    });
  },
  write(assignments: DeviceHomeAssignments): void {
    writeClassified({
      homey,
      key: DEVICE_HOME_ASSIGNMENTS,
      markerKey: DEVICE_HOME_ASSIGNMENTS_INITIALIZED,
      isPlausible: isPlausibleDeviceHomeAssignmentsBlob,
      value: assignments,
    });
  },
});
