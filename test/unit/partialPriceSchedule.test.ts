import { describe, expect, it } from 'vitest';
import { servePartialPriceSchedule, withPartialPriceSchedule } from '../../lib/objectives/deferredObjectives/partialPriceSchedule';
import type { DeferredObjectiveHorizonPlan } from '../../lib/objectives/deferredObjectives/types';
import { partialDouble } from '../helpers/partialDouble';

const HOUR_MS = 3_600_000;
const planAt = (nowMs: number, unplannedUsefulEnergyKWh: number): DeferredObjectiveHorizonPlan => (
  partialDouble<DeferredObjectiveHorizonPlan>({
    horizonStartMs: nowMs, horizonEndMs: 5 * HOUR_MS, planningEndMs: 4 * HOUR_MS,
    status: 'cannot_meet', statusDetail: 'target_cannot_be_met',
    plannedUsefulEnergyKWh: 0, unplannedUsefulEnergyKWh, currentBucket: null, plannedBuckets: [],
  })
);

describe('partial-price Smart task fallback', () => {
  it('keeps a started fallback running when measured progress shortens the next partial plan', () => {
    const first = withPartialPriceSchedule(planAt(0, 3), 1, undefined);
    expect(first.partialPriceSchedule?.fallbackStartsAtMs).toBe(HOUR_MS);

    const nowMs = 1.5 * HOUR_MS;
    const replanned = withPartialPriceSchedule(planAt(nowMs, 1), 1, first.partialPriceSchedule);
    expect(replanned).toMatchObject({
      currentHourClaim: 'claimed',
      runsOnAvailablePower: true,
      partialPriceSchedule: {
        fallbackStartsAtMs: HOUR_MS,
        fallbackWindows: [{ startsAtMs: nowMs, endsAtMs: nowMs + HOUR_MS, plannedKWh: 1 }],
      },
    });
  });

  it('adds no fallback when the device has no admissible speed and the priced plan is empty', () => {
    const plan = planAt(0, 3);
    expect(withPartialPriceSchedule(plan, undefined, undefined)).toBe(plan);
  });

  it('does not price-defer positive booked work while a genuine capacity shortfall remains', () => {
    const plan: DeferredObjectiveHorizonPlan = {
      ...planAt(0, 3),
      currentBucket: {
        bucketId: 'priced', sourceBucketId: 'priced', plannedUsefulEnergyKWh: 1,
        booked: true, keepCharging: false, expectedStepId: 'low',
      },
      currentHourFacts: { aheadOfHourMilestone: true, cheaperHourAhead: true, coldStartFeasible: false },
    };
    expect(servePartialPriceSchedule(plan, { fallbackWindows: [] }).currentHourClaim).toBe('claimed');
  });
});
