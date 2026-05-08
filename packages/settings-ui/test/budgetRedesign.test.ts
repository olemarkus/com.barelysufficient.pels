import type { DailyBudgetDayPayload } from '../../contracts/src/dailyBudgetTypes';
import {
  resolveBudgetNextAction,
  resolveBudgetPlannedDayKWh,
} from '../src/ui/budgetRedesign.ts';

const enabledPayload = {
  budget: { enabled: true },
} as unknown as DailyBudgetDayPayload;

describe('Budget redesign copy', () => {
  it('does not ask users to enable daily budget when enabled budget data is still missing', () => {
    expect(resolveBudgetNextAction(enabledPayload, 'today', 'noPlan')).toBe('Waiting for daily budget data.');
  });

  it('still asks users to enable the daily budget when no plan exists and budget is off', () => {
    expect(resolveBudgetNextAction(null, 'today', 'noPlan')).toBe('Enable daily budget to build a daily plan.');
  });

  it('uses the actual planned bucket total for day plan summaries', () => {
    const payload = {
      buckets: { plannedKWh: [2, 1.5, 0.5] },
    } as unknown as DailyBudgetDayPayload;

    expect(resolveBudgetPlannedDayKWh(payload)).toBe(4);
  });
});
