// Persistence boundary for the learned PV-forecast state (recorded generation
// history + concurrent irradiance), over `homey.settings`. Reads are validated at
// the boundary: a malformed blob is coerced field-by-field, dropping non-finite /
// wrong-shape entries rather than handing them inward, and the boot read is
// classified into `loaded | absent | unreadable` over a written-before marker
// (`pv_forecast_state_initialized`, the `power_calibration_initialized`
// precedent) plus the key-list cross-check, so a transient SDK miss can never
// masquerade as a fresh install and let the persist timer overwrite up to 90
// days of learned generation history (notes/persisted-settings-state.md).

import { PV_FORECAST_STATE, PV_FORECAST_STATE_INITIALIZED } from '../lib/utils/settingsKeys';
import { isFiniteNumber } from '../lib/utils/appTypeGuards';
import type { PvForecastServiceState } from '../lib/solar/pvForecastService';
import type { PvGenerationHistory, PvHourBucket } from '../packages/shared-domain/src/solar/pvGenerationHistory';

// Arrays are rejected too: `typeof [] === 'object'`, and an array-shaped
// `hourly` (numeric indices pass the hour-key check) or blob would otherwise
// pass plausibility as a valid empty state and let the first dirty persist
// overwrite a suspect blob.
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);
const isHourKey = (key: string): boolean => Number.isFinite(Number(key));
const isStringKeyList = (value: unknown): value is string[] => (
  Array.isArray(value) && value.every((key) => typeof key === 'string')
);

// Physical ceiling for an hourly bucket's covered/evidence durations. In-memory
// accrual clamps every segment to the hour boundary (`pvGenerationHistory`), so a
// persisted `coveredMs` above this is a corrupt blob — bounding it here stops an
// oversized value (and the net/import sub-durations it would otherwise admit)
// from forging `unclamped` net-evidence that trains the PV gain.
const ONE_HOUR_MS = 60 * 60 * 1000;

// Net-evidence durations are valid only when finite, non-negative, and within
// their accrual bound. A junk field is OMITTED (the hour then classifies
// 'unknown') rather than dropping the whole hour — evidence degrades, energy stays.
const isEvidenceMs = (value: unknown, maxMs: number): value is number => (
  isFiniteNumber(value) && value >= 0 && value <= maxMs
);

const normalizeHourly = (raw: unknown): Record<string, PvHourBucket> => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).flatMap(([key, value]): Array<readonly [string, PvHourBucket]> => {
      if (!isHourKey(key) || !isRecord(value) || !isFiniteNumber(value.kwh)
        || !isEvidenceMs(value.coveredMs, ONE_HOUR_MS)) {
        return [];
      }
      // coveredMs is now bounded to a physical hour (rejected above if oversized).
      // netMs is bounded by coveredMs; importMs/exportMs are SUB-durations of the
      // net-covered time — in-memory accrual can never produce more, so a blob
      // claiming otherwise (e.g. importMs == coveredMs with netMs below it, which
      // would classify a corrupt hour 'unclamped') drops the offending field. With
      // netMs itself invalid the sub-duration bound collapses to 0.
      const netMs = isEvidenceMs(value.netMs, value.coveredMs) ? value.netMs : undefined;
      const subDurationBoundMs = Math.min(netMs ?? 0, value.coveredMs);
      return [[key, {
        kwh: value.kwh,
        coveredMs: value.coveredMs,
        ...(netMs === undefined ? {} : { netMs }),
        ...(isEvidenceMs(value.importMs, subDurationBoundMs) ? { importMs: value.importMs } : {}),
        ...(isEvidenceMs(value.exportMs, subDurationBoundMs) ? { exportMs: value.exportMs } : {}),
      }]];
    }),
  );
};

const normalizeNumberMap = (raw: unknown): Record<string, number> => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).flatMap(([key, value]): Array<readonly [string, number]> => (
      isHourKey(key) && isFiniteNumber(value) ? [[key, value]] : []
    )),
  );
};

const normalizeTainted = (raw: unknown): Record<string, true> => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.keys(raw).flatMap((key): Array<readonly [string, true]> => (isHourKey(key) ? [[key, true]] : [])),
  );
};

/** Pure parse of a persisted blob. `malformed` = the blob cannot vouch for the
 *  history it claims — wrong top-level shape, a missing `hourly` record (every
 *  writer produces one, even for the empty state), or claimed hours that ALL
 *  failed coercion (partial corruption, not emptiness; the round-4 finding in
 *  notes/persisted-settings-state.md: plausibility must recurse to match what
 *  the normaliser silently drops). The boot read then stays suspect rather
 *  than starting the service empty. */
