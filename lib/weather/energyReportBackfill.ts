import { isUnknownRecord } from '../utils/types';

/**
 * One-shot reconstruction of historical daily whole-home kWh from the Homey
 * Energy monthly reports (`manager/energy/report/month?yearMonth=YYYY-MM`,
 * whose `subReports` are keyed by local calendar day with
 * `electricity.consumedPeriod` already aggregated). This is the energy half
 * of the day-one story: the Insights temperature backfill reaches a year+
 * back, but the power tracker's own kWh history only spans its current
 * install — Energy reports close that gap without any meter differencing.
 *
 * Months predating the Homey's Energy history return HTTP 404 ("Not Found:
 * EnergyReportMonth") — that is a normal empty month, not a failure.
 */

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;
/** A lived-in Norwegian home plausibly uses (0, 1000) kWh on a real day. */
const MAX_PLAUSIBLE_DAY_KWH = 1000;

export type EnergyReportBackfillResult = {
  dailyKwh: Record<string, number>;
  /**
   * True only when every month was fetched without a non-404 error. The
   * caller must not set its one-shot done-marker on a partial run, so a
   * transiently failing month is retried at the next start.
   */
  complete: boolean;
};

export async function fetchDailyConsumedKwh(params: {
  monthKeys: string[];
  /** Read-only GET against the Homey Web API (path without leading slash). */
  fetchFromHomeyApi: (path: string) => Promise<unknown>;
}): Promise<EnergyReportBackfillResult> {
  const { monthKeys, fetchFromHomeyApi } = params;
  const dailyKwh = new Map<string, number>();
  let failureCount = 0;
  for (const monthKey of monthKeys) {
    if (!MONTH_KEY_PATTERN.test(monthKey)) continue;
    try {
      const report = await fetchFromHomeyApi(`manager/energy/report/month?yearMonth=${monthKey}`);
      ingestMonthReport(report, dailyKwh);
    } catch (error) {
      if (isMissingReportError(error)) continue;
      failureCount += 1;
    }
  }
  return { dailyKwh: Object.fromEntries(dailyKwh), complete: failureCount === 0 };
}

/** Inclusive YYYY-MM keys from the month of `fromDateKey` through `toDateKey`'s month. */
export function listMonthKeys(fromDateKey: string, toDateKey: string): string[] {
  if (!DATE_KEY_PATTERN.test(fromDateKey) || !DATE_KEY_PATTERN.test(toDateKey)) return [];
  const fromYear = Number(fromDateKey.slice(0, 4));
  const fromMonth = Number(fromDateKey.slice(5, 7));
  const toYear = Number(toDateKey.slice(0, 4));
  const toMonth = Number(toDateKey.slice(5, 7));
  const fromIndex = fromYear * 12 + (fromMonth - 1);
  const toIndex = toYear * 12 + (toMonth - 1);
  if (toIndex < fromIndex) return [];
  return Array.from({ length: toIndex - fromIndex + 1 }, (_, offset) => {
    const index = fromIndex + offset;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
  });
}

function ingestMonthReport(report: unknown, dailyKwh: Map<string, number>): void {
  if (!isUnknownRecord(report) || !isUnknownRecord(report.subReports)) return;
  for (const [dateKey, day] of Object.entries(report.subReports)) {
    if (!DATE_KEY_PATTERN.test(dateKey) || !isUnknownRecord(day)) continue;
    const electricity = day.electricity;
    if (!isUnknownRecord(electricity)) continue;
    const consumed = electricity.consumedPeriod;
    if (typeof consumed !== 'number' || !Number.isFinite(consumed)) continue;
    if (consumed <= 0 || consumed > MAX_PLAUSIBLE_DAY_KWH) continue;
    dailyKwh.set(dateKey, consumed);
  }
}

function isMissingReportError(error: unknown): boolean {
  if (isUnknownRecord(error)) {
    const status = error.statusCode ?? error.status;
    if (status === 404) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('404') || message.includes('Not Found');
}
