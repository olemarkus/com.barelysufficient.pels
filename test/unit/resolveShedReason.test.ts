import { describe, it, expect } from 'vitest';
import { resolveShedReason } from '../../lib/plan/shedding/selection';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemanticsCore';

// `softLimitSource` says which soft limit is BINDING (the lower of the two), not
// which one the current draw has actually breached. When capacity is breached as
// well, total is over both and capacity is the constraint doing the work — and it
// is the only reason a budget-exempt device can be shed at all
// (`shedding/candidates.ts` excludes exempt devices from daily-budget shedding
// unless capacity is breached). Prod 2026-07-25: an exempt EV charger was shed at
// 6.60 kW against a 5.12 kW capacity soft limit and labelled "Limited by today's
// daily budget" on a card that also showed the "Always on" (budget exempt) chip.
describe('resolveShedReason', () => {
  it('names the daily budget when it binds and capacity is not breached', () => {
    expect(resolveShedReason('daily', false)).toEqual({
      code: PLAN_REASON_CODES.dailyBudget,
      detail: null,
    });
  });

  it('names capacity when the daily budget binds but capacity is ALSO breached', () => {
    expect(resolveShedReason('daily', true)).toEqual({
      code: PLAN_REASON_CODES.capacity,
      detail: null,
    });
  });

  it('names capacity when capacity is the binding limit', () => {
    expect(resolveShedReason('capacity', false)).toEqual({
      code: PLAN_REASON_CODES.capacity,
      detail: null,
    });
    expect(resolveShedReason('capacity', true)).toEqual({
      code: PLAN_REASON_CODES.capacity,
      detail: null,
    });
  });
});
