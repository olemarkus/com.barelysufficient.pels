import { getDateKeyInTimeZone, shiftDateKey } from '../../../shared-domain/src/utils/dateUtils.ts';
import type { SettingsUiPowerPayload } from '../../../contracts/src/settingsUi/power.ts';

/**
 * What the home's own recent usage says about a limit the owner is about to
 * save. Only the settings form asks, so this stays with the settings UI. The
 * history is the hourly energy the power payload already carries. Each complete
 * bucket describes that hour's average draw.
 */

const HOUR_MS = 3_600_000;
const WINDOW_HOURS = 7 * 24;
/** Under a day of complete hours, only the current reading is compared. */
const MIN_HISTORY_HOURS = 24;
/** A reading older than this no longer says what the home uses now. */
const CURRENT_READING_MAX_AGE_MS = 5 * 60_000;
/** The share of hours the base load is under: one hour in ten. */
const BASE_LOAD_PERCENTILE = 0.1;

export type UsageHour = { readonly startMs: number; readonly kw: number };

export type LimitUsageEvidence = {
  /** What the home draws now, when the last reading is recent. */
  readonly current: { readonly kw: number; readonly sampledAtMs: number } | null;
  /** Complete, reliable hours of the last 7 days; empty under a day of history. */
  readonly hours: readonly UsageHour[];
};

export const NO_USAGE_EVIDENCE: LimitUsageEvidence = { current: null, hours: [] };

const isReliable = (startMs: number, periods: readonly { start: number; end: number }[]): boolean => (
  !periods.some((period) => period.start < startMs + HOUR_MS && period.end > startMs)
);

const readCurrent = (payload: SettingsUiPowerPayload, nowMs: number): LimitUsageEvidence['current'] => {
  const { readings, tracker } = payload;
  if (readings?.state !== 'received') return null;
  // A status-only push advances the readings stamp without replacing the cached tracker.
  const stamp = Math.min(readings.lastPowerUpdateMs, tracker.lastTimestamp ?? readings.lastPowerUpdateMs);
  const watts = tracker.lastPowerW;
  if (!Number.isFinite(stamp) || stamp > nowMs || nowMs - stamp >= CURRENT_READING_MAX_AGE_MS
    || typeof watts !== 'number' || !Number.isFinite(watts) || watts <= 0) return null;
  return { kw: watts / 1000, sampledAtMs: stamp };
};

const historyWindowStart = (nowMs: number): number => (Math.floor(nowMs / HOUR_MS) - WINDOW_HOURS) * HOUR_MS;

// A failed refresh can leave the form open on the same history across days.
const recentHours = (evidence: LimitUsageEvidence, nowMs: number): readonly UsageHour[] => {
  const start = historyWindowStart(nowMs);
  if (!evidence.hours.length || evidence.hours[0]!.startMs >= start) return evidence.hours;
  const hours = evidence.hours.filter((hour) => hour.startMs >= start);
  return hours.length >= MIN_HISTORY_HOURS ? hours : [];
};

const readHours = (payload: SettingsUiPowerPayload, nowMs: number): UsageHour[] => {
  const { buckets, unreliablePeriods = [] } = payload.tracker;
  const currentHourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const windowStart = historyWindowStart(nowMs);
  const hours = Object.entries(buckets ?? {}).flatMap(([iso, kWh]) => {
    const startMs = Date.parse(iso);
    const complete = startMs >= windowStart && startMs < currentHourStart;
    if (!complete || typeof kWh !== 'number' || !Number.isFinite(kWh) || kWh < 0) return [];
    return isReliable(startMs, unreliablePeriods) ? [{ startMs, kw: kWh }] : [];
  });
  return hours.length >= MIN_HISTORY_HOURS ? hours.sort((a, b) => a.startMs - b.startMs) : [];
};

/** A payload without a usage history (as the Usage page also allows) is no evidence. */
export const resolveLimitUsageEvidence = (payload: SettingsUiPowerPayload, nowMs: number): LimitUsageEvidence => (
  payload.tracker && typeof payload.tracker === 'object'
    ? { current: readCurrent(payload, nowMs), hours: readHours(payload, nowMs) }
    : NO_USAGE_EVIDENCE
);

