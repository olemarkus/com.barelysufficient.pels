import {
  getMonthStartInTimeZone,
  getZonedParts,
} from '../utils/dateUtils';
import { DEFAULT_NORGESPRIS_HOURLY_USAGE_ESTIMATE_KWH } from './norwayPriceDefaults';

type SettingsReader = { settings: { get: (key: string) => unknown }; clock: { getTimezone: () => string } };
type HomeyApi = SettingsReader;

const getSettingValue = (homey: HomeyApi, key: string): unknown => homey.settings.get(key);

export const getCurrentMonthUsageKwh = (homey: HomeyApi): number => {
  const raw = getSettingValue(homey, 'power_tracker_state');
  if (!raw || typeof raw !== 'object') return 0;
  const tracker = raw as { dailyTotals?: unknown; buckets?: unknown };
  const timeZone = homey.clock.getTimezone();
  const now = new Date();
  const monthStartMs = getMonthStartInTimeZone(now, timeZone);
  const { year, month } = getZonedParts(now, timeZone);
  const nextMonthProbe = new Date(Date.UTC(year, month, 15, 12, 0, 0));
  const monthEndMs = getMonthStartInTimeZone(nextMonthProbe, timeZone);
  const hasFiniteMonthEnd = Number.isFinite(monthEndMs);

  let usageKwh = 0;
  const dailyTotals = tracker.dailyTotals;
  const buckets = tracker.buckets;
  if (buckets && typeof buckets === 'object') {
    Object.entries(buckets as Record<string, unknown>).forEach(([isoHour, value]) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      const date = new Date(isoHour);
      const ts = date.getTime();
      if (!Number.isFinite(ts)) return;
      if (ts < monthStartMs) return;
      if (hasFiniteMonthEnd && ts >= monthEndMs) return;
      usageKwh += value;
    });
  }

  // Daily totals are keyed by YYYY-MM-DD (Homey-local when the runtime can supply a
  // timezone to `aggregateAndPruneHistory`, otherwise legacy UTC). The conservative
  // "fully inside the month window" check works for both: a day-key whose UTC midnight
  // sits inside the local-month UTC window is unambiguously inside that local month.
  if (dailyTotals && typeof dailyTotals === 'object') {
    Object.entries(dailyTotals as Record<string, unknown>).forEach(([dateKey, value]) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      const dayStartUtcMs = Date.parse(`${dateKey}T00:00:00.000Z`);
      if (!Number.isFinite(dayStartUtcMs)) return;
      const dayEndUtcMs = dayStartUtcMs + 24 * 60 * 60 * 1000;
      const isFullyInsideMonth = dayStartUtcMs >= monthStartMs
        && (!hasFiniteMonthEnd || dayEndUtcMs <= monthEndMs);
      if (isFullyInsideMonth) {
        usageKwh += value;
      }
    });
  }

  return usageKwh;
};

export const getHourlyUsageEstimateKwh = (homey: HomeyApi): number => {
  const raw = getSettingValue(homey, 'power_tracker_state');
  if (!raw || typeof raw !== 'object') return DEFAULT_NORGESPRIS_HOURLY_USAGE_ESTIMATE_KWH;
  const tracker = raw as { lastPowerW?: unknown };
  const lastPowerW = tracker.lastPowerW;
  if (typeof lastPowerW === 'number' && Number.isFinite(lastPowerW) && lastPowerW > 0) {
    return lastPowerW / 1000;
  }
  return DEFAULT_NORGESPRIS_HOURLY_USAGE_ESTIMATE_KWH;
};
