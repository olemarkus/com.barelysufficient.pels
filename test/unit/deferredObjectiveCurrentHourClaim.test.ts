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
    currentHourBooking: 'booked_with_energy',
    facts: NO_RELEASE_FACTS,
    floorShortfallCause: 'none',
    ...overrides,
  })
);

describe('resolveCurrentHourClaim', () => {
  it('claims a booked hour, also one booked at 0 kWh', () => {
    expect(claim()).toBe('claimed');
    expect(claim({ currentHourBooking: 'booked_without_energy' })).toBe('claimed');
  });

  it('never price-defers a hour booked without energy', () => {
    // Nothing promised to move, and its milestone does not advance, so "ahead" is true
    // by construction: deferring would switch the device off in the very hour it was
    // booked to run in.
    for (const floorShortfallCause of ['none', 'budget'] as const) {
      expect(claim({ currentHourBooking: 'booked_without_energy', facts: PRICE_DEFERRAL_FACTS, floorShortfallCause }))
        .toBe('claimed');
    }
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
    expect(claim({ facts, currentHourBooking: 'unbooked', floorShortfallCause: 'budget' })).toBe('released');
  });

  // An hour the plan did not book is one the task can finish without, unless the task
  // falls short: then it needs every hour, booked or not (e.g. a commitment saved
  // before the allocator booked every hour of a short task).
  const unbookedByCause: Array<[DeferredObjectiveActivePlanFloorShortfallCause, string]> = [
    ['budget', 'claimed'],
    ['time_capacity', 'claimed'],
    ['step_power', 'released'],
    ['estimate', 'released'],
    ['none', 'released'],
  ];
  it.each(unbookedByCause)('resolves an unbooked hour with cause %s to %s', (cause, expected) => {
    expect(claim({ currentHourBooking: 'unbooked', floorShortfallCause: cause })).toBe(expected);
  });
});
