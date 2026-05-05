import {
  buildDeferredObjectiveDebugPayload,
  evaluateThermalStorageObjective,
  thermalEnergyDeltaKwh,
} from '../lib/core/deferredObjectives';
import type { SteppedLoadProfile } from '../lib/utils/types';

const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
const hourMs = 60 * 60 * 1000;

const thermalProfile: SteppedLoadProfile = {
  model: 'stepped_load',
  tankVolumeL: 300,
  minComfortTempC: 50,
  maxStorageTempC: 75,
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 2000 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

const evaluate = (overrides: Partial<Parameters<typeof evaluateThermalStorageObjective>[0]> = {}) => (
  evaluateThermalStorageObjective({
    nowMs,
    profile: thermalProfile,
    measuredTemperatureC: 60,
    measuredTemperatureObservedAtMs: nowMs,
    targetTemperatureC: 70,
    deadlineAtMs: nowMs + 4 * hourMs,
    rateConfidence: 'high',
    ...overrides,
  })
);

describe('deferred thermal objectives', () => {
  it('maps temperature delta to usable stored energy', () => {
    expect(thermalEnergyDeltaKwh({
      tankVolumeL: 300,
      fromTemperatureC: 50,
      toTemperatureC: 60,
    })).toBeCloseTo(3.488, 3);
    expect(thermalEnergyDeltaKwh({
      tankVolumeL: 300,
      fromTemperatureC: 60,
      toTemperatureC: 50,
    })).toBe(0);
  });

  it('returns unknown when required thermal inputs are missing or stale', () => {
    expect(evaluate({ profile: undefined }).reasonCode).toBe('objective_missing_thermal_profile');
    expect(evaluate({ measuredTemperatureC: undefined }).reasonCode).toBe('objective_missing_temperature');
    expect(evaluate({ targetTemperatureC: undefined }).reasonCode).toBe('objective_missing_target');

    const missingObservationTime = evaluate({ measuredTemperatureObservedAtMs: undefined });
    expect(missingObservationTime.status).toBe('unknown');
    expect(missingObservationTime.progressStatus).toBe('unknown');
    expect(missingObservationTime.reasonCode).toBe('objective_missing_temperature');

    const stale = evaluate({
      measuredTemperatureObservedAtMs: nowMs - 31 * 60 * 1000,
      maxTemperatureAgeMs: 30 * 60 * 1000,
    });
    expect(stale.status).toBe('unknown');
    expect(stale.progressStatus).toBe('stale');
    expect(stale.reasonCode).toBe('objective_progress_stale');
  });

  it('reports boost progress without optimistic deadline planning when no deadline exists', () => {
    const result = evaluate({ deadlineAtMs: undefined });

    expect(result.status).toBe('unknown');
    expect(result.reasonCode).toBe('objective_missing_deadline');
    expect(result.currentEnergyKwh).toBeCloseTo(3.488, 3);
    expect(result.targetEnergyKwh).toBeCloseTo(6.977, 3);
    expect(result.energyNeededKwh).toBeCloseTo(3.488, 3);
    expect(result.requestedMinimumStepId).toBeUndefined();
  });

  it('returns target met without requesting a step', () => {
    const result = evaluate({ measuredTemperatureC: 71 });

    expect(result.status).toBe('likely_to_meet');
    expect(result.activeMode).toBe('none');
    expect(result.reasonCode).toBe('objective_target_met');
    expect(result.requestedMinimumStepId).toBeUndefined();
    expect(result.energyNeededKwh).toBe(0);
  });

  it('returns cannot meet when the active thermal profile cannot reach the target', () => {
    const result = evaluate({ targetTemperatureC: 80 });

    expect(result.status).toBe('cannot_be_met');
    expect(result.reasonCode).toBe('objective_mode_cannot_reach_target');
    expect(result.requestedMinimumStepId).toBeUndefined();
  });

  it('uses the lowest step that can meet the deadline margin', () => {
    expect(evaluate({
      deadlineAtMs: nowMs + 4 * hourMs,
      rateConfidence: 'high',
    }).requestedMinimumStepId).toBe('low');

    expect(evaluate({
      deadlineAtMs: nowMs + 3 * hourMs,
      rateConfidence: 'high',
    }).requestedMinimumStepId).toBe('medium');

    expect(evaluate({
      deadlineAtMs: nowMs + 2 * hourMs,
      rateConfidence: 'high',
    }).requestedMinimumStepId).toBe('max');
  });

  it('marks low-margin completion as at risk and requests the lowest deadline-capable step', () => {
    const result = evaluate({
      deadlineAtMs: nowMs + 2 * hourMs,
      rateConfidence: 'low',
    });

    expect(result.status).toBe('at_risk');
    expect(result.reasonCode).toBe('objective_at_risk');
    expect(result.requestedMinimumStepId).toBe('max');
    expect(result.deadlineMarginMs).toBe(60 * 60 * 1000);
  });

  it('requests the highest step when no step can meet the deadline', () => {
    const result = evaluate({ deadlineAtMs: nowMs + hourMs });

    expect(result.status).toBe('cannot_be_met');
    expect(result.reasonCode).toBe('objective_cannot_be_met');
    expect(result.requestedMinimumStepId).toBe('max');
  });

  it('returns unknown when no positive charge-rate estimate exists', () => {
    const result = evaluate({
      profile: {
        ...thermalProfile,
        steps: [{ id: 'off', planningPowerW: 0 }],
      },
    });

    expect(result.status).toBe('unknown');
    expect(result.reasonCode).toBe('objective_missing_charge_rate');
  });

  it('returns unknown when derating removes all positive charge-rate estimates', () => {
    const result = evaluate({ derateFactor: 0 });

    expect(result.status).toBe('unknown');
    expect(result.reasonCode).toBe('objective_missing_charge_rate');
    expect(result.projectedCompletionAtMs).toBeUndefined();
  });

  it('builds objective debug payloads', () => {
    const result = evaluate({
      deadlineAtMs: nowMs + 4 * hourMs,
      rateConfidence: 'high',
    });
    const payload = buildDeferredObjectiveDebugPayload({
      deviceId: 'heater-1',
      deviceName: 'Water heater',
      evaluation: result,
    });

    expect(payload).toEqual(expect.objectContaining({
      event: 'deferred_objective_evaluated',
      deviceId: 'heater-1',
      deviceName: 'Water heater',
      objectiveKind: 'thermal_storage',
      status: 'likely_to_meet',
      requestedMinimumStepId: 'low',
    }));
  });
});
