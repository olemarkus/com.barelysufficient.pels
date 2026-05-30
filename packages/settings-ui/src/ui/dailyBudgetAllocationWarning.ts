import type { DailyBudgetDayPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import {
  DAILY_BUDGET_ALLOCATION_WARNING_TITLE,
  formatDailyBudgetAllocationWarningBody,
} from '../../../shared-domain/src/dailyBudgetWarningStrings.ts';
import { formatKWh } from './dailyBudgetFormat.ts';

export type AllocationWarning = {
  title: string;
  body: string;
};

export const resolveAllocationWarning = (
  payload: DailyBudgetDayPayload | null,
): AllocationWarning | null => {
  const pressure = payload?.state.allocationPressure;
  if (!pressure?.constrained) return null;
  // `constrained` reflects remaining-day saturation, so it can fire even when the
  // configured daily budget is already at or below the full-day ceiling. In that
  // case lowering the setting would not help, so suppress the warning entirely.
  const ceilingKWh = pressure.maxFittingDailyBudgetKWh;
  if (ceilingKWh > 0 && payload.budget.dailyBudgetKWh <= ceilingKWh) return null;
  const configured = formatKWh(payload.budget.dailyBudgetKWh, 1);
  const ceilingText = ceilingKWh > 0 ? formatKWh(ceilingKWh, 1) : null;
  return {
    title: DAILY_BUDGET_ALLOCATION_WARNING_TITLE,
    body: formatDailyBudgetAllocationWarningBody(configured, ceilingText),
  };
};

