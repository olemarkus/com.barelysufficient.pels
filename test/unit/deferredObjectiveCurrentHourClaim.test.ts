import { describe, expect, it } from 'vitest';
import { resolveCurrentHourClaim } from '../../lib/objectives/deferredObjectives/currentHourClaim';
import type {
  DeferredObjectiveActivePlanFloorShortfallCause,
} from '../../packages/contracts/src/deferredObjectiveActivePlans';

const claim = (overrides: Partial<Parameters<typeof resolveCurrentHourClaim>[0]> = {}) => (
  resolveCurrentHourClaim({
    currentBucketBookedKWh: 1,
    priceDeferralEligible: false,
    coldStartReleaseEligible: false,
    floorShortfallCause: 'none',
    ...overrides,
  })
);

describe('resolveCurrentHourClaim', () => {
  it('claims an hour that carries booked energy', () => {
    expect(claim()).toBe('claimed');
  });

  it('releases a booked hour when a price release applies', () => {
    // Both are only asserted when the remaining need fits elsewhere, so they carry
    // their own justification and outrank the booking — including for a task whose
    // shortfall would otherwise keep every unbooked hour.
    expect(claim({ priceDeferralEligible: true, floorShortfallCause: 'budget' })).toBe('released');
    expect(claim({ coldStartReleaseEligible: true, floorShortfallCause: 'time_capacity' })).toBe('released');
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
