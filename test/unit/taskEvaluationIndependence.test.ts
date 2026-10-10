import { applyDeferredObjectiveAdmission } from '../../lib/objectives/deferredObjectives/admission';
import { buildPriorityReservations } from '../../lib/objectives/deferredObjectives/priorityAllocation';
import { resolveTaskCompletion } from '../../lib/objectives/deferredObjectives/taskCompletion';
import type { TaskEvaluation } from '../../lib/objectives/deferredObjectives/taskEvaluation';
import type { DeferredObjectiveHorizonPlan } from '../../lib/objectives/deferredObjectives/types';
import type { ObjectiveDeviceInput } from '../../lib/objectives/types';
import { partialDouble } from '../helpers/partialDouble';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';

it('keeps admission, reservations and requested completion independent of reporting columns', () => {
  const plan = partialDouble<DeferredObjectiveHorizonPlan>({
    currentHourClaim: 'claimed',
    currentBucket: { bucketId: 'now', sourceBucketId: 'now', expectedStepId: 'on', plannedUsefulEnergyKWh: 1, booked: true },
    plannedBuckets: [{
      id: 'now', sourceBucketId: 'now', startMs: 0, endMs: 3_600_000, durationHours: 1,
      price: null, reserve: false, current: true, usefulEnergyCapacityKWh: 1,
      plannedUsefulEnergyKWh: 1, plannedAdmissionPowerKw: 1, booked: true,
    }],
  });
  const evaluation: TaskEvaluation = {
    deviceId: 'task', deadlineAtMs: 3_600_000, requestedTarget: 80,
    progress: { kind: 'known', value: 70, direction: 'increasing' },
    completion: { kind: 'unmet' }, planning: { kind: 'allocated', plan },
    permissions: { budgetExempt: false, limitLowerPriority: false, pauseLowerPriority: false },
    targetControl: { kind: 'none' },
  };
  const objective = {
    enabled: true, kind: 'ev_soc' as const, enforcement: 'soft' as const,
    targetPercent: 80, deadlineAtMs: evaluation.deadlineAtMs,
  };
  const reports = [
    { evaluation, reasonCode: 'planned_with_margin', objectiveKind: 'ev_soc', currentPercent: 70, carChargeLimitPercent: 70 },
    { evaluation, reasonCode: 'objective_stalled_device_capped', objectiveKind: 'temperature', currentTemperatureC: 80 },
    { evaluation, reasonCode: 'limited_by_capacity', objectiveKind: 'energy', deliveredKWh: 100 },
  ];
  const outcomes = reports.map((report) => {
    const operational = report.evaluation;
    if (operational.progress.kind !== 'known') throw new Error('Fixture requires known task progress');
    return {
      admission: [...applyDeferredObjectiveAdmission([operational])],
      reservations: buildPriorityReservations({
        evaluation: operational, objective, device: undefined, activePlans: null, powerLimits: capacityOnlyPowerLimits(10), nowMs: 0,
      }),
      completion: resolveTaskCompletion({
        currentValue: operational.progress.value, requestedTarget: operational.requestedTarget,
        direction: operational.progress.direction, thermalEvidence: { kind: 'none' },
      }),
    };
  });
  expect(outcomes[0]?.admission[0]?.[1]).toMatchObject({ kind: 'planned' });
  expect(outcomes[0]?.reservations).toMatchObject([{ plannedKWh: 1 }]);
  expect(outcomes[0]?.completion).toEqual({ kind: 'unmet' });
  expect(outcomes[1]).toEqual(outcomes[0]);
  expect(outcomes[2]).toEqual(outcomes[0]);
});

it('caps a higher task booking at the current device maximum step', () => {
  const plan = partialDouble<DeferredObjectiveHorizonPlan>({
    plannedBuckets: [{
      id: 'now', sourceBucketId: 'now', startMs: 0, endMs: 3_600_000, durationHours: 1,
      price: null, reserve: false, current: true, usefulEnergyCapacityKWh: 1,
      plannedUsefulEnergyKWh: 1, plannedAdmissionPowerKw: 5, booked: true,
    }],
  });
  const evaluation: TaskEvaluation = {
    deviceId: 'heater', deadlineAtMs: 3_600_000, requestedTarget: 60,
    progress: { kind: 'known', value: 50, direction: 'increasing' },
    completion: { kind: 'unmet' }, planning: { kind: 'allocated', plan },
    permissions: { budgetExempt: false, limitLowerPriority: true, pauseLowerPriority: false },
    targetControl: { kind: 'temperature', value: 60 },
  };
  const device = partialDouble<ObjectiveDeviceInput>({
    id: 'heater',
    steppedLoadProfile: { steps: [
      { id: 'low', planningPowerW: 1250 },
      { id: 'medium', planningPowerW: 1750 },
      { id: 'max', planningPowerW: 3000 },
    ] },
  });
  const reservations = buildPriorityReservations({
    evaluation,
    objective: {
      enabled: true, kind: 'temperature', enforcement: 'soft',
      targetTemperatureC: 60, deadlineAtMs: 3_600_000,
    },
    device, activePlans: null, powerLimits: capacityOnlyPowerLimits(9.5), nowMs: 0,
  });
  expect(reservations).toMatchObject([{ admissionPowerKw: 3 }]);
  expect(reservations[0]?.energySegments[0]?.endMs).toBe(1_200_000);
});
