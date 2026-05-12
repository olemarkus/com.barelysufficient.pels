import {
  usageHero,
  usageHeroHeadline,
  usageHeroComparison,
  usageHeroDelta,
  usageHeroProjection,
  usageWeeklyAvg,
} from './dom.ts';
import { getStartOfDayInTimeZone, getZonedParts } from './timezone.ts';

export type PowerStatsLike = {
  today: number;
  weekdayAvg: number;
  weekendAvg: number;
  hasPatternData: boolean;
};

type ChipTone = 'ok' | 'warn' | 'alert' | 'muted';

const CHIP_TONE_CLASSES: readonly string[] = [
  'plan-chip--ok',
  'plan-chip--warn',
  'plan-chip--alert',
  'plan-chip--muted',
];

// Pace evaluation thresholds (kWh and ratios). Named to make the hero behavior
// auditable without re-reading the implementation.
const PACE_ON_PACE_KWH = 0.2;
const PROJECTION_ON_TRACK_KWH = 0.3;
const WARN_PACE_RATIO = 0.1;
const WARN_PACE_ABS_KWH = 0.3;
const ALERT_PACE_RATIO = 0.25;
const ALERT_PACE_ABS_KWH = 0.5;

// Below this fraction of the day, projecting to midnight amplifies noise (e.g. one
// kettle boil early in the morning would balloon into a wildly high projection).
// Pace chip still tracks against the elapsed-time expectation, but the projection
// text is suppressed.
const MIN_PROJECTION_FRACTION = 0.1;

const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = 60_000;

const setHeroTone = (hero: HTMLElement | null, tone: 'ok' | 'warn' | 'alert') => {
  hero?.setAttribute('data-tone', tone);
};

const setHeroChip = (chip: HTMLElement | null, label: string, tone: ChipTone) => {
  if (!chip) return;
  const target = chip;
  target.textContent = label;
  target.classList.remove(...CHIP_TONE_CLASSES);
  target.classList.add(`plan-chip--${tone}`);
  target.hidden = false;
};

const setElementText = (el: HTMLElement | null, text: string | null) => {
  if (!el) return;
  const target = el;
  if (text === null) {
    target.hidden = true;
    return;
  }
  target.textContent = text;
  target.hidden = false;
};

const isWeekendDate = (date: Date, timeZone: string): boolean => {
  const { year, month, day } = getZonedParts(date, timeZone);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
};

export const computeBlendedDailyAvg = (stats: PowerStatsLike): number => {
  const hasWeekday = stats.weekdayAvg > 0;
  const hasWeekend = stats.weekendAvg > 0;
  if (hasWeekday && hasWeekend) {
    return (stats.weekdayAvg * 5 + stats.weekendAvg * 2) / 7;
  }
  if (hasWeekday) return stats.weekdayAvg;
  if (hasWeekend) return stats.weekendAvg;
  return 0;
};

export type PaceContext = {
  diff: number;
  absDiff: number;
  expectedSoFar: number;
  projected: number | null;
  fractionOfDay: number;
  typicalDay: number;
};

export const formatDeltaChipLabel = (ctx: PaceContext): { label: string; tone: ChipTone } => {
  if (ctx.absDiff < PACE_ON_PACE_KWH) {
    return { label: 'On pace', tone: 'ok' };
  }
  if (ctx.diff > 0) {
    const ratio = ctx.diff / Math.max(ctx.expectedSoFar, 0.1);
    const tone: ChipTone = ratio > ALERT_PACE_RATIO ? 'alert' : 'warn';
    return { label: `+${ctx.absDiff.toFixed(1)} kWh vs pace`, tone };
  }
  return { label: `−${ctx.absDiff.toFixed(1)} kWh vs pace`, tone: 'ok' };
};

export const formatProjectionText = (ctx: PaceContext): string | null => {
  if (ctx.projected === null) return null;
  const projectedDiff = ctx.projected - ctx.typicalDay;
  if (Math.abs(projectedDiff) < PROJECTION_ON_TRACK_KWH) {
    return `On track for ~${ctx.projected.toFixed(1)} kWh by midnight.`;
  }
  const direction = projectedDiff > 0 ? 'above' : 'below';
  const gap = Math.abs(projectedDiff).toFixed(1);
  return `On track for ~${ctx.projected.toFixed(1)} kWh — about ${gap} kWh ${direction} typical.`;
};

