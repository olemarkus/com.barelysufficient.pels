// Canonical tooltip copy for the Overview hero. Lives with its browser consumer;
// any future runtime log line must first establish a genuine shared consumer
// (Rule 7, `notes/ui-terminology.md`). Wording is sourced from
// `notes/ui-terminology.md` § "Safe pace now — one label, two possible
// sources" and § "Hero bar vocabulary".

import type { CapacityPeriodMinutes } from '../../../contracts/src/capacitySettings.ts';
import { capacityPeriodNoun } from './capacityPeriodCopy.ts';

// The pacing sources that put a safe-pace marker and source clause on the hero.
// `softLimitSource` (`lib/plan/planContext.ts`) can also answer `'grid'`, when
// the grid import limit's working target binds, and `null`, when no limit is on;
// the hero shows neither as a safe pace (`notes/ui-terminology.md` § "Grid import
// limit and optional capacity control"), so callers narrow before asking here.
// (Not to be confused with `limitReason` in `homeLimitsStatus.ts`, which has a
// real four-member union including `'both'`.)
export type SafePaceSource = 'capacity' | 'daily';

export const HERO_INFO_TOOLTIP_TEXT = [
  'Power now is measured in kW — how fast electricity is being used right now.',
  'Energy this hour is measured in kWh — how much has been used so far this hour.',
  'Safe pace is the whole-home power rate where PELS starts reacting.',
  'It can be set by this hour\'s energy pace or today\'s budget pace.',
  'The hard cap is your grid tariff step — an hourly average, so short bursts above it are fine '
  + 'while the hour\'s energy stays under it.',
  'kW is speed. kWh is distance.',
].join(' ');

export const formatHeroInfoTooltip = (
  periodMinutes: CapacityPeriodMinutes,
  capacityEnabled: boolean,
  gridEnabled: boolean,
): string => {
  const gridText = gridEnabled
    ? 'Grid import limit applies to the latest observed net power from the grid. '
      + 'PELS leaves an automatic margin and reduces flexible loads when import rises. '
      + 'Temporary overshoot is possible while meter readings and devices catch up.'
    : '';
  if (!capacityEnabled) return [
    'Power now is how fast the home draws from the grid right now, in kW.',
    gridText,
    'With Capacity limit off, Safe pace comes from your daily budget when you set one: '
      + 'the whole-home rate where PELS starts reacting.',
  ].filter(Boolean).join(' ');
  const capacityText = formatCapacityHeroInfoTooltip(periodMinutes);
  return [capacityText, gridText].filter(Boolean).join(' ');
};

const formatCapacityHeroInfoTooltip = (periodMinutes: CapacityPeriodMinutes): string => {
  if (periodMinutes === 60) return HERO_INFO_TOOLTIP_TEXT;
  return [
    'Power now is measured in kW — how fast electricity is being used right now.',
    'Energy this quarter is measured in kWh — how much has been used so far this quarter.',
    'Safe pace is the whole-home power rate where PELS starts reacting.',
    'It can be set by this quarter\'s energy pace or today\'s budget pace.',
    'The hard cap is your grid tariff step, measured as a 15-minute average.',
    'PELS keeps each quarter at or below the hard cap minus your safety margin, '
      + 'and does not save unused energy for later in the quarter.',
    'kW is speed. kWh is distance.',
  ].join(' ');
};

// Tooltips appended after "Safe pace now {N} kW — ", so each phrase starts in
// lowercase and uses a semicolon (not a second em-dash) as its internal
// separator. Source-specific copy mirrors `notes/ui-terminology.md`.
export const SAFE_PACE_TOOLTIP_BY_SOURCE: Record<'capacity' | 'daily', string> = {
  capacity: 'the hourly pace sets this marker; PELS starts reacting here.',
  daily: 'today\'s budget sets this marker, which may include power allowed beyond today\'s budget; '
    + 'PELS starts reacting here.',
};

// Visible on the Power-now subline, not only in the tooltip above.
//
// WHICH ceiling is binding is a house-level fact — the same one for every device
// — so from 2026-08-02 the hero owns it and the device cards stopped repeating
// it once per card (see `planCardReasonLine.ts`). That makes this the only place
// the owner can learn it, and a hover tooltip is not a place: the settings UI
// runs in a touch WebView where nothing hovers.
export const SAFE_PACE_SOURCE_BY_SOURCE: Record<'capacity' | 'daily', string> = {
  capacity: 'set by this hour\'s pace',
  daily: 'set by today\'s budget',
};

