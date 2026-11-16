import type { SettingsUiPowerPayload } from '../../../contracts/src/settingsUi/power.ts';

/**
 * What the home's own recent usage says about a limit the owner is about to
 * save. Only the settings form asks, so this stays with the settings UI. The
 * history is the hourly energy the power payload already carries: an hour's
 * average never exceeds the real peaks inside it, so a limit below one is a
 * limit the home really stayed above for that whole hour.
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
  readonly currentKw: number | null;
  /** Complete, reliable hours of the last 7 days; empty under a day of history. */
  readonly hours: readonly UsageHour[];
};

export const NO_USAGE_EVIDENCE: LimitUsageEvidence = { currentKw: null, hours: [] };

const isReliable = (startMs: number, periods: readonly { start: number; end: number }[]): boolean => (
  !periods.some((period) => period.start < startMs + HOUR_MS && period.end > startMs)
);

const readCurrentKw = (payload: SettingsUiPowerPayload, nowMs: number): number | null => {
  const { readings, tracker } = payload;
  if (readings.state !== 'received' || nowMs - readings.lastPowerUpdateMs > CURRENT_READING_MAX_AGE_MS) return null;
  const watts = tracker.lastPowerW;
  return typeof watts === 'number' && Number.isFinite(watts) && watts > 0 ? watts / 1000 : null;
};

const readHours = (payload: SettingsUiPowerPayload, nowMs: number): UsageHour[] => {
  const { buckets, unreliablePeriods = [] } = payload.tracker;
  const currentHourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const windowStart = currentHourStart - WINDOW_HOURS * HOUR_MS;
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
    ? { currentKw: readCurrentKw(payload, nowMs), hours: readHours(payload, nowMs) }
    : NO_USAGE_EVIDENCE
);

/** An instantaneous limit (grid import limit, main fuse) the home is already above. */
export type InstantLimitFinding =
  | { readonly kind: 'past_hours'; readonly peak: UsageHour; readonly hoursAbove: number; readonly targetKw: number }
  | { readonly kind: 'current'; readonly currentKw: number; readonly targetKw: number };

/** `targetKw` is where PELS starts reducing loads under the limit. */
export const checkInstantLimit = (targetKw: number, evidence: LimitUsageEvidence): InstantLimitFinding | null => {
  const above = evidence.hours.filter((hour) => hour.kw > targetKw);
  if (above.length > 0) {
    const peak = above.reduce((best, hour) => (hour.kw > best.kw ? hour : best));
    return { kind: 'past_hours', peak, hoursAbove: above.length, targetKw };
  }
  if (evidence.currentKw !== null && evidence.currentKw > targetKw) {
    return { kind: 'current', currentKw: evidence.currentKw, targetKw };
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
export const checkHardCap = (targetKw: number, evidence: LimitUsageEvidence): HardCapFinding | null => {
  if (evidence.hours.length === 0) return null;
  const baseLoadKw = percentile(evidence.hours.map((hour) => hour.kw), BASE_LOAD_PERCENTILE);
  return baseLoadKw > targetKw ? { baseLoadKw, targetKw } : null;
};

// Two decimals under 1 kW, as the limit hints show them.
const formatKw = (kw: number): string => kw.toFixed(kw < 1 ? 2 : 1);

const dayKey = (ms: number, timeZone: string): string => (
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
);

const formatClock = (ms: number, timeZone: string): string => (
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
);

const formatDay = (ms: number, nowMs: number, timeZone: string): string => {
  const day = dayKey(ms, timeZone);
  if (day === dayKey(nowMs, timeZone)) return 'today';
  if (day === dayKey(nowMs - 24 * HOUR_MS, timeZone)) return 'yesterday';
  return `on ${new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(ms)}`;
};

export const formatInstantLimitFinding = (
  finding: InstantLimitFinding,
  nowMs: number,
  timeZone: string,
): string => {
  const target = `the ${formatKw(finding.targetKw)} kW where PELS starts reducing loads`;
  if (finding.kind === 'current') {
    return `Your home is using ${formatKw(finding.currentKw)} kW right now, above ${target}. `
      + 'PELS would start holding back devices at once.';
  }
  const { peak, hoursAbove } = finding;
  const from = formatClock(peak.startMs, timeZone);
  const to = formatClock(peak.startMs + HOUR_MS, timeZone);
  const hours = hoursAbove === 1 ? '1 whole hour' : `${hoursAbove} whole hours`;
  const day = formatDay(peak.startMs, nowMs, timeZone);
  return `Your home averaged ${formatKw(peak.kw)} kW from ${from} to ${to} ${day}, `
    + `above ${target}. It stayed above it for ${hours} in the last 7 days, `
    + 'and PELS would have held back devices all that time.';
};

export const formatHardCapFinding = (finding: HardCapFinding): string => (
  `In 9 of 10 hours over the last 7 days your home used more than ${formatKw(finding.baseLoadKw)} kW, `
  + `above the ${formatKw(finding.targetKw)} kW PELS aims for under this hard cap. `
  + 'PELS could not keep the average under it.'
);