export const resolveHeroTone = (ctx: PaceContext): 'ok' | 'warn' | 'alert' => {
  if (ctx.diff > ctx.expectedSoFar * ALERT_PACE_RATIO && ctx.absDiff >= ALERT_PACE_ABS_KWH) {
    return 'alert';
  }
  if (ctx.diff > ctx.expectedSoFar * WARN_PACE_RATIO && ctx.absDiff >= WARN_PACE_ABS_KWH) {
    return 'warn';
  }
  return 'ok';
};

// Length of the local day containing `now` in minutes, accounting for DST
// transitions (spring-forward = 1380, fall-back = 1500). Falls back to a flat
// 24h day if the timezone helpers cannot resolve the next midnight.
const localDayLengthMinutes = (now: Date, timeZone: string): number => {
  const dayStartMs = getStartOfDayInTimeZone(now, timeZone);
  const probe = new Date(dayStartMs + 26 * MINUTES_PER_HOUR * MS_PER_MINUTE);
  const nextDayStartMs = getStartOfDayInTimeZone(probe, timeZone);
  const lengthMs = nextDayStartMs - dayStartMs;
  const lengthMinutes = Math.round(lengthMs / MS_PER_MINUTE);
  return Number.isFinite(lengthMinutes) && lengthMinutes > 0
    ? lengthMinutes
    : 24 * MINUTES_PER_HOUR;
};

export const computePaceContext = (
  todayKWh: number,
  typicalDay: number,
  now: Date,
  timeZone: string,
): PaceContext => {
  const dayLengthMinutes = localDayLengthMinutes(now, timeZone);
  const dayStartMs = getStartOfDayInTimeZone(now, timeZone);
  const minutesElapsed = Math.max(0, Math.min(
    dayLengthMinutes,
    Math.round((now.getTime() - dayStartMs) / MS_PER_MINUTE),
  ));
  const fractionOfDay = minutesElapsed / dayLengthMinutes;
  const expectedSoFar = typicalDay * fractionOfDay;
  const diff = todayKWh - expectedSoFar;
  // Floor only the projection division; expectedSoFar must reach 0 at midnight
  // so the chip tone isn't biased upward right after the day rolls over.
  const projectionDenom = Math.max(0.001, fractionOfDay);
  return {
    diff,
    absDiff: Math.abs(diff),
    expectedSoFar,
    projected: fractionOfDay >= MIN_PROJECTION_FRACTION ? todayKWh / projectionDenom : null,
    fractionOfDay,
    typicalDay,
  };
};

const renderHeroEmpty = (todayText: string) => {
  setElementText(usageHeroComparison, `Today · ${todayText}. Collecting history…`);
  if (usageHeroDelta) usageHeroDelta.hidden = true;
  if (usageHeroProjection) usageHeroProjection.hidden = true;
  setHeroTone(usageHero, 'ok');
};

export const renderUsageHero = (
  stats: PowerStatsLike,
  timeZone: string,
  todayText: string,
): void => {
  if (usageHeroHeadline) usageHeroHeadline.textContent = `${stats.today.toFixed(1)} kWh today`;
  if (usageWeeklyAvg) {
    usageWeeklyAvg.textContent = stats.hasPatternData
      ? `${computeBlendedDailyAvg(stats).toFixed(1)} kWh`
      : '-- kWh';
  }

  const now = new Date();
  const isWeekend = isWeekendDate(now, timeZone);
  const typicalDay = isWeekend ? stats.weekendAvg : stats.weekdayAvg;
  if (!stats.hasPatternData || typicalDay <= 0) {
    renderHeroEmpty(todayText);
    return;
  }

  const ctx = computePaceContext(stats.today, typicalDay, now, timeZone);
  const typicalLabel = isWeekend ? 'weekend' : 'weekday';
  setElementText(
    usageHeroComparison,
    `Today · ${todayText}. Typical ${typicalLabel}: ${typicalDay.toFixed(1)} kWh.`,
  );

  const chip = formatDeltaChipLabel(ctx);
  setHeroChip(usageHeroDelta, chip.label, chip.tone);
  setElementText(usageHeroProjection, formatProjectionText(ctx));
  setHeroTone(usageHero, resolveHeroTone(ctx));
};
