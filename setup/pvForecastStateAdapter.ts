// Persistence boundary for the learned PV-forecast state (recorded generation
// history + concurrent irradiance), over `homey.settings`. Reads are validated at
// the boundary: a malformed blob is coerced field-by-field, dropping non-finite /
// wrong-shape entries rather than handing them inward.

import { PV_FORECAST_STATE } from '../lib/utils/settingsKeys';
import { isFiniteNumber } from '../lib/utils/appTypeGuards';
import type { PvForecastServiceState } from '../lib/solar/pvForecastService';
import type { PvGenerationHistory, PvHourBucket } from '../packages/shared-domain/src/solar/pvGenerationHistory';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);
const isHourKey = (key: string): boolean => Number.isFinite(Number(key));

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
      if (!isHourKey(key) || !isRecord(value) || !isFiniteNumber(value.kwh) || !isFiniteNumber(value.coveredMs)) {
        return [];
      }
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

/** Validate a persisted blob into a usable state, or `undefined` when unrecoverable. */
export const normalizePvForecastState = (raw: unknown): PvForecastServiceState | undefined => {
  if (!isRecord(raw) || !isRecord(raw.history)) return undefined;
  const historyRaw = raw.history;
  const history: PvGenerationHistory = {
    hourly: normalizeHourly(historyRaw.hourly),
    ...(isFiniteNumber(historyRaw.lastSampleMs) ? { lastSampleMs: historyRaw.lastSampleMs } : {}),
    ...(isFiniteNumber(historyRaw.lastGenerationW) ? { lastGenerationW: historyRaw.lastGenerationW } : {}),
    // SIGNED net anchor — never floor at 0 (export is negative by design).
    ...(isFiniteNumber(historyRaw.lastNetW) ? { lastNetW: historyRaw.lastNetW } : {}),
    ...(isRecord(historyRaw.taintedHourStarts)
      ? { taintedHourStarts: normalizeTainted(historyRaw.taintedHourStarts) }
      : {}),
  };
  return { history, irradianceByHour: normalizeNumberMap(raw.irradianceByHour) };
};

export type PvForecastStore = {
  read: () => PvForecastServiceState | undefined;
  write: (state: PvForecastServiceState) => void;
};

export const createPvForecastStore = (
  homey: { settings: { get: (key: string) => unknown; set: (key: string, value: unknown) => void } },
): PvForecastStore => ({
  read: () => normalizePvForecastState(homey.settings.get(PV_FORECAST_STATE)),
  write: (state) => homey.settings.set(PV_FORECAST_STATE, state),
});
