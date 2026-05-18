import {
  usageHero,
  usageHeroHeadline,
  usageHeroComparison,
  usageHeroDelta,
  usageHeroProjection,
} from './dom.ts';
import { getStartOfDayInTimeZone, getZonedParts } from './timezone.ts';
import { formatTypicalDayLine } from '../../../shared-domain/src/usageVoice.ts';

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
//
// `PROJECTION_ON_TRACK_KWH` is reused by the chip + the prose so both surfaces
// agree on the "On track" dead-band — TODO 490 was about the chip ("vs pace")
// and the prose ("vs typical") publishing two different numbers in the same
// card; they now share the projected-vs-typical baseline so the card surfaces
// a single delta.
//
// The two dead-band constants are deliberately distinct. `PACE_ON_PACE_KWH`
// (0.2) is compared to the elapsed-vs-expected delta — small absolute kWh
// because we're only a fraction of the day in. `PROJECTION_ON_TRACK_KWH`
// (0.3) is compared to the projected-end-of-day-vs-typical delta — slightly
// larger because the projection extrapolates the partial-day delta to the
// full day.
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

const getZonedWeekday = (date: Date, timeZone: string): number => {
  const { year, month, day } = getZonedParts(date, timeZone);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

export type PaceContext = {
  diff: number;
  absDiff: number;
  expectedSoFar: number;
  projected: number | null;
  fractionOfDay: number;
  typicalDay: number;
};

// Maps a positive over-delta and its base to the same `ok | warn | alert`
// tone the hero rim uses (see `resolveHeroTone`). Shared between the pace
// and projection branches of `formatDeltaChipLabel` so the chip tone never
// disagrees with the hero rim regardless of which branch evaluated it.
const resolveOverDeltaTone = (overDelta: number, base: number): ChipTone => {
  const ratio = overDelta / Math.max(base, 0.1);
  const absDelta = Math.abs(overDelta);
  if (ratio > ALERT_PACE_RATIO && absDelta >= ALERT_PACE_ABS_KWH) return 'alert';
  if (ratio > WARN_PACE_RATIO && absDelta >= WARN_PACE_ABS_KWH) return 'warn';
  return 'ok';
};

// Chip + prose share the projected-vs-typical baseline so the card surfaces
// a single delta (TODO 490). When the projection window is suppressed (first
// ~2.4 h of the day — see `MIN_PROJECTION_FRACTION`) the chip falls back to
// the elapsed-pace delta, since projecting from a handful of minutes amplifies
// noise; the comparison subline still names the typical-day target so users
// see the baseline.
export const formatDeltaChipLabel = (ctx: PaceContext): { label: string; tone: ChipTone } => {
  if (ctx.projected === null) {
    if (ctx.absDiff < PACE_ON_PACE_KWH) {
      return { label: 'On pace', tone: 'ok' };
    }
    if (ctx.diff > 0) {
      return {
        label: `+${ctx.absDiff.toFixed(1)} kWh vs pace`,
        tone: resolveOverDeltaTone(ctx.diff, ctx.expectedSoFar),
      };
    }
    return { label: `−${ctx.absDiff.toFixed(1)} kWh vs pace`, tone: 'ok' };
  }
  const projectedDiff = ctx.projected - ctx.typicalDay;
  const absDiff = Math.abs(projectedDiff);
  if (absDiff < PROJECTION_ON_TRACK_KWH) {
    return { label: 'On track', tone: 'ok' };
  }
  if (projectedDiff > 0) {
    return {
      label: `+${absDiff.toFixed(1)} kWh vs typical`,
      tone: resolveOverDeltaTone(projectedDiff, ctx.typicalDay),
    };
  }
  return { label: `−${absDiff.toFixed(1)} kWh vs typical`, tone: 'ok' };
};

export const formatProjectionText = (ctx: PaceContext): string | null => {
  if (ctx.projected === null) return null;
  // Tightened copy: the chip already carries the delta + direction, so the
  // prose just names the landing figure in plain language. "Tonight" replaces
  // "by midnight" because users live in a day-of-week vocabulary, not clocks.
  return `On pace to finish near ${ctx.projected.toFixed(1)} kWh tonight.`;
};

export const resolveHeroTone = (ctx: PaceContext): 'ok' | 'warn' | 'alert' => {
  // When the projection window is open, mirror the chip's projected-vs-typical
  // baseline so the hero rim and the delta chip never disagree. The earlier
  // pace-based logic falls back in the early-morning window where projection
  // is suppressed and the chip already uses the elapsed-pace delta.
  if (ctx.projected !== null) {
    const projectedDiff = ctx.projected - ctx.typicalDay;
    const absDiff = Math.abs(projectedDiff);
    if (projectedDiff > ctx.typicalDay * ALERT_PACE_RATIO && absDiff >= ALERT_PACE_ABS_KWH) {
      return 'alert';
    }
    if (projectedDiff > ctx.typicalDay * WARN_PACE_RATIO && absDiff >= WARN_PACE_ABS_KWH) {
      return 'warn';
    }
    return 'ok';
  }
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

  const now = new Date();
  const weekdayIndex = getZonedWeekday(now, timeZone);
  const isWeekend = weekdayIndex === 0 || weekdayIndex === 6;
  const typicalDay = isWeekend ? stats.weekendAvg : stats.weekdayAvg;
  if (!stats.hasPatternData || typicalDay <= 0) {
    renderHeroEmpty(todayText);
    return;
  }

  const ctx = computePaceContext(stats.today, typicalDay, now, timeZone);
  setElementText(
    usageHeroComparison,
    `Today · ${todayText}. ${formatTypicalDayLine(weekdayIndex, typicalDay)}`,
  );

  const chip = formatDeltaChipLabel(ctx);
  setHeroChip(usageHeroDelta, chip.label, chip.tone);
  setElementText(usageHeroProjection, formatProjectionText(ctx));
  setHeroTone(usageHero, resolveHeroTone(ctx));
};
