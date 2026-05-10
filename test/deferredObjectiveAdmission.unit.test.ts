import { applyDeferredObjectiveAdmission } from '../lib/plan/deferredObjectives/admission';
import type { DeferredObjectiveDiagnostic } from '../lib/plan/deferredObjectives';
import type { DeferredObjectiveHorizonPlan } from '../lib/plan/deferredObjectives';

const buildDiagnostic = (overrides: Partial<DeferredObjectiveDiagnostic> & { deviceId: string }): DeferredObjectiveDiagnostic => ({
  deviceId: overrides.deviceId,
  objectiveId: `${overrides.deviceId}:temperature`,
  objectiveKind: 'temperature',
  enforcement: 'soft',
  status: 'on_track',
  reasonCode: 'planned_with_margin',
  targetPercent: null,
  currentPercent: null,
  targetTemperatureC: 65,
  currentTemperatureC: 50,
  deadlineAtMs: Date.UTC(2026, 4, 11, 7, 0, 0),
  deadlineLocalTime: '07:00',
  deadlineRollsToNextDay: false,
  energyNeededKWh: 1.5,
  kWhPerPercent: null,
  kWhPerDegreeC: 0.5,
  rateConfidence: 'high',
  horizonBucketCount: 6,
  requestedMinimumStepId: 'low',
  ...overrides,
});

const buildHorizonPlan = (overrides: Partial<DeferredObjectiveHorizonPlan> = {}): DeferredObjectiveHorizonPlan => ({
  objectiveId: 'dev:temperature',
  kind: 'temperature',
  enforcement: 'soft',
  status: 'on_track',
  statusDetail: 'planned_with_margin',
  horizonStartMs: 0,
  horizonEndMs: 6 * 3600_000,
  planningEndMs: 6 * 3600_000,
  deadlineMarginMs: 0,
  energyNeededKWh: 1.5,
  plannedUsefulEnergyKWh: 1.5,
  unplannedUsefulEnergyKWh: 0,
  requestedMinimumStepId: 'low',
  currentBucket: {
    bucketId: 'b0',
    sourceBucketId: 'b0',
    plannedUsefulEnergyKWh: 1.5,
    requestedMinimumStepId: 'low',
  },
  plannedBuckets: [],
  usesDeadlineReserve: false,
  usesPolicyAvoid: false,
  ...overrides,
});

describe('applyDeferredObjectiveAdmission', () => {
  it('returns planned with the requested minimum step when the current bucket has planned energy', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'dev1',
      horizonPlan: buildHorizonPlan(),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'planned', requestedMinimumStepId: 'low' });
  });

  it('returns idle when the current bucket has no planned energy', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'dev1',
      horizonPlan: buildHorizonPlan({
        currentBucket: { bucketId: 'b1', sourceBucketId: 'b1', plannedUsefulEnergyKWh: 0, requestedMinimumStepId: null },
      }),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'idle' });
  });

  it('returns idle when the current bucket is missing entirely', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'dev1',
      horizonPlan: buildHorizonPlan({ currentBucket: null }),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'idle' });
  });

  it('returns inactive when the goal is already satisfied so the device falls back to its normal behavior', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'dev1',
      status: 'satisfied',
      horizonPlan: buildHorizonPlan({ status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0 }),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'inactive' });
  });

  it('returns inactive for unknown / cannot_meet / invalid statuses', () => {
    for (const status of ['unknown', 'cannot_meet', 'invalid'] as const) {
      const diagnostic = buildDiagnostic({
        deviceId: `dev_${status}`,
        status,
        horizonPlan: undefined,
      });
      const decisions = applyDeferredObjectiveAdmission([diagnostic]);
      expect(decisions.get(`dev_${status}`)).toEqual({ kind: 'inactive' });
    }
  });

  it('returns inactive when the horizon plan is missing', () => {
    const diagnostic = buildDiagnostic({ deviceId: 'dev1', horizonPlan: undefined });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'inactive' });
  });

  it('produces one decision per diagnostic device id', () => {
    const decisions = applyDeferredObjectiveAdmission([
      buildDiagnostic({ deviceId: 'dev_a', horizonPlan: buildHorizonPlan() }),
      buildDiagnostic({ deviceId: 'dev_b', status: 'unknown', horizonPlan: undefined }),
    ]);
    expect(decisions.size).toBe(2);
    expect(decisions.get('dev_a')?.kind).toBe('planned');
    expect(decisions.get('dev_b')?.kind).toBe('inactive');
  });
});
