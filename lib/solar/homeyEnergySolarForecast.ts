// Homey Energy's solar production forecast as a PV forecast source. Homey
// firmware 13.4.0+ serves `GET manager/energy/forecast/solar?date=YYYY-MM-DD`
// (local calendar date) with a 15-minute watts timeseries it computes from the
// owner's panel configuration and weather — cached Homey-side for
// yesterday/today/tomorrow and refreshed there once a day, so reads are local
// and cheap. This class caches the parsed per-hour kWh series in memory and
// answers the same `forecast(hourStarts)` shape as `PvForecastService`.
//
// SDK-free: the per-day fetch is injected as an already-classified semantic
// read (`SolarForecastDayRead`) — the setup adapter
// (`setup/homeyEnergySolarForecastAdapter.ts`) owns turning transport junk
// into `resolved | unavailable | failed`, and this class trusts that verdict
// (root AGENTS.md → "Clean and trusted interfaces between layers").

import { getDateKeyInTimeZone, shiftDateKey } from '../utils/dateUtils';
import { isFiniteNumber } from '../utils/appTypeGuards';
import type { PvForecastHour } from './pvForecastService';
import type { PvGainFit } from '../../packages/shared-domain/src/solar/pvGain';

const HOUR_MS = 3_600_000;
const WATTS_PER_KW = 1000;

/**
 * One day's forecast read, fully classified by the adapter: `resolved` carries
 * the raw response body (point-level validation stays here in the parser);
 * `unavailable` is a definitive semantic answer (route missing on pre-13.4.0
 * firmware, or Homey has no forecast basis — no solar device / not-found);
 * `failed` is a transient transport failure and must be treated as a no-op.
 */
export type SolarForecastDayRead =
  | { kind: 'resolved'; body: unknown }
  | { kind: 'unavailable' }
  | { kind: 'failed' };

export type SolarForecastDay = {
  /** Mean generation per UTC hour-start, kWh (an hour with no valid points is absent, never 0). */
  kwhByHourStart: Record<string, number>;
  /** Homey's own daily integral (Wh) when finite — observability only, never summed with points. */
  totalWh: number | null;
};

export type HomeyEnergySolarForecastDeps = {
  fetchForecastDay: (localDateKey: string) => Promise<SolarForecastDayRead>;
  getTimeZone: () => string;
  getNowMs: () => number;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
);

/**
 * Resolve a raw forecast-day body into per-UTC-hour mean kWh. Points are
 * 15-minute `{ t: ISO-UTC, watts }` samples; an hour's kWh is the mean of its
 * valid points / 1000 (verified against Homey's own `totalWh`: sum(watts)/4 ≈
 * totalWh on firmware 13.4.1). Junk points — unparseable `t`, non-finite or
 * negative `watts` — are dropped, never fabricated; a day with zero valid
 * points yields an empty map for the caller to classify.
 */
export function parseSolarForecastDay(raw: unknown): SolarForecastDay {
  const body = asRecord(raw);
  const points = Array.isArray(body?.points) ? body.points : [];
  const sums = points.reduce<Record<string, { watts: number; count: number }>>((acc, point) => {
    const record = asRecord(point);
    if (!record) return acc;
    const atMs = typeof record.t === 'string' ? Date.parse(record.t) : Number.NaN;
    const watts = record.watts;
    if (!Number.isFinite(atMs) || !isFiniteNumber(watts) || watts < 0) return acc;
    const hourKey = String(Math.floor(atMs / HOUR_MS) * HOUR_MS);
    const slot = acc[hourKey] ?? { watts: 0, count: 0 };
    return { ...acc, [hourKey]: { watts: slot.watts + watts, count: slot.count + 1 } };
  }, {});
  const kwhByHourStart = Object.fromEntries(
    Object.entries(sums).map(([hourKey, slot]) => [hourKey, slot.watts / slot.count / WATTS_PER_KW]),
  );
  const totalWh = isFiniteNumber(body?.totalWh) ? body.totalWh : null;
  return { kwhByHourStart, totalWh };
}

export type SolarForecastRefreshOutcome = 'ok' | 'unavailable' | 'failed';

export class HomeyEnergySolarForecastSource {
  // Per-local-date cache so a transiently failed day keeps its last good series
  // while a resolved day replaces its own entry — the no-op rule per day.
  private cacheByDate: Record<string, SolarForecastDay> = {};

  constructor(private readonly deps: HomeyEnergySolarForecastDeps) {}

