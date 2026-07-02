// Read-side solar statistics for the Usage tab card: folds the tracker's
// sparse per-UTC-hour generation/export kWh families into Homey-local days
// (mirroring `powerStats.getDerivedDailyTotals`) and resolves the card's
// visibility gate. Pure data producers — the view only renders.
//
// v1 window = the last 7 local days from hourly buckets (30-day retention
// comfortably covers it); merging the aged `*DailyTotals` families into a
// longer window is deferred to the v2 month view.

import { getDateKeyInTimeZone, shiftDateKey } from './timezone.ts';

export type SolarDayRow = {
  dateKey: string;
  generatedKWh: number;
  exportedKWh: number;
  /**
   * Σ_h max(0, generated_h − exported_h): the per-hour floor keeps a
   * battery-discharge export hour (exported > generated) from dragging the
   * day negative.
   */
  selfUsedKWh: number;
  /**
   * Self-consumption rate = selfUsed / generated for the local day, or `null`
   * when the day generated under {@link MIN_RATE_GENERATED_KWH} (a percentage
   * of almost-nothing is noise).
   */
  selfUseRate: number | null;
};

const MIN_RATE_GENERATED_KWH = 0.05;

/**
 * Read-side materiality gate (not persisted): export alone only argues for the
 * solar card once the displayed 7-day window carries at least this much, so a
 * single junk-negative flow sample can't conjure the card.
 */
export const SOLAR_USAGE_MIN_EXPORT_KWH = 0.1;

const SOLAR_DAY_WINDOW_DAYS = 7;

// Boundary normalization for the untrusted payload bucket values: non-finite
// or negative junk contributes nothing.
const toKWh = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
);

type HourTotals = { generatedKWh: number; exportedKWh: number };

const collectHourTotals = (
  generationBuckets: Record<string, number> | undefined,
  exportBuckets: Record<string, number> | undefined,
): Map<string, HourTotals> => {
  const byIso = new Map<string, HourTotals>();
  const fold = (buckets: Record<string, number> | undefined, key: keyof HourTotals): void => {
    for (const [iso, value] of Object.entries(buckets ?? {})) {
      const kWh = toKWh(value);
      const existing = byIso.get(iso) ?? { generatedKWh: 0, exportedKWh: 0 };
      existing[key] += kWh;
      byIso.set(iso, existing);
    }
  };
  fold(generationBuckets, 'generatedKWh');
  fold(exportBuckets, 'exportedKWh');
  return byIso;
};

/**
 * Builds the last-7-local-days solar rows (today included, newest first).
 * Days without any solar data are omitted — the card renders presence, not a
 * dense calendar.
 */
export const buildSolarDayRows = (params: {
  generationBuckets?: Record<string, number>;
  exportBuckets?: Record<string, number>;
  timeZone: string;
  todayKey: string;
  days?: number;
}): SolarDayRow[] => {
  const { generationBuckets, exportBuckets, timeZone, todayKey } = params;
  const days = params.days ?? SOLAR_DAY_WINDOW_DAYS;
  const windowKeys = new Set<string>();
  for (let offset = 0; offset < days; offset += 1) {
    windowKeys.add(shiftDateKey(todayKey, -offset));
  }

  const byDay = new Map<string, { generatedKWh: number; exportedKWh: number; selfUsedKWh: number }>();
  for (const [iso, totals] of collectHourTotals(generationBuckets, exportBuckets)) {
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) continue;
    const dateKey = getDateKeyInTimeZone(new Date(ts), timeZone);
    if (!windowKeys.has(dateKey)) continue;
    const day = byDay.get(dateKey) ?? { generatedKWh: 0, exportedKWh: 0, selfUsedKWh: 0 };
    day.generatedKWh += totals.generatedKWh;
    day.exportedKWh += totals.exportedKWh;
    day.selfUsedKWh += Math.max(0, totals.generatedKWh - totals.exportedKWh);
    byDay.set(dateKey, day);
  }

  return [...byDay.entries()]
    .filter(([, day]) => day.generatedKWh > 0 || day.exportedKWh > 0)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([dateKey, day]) => ({
      dateKey,
      generatedKWh: day.generatedKWh,
      exportedKWh: day.exportedKWh,
      selfUsedKWh: day.selfUsedKWh,
      selfUseRate: day.generatedKWh >= MIN_RATE_GENERATED_KWH
        ? day.selfUsedKWh / day.generatedKWh
        : null,
    }));
};

/**
 * Today's per-UTC-hour kWh maps + hour list for the money join
 * (`resolveSolarMoneyToday`). Keys are epoch hour-start ms so the tracker's
 * ISO keys and the price rows' `startsAt` meet on the same instant.
 */
export const buildTodaySolarHourMaps = (params: {
  generationBuckets?: Record<string, number>;
  exportBuckets?: Record<string, number>;
  timeZone: string;
  todayKey: string;
}): {
  generationKWhByHourMs: Map<number, number>;
  exportKWhByHourMs: Map<number, number>;
  todayHourStartsMs: number[];
} => {
  const { generationBuckets, exportBuckets, timeZone, todayKey } = params;
  const generationKWhByHourMs = new Map<number, number>();
  const exportKWhByHourMs = new Map<number, number>();
  const todayHourStartsMs: number[] = [];
  for (const [iso, totals] of collectHourTotals(generationBuckets, exportBuckets)) {
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) continue;
    if (getDateKeyInTimeZone(new Date(ts), timeZone) !== todayKey) continue;
    generationKWhByHourMs.set(ts, totals.generatedKWh);
    exportKWhByHourMs.set(ts, totals.exportedKWh);
    todayHourStartsMs.push(ts);
  }
  return { generationKWhByHourMs, exportKWhByHourMs, todayHourStartsMs };
};

/**
 * Card visibility gate: a home with a tracked solar device always sees the
 * card (its zero-data state is honest), any recorded generation shows it, and
 * export alone shows it only past the 7-day materiality floor — so a single
 * junk-negative net sample in a non-solar home stays invisible.
 */
export const resolveSolarCardVisible = (params: {
  hasManagedSolarDevice: boolean;
  generationBuckets?: Record<string, number>;
  rows: readonly SolarDayRow[];
}): boolean => {
  const { hasManagedSolarDevice, generationBuckets, rows } = params;
  if (hasManagedSolarDevice) return true;
  const totalGeneratedKWh = Object.values(generationBuckets ?? {})
    .reduce((sum, value) => sum + toKWh(value), 0);
  if (totalGeneratedKWh > 0) return true;
  const windowExportKWh = rows.reduce((sum, row) => sum + row.exportedKWh, 0);
  return windowExportKWh >= SOLAR_USAGE_MIN_EXPORT_KWH;
};
