import { describe, expect, it } from 'vitest';
import { buildFrozenHorizonPlan } from '../../lib/objectives/deferredObjectives/frozenHorizonPlan';
import type { DeferredObjectiveActivePlanFloorShortfallCause, DeferredObjectiveActivePlanHourV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveStep } from '../../lib/objectives/deferredObjectives/types';
import type { DeferredObjectiveSettingsEntry } from '../../packages/contracts/src/deferredObjectiveSettings';
import { partialDouble } from '../helpers/partialDouble';

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0); // hour-aligned
const STEPS: DeferredObjectiveStep[] = [
  { id: 'low', usefulPowerKw: 2, admissionPowerKw: 2 },
  { id: 'high', usefulPowerKw: 4, admissionPowerKw: 4 },
];

const build = (overrides: {
  committedHours: DeferredObjectiveActivePlanHourV1[];
  aheadOfHourMilestone?: boolean;
  objectiveKind?: 'temperature' | 'ev_soc';
  planStatus?: 'on_track' | 'at_risk' | 'cannot_meet';
  // The settle's verdict the frozen read replays. `'none'` (no floor shortfall) is
  // the covered case, so an hour the commitment skipped is one the task can give up.
  floorShortfallCause?: DeferredObjectiveActivePlanFloorShortfallCause;
}) => buildFrozenHorizonPlan({
  nowMs: NOW_MS,
  deviceId: 'dev',
  objective: partialDouble<DeferredObjectiveSettingsEntry>({
    kind: overrides.objectiveKind ?? 'temperature',
    enforcement: 'soft',
    deadlineAtMs: NOW_MS + 6 * HOUR_MS,
  }),
  frozenRead: {
    hours: overrides.committedHours,
    floorShortfallCause: overrides.floorShortfallCause ?? 'none',
    budgetContributedToShortfall: false,
    planStatus: overrides.planStatus ?? 'on_track',
  },
  energyNeededKWh: 3,
  aheadOfHourMilestone: overrides.aheadOfHourMilestone ?? false,
  steps: STEPS,
});

