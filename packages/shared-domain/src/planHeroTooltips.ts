// Canonical tooltip copy for the Overview hero. Lives in shared-domain so
// the settings UI and any future runtime log line emit identical wording
// (Rule 7, `notes/ui-terminology.md`). Wording is sourced from
// `notes/ui-terminology.md` § "Safe pace now — one label, two possible
// sources" and § "Hero bar vocabulary".

// Mirrors `softLimitSource` in `packages/contracts/src/settingsUiApi.ts` and
// `lib/plan/planTypes.ts`. Declared locally so shared-domain stays free of
// cross-package type pulls — the union is short and stable.
//
// There is no `'both'`. The producer is `resolveSoftLimitSource`
// (`lib/plan/planBuilder.ts`), which is total over exactly these two: when the
// two paces coincide within `SOFT_LIMIT_EPSILON` it answers `'capacity'`, not a
// third "they meet here" state. The member and its copy existed on the wire
// with nothing able to emit them. (Not to be confused with `limitReason` in
// `homeLimitsStatus.ts`, which has a real four-member union including `'both'`.)
export type HeroSoftLimitSource = 'capacity' | 'daily';

export const HERO_INFO_TOOLTIP_TEXT = [
  'Power now is measured in kW — how fast electricity is being used right now.',
  'Energy this hour is measured in kWh — how much has been used so far this hour.',
  'Safe pace is the whole-home power rate where PELS starts reacting.',
  'It can be set by this hour\'s energy pace or today\'s budget pace.',
  'The hard cap is your grid tariff step — an hourly average, so short bursts above it are fine '
  + 'while the hour\'s energy stays under it.',
  'kW is speed. kWh is distance.',
].join(' ');

// Tooltips appended after "Safe pace now {N} kW — ", so each phrase starts in
// lowercase and uses a semicolon (not a second em-dash) as its internal
// separator. Source-specific copy mirrors `notes/ui-terminology.md`.
export const SAFE_PACE_TOOLTIP_BY_SOURCE: Record<HeroSoftLimitSource, string> = {
  capacity: 'the hourly pace sets this marker; PELS starts reacting here.',
  daily: 'today\'s budget sets this marker, which may include power allowed beyond today\'s budget; '
    + 'PELS starts reacting here.',
};

export const HARD_CAP_TOOLTIP
  = 'your grid tariff step; PELS keeps each hour\'s average power under this.';

// Visible on the Power-now subline, not only in the tooltip above.
//
// WHICH ceiling is binding is a house-level fact — the same one for every device
// — so from 2026-08-02 the hero owns it and the device cards stopped repeating
// it once per card (see `planCardReasonLine.ts`). That makes this the only place
// the owner can learn it, and a hover tooltip is not a place: the settings UI
// runs in a touch WebView where nothing hovers.
export const SAFE_PACE_SOURCE_BY_SOURCE: Record<HeroSoftLimitSource, string> = {
  capacity: 'set by this hour\'s pace',
  daily: 'set by today\'s budget',
};

// `null` (rather than the capacity phrase) when the source is unknown: an
// unattributed marker is honest, a guessed attribution is not — and naming the
// hard cap when it is not binding is the specific error
// `feedback_hard_cap_is_physical` warns about.
export const resolveSafePaceSourceText = (
  source: HeroSoftLimitSource | null | undefined,
): string | null => (
  source === 'capacity' || source === 'daily'
    ? SAFE_PACE_SOURCE_BY_SOURCE[source]
    : null
);

const formatKw = (kw: number): string => `${kw.toFixed(1)} kW`;
const roundKw = (kw: number): number => Math.round(kw * 10) / 10;

const resolveSafePaceTooltipBySource = (
  source: HeroSoftLimitSource | null | undefined,
): string => {
  switch (source) {
    case 'daily':
      return SAFE_PACE_TOOLTIP_BY_SOURCE.daily;
    case 'capacity':
    case null:
    case undefined:
      return SAFE_PACE_TOOLTIP_BY_SOURCE.capacity;
    default: {
      // Exhaustiveness guard: a new HeroSoftLimitSource member must pick its
      // own tooltip above rather than silently borrowing the capacity copy.
      const exhaustive: never = source;
      void exhaustive;
      return SAFE_PACE_TOOLTIP_BY_SOURCE.capacity;
    }
  }
};

export const formatSafePaceTooltip = (
  safePaceKw: number,
  source: HeroSoftLimitSource | null | undefined,
  composition?: SafePaceComposition,
): string => {
  const detail = resolveSafePaceComposition(safePaceKw, composition);
  if (source === 'daily' && detail !== null) {
    const compositionDetail = `today's budget paces counted usage at ${formatKw(detail.budgetPaceKw)}, `
      + `plus ${formatKw(detail.projectedExemptKw)} reserved for devices allowed beyond it; `;
    return `Safe pace now ${formatKw(safePaceKw)} — ${compositionDetail}PELS starts reacting here.`;
  }
  return `Safe pace now ${formatKw(safePaceKw)} — ${resolveSafePaceTooltipBySource(source)}`;
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
  source: HeroSoftLimitSource | null | undefined,
  composition: SafePaceComposition,
): string | null => {
  if (source !== 'daily') return null;
  const detail = resolveSafePaceComposition(safePaceKw, composition);
  if (detail === null) return null;
  return `Safe pace reserves ${formatKw(detail.projectedExemptKw)} for devices allowed beyond today's budget; `
    + `usage counted toward today's budget is paced at ${formatKw(detail.budgetPaceKw)}.`;
};

export const formatHardCapTooltip = (hardCapKw: number): string =>
  `Hard cap ${formatKw(hardCapKw)} — ${HARD_CAP_TOOLTIP}`;

// Energy-bar variant: the cap expressed as this hour's kWh ceiling. Appears on
// the bar that carries the "Above hard cap" judgement, so the tooltip names
// the consequence of crossing it.
export const formatHardCapEnergyTooltip = (hardCapKWh: number): string =>
  `Hard cap this hour ${hardCapKWh.toFixed(1)} kWh — landing past this puts the hour on a higher tariff step.`;
