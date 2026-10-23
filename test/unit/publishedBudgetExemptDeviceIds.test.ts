import { resolvePublishedBudgetExemptDeviceIds, type PublishedPlan } from '../../lib/plan/publishedPlan';
import type { DevicePlan } from '../../lib/plan/planTypes';

const HOUR_MS = 60 * 60 * 1000;
const publishedAt = Date.UTC(2026, 9, 23, 10, 20, 0);

const published = (devices: Array<{ id: string; budgetExempt?: boolean }>): PublishedPlan => ({
  plan: { devices } as unknown as DevicePlan,
  publishedAtMs: publishedAt,
});

describe('resolvePublishedBudgetExemptDeviceIds', () => {
  it('answers the devices the plan in force exempts', () => {
    const plan = published([{ id: 'task', budgetExempt: true }, { id: 'other', budgetExempt: false }, { id: 'bare' }]);
    expect([...resolvePublishedBudgetExemptDeviceIds(plan, publishedAt + 60_000)]).toEqual(['task']);
  });

  it('answers nothing once the sample is in a later tracker hour than the plan', () => {
    const plan = published([{ id: 'task', budgetExempt: true }]);
    expect(resolvePublishedBudgetExemptDeviceIds(plan, publishedAt + HOUR_MS).size).toBe(0);
  });

  it('answers nothing before any plan is published', () => {
    expect(resolvePublishedBudgetExemptDeviceIds(null, publishedAt).size).toBe(0);
  });
});
