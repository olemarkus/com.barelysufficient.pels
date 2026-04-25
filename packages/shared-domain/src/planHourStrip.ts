export type SoftLimitSource = 'capacity' | 'daily' | 'both';

export type PlanHourStripInput = {
  softLimitSource?: SoftLimitSource;
  usedKWh?: number;
  budgetKWh?: number;
  dailyBudgetHourKWh?: number;
  hourControlledKWh?: number;
  hourUncontrolledKWh?: number;
  minutesRemaining?: number;
};

export type HourStripLabel = {
  primary: string | null;
  secondary: string | null;
  endsInMin: number | null;
  usedKWh: number | null;
  budgetKWh: number | null;
  usedFraction: number | null;
};

const resolveDisplayBudgetKWh = (meta: PlanHourStripInput): number | null => {
  if (typeof meta.usedKWh !== 'number' || typeof meta.budgetKWh !== 'number') return null;
  if (meta.softLimitSource === 'daily' && typeof meta.dailyBudgetHourKWh === 'number') {
    return meta.dailyBudgetHourKWh;
  }
  return meta.budgetKWh;
};

const resolveSecondary = (source: SoftLimitSource | undefined): string | null => {
  if (source === 'daily') return "Keeping within today's budget";
  if (source === 'both') return "Keeping within today's budget and power limit";
  if (source === 'capacity') return 'Keeping under the power limit';
  return null;
};

export const formatHourStripLabel = (meta: PlanHourStripInput | undefined): HourStripLabel => {
  if (!meta) {
    return {
      primary: null,
      secondary: null,
      endsInMin: null,
      usedKWh: null,
      budgetKWh: null,
      usedFraction: null,
    };
  }
  const displayBudget = resolveDisplayBudgetKWh(meta);
  const usedKWh = typeof meta.usedKWh === 'number' ? meta.usedKWh : null;
  const budgetKWh = displayBudget;
  const primary = displayBudget !== null && usedKWh !== null
    ? `${usedKWh.toFixed(2)} of ${displayBudget.toFixed(1)} kWh`
    : null;
  const usedFraction = displayBudget !== null && usedKWh !== null && displayBudget > 0
    ? Math.min(1, Math.max(0, usedKWh / displayBudget))
    : null;
  const endsInMin = typeof meta.minutesRemaining === 'number' && meta.minutesRemaining <= 10
    ? Math.max(0, Math.round(meta.minutesRemaining))
    : null;
  return {
    primary,
    secondary: resolveSecondary(meta.softLimitSource),
    endsInMin,
    usedKWh,
    budgetKWh,
    usedFraction,
  };
};
