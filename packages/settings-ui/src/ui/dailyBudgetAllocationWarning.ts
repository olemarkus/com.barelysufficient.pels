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
  const planned = formatKWh(pressure.plannedBudgetKWh, 1);
  const requested = formatKWh(pressure.requestedBudgetKWh, 1);
  return {
    title: 'Daily budget is larger than your hourly limit allows',
    body: `Your hourly power limit leaves room for about ${planned} per day, `
      + `but you've set a daily budget of ${requested}. `
      + `PELS has to run flat against the limit and can't shift usage to cheaper hours. `
      + `Lower the daily budget to get full price savings.`,
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