/** An instantaneous limit (grid import limit, main fuse) the home is already above. */
export type InstantLimitFinding =
  | { readonly kind: 'past_hours'; readonly peak: UsageHour; readonly hoursAbove: number; readonly targetKw: number }
  | { readonly kind: 'current'; readonly currentKw: number; readonly sampledAtMs: number; readonly targetKw: number };

/** `targetKw` is where PELS starts reducing loads under the limit. */
export const checkInstantLimit = (
  targetKw: number, evidence: LimitUsageEvidence, nowMs: number,
): InstantLimitFinding | null => {
  const above = recentHours(evidence, nowMs).filter((hour) => hour.kw > targetKw);
  if (above.length > 0) {
    const peak = above.reduce((best, hour) => (hour.kw > best.kw ? hour : best));
    return { kind: 'past_hours', peak, hoursAbove: above.length, targetKw };
  }
  const { current } = evidence;
  if (current !== null && nowMs - current.sampledAtMs < CURRENT_READING_MAX_AGE_MS && current.kw > targetKw) {
    return { kind: 'current', currentKw: current.kw, sampledAtMs: current.sampledAtMs, targetKw };
  }
  return null;
};

/** A hard cap under the home's base load, which PELS cannot hold the average to. */
export type HardCapFinding = { readonly baseLoadKw: number; readonly targetKw: number };

const percentile = (values: readonly number[], share: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(share * (sorted.length - 1))] ?? 0;
};

/**
 * Below past peaks is what a hard cap is for; only a target under what the home
 * draws in nine hours out of ten is one PELS cannot meet.
 */
export const checkHardCap = (targetKw: number, evidence: LimitUsageEvidence, nowMs: number): HardCapFinding | null => {
  const hours = recentHours(evidence, nowMs);
  if (hours.length === 0) return null;
  const baseLoadKw = percentile(hours.map((hour) => hour.kw), BASE_LOAD_PERCENTILE);
  return baseLoadKw > targetKw ? { baseLoadKw, targetKw } : null;
};

// Two decimals under 1 kW, as the limit hints show them.
const formatKw = (kw: number): string => kw.toFixed(kw < 1 ? 2 : 1);

const formatClock = (ms: number, timeZone: string): string => (
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
);

const formatDay = (ms: number, nowMs: number, timeZone: string): string => {
  const day = getDateKeyInTimeZone(new Date(ms), timeZone);
  const today = getDateKeyInTimeZone(new Date(nowMs), timeZone);
  if (day === today) return 'today';
  if (day === shiftDateKey(today, -1)) return 'yesterday';
  return `on ${new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(ms)}`;
};

export const formatInstantLimitFinding = (
  finding: InstantLimitFinding,
  nowMs: number,
  timeZone: string,
): string => {
  const target = `the ${formatKw(finding.targetKw)} kW where PELS starts reducing loads`;
  if (finding.kind === 'current') {
    const time = formatClock(finding.sampledAtMs, timeZone);
    return `At ${time} your home drew ${formatKw(finding.currentKw)} kW, above ${target}.`;
  }
  const { peak, hoursAbove } = finding;
  const from = formatClock(peak.startMs, timeZone);
  const to = formatClock(peak.startMs + HOUR_MS, timeZone);
  const hours = hoursAbove === 1 ? '1 hour' : `${hoursAbove} hours`;
  const day = formatDay(peak.startMs, nowMs, timeZone);
  return `Your home averaged ${formatKw(peak.kw)} kW from ${from} to ${to} ${day}, `
    + `above ${target}. The hourly average exceeded that target in ${hours} over the last 7 days.`;
};

export const formatHardCapFinding = (finding: HardCapFinding): string => (
  'In about 9 of 10 measured hours over the last 7 days your home averaged at least '
  + `${formatKw(finding.baseLoadKw)} kW, above the ${formatKw(finding.targetKw)} kW PELS aims for under this hard cap.`
);
