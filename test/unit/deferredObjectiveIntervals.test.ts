import { expect, it } from 'vitest';
import { planDeferredObjectiveHorizon } from '../../lib/objectives/deferredObjectives/horizonPlanner';
import { buildHoursFromHorizonPlan, buildReservationSegmentsFromHorizonPlan, mergeHoursPreservingCommitment, sameHourSchedule, shouldFireNotification, stampUnitMilestones } from '../../lib/objectives/deferredObjectives/activePlanSchedule';
import { buildFrozenHorizonPlan } from '../../lib/objectives/deferredObjectives/frozenHorizonPlan';
import { buildDeferredObjectivePolicyHorizon } from '../../lib/objectives/deferredObjectives/policyHorizon';
import { inactiveTaskEvaluation } from '../../lib/objectives/deferredObjectives/taskEvaluation';
import { plannedDurationHours } from '../../lib/objectives/deferredObjectives/plannedDuration';
import { normalizeDeferredObjectiveActivePlansShape } from '../../packages/shared-domain/src/deferredObjectiveActivePlanShape';
import { isPastHourSettleMark } from '../../lib/objectives/deferredObjectives/settleWindow';
import type { DeferredObjectiveSettingsEntry } from '../../packages/contracts/src/deferredObjectiveSettings';
import type { DailyBudgetUiPayload, DailyBudgetDayPayload } from '../../packages/contracts/src/dailyBudgetTypes';
import type { DeferredObjectivePlanInterval } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import { isAheadOfHourMilestone } from '../../lib/objectives/deferredObjectives/trajectoryMilestone';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives/diagnosticTypes';
import { partialDouble } from '../helpers/partialDouble';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';

const HOUR = 3_600_000;
const QUARTER = HOUR / 4;
const START = Date.UTC(2026, 9, 25, 1);
const steps = [{ id: 'on', usefulPowerKw: 4, admissionPowerKw: 4 }];
const prices = [10, 100, -20, 100].map((price, index) => ({
  startMs: START + index * QUARTER, endMs: START + (index + 1) * QUARTER, price, moneyPrice: price,
}));
const objective: DeferredObjectiveSettingsEntry = {
  enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 2, deadlineAtMs: START + HOUR,
};
const interval = (start: number, end: number, energy: number): DeferredObjectivePlanInterval => ({
  startsAtMs: START + start * QUARTER, endsAtMs: START + end * QUARTER, plannedKWh: energy,
});
const allocate = (nowMs = START, deadlineAtMs = START + HOUR) => planDeferredObjectiveHorizon({
  nowMs, objective: {
    id: 'task', kind: 'energy', enforcement: 'soft', energyNeededKWh: 2,
    fullyReserved: false, deadlineMarginMs: 0, deadlineAtMs,
  },
  steps, powerLimit: { kind: 'unlimited' }, commitment: { kind: 'uncommitted' }, aheadOfHourMilestone: false,
  buckets: prices.map((period) => ({ ...period, id: new Date(period.startMs).toISOString() })),
});

it('books separated cheap quarters inside one hour and preserves their real ends', () => {
  const plan = allocate();
  const hours = buildHoursFromHorizonPlan({
    ...inactiveTaskEvaluation('task', START + HOUR, 2), planning: { kind: 'allocated', plan },
  });
  expect(hours).toEqual([
    { ...interval(0, 1, 1), plannedAdmissionPowerKw: 4 },
    { ...interval(2, 3, 1), plannedAdmissionPowerKw: 4 },
  ]);
  expect(plannedDurationHours(hours ?? [])).toBe(0.5);
});

it('clips the first and last price periods to exact request bounds', () => {
  const plan = allocate(START + 5 * 60_000, START + 55 * 60_000);
  expect(plan.plannedBuckets[0]?.durationHours).toBeCloseTo(1 / 6);
  expect(plan.plannedBuckets.at(-1)?.durationHours).toBeCloseTo(1 / 6);
  expect(plan.plannedBuckets[0]?.startMs).toBe(START + 5 * 60_000);
  expect(plan.plannedBuckets.at(-1)?.endMs).toBe(START + 55 * 60_000);
});

it.each(['temperature', 'ev_soc', 'energy'] as const)('replays quarter boundaries for %s without a quarter settle', (kind) => {
  const hours = [interval(0, 1, 1), interval(2, 3, 1)];
  const task = partialDouble<DeferredObjectiveSettingsEntry>({ ...objective, kind });
  const frozen = {
    hours, planStatus: 'on_track' as const, floorShortfallCause: 'none' as const,
    budgetContributedToShortfall: false,
    drawWindows: hours.map((hour) => ({ startMs: hour.startsAtMs, endMs: hour.endsAtMs, plannedKWh: hour.plannedKWh })),
  };
  const at = (offset: number) => buildFrozenHorizonPlan(START + offset, 'task', task, frozen, 2, false, steps);
  expect(at(QUARTER - 1).currentHourClaim).toBe('claimed');
  expect(at(QUARTER).currentHourClaim).toBe('released');
  expect(at(2 * QUARTER).currentHourClaim).toBe('claimed');
  expect(at(3 * QUARTER).currentHourClaim).toBe('released');
  expect(at(2 * QUARTER + 1).currentBucket?.expectedStepId).toBe('on');
  expect(isPastHourSettleMark(START + QUARTER)).toBe(false);
  expect(isPastHourSettleMark(START + 58 * 60_000)).toBe(true);
});

