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
  if (overHardLimit) return 'Over the hard limit';
  if (overSoftLimit) return 'Over the power limit';
  if (capacityShortfall) return 'Keeping power under the limit';
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