type PvForecastStateParse =
  | { kind: 'valid'; state: PvForecastServiceState }
  | { kind: 'malformed' };

/** Validate a persisted blob into a usable state, coercing field-by-field. */
export const normalizePvForecastState = (raw: unknown): PvForecastStateParse => {
  if (!isRecord(raw) || !isRecord(raw.history) || !isRecord(raw.history.hourly)) {
    return { kind: 'malformed' };
  }
  const historyRaw = raw.history;
  const hourly = normalizeHourly(historyRaw.hourly);
  if (Object.keys(historyRaw.hourly as Record<string, unknown>).length > 0
    && Object.keys(hourly).length === 0) {
    return { kind: 'malformed' };
  }
  const history: PvGenerationHistory = {
    hourly,
    ...(isFiniteNumber(historyRaw.lastSampleMs) ? { lastSampleMs: historyRaw.lastSampleMs } : {}),
    ...(isFiniteNumber(historyRaw.lastGenerationW) ? { lastGenerationW: historyRaw.lastGenerationW } : {}),
    // SIGNED net anchor — never floor at 0 (export is negative by design).
    ...(isFiniteNumber(historyRaw.lastNetW) ? { lastNetW: historyRaw.lastNetW } : {}),
    ...(isRecord(historyRaw.taintedHourStarts)
      ? { taintedHourStarts: normalizeTainted(historyRaw.taintedHourStarts) }
      : {}),
  };
  return { kind: 'valid', state: { history, irradianceByHour: normalizeNumberMap(raw.irradianceByHour) } };
};

/**
 * Classified boot read (clean-interface seam): the adapter owns every SDK
 * outcome — `null`-vs-`undefined` absence, thrown reads, malformed payloads,
 * the written-before marker, and the key-list cross-check — so the controller
 * only ever branches on the semantic result.
 *  - `loaded`     — a valid persisted state (junk entries dropped field-by-field).
 *  - `absent`      — provably never written: no blob, no marker, and a healthy
 *                    non-empty key list that does not contain the blob's key.
 *                    A fresh install, pending the caller's confirmation across
 *                    spaced re-reads.
 *  - `marker_only` — the written-before marker is cleanly present while the
 *                    blob key is cleanly missing from a healthy key list: the
 *                    half-persist signature (the marker-first write landed,
 *                    the blob write never did). Once the caller has confirmed
 *                    it across spaced re-reads it is a recoverable fresh
 *                    start — treating it as forever-unreadable would wedge
 *                    persistence permanently.
 *  - `unreadable`  — ambiguous; the caller must defer writes and re-read. The
 *                    `reason` says which evidence failed: `read_threw` (the
 *                    SDK refused to answer), `malformed` (a payload the writer
 *                    never produces), `absence_unproven` (an empty read whose
 *                    marker/key-list probes threw, disagreed, or contradicted
 *                    the empty read — e.g. the key list still lists the blob).
 */
export type PvForecastStateRead =
  | { kind: 'loaded'; state: PvForecastServiceState }
  | { kind: 'absent' }
  | { kind: 'marker_only' }
  | { kind: 'unreadable'; reason: 'read_threw' | 'malformed' | 'absence_unproven' };

/** The settings surface the store binds. `getKeys` is typed as the untrusted
 *  boundary it is (the `readTemperatureControlDisabledDevicesSetting`
 *  precedent): its return is validated before it may vouch for genuine absence. */
export type PvForecastStoreSettings = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  getKeys: () => unknown;
};

export type PvForecastStore = {
  read: () => PvForecastStateRead;
  write: (state: PvForecastServiceState) => void;
};