describe('buildFrozenHorizonPlan', () => {
  it('builds currentBucket + plannedBuckets from the frozen commitment and carries the persisted status', () => {
    const plan = build({
      planStatus: 'at_risk',
      committedHours: [
        { startsAtMs: NOW_MS, plannedKWh: 2, plannedAdmissionPowerKw: 2.4 },
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
    expect(plan.plannedBuckets.find((b) => b.current)?.plannedAdmissionPowerKw).toBe(2.4);
    expect(plan.plannedUsefulEnergyKWh).toBe(3);
  });

  it('releases (currentBucket null) when the current hour is not in the commitment', () => {
    const plan = build({ committedHours: [{ startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 1 }] });
    expect(plan.currentBucket).toBeNull();
    expect(plan.currentHourFacts.cheaperHourAhead).toBe(false);
    expect(plan.currentHourFacts.coldStartFeasible).toBe(false);
    expect(plan.currentHourClaim).toBe('released');
  });

  it('price-defers a booked hour only when ahead AND the settle stamped cheaperHourAhead', () => {
    const hoursAheadCheaper: DeferredObjectiveActivePlanHourV1[] = [
      { startsAtMs: NOW_MS, plannedKWh: 1, cheaperHourAhead: true },
      { startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 2 },
    ];
    const deferred = build({ committedHours: hoursAheadCheaper, aheadOfHourMilestone: true });
    expect(deferred.currentHourFacts.cheaperHourAhead).toBe(true);
    expect(deferred.currentHourClaim).toBe('released');
    // Not ahead ⇒ no price deferral (cold-start is handled on the fresh path, not here).
    expect(build({ committedHours: hoursAheadCheaper, aheadOfHourMilestone: false }).currentHourClaim).toBe('claimed');
    // cheaperHourAhead false ⇒ no deferral even when ahead.
    const noCheaper: DeferredObjectiveActivePlanHourV1[] = [
      { startsAtMs: NOW_MS, plannedKWh: 1, cheaperHourAhead: false },
    ];
    const kept = build({ committedHours: noCheaper, aheadOfHourMilestone: true });
    expect(kept.currentHourFacts.cheaperHourAhead).toBe(false);
    expect(kept.currentHourClaim).toBe('claimed');
  });

  it('keeps the hour claimed when ahead with a cheaper hour but the settled status is cannot_meet', () => {
    const plan = build({
      objectiveKind: 'ev_soc',
      planStatus: 'cannot_meet',
      floorShortfallCause: 'time_capacity',
      aheadOfHourMilestone: true,
      committedHours: [
        { startsAtMs: NOW_MS, plannedKWh: 1, cheaperHourAhead: true },
        { startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 2 },
      ],
    });
    expect(plan.currentHourFacts).toMatchObject({ aheadOfHourMilestone: true, cheaperHourAhead: true });
    expect(plan.currentHourClaim).toBe('claimed');
  });

  it('claims a saved hour booked at 0 kWh, with nothing promised', () => {
    // Every saved hour is a booking. One the forecast left no room for carries 0 kWh:
    // the task claims it and runs on capacity that turns out to be free.
    const plan = build({
      committedHours: [
        { startsAtMs: NOW_MS, plannedKWh: 0 },
        { startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 2 },
      ],
    });
    expect(plan.currentBucket).toMatchObject({ plannedUsefulEnergyKWh: 0, booked: true, expectedStepId: null });
    expect(plan.currentHourClaim).toBe('claimed');
  });

  it('does not price-defer a saved 0 kWh hour for a budget-bound task that is ahead', () => {
    // Its milestone is the previous hour's, so the device is "ahead" as soon as it met
    // that; a cheaper hour with energy follows. Deferring would switch the charger off.
    const plan = build({
      objectiveKind: 'ev_soc',
      planStatus: 'at_risk',
      floorShortfallCause: 'budget',
      aheadOfHourMilestone: true,
      committedHours: [
        { startsAtMs: NOW_MS, plannedKWh: 0, cheaperHourAhead: true },
        { startsAtMs: NOW_MS + 3 * HOUR_MS, plannedKWh: 2 },
      ],
    });
    expect(plan.currentHourFacts).toMatchObject({ aheadOfHourMilestone: true, cheaperHourAhead: true });
    expect(plan.currentHourClaim).toBe('claimed');
  });

  it('never states coldStartFeasible — cold-start candidates run the fresh allocator instead', () => {
    const hours: DeferredObjectiveActivePlanHourV1[] = [
      { startsAtMs: NOW_MS, plannedKWh: 1, cheaperHourAhead: true },
      { startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 2 },
    ];
    // The frozen read cannot prove "full need fits the cheaper future at the climbed
    // step", so it never claims cold-start release; the diagnostics build routes such
    // a behind-temperature candidate to the fresh allocator (asserted in
    // deferredObjectiveDiagnostics.test.ts). The frozen plan reports false regardless.
    expect(build({ committedHours: hours, aheadOfHourMilestone: false }).currentHourFacts.coldStartFeasible).toBe(false);
    expect(build({ committedHours: hours, aheadOfHourMilestone: true }).currentHourFacts.coldStartFeasible).toBe(false);
  });

  it('keeps a positive sub-Wh EV booking price-released when ahead with a cheaper hour booked', () => {
    const plan = build({
      objectiveKind: 'ev_soc',
      aheadOfHourMilestone: true,
      committedHours: [
        { startsAtMs: NOW_MS, plannedKWh: 0.0003, cheaperHourAhead: true },
        { startsAtMs: NOW_MS + HOUR_MS, plannedKWh: 2 },
      ],
    });
    expect(plan.currentHourFacts.cheaperHourAhead).toBe(true);
    expect(plan.currentHourClaim).toBe('released');
  });
});