  /**
   * Refetch today + tomorrow (local calendar dates in the Homey's timezone; the
   * two dates cover every hour of a 23/25 h DST day because points are
   * UTC-stamped and bucketed on UTC hour-starts — only the query key is local).
   * Per day: resolved-with-points replaces the day's cache; `unavailable` (and
   * resolved-but-empty) clears it — a definitive "no forecast for this day";
   * `failed` keeps the last good series (transient failure = no-op). Days
   * outside the queried pair are pruned. Outcome: `'ok'` when any day resolved
   * with points (tomorrow legitimately absent early in the day is still ok),
   * else `'failed'` when any day failed, else `'unavailable'`.
   */
  async refresh(nowMs: number): Promise<SolarForecastRefreshOutcome> {
    const todayKey = getDateKeyInTimeZone(new Date(nowMs), this.deps.getTimeZone());
    const dateKeys = [todayKey, shiftDateKey(todayKey, 1)];
    // Carry each day's key alongside its read rather than pairing two arrays by
    // index: the key is what the cache is written under, so it travels with the
    // result it belongs to.
    const reads = await Promise.all(dateKeys.map(async (dateKey) => ({
      dateKey,
      read: await this.deps.fetchForecastDay(dateKey),
    })));
    const nextCache: Record<string, SolarForecastDay> = {};
    let sawPoints = false;
    let sawFailed = false;
    for (const { dateKey, read } of reads) {
      if (read.kind === 'failed') {
        sawFailed = true;
        const previous = this.cacheByDate[dateKey];
        if (previous) nextCache[dateKey] = previous;
        continue;
      }
      if (read.kind === 'unavailable') continue;
      const day = parseSolarForecastDay(read.body);
      if (Object.keys(day.kwhByHourStart).length === 0) continue; // resolved but empty ⇒ no forecast
      nextCache[dateKey] = day;
      sawPoints = true;
    }
    this.cacheByDate = nextCache;
    if (sawPoints) return 'ok';
    return sawFailed ? 'failed' : 'unavailable';
  }

  /** Forecast kWh for the given UTC hour-starts; hours Homey has no point for are skipped, not guessed. */
  forecast(hourStarts: readonly number[]): PvForecastHour[] {
    const result: PvForecastHour[] = [];
    for (const hourStart of hourStarts) {
      const kwh = this.lookupKwh(hourStart);
      if (kwh === undefined) continue;
      result.push({ hourStartMs: hourStart, generationKwh: kwh });
    }
    return result;
  }

  /**
   * Whether the cached forecast is worth preferring over the learned model:
   * its CURRENT-OR-FUTURE hours must carry positive energy. Past hours are
   * deliberately excluded — a sunny morning must not qualify an all-zero
   * remainder of the day. A resolved-but-all-zero forward forecast (a solar
   * device is registered but Homey has no real basis yet, or night with no
   * tomorrow yet) is not useful — the learned model keeps serving until Homey
   * forecasts something non-trivial ahead.
   */
  hasUsefulForecast(nowMs: number): boolean {
    const currentHourStartMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    let forwardKwh = 0;
    for (const day of Object.values(this.cacheByDate)) {
      for (const [hourKey, kwh] of Object.entries(day.kwhByHourStart)) {
        if (Number(hourKey) >= currentHourStartMs) forwardKwh += kwh;
      }
    }
    return forwardKwh > 0;
  }

  /**
   * Confidence carried alongside the forecast for the curtailment potential —
   * the same scale the learned fit reports. Constant `'high'` while a useful
   * forecast exists: Homey's forecast incorporates the configured panel
   * geometry/capacity plus a weather model, so the learned fit's low/medium
   * states (sparse or clamp-contaminated self-training) do not apply.
   * Dogfood-tunable: if prod comparison shows Homey overstating deliverable
   * surplus for zero-export homes, derive this instead of pinning it.
   */
  getConfidence(): PvGainFit['confidence'] | null {
    return this.hasUsefulForecast(this.deps.getNowMs()) ? 'high' : null;
  }

  /** Observability rollup for the structured refresh log. */
  summarize(nowMs: number): {
    hourCount: number;
    next24hKwh: number;
    firstHourStartMs: number | null;
    lastHourStartMs: number | null;
    totalWhReported: number | null;
  } {
    const currentHourStartMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    let hourCount = 0;
    let next24hKwh = 0;
    let firstHourStartMs: number | null = null;
    let lastHourStartMs: number | null = null;
    let totalWhReported: number | null = null;
    for (const day of Object.values(this.cacheByDate)) {
      if (day.totalWh !== null) totalWhReported = (totalWhReported ?? 0) + day.totalWh;
      for (const [hourKey, kwh] of Object.entries(day.kwhByHourStart)) {
        const hourStartMs = Number(hourKey);
        hourCount += 1;
        if (firstHourStartMs === null || hourStartMs < firstHourStartMs) firstHourStartMs = hourStartMs;
        if (lastHourStartMs === null || hourStartMs > lastHourStartMs) lastHourStartMs = hourStartMs;
        if (hourStartMs >= currentHourStartMs && hourStartMs < currentHourStartMs + 24 * HOUR_MS) {
          next24hKwh += kwh;
        }
      }
    }
    return { hourCount, next24hKwh, firstHourStartMs, lastHourStartMs, totalWhReported };
  }

  private lookupKwh(hourStartMs: number): number | undefined {
    const hourKey = String(hourStartMs);
    for (const day of Object.values(this.cacheByDate)) {
      const kwh = day.kwhByHourStart[hourKey];
      if (kwh !== undefined) return kwh;
    }
    return undefined;
  }
}