export const resolveSafePaceSourceText = (
  source: SafePaceSource,
  periodMinutes: CapacityPeriodMinutes,
): string => {
  if (source === 'capacity' && periodMinutes === 15) return 'set by this quarter\'s pace';
  return SAFE_PACE_SOURCE_BY_SOURCE[source];
};

const formatKw = (kw: number): string => `${kw.toFixed(1)} kW`;
const roundKw = (kw: number): number => Math.round(kw * 10) / 10;

const resolveSafePaceTooltipBySource = (
  source: SafePaceSource,
  periodMinutes: CapacityPeriodMinutes,
): string => {
  switch (source) {
    case 'daily':
      return SAFE_PACE_TOOLTIP_BY_SOURCE.daily;
    case 'capacity':
      return periodMinutes === 15
        ? 'the quarter-hour pace sets this marker; PELS starts reacting here.'
        : SAFE_PACE_TOOLTIP_BY_SOURCE.capacity;
    default: {
      // Exhaustiveness guard: a new SafePaceSource member must pick its
      // own tooltip above rather than silently borrowing the capacity copy.
      const exhaustive: never = source;
      void exhaustive;
      return SAFE_PACE_TOOLTIP_BY_SOURCE.capacity;
    }
  }
};

export const formatSafePaceTooltip = (
  safePaceKw: number,
  source: SafePaceSource,
  periodMinutes: CapacityPeriodMinutes,
  composition?: SafePaceComposition,
): string => {
  const detail = resolveSafePaceComposition(safePaceKw, composition);
  if (source === 'daily' && detail !== null) {
    const compositionDetail = `today's budget paces counted usage at ${formatKw(detail.budgetPaceKw)}, `
      + `plus ${formatKw(detail.projectedExemptKw)} reserved for devices allowed beyond it; `;
    return `Safe pace now ${formatKw(safePaceKw)} — ${compositionDetail}PELS starts reacting here.`;
  }
  return `Safe pace now ${formatKw(safePaceKw)} — ${resolveSafePaceTooltipBySource(source, periodMinutes)}`;
};

export type SafePaceComposition = {
  budgetPaceKw?: number | null;
  projectedExemptKw?: number | null;
};

const resolveSafePaceComposition = (
  safePaceKw: number,
  composition: SafePaceComposition | null | undefined,
): { budgetPaceKw: number; projectedExemptKw: number } | null => {
  const budgetPaceKw = composition?.budgetPaceKw;
  const projectedExemptKw = composition?.projectedExemptKw;
  if (
    typeof budgetPaceKw !== 'number'
    || !Number.isFinite(budgetPaceKw)
    || budgetPaceKw < 0
    || typeof projectedExemptKw !== 'number'
    || !Number.isFinite(projectedExemptKw)
    || projectedExemptKw < 0.05
    || !Number.isFinite(safePaceKw)
    || Math.abs(safePaceKw - budgetPaceKw - projectedExemptKw) > 0.11
  ) {
    return null;
  }
  const displayedSafePaceKw = roundKw(safePaceKw);
  const displayedProjectedExemptKw = roundKw(projectedExemptKw);
  return {
    budgetPaceKw: roundKw(displayedSafePaceKw - displayedProjectedExemptKw),
    projectedExemptKw: displayedProjectedExemptKw,
  };
};

export const formatSafePaceComposition = (
  safePaceKw: number,
  source: SafePaceSource,
  composition: SafePaceComposition,
): string | null => {
  if (source !== 'daily') return null;
  const detail = resolveSafePaceComposition(safePaceKw, composition);
  if (detail === null) return null;
  return `Safe pace reserves ${formatKw(detail.projectedExemptKw)} for devices allowed beyond today's budget; `
    + `usage counted toward today's budget is paced at ${formatKw(detail.budgetPaceKw)}.`;
};

// Energy-bar variant: the cap expressed as this hour's kWh ceiling. Appears on
// the bar that carries the "Above hard cap" judgement, so the tooltip names
// the consequence of crossing it.
export const formatHardCapEnergyTooltip = (
  hardCapKWh: number,
  periodMinutes: CapacityPeriodMinutes,
): string => {
  const period = capacityPeriodNoun(periodMinutes);
  return `Hard cap this ${period} ${hardCapKWh.toFixed(1)} kWh — landing past this raises the measured peak.`;
};
