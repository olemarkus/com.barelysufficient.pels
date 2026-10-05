import { describe, expect, it } from 'vitest';
import { resolveCurrentHourClaim } from '../../lib/objectives/deferredObjectives/currentHourClaim';
import type {
  DeferredObjectiveActivePlanFloorShortfallCause,
} from '../../packages/contracts/src/deferredObjectiveActivePlans';

type ClaimParams = Parameters<typeof resolveCurrentHourClaim>[0];
const NO_RELEASE_FACTS: ClaimParams['facts'] = {
  aheadOfHourMilestone: false,
  cheaperHourAhead: false,
  coldStartFeasible: false,
};
const PRICE_DEFERRAL_FACTS: ClaimParams['facts'] = {
  ...NO_RELEASE_FACTS,
  aheadOfHourMilestone: true,
  cheaperHourAhead: true,
};
const claim = (overrides: Partial<ClaimParams> = {}) => (
  resolveCurrentHourClaim({
    currentBucketBookedKWh: 1,
    facts: NO_RELEASE_FACTS,
    floorShortfallCause: 'none',
    ...overrides,
  })
);

describe('resolveCurrentHourClaim', () => {
  it('claims an hour that carries booked energy', () => {
    expect(claim()).toBe('claimed');
  });

  it('price-defers a booked hour when ahead with a cheaper booked hour later', () => {
    expect(claim({ facts: PRICE_DEFERRAL_FACTS })).toBe('released');
    // Ahead alone, or a cheaper hour alone, is not enough.
    expect(claim({ facts: { ...NO_RELEASE_FACTS, aheadOfHourMilestone: true } })).toBe('claimed');
    expect(claim({ facts: { ...NO_RELEASE_FACTS, cheaperHourAhead: true } })).toBe('claimed');
  });

  // Coasting a task that physically cannot finish moves no load into the cheaper hours
  // (they are booked to their cap); it only widens the miss. A budget-bound task
  // still defers: see `CAUSES_THAT_BLOCK_PRICE_DEFERRAL`.
  const priceDeferralByCause: Array<[DeferredObjectiveActivePlanFloorShortfallCause, string]> = [
    ['budget', 'released'],
    ['time_capacity', 'claimed'],
    ['step_power', 'released'],
    ['estimate', 'released'],
    ['none', 'released'],
  ];
  it.each(priceDeferralByCause)('resolves a price-deferrable booked hour with cause %s to %s', (cause, expected) => {
    expect(claim({ facts: PRICE_DEFERRAL_FACTS, floorShortfallCause: cause })).toBe(expected);
  });

  it('cold-start releases even a task whose floor plan cannot finish', () => {
    // Cold-start feasibility proves the need fits the cheaper hours at the real
    // element, which is exactly where the floor's `cannot_meet` is a false premise
    // (see `CAUSES_THAT_BLOCK_PRICE_DEFERRAL`). It outranks the booking and the cause.
    const facts = { ...NO_RELEASE_FACTS, coldStartFeasible: true };
    expect(claim({ facts, floorShortfallCause: 'time_capacity' })).toBe('released');
    expect(claim({ facts, currentBucketBookedKWh: 0, floorShortfallCause: 'budget' })).toBe('released');
  });

  it('never price-defers an unbooked hour', () => {
    // Nothing booked ⇒ the unbooked rule decides; the price facts do not apply.
    expect(claim({ facts: PRICE_DEFERRAL_FACTS, currentBucketBookedKWh: 0, floorShortfallCause: 'time_capacity' }))
      .toBe('unclaimed');
  });

  // The whole precision of the rule: only a shortfall the task cannot climb or
  // re-estimate its way out of makes an unbooked hour one it still needs.
  const byCause: Array<[DeferredObjectiveActivePlanFloorShortfallCause, string]> = [
    ['budget', 'unclaimed'],
    ['time_capacity', 'unclaimed'],
    ['step_power', 'released'],
    ['estimate', 'released'],
    ['none', 'released'],
  ];
  it.each(byCause)('resolves an unbooked hour with cause %s to %s', (cause, expected) => {
    expect(claim({ currentBucketBookedKWh: 0, floorShortfallCause: cause })).toBe(expected);
    // No current bucket at all is the same question — the commitment skipped the
    // hour, so there is nothing booked in it either way.
    expect(claim({ currentBucketBookedKWh: null, floorShortfallCause: cause })).toBe(expected);
  });

  it('gives up an hour a climbable task can finish without', () => {
    // `feasible_above_floor` is the normal state of a stepped thermal task: the
    // climbed-band probe already proved the booked hours finish the job. Keeping the
    // hour here would switch price optimisation off for most such tasks.
    expect(claim({ currentBucketBookedKWh: 0, floorShortfallCause: 'step_power' })).toBe('released');
  });
});