it('conserves a legacy hourly floor when the source changes to quarters', () => {
  const result = mergeHoursPreservingCommitment([interval(0, 4, 4)], [0, 1, 2, 3].map((i) => interval(i, i + 1, 0.5)), START);
  expect(result.map((booking) => booking.plannedKWh)).toEqual([1, 1, 1, 1]);
  expect(result.reduce((sum, booking) => sum + booking.plannedKWh, 0)).toBe(4);
  expect(sameHourSchedule([interval(0, 4, 4)], result)).toBe(true);
});

// A plan saved before interval ends stored a deadline at :30 as its last whole
// hour. Once migrated, live bookings that run to the deadline still cover it.
it('adopts live bookings over a migrated legacy hour that ends at the deadline', () => {
  const legacy = { hours: [{ startsAtMs: START, plannedKWh: 1 }] };
  const migrated = normalizeDeferredObjectiveActivePlansShape({
    version: 1,
    plansByDeviceId: { task: { deadlineAtMs: START + 2 * QUARTER, commitment: legacy, original: legacy, latest: legacy } },
  }, {
    isValidPlan: (plan): plan is { commitment: { hours: DeferredObjectivePlanInterval[] } } => typeof plan === 'object',
    empty: () => null,
  });
  const committed = migrated?.plansByDeviceId.task?.commitment.hours ?? [];
  const merged = mergeHoursPreservingCommitment(committed, [interval(0, 1, 0.5), interval(1, 2, 1)], START);
  expect(merged.map((booking) => booking.plannedKWh)).toEqual([0.5, 1]);
});

it('keeps elapsed history and refuses a hole in a pending floor', () => {
  const committed = [interval(0, 1, 1), interval(2, 3, 1)];
  expect(mergeHoursPreservingCommitment(committed, [interval(3, 4, 2)], START + QUARTER)).toEqual(committed);
  const expanded = mergeHoursPreservingCommitment(committed, [interval(2, 3, 0.5), interval(3, 4, 1)], START + QUARTER);
  expect(expanded).toEqual([...committed, interval(3, 4, 1)]);
});

it('compares schedule coverage and not just start timestamps', () => {
  expect(sameHourSchedule([interval(0, 1, 1)], [interval(0, 2, 1)])).toBe(false);
  expect(sameHourSchedule([interval(0, 1, 1), interval(2, 3, 1)], [interval(0, 3, 2)])).toBe(false);
  expect(shouldFireNotification(0.5, 0.75, 'on_track')).toBe(true);
  expect(shouldFireNotification(0.5, 0.5, 'on_track')).toBe(false);
});

it('prorates one hourly budget across four quarters and subtracts only overlapping reservations', () => {
  const budget = partialDouble<DailyBudgetUiPayload>({
    todayKey: '2026-10-25', tomorrowKey: null,
    days: { '2026-10-25': partialDouble<DailyBudgetDayPayload>({
      budget: { enabled: true, dailyBudgetKWh: 10, priceShapingEnabled: true }, buckets: partialDouble<DailyBudgetDayPayload['buckets']>({
        startUtc: [new Date(START).toISOString()], plannedControlledKWh: [4],
        plannedUncontrolledKWh: [2], plannedGrossUncontrolledKWh: [2],
      }),
    }) },
  });
  const horizon = buildDeferredObjectivePolicyHorizon({
    nowMs: START, deadlineAtMs: START + HOUR, priceOptimizationEnabled: true, priceHorizon: prices,
    dailyBudgetSnapshot: budget, exemptFromBudget: false, powerLimits: capacityOnlyPowerLimits(10),
    hasSolarProduction: false, higherPriorityUnbookedPowerKw: 0,
    higherPriorityReservations: [{
      deviceId: 'higher', topologyKey: 'quarter0', startsAtMs: START, admissionPowerKw: 4,
      plannedKWh: 1, exemptFromBudget: false,
      energySegments: [{ startMs: START, endMs: START + QUARTER, plannedKWh: 1 }],
    }],
  });
  expect(horizon.reasonCode).toBeNull();
  expect(horizon.buckets.map((bucket) => bucket.maxUsefulEnergyKWh)).toEqual([1, 1, 1, 1]);
  expect(horizon.buckets.map((bucket) => bucket.reservedHeadroomKw)).toEqual([4, 8, 8, 8]);
  const plan = planDeferredObjectiveHorizon({
    nowMs: START, objective: { id: 'lower', kind: 'energy', enforcement: 'soft', fullyReserved: false,
      energyNeededKWh: 4, deadlineMarginMs: 0, deadlineAtMs: START + HOUR },
    steps, powerLimit: { kind: 'limited', admissionCeilingKw: null },
    commitment: { kind: 'uncommitted' }, aheadOfHourMilestone: false, buckets: horizon.buckets,
  });
  expect(plan.plannedUsefulEnergyKWh).toBe(3);
  expect(plan.plannedBuckets.map((bucket) => bucket.plannedUsefulEnergyKWh)).toEqual([0, 1, 1, 1]);
});


