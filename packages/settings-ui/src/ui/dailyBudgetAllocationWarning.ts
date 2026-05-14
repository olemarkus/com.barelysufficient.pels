import type { DailyBudgetDayPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
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
  const body = ceilingKWh > 0
    ? `You've set ${configured}, but at most ${formatKWh(ceilingKWh, 1)} fits within your `
      + `hourly power limit. Lower the daily budget to that or below so PELS can shift usage `
      + `to cheaper hours.`
    : `You've set a daily budget of ${configured}, which is more than your hourly power limit `
      + `can deliver in a day. Lower the daily budget so PELS can shift usage to cheaper hours.`;
  return {
    title: 'Daily budget is larger than your hourly limit allows',
    body,
  };
};

export const setDailyBudgetAllocationWarning = (
  element: HTMLElement | null,
  payload: DailyBudgetDayPayload | null,
) => {
  const target = element;
  if (!target) return;
  const textEl = target.querySelector('.banner__text') as HTMLElement | null;
  const warning = resolveAllocationWarning(payload);
  if (!warning) {
    target.hidden = true;
    if (textEl) textEl.textContent = '';
    return;
  }
  if (textEl) textEl.textContent = `${warning.title}. ${warning.body}`;
  target.hidden = false;
};
