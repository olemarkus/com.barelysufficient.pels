import { describe, expect, it } from 'vitest';
import { buildFrozenHorizonPlan } from '../../lib/objectives/deferredObjectives/frozenHorizonPlan';
import type { DeferredObjectiveActivePlanHourV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveStep } from '../../lib/objectives/deferredObjectives/types';

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0); // hour-aligned
const STEPS: DeferredObjectiveStep[] = [
  { id: 'low', usefulPowerKw: 2 },
  { id: 'high', usefulPowerKw: 4 },
];

const build = (overrides: {
  committedHours: DeferredObjectiveActivePlanHourV1[];
  aheadOfHourMilestone?: boolean;
  objectiveKind?: 'temperature' | 'ev_soc';
  planStatus?: 'on_track' | 'at_risk' | 'cannot_meet';
}) => buildFrozenHorizonPlan({
  nowMs: NOW_MS,
  objectiveId: 'dev:temperature',
  objectiveKind: overrides.objectiveKind ?? 'temperature',
  enforcement: 'soft',
  deadlineAtMs: NOW_MS + 6 * HOUR_MS,
  deadlineMarginMs: HOUR_MS,
  committedHours: overrides.committedHours,
  planStatus: overrides.planStatus ?? 'on_track',
  energyNeededKWh: 3,
  aheadOfHourMilestone: overrides.aheadOfHourMilestone ?? false,
  steps: STEPS,
  epsilonKWh: 0.001,
});

describe('buildFrozenHorizonPlan', () => {
  it('builds currentBucket + plannedBuckets from the frozen commitment and carries the persisted status', () => {
    const plan = build({
      planStatus: 'at_risk',
      committedHours: [
        { startsAtMs: NOW_MS, plannedKWh: 2 },
        { startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 1 },
      ],
    });
    expect(plan.status).toBe('at_risk');
    expect(plan.currentBucket?.plannedUsefulEnergyKWh).toBe(2);
    // 2 kWh in one hour ⇒ the lowest step that delivers it is 'low' (2 kW).
    expect(plan.currentBucket?.expectedStepId).toBe('low');
    expect(plan.expectedStepId).toBe('low');
    // Source ids match the allocator's hour-aligned ISO convention.
    expect(plan.plannedBuckets.map((b) => b.sourceBucketId)).toEqual([
      new Date(NOW_MS).toISOString(),
      new Date(NOW_MS + 2 * HOUR_MS).toISOString(),
    ]);
    expect(plan.plannedBuckets.find((b) => b.current)?.startMs).toBe(NOW_MS);
    expect(plan.plannedUsefulEnergyKWh).toBe(3);
  });

  it('releases (currentBucket null) when the current hour is not in the commitment', () => {
    const plan = build({ committedHours: [{ startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 1 }] });
    expect(plan.currentBucket).toBeNull();
    expect(plan.priceDeferralEligible).toBe(false);
    expect(plan.coldStartReleaseEligible).toBe(false);
  });

  it('flags priceDeferralEligible only when current hour booked AND ahead AND cheaperHourAhead', () => {
    const hoursAheadCheaper: DeferredObjectiveActivePlanHourV1[] = [
      { startsAtMs: NOW_MS, plannedKWh: 1, cheaperHourAhead: true },
      { startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 2 },
    ];
    expect(build({ committedHours: hoursAheadCheaper, aheadOfHourMilestone: true }).priceDeferralEligible).toBe(true);
    // Not ahead ⇒ no price deferral (cold-start is handled on the fresh path, not here).
    expect(build({ committedHours: hoursAheadCheaper, aheadOfHourMilestone: false }).priceDeferralEligible).toBe(false);
    // cheaperHourAhead false ⇒ no deferral even when ahead.
    const noCheaper: DeferredObjectiveActivePlanHourV1[] = [
      { startsAtMs: NOW_MS, plannedKWh: 1, cheaperHourAhead: false },
    ];
    expect(build({ committedHours: noCheaper, aheadOfHourMilestone: true }).priceDeferralEligible).toBe(false);
  });

  it('never asserts coldStartReleaseEligible — cold-start candidates run the fresh allocator instead', () => {
    const hours: DeferredObjectiveActivePlanHourV1[] = [
      { startsAtMs: NOW_MS, plannedKWh: 1, cheaperHourAhead: true },
      { startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 2 },
    ];
    // The frozen read cannot prove "full need fits the cheaper future at the climbed
    // step", so it never claims cold-start release; the diagnostics build routes such
    // a behind-temperature candidate to the fresh allocator (asserted in
    // deferredObjectiveDiagnostics.test.ts). The frozen plan reports false regardless.
    expect(build({ committedHours: hours, aheadOfHourMilestone: false }).coldStartReleaseEligible).toBe(false);
    expect(build({ committedHours: hours, aheadOfHourMilestone: true }).coldStartReleaseEligible).toBe(false);
  });
});
