import { formatRelativeTime } from './planFormatUtils.ts';

export type PlanHeroMetaInput = {
  totalKw?: number;
  softLimitKw?: number;
  headroomKw?: number;
  hardCapLimitKw?: number | null;
  hardCapHeadroomKw?: number | null;
  controlledKw?: number;
  uncontrolledKw?: number;
  capacityShortfall?: boolean;
  shortfallBudgetThresholdKw?: number;
  lastPowerUpdateMs?: number;
};

export type PowerFreshnessState = 'fresh' | 'stale_hold' | 'stale_fail_closed';

export type HeroTone = 'ok' | 'warn' | 'alert';

export type HeroHeadline = {
  totalKw: number;
  softLimitKw: number;
  hardLimitKw: number | null;
  controlledKw: number | null;
  uncontrolledKw: number | null;
  headroomKw: number;
  overSoftLimit: boolean;
  overHardLimit: boolean;
  kwText: string;
  limitText: string;
  message: string;
  tone: HeroTone;
  ageText: string | null;
};

export type FreshnessChipView = {
  kind: PowerFreshnessState;
  label: string;
  tone: HeroTone;
};

const resolveTone = (overSoftLimit: boolean, overHardLimit: boolean): HeroTone => {
  if (overHardLimit) return 'alert';
  if (overSoftLimit) return 'warn';
  return 'ok';
};

const resolveMessage = (params: {
  headroomKw: number;
  overSoftLimit: boolean;
  overHardLimit: boolean;
  capacityShortfall: boolean;
}): string => {
  const { headroomKw, overSoftLimit, overHardLimit, capacityShortfall } = params;
  if (overHardLimit) return 'Above hard cap';
  if (overSoftLimit) return 'Above safe pace';
  if (capacityShortfall) return 'Keeping power under the hard cap';
  const spare = Math.max(0, headroomKw);
  return `${spare.toFixed(1)} kW to spare`;
};

export const formatHeroHeadline = (
  meta: PlanHeroMetaInput | undefined,
  nowMs: number,
): HeroHeadline | null => {
  if (!meta) return null;
  const { totalKw, softLimitKw, headroomKw } = meta;
  if (typeof totalKw !== 'number' || typeof softLimitKw !== 'number' || typeof headroomKw !== 'number') {
    return null;
  }

  const hardCapLimitKw = typeof meta.hardCapLimitKw === 'number' ? meta.hardCapLimitKw : null;
  const hardCapHeadroomKw = typeof meta.hardCapHeadroomKw === 'number' ? meta.hardCapHeadroomKw : null;
  const hardLimitKw = hardCapLimitKw;
  const overSoftLimit = headroomKw < 0;
  const overHardLimit = hardCapHeadroomKw !== null && hardCapHeadroomKw < 0;
  const tone = resolveTone(overSoftLimit, overHardLimit);
  const message = resolveMessage({
    headroomKw,
    overSoftLimit,
    overHardLimit,
    capacityShortfall: meta.capacityShortfall === true,
  });
  const ageText = typeof meta.lastPowerUpdateMs === 'number'
    ? formatRelativeTime(meta.lastPowerUpdateMs, nowMs)
    : null;

  return {
    totalKw,
    softLimitKw,
    hardLimitKw,
    controlledKw: typeof meta.controlledKw === 'number' ? meta.controlledKw : null,
    uncontrolledKw: typeof meta.uncontrolledKw === 'number' ? meta.uncontrolledKw : null,
    headroomKw,
    overSoftLimit,
    overHardLimit,
    kwText: `${totalKw.toFixed(1)} kW`,
    limitText: `of ${softLimitKw.toFixed(1)} kW limit`,
    message,
    tone,
    ageText,
  };
};

export const formatFreshnessChip = (
  state: PowerFreshnessState | undefined,
): FreshnessChipView | null => {
  if (!state) return null;
  if (state === 'fresh') return { kind: state, label: 'Live', tone: 'ok' };
  if (state === 'stale_hold') return { kind: state, label: 'Delayed', tone: 'warn' };
  return { kind: state, label: 'No data', tone: 'alert' };
};

