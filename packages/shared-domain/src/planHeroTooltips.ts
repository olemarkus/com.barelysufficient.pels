// Canonical tooltip copy for the Overview hero. Lives in shared-domain so
// the settings UI and any future runtime log line emit identical wording
// (Rule 7, `notes/ui-terminology.md`). Wording is sourced from
// `notes/ui-terminology.md` § "Safe pace now — one label, two possible
// sources" and § "Hero bar vocabulary".

// Mirrors `softLimitSource` in `packages/contracts/src/settingsUiApi.ts` and
// `lib/plan/planTypes.ts`. Declared locally so shared-domain stays free of
// cross-package type pulls — the union is short and stable.
export type HeroSoftLimitSource = 'capacity' | 'daily' | 'both';

export const HERO_INFO_TOOLTIP_TEXT = [
  'Power now is measured in kW — how fast electricity is being used right now.',
  'Energy this hour is measured in kWh — how much has been used so far this hour.',
  'Safe pace is the highest power rate that keeps this hour on track for the energy budget.',
  'kW is speed. kWh is distance.',
].join(' ');

// Tooltips appended after "Safe pace now {N} kW — ", so each phrase starts in
// lowercase. Source-specific copy mirrors `notes/ui-terminology.md`.
export const SAFE_PACE_TOOLTIP_BY_SOURCE: Record<HeroSoftLimitSource, string> = {
  capacity: 'hourly power limit minus safety margin, PELS starts reacting here.',
  daily: 'slowed to stay within today’s budget — daily pacing is the tighter constraint right now.',
  both: 'both capacity and daily pacing are constraining PELS right now.',
};

export const HARD_CAP_TOOLTIP
  = 'your configured maximum, staying under this avoids tariff steps or breaker trips.';

const formatKw = (kw: number): string => `${kw.toFixed(1)} kW`;

const resolveSafePaceTooltipBySource = (
  source: HeroSoftLimitSource | null | undefined,
): string => {
  switch (source) {
    case 'daily':
      return SAFE_PACE_TOOLTIP_BY_SOURCE.daily;
    case 'both':
      return SAFE_PACE_TOOLTIP_BY_SOURCE.both;
    default:
      return SAFE_PACE_TOOLTIP_BY_SOURCE.capacity;
  }
};

export const formatSafePaceTooltip = (
  safePaceKw: number,
  source: HeroSoftLimitSource | null | undefined,
): string => `Safe pace now ${formatKw(safePaceKw)} — ${resolveSafePaceTooltipBySource(source)}`;

export const formatHardCapTooltip = (hardCapKw: number): string =>
  `Hard cap ${formatKw(hardCapKw)} — ${HARD_CAP_TOOLTIP}`;