it('preserves a committed quarter when a new hourly source crosses its edge', () => {
  const plan = planDeferredObjectiveHorizon({
    nowMs: START, objective: { id: 'changed-grid', kind: 'energy', enforcement: 'soft', fullyReserved: false,
      energyNeededKWh: 1, deadlineMarginMs: 0, deadlineAtMs: START + HOUR },
    steps, powerLimit: { kind: 'unlimited' }, aheadOfHourMilestone: false,
    commitment: { kind: 'committed', hours: [interval(1, 2, 1)] },
    buckets: [{ id: 'hour', startMs: START, endMs: START + HOUR, price: 10 }],
  });
  const positive = plan.plannedBuckets.filter((bucket) => bucket.plannedUsefulEnergyKWh > 0);
  expect(positive).toHaveLength(1);
  expect(positive[0]).toMatchObject({ startMs: START + QUARTER, endMs: START + 2 * QUARTER, plannedUsefulEnergyKWh: 1 });
  expect(plan.plannedBuckets.reduce((sum, bucket) => sum + bucket.plannedUsefulEnergyKWh, 0))
    .toBe(plan.plannedUsefulEnergyKWh);
  expect(plan.currentHourClaim).toBe('released');
});


it('keeps a saved unit milestone at its real end after regridding and uses energy at new edges', () => {
  const old = [{ ...interval(0, 4, 4), plannedUnitMilestone: 44 }];
  const regridded = mergeHoursPreservingCommitment(old, [0, 1, 2, 3].map((i) => interval(i, i + 1, 0.5)), START);
  const stamped = stampUnitMilestones(regridded, partialDouble<DeferredObjectiveDiagnostic>({
    currentValue: 41.1, progressDirection: 'increasing', kWhPerUnitBanded: 1,
  }), START, old);
  expect(stamped.map((booking) => booking.plannedUnitMilestone)).toEqual([undefined, undefined, undefined, 44]);
  expect(isAheadOfHourMilestone(2.9, 'increasing', stamped, START, 41.1)).toBe(true);
});


it('drops an unneeded pending zero-energy booking but preserves elapsed history', () => {
  expect(mergeHoursPreservingCommitment([interval(2, 3, 0)], [], START)).toEqual([]);
  expect(mergeHoursPreservingCommitment([interval(0, 1, 0)], [], START + QUARTER)).toEqual([interval(0, 1, 0)]);
});


it('carries a larger physical rung across every regridded reservation', () => {
  const plan = planDeferredObjectiveHorizon({
    nowMs: START, objective: { id: 'larger-rung', kind: 'energy', enforcement: 'soft', fullyReserved: false,
      energyNeededKWh: 2, deadlineMarginMs: 0, deadlineAtMs: START + HOUR },
    steps: [{ id: 'run', usefulPowerKw: 2, admissionPowerKw: 4 }], powerLimit: { kind: 'unlimited' },
    aheadOfHourMilestone: false, commitment: { kind: 'uncommitted' },
    buckets: prices.map((period) => ({ ...period, price: 10, id: new Date(period.startMs).toISOString() })),
  });
  const evaluation = { ...inactiveTaskEvaluation('task', START + HOUR, 2), planning: { kind: 'allocated' as const, plan } };
  const hours = mergeHoursPreservingCommitment([{ ...interval(0, 4, 2), plannedAdmissionPowerKw: 2 }],
    buildHoursFromHorizonPlan(evaluation) ?? [], START);
  const segments = buildReservationSegmentsFromHorizonPlan(partialDouble<DeferredObjectiveDiagnostic>({
    evaluation, deadlineAtMs: START + HOUR,
  }), hours, [{ startMs: START, endMs: START + HOUR, plannedKWh: 2, plannedAdmissionPowerKw: 2,
    sourceBucketId: new Date(START).toISOString() }]);
  expect(segments.map((segment) => segment.plannedAdmissionPowerKw)).toEqual([4, 4, 4, 4]);
});


it('stamps a fresh energy increase when the booking boundary has not changed', () => {
  const old = [{ ...interval(0, 1, 0.2), plannedUnitMilestone: 40.2 }];
  const merged = mergeHoursPreservingCommitment(old, [interval(0, 1, 0.5)], START);
  const stamped = stampUnitMilestones(merged, partialDouble<DeferredObjectiveDiagnostic>({
    currentValue: 40, progressDirection: 'increasing', kWhPerUnitBanded: 1,
  }), START, old);
  expect(stamped[0]?.plannedUnitMilestone).toBe(40.5);
});