/**
 * Formats the "energy used this hour" headline shown on the Overview hero and
 * emitted by the runtime logger so logs match the on-screen wording verbatim.
 * One decimal precision is applied to both sides to keep the pair consistent.
 */
export const formatEnergyUsedOfBudget = (usedKWh: number, budgetKWh: number): string =>
  `${usedKWh.toFixed(1)} of ${budgetKWh.toFixed(1)} kWh used`;

// ─── Hero meter marker labels ────────────────────────────────────────────────
// Source of truth for every "what is this dot on the bar?" label the Overview
// hero exposes — used both as `aria-label` (screen-reader) and as the visible
// legend row below the bar. Wording matches `notes/ui-terminology.md`
// § "Hero bar vocabulary" so the screen-reader text mirrors the visible chip /
// tooltip copy. The runtime logger imports these helpers when it emits
// hero-render diagnostics so the wording never drifts between the UI and the
// logs (see `feedback_ui_text_shared_with_logs.md`).

export type HeroMeterMarkerLabels = {
  // Concise legend label, no value — e.g. "Safe pace".
  short: string;
  // Screen-reader label with the numeric value — e.g. "Safe pace now 12.0 kW".
  aria: string;
};

const formatKw = (kw: number): string => `${kw.toFixed(1)} kW`;
const formatKWh = (kwh: number): string => `${kwh.toFixed(1)} kWh`;

export const formatPowerMeterMarkerLabels = (
  kind: 'target' | 'cap',
  valueKw: number,
): HeroMeterMarkerLabels => {
  if (kind === 'cap') {
    return { short: 'Hard cap', aria: `Hard cap ${formatKw(valueKw)}` };
  }
  return { short: 'Safe pace', aria: `Safe pace now ${formatKw(valueKw)}` };
};

export const formatEnergyMeterMarkerLabels = (
  kind: 'target' | 'projected',
  valueKWh: number,
): HeroMeterMarkerLabels => {
  if (kind === 'projected') {
    return {
      short: 'Projected this hour',
      aria: `Projected this hour ${formatKWh(valueKWh)}`,
    };
  }
  return { short: 'Budget this hour', aria: `Budget this hour ${formatKWh(valueKWh)}` };
};

// ─── Above-safe-pace / above-hard-cap subline ────────────────────────────────
// `headroomKw` is the spare room before safe pace (negative when above).
// `hardCapHeadroomKw` is the spare room before hard cap (negative when above).
// The subline copy matches `notes/overview-hero-spec.md` § "Power now" and is
// rendered when the chip indicates the hero is above one of the thresholds.

// Keep the safe-pace numeric reference visible in the above-safe-pace state so
// the user can compare "how much over" against the actual target. Spec:
// `notes/overview-hero-spec.md` § "Power now".
export const formatAboveSafePaceSubline = (headroomKw: number, safePaceKw: number): string => {
  const overshootKw = Math.max(0, -headroomKw);
  return `${formatKw(overshootKw)} above safe pace (${formatKw(safePaceKw)})`;
};

export const formatAboveHardCapSubline = (
  hardCapHeadroomKw: number,
  hardCapKw: number,
): string => {
  const overshootKw = Math.max(0, -hardCapHeadroomKw);
  return `${formatKw(overshootKw)} above hard cap (${formatKw(hardCapKw)})`;
};

// Energy-bar scale used by the Overview hero. When projected is at-or-below
// budget the budget marker sits at 100 % so the projected dot's visual position
// matches the printed `projected / budget` ratio; when projected overshoots,
// the scale tracks the projection (with 5 % headroom) so the overshoot is
// visible past the budget marker. Source: TODO #5 fix, 2026-05-17.
export const computeEnergyBarScaleKWh = (
  budgetKWh: number,
  projectedKWh: number | null,
  usedKWh: number,
): number => {
  const overshoot = Math.max(projectedKWh ?? 0, usedKWh);
  if (overshoot <= budgetKWh) return budgetKWh;
  return overshoot * 1.05;
};
