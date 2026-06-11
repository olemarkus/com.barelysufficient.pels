// Canonical wording for the Usage hero — the "how's today tracking?" delta
// chip, the end-of-day projection subline, and the day-aware comparison line.
// Lives in shared-domain so runtime structured logs can quote the exact wording
// the user reads in the hero (Rule 4 / CLAUDE.md feedback `ui_text_shared_with
// _logs`), matching the sibling `dailyBudgetHeroStrings.ts` and `usageVoice.ts`.
//
// These helpers own the language and punctuation only. The pace/projection math
// and the tone thresholds stay in the settings-ui caller (`usageHero.ts`); the
// caller hands finished numbers in, these return the finished string. `toFixed`
// is plain JS (browser-safe), mirroring `usageVoice.ts` which already formats
// kWh here.
import { formatTypicalDayLine } from './usageVoice';

// Dead-band labels: the chip says one of these when today's delta sits inside
// the "nothing to report" window (the caller owns the threshold check).
export const USAGE_HERO_ON_PACE = 'On pace';
export const USAGE_HERO_ON_TRACK = 'On track';

// Chip label for the elapsed-pace baseline (used in the early-morning window
// where the end-of-day projection is suppressed). Sign follows `diff`.
export const formatVsPaceChipLabel = (diff: number, absDiff: number): string => (
  `${diff > 0 ? '+' : '−'}${absDiff.toFixed(1)} kWh vs pace`
);

// Chip label for the projected-end-of-day-vs-typical baseline. Sign follows
// `projectedDiff`.
export const formatVsTypicalChipLabel = (projectedDiff: number, absDiff: number): string => (
  `${projectedDiff > 0 ? '+' : '−'}${absDiff.toFixed(1)} kWh vs typical`
);

// Projection subline. When the projection lands inside the dead-band the prose
// is a plain "on track" sentence; otherwise it names the direction (the chip
// already carries the kWh delta, so the prose drops the duplicate number).
export const formatProjectionLine = (
  projected: number,
  projectedDiff: number,
  withinDeadBand: boolean,
): string => {
  if (withinDeadBand) {
    return `On track for ~${projected.toFixed(1)} kWh by midnight.`;
  }
  const direction = projectedDiff > 0 ? 'above' : 'below';
  return `On track for ~${projected.toFixed(1)} kWh by midnight (${direction} typical).`;
};

// Day-aware comparison line: "Today · <date>." followed by the typical-day
// voice line (reused from `usageVoice`).
export const formatUsageComparisonLine = (
  todayText: string,
  weekdayIndex: number,
  typicalDayKWh: number,
): string => `Today · ${todayText}. ${formatTypicalDayLine(weekdayIndex, typicalDayKWh)}`;

// Empty/bootstrap line shown before enough history exists for a typical-day
// baseline.
export const formatUsageCollectingLine = (todayText: string): string => (
  `Today · ${todayText}. Collecting history…`
);