export const createPvForecastStore = (
  homey: { settings: PvForecastStoreSettings },
): PvForecastStore => {
  const { settings } = homey;
  // Cached once the marker is confirmed present (read) or written (persist) in
  // this process, so steady-state persists skip the extra settings round-trip.
  let markerConfirmed = false;

  // The marker probe answers three ways — `present` / `absent` / `unanswered`
  // — because the split matters: `true` is the only value ever stored, but an
  // uninterpretable value still counts as present (it vouches; the
  // `externalOffHoldAdapter.hasWrittenBefore` precedent), while a thrown read
  // is `unanswered` and must keep the classification ambiguous. Only a literal
  // `true` is CACHED, so the next persist normalises anything else.
  const probeMarker = (): 'present' | 'absent' | 'unanswered' => {
    if (markerConfirmed) return 'present';
    try {
      const marker = settings.get(PV_FORECAST_STATE_INITIALIZED);
      if (marker === undefined || marker === null) return 'absent';
      if (marker === true) markerConfirmed = true;
      return 'present';
    } catch {
      return 'unanswered';
    }
  };

  // A clean absence claim needs a healthy key list that omits the blob's key.
  // An empty list, junk entries, or a throw prove nothing (a running install
  // always has keys) and answer `unanswered`; a list still CONTAINING the key
  // while the blob read came back empty contradicts the read outright
  // (setup/AGENTS.md key-list cross-check rule).
  const probeKeyList = (): 'lists_blob' | 'omits_blob' | 'unanswered' => {
    try {
      const keys = settings.getKeys();
      if (!isStringKeyList(keys) || keys.length === 0) return 'unanswered';
      return keys.includes(PV_FORECAST_STATE) ? 'lists_blob' : 'omits_blob';
    } catch {
      return 'unanswered';
    }
  };

  /** Classify an empty blob read. Only a fully coherent set of probes may
   *  resolve to one of the clean shapes (`absent`, `marker_only`); any thrown,
   *  junk, or contradictory probe keeps the read `unreadable`. */
  const classifyCleanAbsence = (): PvForecastStateRead => {
    const marker = probeMarker();
    const keyList = probeKeyList();
    if (keyList !== 'omits_blob' || marker === 'unanswered') {
      return { kind: 'unreadable', reason: 'absence_unproven' };
    }
    return marker === 'present' ? { kind: 'marker_only' } : { kind: 'absent' };
  };

  // Installs that persisted the blob before the marker existed get it
  // backfilled whenever a read proves the blob is real (the
  // `loadPowerCalibrationStore` backfill precedent). A later miss on such an
  // install is already caught by the key-list cross-check; the backfill's
  // value is converging it onto the marker — the primary per-key probe — a few
  // minutes before the next persist would, hardening against a key list that
  // looks healthy while being incomplete. Best-effort: a failure must not fail
  // the read; skipped when the marker read itself threw (no signal that it is
  // actually missing), and retried by the next read or persist otherwise.
  const backfillMarkerBestEffort = (): void => {
    if (probeMarker() !== 'absent') return; // present: done; unanswered: no signal — skip
    try {
      settings.set(PV_FORECAST_STATE_INITIALIZED, true);
      markerConfirmed = true;
    } catch { /* retried on the next read/persist */ }
  };

  const read = (): PvForecastStateRead => {
    let raw: unknown;
    try {
      raw = settings.get(PV_FORECAST_STATE);
    } catch {
      return { kind: 'unreadable', reason: 'read_threw' };
    }
    // `null` is the SDK's genuine-absence answer; `undefined` covers doubles
    // (setup/AGENTS.md — classify absence on BOTH).
    if (raw === undefined || raw === null) return classifyCleanAbsence();
    // Insurance: `read()` runs in the controller CONSTRUCTOR at app boot, so a
    // future normaliser bug must degrade to `unreadable`, never escape the
    // discriminated contract and fail boot (the `homeRegistryAdapter
    // classifyRead` precedent).
    let parsed: PvForecastStateParse;
    try {
      parsed = normalizePvForecastState(raw);
    } catch {
      return { kind: 'unreadable', reason: 'malformed' };
    }
    if (parsed.kind === 'malformed') return { kind: 'unreadable', reason: 'malformed' };
    backfillMarkerBestEffort();
    return { kind: 'loaded', state: parsed.state };
  };

  const write = (state: PvForecastServiceState): void => {
    // The marker and the blob are ONE persist, marker FIRST (the
    // `homeRegistryAdapter.writeClassified` ordering): a throw on either set
    // fails the whole write, so the caller keeps its state dirty and retries
    // both — rewriting either key is idempotent. Marker-first means a crash
    // between the sets can only leave marker-without-blob, which later boots
    // classify `marker_only` and resolve to a recoverable fresh start after
    // spaced confirming re-reads; blob-first could leave blob-without-marker,
    // where a later transient blob miss rests on the key-list check alone.
    if (!markerConfirmed) {
      settings.set(PV_FORECAST_STATE_INITIALIZED, true);
      markerConfirmed = true;
    }
    settings.set(PV_FORECAST_STATE, state);
  };

  return { read, write };
};
