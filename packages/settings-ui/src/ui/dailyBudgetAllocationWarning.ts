import type { DailyBudgetDayPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import { formatKWh } from './dailyBudgetFormat.ts';

export const setDailyBudgetAllocationWarning = (
  element: HTMLElement | null,
  payload: DailyBudgetDayPayload | null,
) => {
  const target = element;
  if (!target) return;
  const textEl = target.querySelector('.banner__text') as HTMLElement | null;
  const pressure = payload?.state.allocationPressure;
  if (!pressure?.constrained) {
    target.hidden = true;
    if (textEl) textEl.textContent = '';
    return;
  }

  const unallocated = formatKWh(pressure.unallocatedBudgetKWh, 1);
  const planned = formatKWh(pressure.plannedBudgetKWh, 1);
  const requested = formatKWh(pressure.requestedBudgetKWh, 1);
  if (textEl) {
    textEl.textContent = formatAllocationPressureWarning({
      planned,
      requested,
      unallocated,
    });
  }
  target.hidden = false;
};

function formatAllocationPressureWarning(parts: {
  planned: string;
  requested: string;
  unallocated: string;
}): string {
  return `Daily budget has ${parts.unallocated} that cannot currently be allocated. `
    + `The current hourly caps allow about ${parts.planned} of ${parts.requested}; price shaping may be limited.`;
}
