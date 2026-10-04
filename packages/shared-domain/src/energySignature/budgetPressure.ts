import type { BudgetPressureState, WeatherDailyRecord } from '../../../contracts/src/weatherAdvisorTypes';

const MAX_STEP_KWH = 10;
const QUIET_DAY_DECAY = 0.75;
const NEGLIGIBLE_KWH = 0.25;

const positive = (value: number | undefined): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
);

/**
 * Trusted day balance on the budget's own axis: what the budget counted
 * (metered less budget-exempt, `kwhBudgetCounted`) against what it allowed.
 * Whole-home `kwhTotal` also counts exempt load the budget never paced, so
 * using it would read an exempt device's energy as an overshoot.
 *
 * Missing/unreliable readings must not invent spare allowance or an overshoot.
 * A record without `kwhBudgetCounted` (rolled up before the field existed)
 * has no measurable balance: absent is not zero, and its whole-home total
 * cannot stand in for it.
 */
function measuredBalanceKwh(record: WeatherDailyRecord): number | undefined {
  if (record.quality.unreliablePower || record.quality.missingKwh) return undefined;
  if (positive(record.appliedBudgetKwh) === 0) return undefined;
  const counted = record.kwhBudgetCounted;
  if (counted === undefined || !Number.isFinite(counted) || counted < 0) return undefined;
  return counted - (record.appliedBudgetKwh as number);
}

/**
 * Feedback prices unresolved, budget-attributed demand rather than all device
 * holds. Spare allowance absorbs heater denial: with enough total energy left,
 * the failure is pacing/scheduling, not evidence for a higher daily allowance.
 * A finalized budget-exhausted task miss proves a shortfall at its deadline and
 * remains evidence even if the house subsequently used less energy.
 * Legacy cumulative denial/hold counters cannot establish recovery or cause and
 * deliberately do not drive either this correction or q90 headroom.
 */
export function unresolvedBudgetShortfallKwh(record: WeatherDailyRecord): number {
  const balance = measuredBalanceKwh(record);
  const heaterDenial = positive(record.suppression?.budgetUnservedKwh);
  const heaterShortfall = heaterDenial > 0 && balance !== undefined
    ? Math.max(0, heaterDenial + balance) : 0;
  const taskDenial = positive(record.suppression?.deadlineMissDeniedKwh);
  const taskShortfall = taskDenial > 0 ? taskDenial + Math.max(0, balance ?? 0) : 0;
  // A heater carrying a smart task may appear in both signals.
  return Math.max(heaterShortfall, taskShortfall);
}

export function dayWasBudgetDamaged(record: WeatherDailyRecord): boolean {
  return unresolvedBudgetShortfallKwh(record) >= NEGLIGIBLE_KWH;
}

/** Once per closed local day. Unused allowance unwinds correction as well as its leak. */
export function foldBudgetPressureDay(
  previous: BudgetPressureState | undefined,
  record: WeatherDailyRecord,
  applicableCeilingKwh?: number,
): BudgetPressureState {
  if (previous !== undefined && record.dateKey <= previous.throughDateKey) return previous;
  const ceiling = positive(applicableCeilingKwh) || Number.POSITIVE_INFINITY;
  const carried = Math.min(positive(previous?.kwh), ceiling);
  const shortfall = unresolvedBudgetShortfallKwh(record);
  const balance = measuredBalanceKwh(record);
  const spare = balance === undefined ? 0 : Math.max(0, -balance);
  // Actual consumption above the allowance is direct evidence that the usage
  // estimate ran low, even when devices ultimately recovered. It corrects the
  // allowance without asserting damage or switching headroom to q90.
  const correction = Math.max(shortfall, Math.max(0, balance ?? 0));
  const next = correction >= NEGLIGIBLE_KWH
    ? Math.min(ceiling, carried + Math.min(MAX_STEP_KWH, correction))
    : Math.max(0, carried * QUIET_DAY_DECAY - Math.min(MAX_STEP_KWH, spare));
  return {
    algorithmVersion: 3,
    kwh: next < NEGLIGIBLE_KWH ? 0 : next,
    throughDateKey: record.dateKey,
  };
}

/** The suggestion owns the final physical and setting clamps. */
export function resolveBudgetPressureKwh(params: { state: BudgetPressureState | undefined }): number {
  return positive(params.state?.kwh);
}
