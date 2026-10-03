import { describe, expect, it } from 'vitest';
import { resolveObjectiveSteps } from '../../lib/objectives/deferredObjectives/objectiveSteps';
import { resolvePlanningSpeedKw } from '../../lib/objectives/deferredObjectives/planningSpeed';
import {
  allocateEnergyToBuckets,
  normalizeHorizonBuckets,
} from '../../lib/objectives/deferredObjectives/bucketAllocation';
import {
  getActiveObjectiveSteps,
  normalizeObjectiveSteps,
} from '../../lib/objectives/deferredObjectives/stepSelection';
import type { ObjectiveDeviceInput } from '../../lib/objectives/types';

// A smart task asks two questions of a rung and they get two answers. How fast
// does energy land? The learned step power. How much room must the rung have?
// Its nameplate, the same price the planner's restore admission puts on it.
//
// The device is "Elbillader" as of 2026-10-01: its `6a` rung had learned
// 0.7878 kW against a 1.38 kW nameplate; the other rungs have no learned figure.
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 1, 18, 0, 0);

const elbillader: ObjectiveDeviceInput = {
  id: 'elbillader',
  name: 'Elbillader',
  isEvCharger: true,
  deviceType: 'onoff',
  steppedLoadProfile: {
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: '6a', planningPowerW: 1380 },
      { id: '10a', planningPowerW: 2300 },
      { id: '16a', planningPowerW: 3680 },
    ],
  },
  currentDrawKw: 0,
  expectedPowerKw: 1.38,
  objectiveSessionInactive: false,
  thermalDirection: 'heating',
  stepPowerCalibration: { '6a': 0.7878 },
};

describe('smart-task step power: learned for energy, nameplate for room', () => {
  it('resolves useful power from the learned figure and admission power from the nameplate', () => {
    expect(resolveObjectiveSteps(elbillader)).toEqual([
      { id: 'off', usefulPowerKw: 0, admissionPowerKw: 0 },
      { id: '6a', usefulPowerKw: 0.7878, admissionPowerKw: 1.38 },
      { id: '10a', usefulPowerKw: 2.3, admissionPowerKw: 2.3 },
      { id: '16a', usefulPowerKw: 3.68, admissionPowerKw: 3.68 },
    ]);
  });

  it('plans delivery speed at the learned figure', () => {
    expect(resolvePlanningSpeedKw(elbillader)).toBe(0.7878);
  });

  it('books an hour\'s useful energy at the learned rate but fits and reserves the rung at nameplate', () => {
    const [floorStep] = getActiveObjectiveSteps(normalizeObjectiveSteps(resolveObjectiveSteps(elbillader)));
    expect(floorStep?.id).toBe('6a');
    if (!floorStep) return;

    const buckets = normalizeHorizonBuckets({
      nowMs: NOW,
      deadlineAtMs: NOW + 3 * HOUR_MS,
      deadlineMarginMs: 0,
      buckets: [
        { id: 'open', startMs: NOW, endMs: NOW + HOUR_MS, price: 1 },
        // A higher-priority task draws here at the same time and leaves 1.0 kW of
        // room: enough for the learned 0.79 kW, not for a rung that may draw 1.38.
        {
          id: 'contended',
          startMs: NOW + HOUR_MS,
          endMs: NOW + 2 * HOUR_MS,
          price: 1,
          reservedHeadroomKw: 1.0,
          higherPriorityAdmissionPowerKw: 1.6,
        },
      ],
    });
    const result = allocateEnergyToBuckets({
      buckets,
      stepForBucket: () => floorStep,
      energyNeededKWh: 5,
      epsilonKWh: 0.001,
    });
    const byId = new Map(result.plannedBuckets.map((bucket) => [bucket.id, bucket]));

    // Energy at the rate the rung really delivers; the claim on the hour at
    // what it may draw, which is what the tasks behind this one must leave free.
    expect(byId.get('open')).toMatchObject({
      usefulEnergyCapacityKWh: expect.closeTo(0.7878, 6),
      plannedUsefulEnergyKWh: expect.closeTo(0.7878, 6),
      plannedAdmissionPowerKw: 1.38,
    });
    expect(byId.get('contended')).toMatchObject({
      usefulEnergyCapacityKWh: 0,
      plannedUsefulEnergyKWh: 0,
      plannedAdmissionPowerKw: 0,
    });
  });
});
