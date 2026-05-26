import {
  applyDeferredAdmissionToInput,
  applyDeferredObjectiveAdmission,
  buildDeferredTargetOverrides,
} from '../lib/plan/admission';
import type { DeferredObjectiveDiagnostic } from '../lib/plan/deferredObjectives';
import type { DeferredObjectiveHorizonPlan } from '../lib/plan/deferredObjectives';
import type { PlanInputDevice } from '../lib/plan/planTypes';

const buildEvDevice = (overrides: Partial<PlanInputDevice> & { id: string }): PlanInputDevice => ({
  id: overrides.id,
  name: overrides.id,
  targets: [],
  deviceClass: 'evcharger',
  controlCapabilityId: 'evcharger_charging',
  currentOn: true,
  ...overrides,
});

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
  energyNeededKWh: 1.5,
  kWhPerPercent: null,
  kWhPerDegreeC: 0.5,
  rateConfidence: 'high',
  kwhPerUnitSource: 'learned',
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
    expect(decisions.get('dev1')).toEqual({ kind: 'planned', requestedMinimumStepId: 'low', budgetExempt: false, engageBoost: false });
  });

  it('adds an EV resume intent for an EV objective in a planned bucket', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'ev1',
      objectiveId: 'ev1:ev_soc',
      objectiveKind: 'ev_soc',
      targetPercent: 80,
      currentPercent: 40,
      kWhPerPercent: 1,
      kWhPerDegreeC: null,
      horizonPlan: buildHorizonPlan({ kind: 'ev_soc', objectiveId: 'ev1:ev_soc' }),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('ev1')).toEqual({
      kind: 'planned',
      budgetExempt: false,
      engageBoost: false,
      requestedMinimumStepId: 'low',
      evCommandIntent: 'ev_resume',
    });
  });

  it('returns idle when the current bucket has no planned energy', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'dev1',
      horizonPlan: buildHorizonPlan({
        currentBucket: { bucketId: 'b1', sourceBucketId: 'b1', plannedUsefulEnergyKWh: 0, requestedMinimumStepId: null },
      }),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'idle', budgetExempt: false });
  });

  it('adds an EV pause intent for an EV objective in an idle bucket', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'ev1',
      objectiveId: 'ev1:ev_soc',
      objectiveKind: 'ev_soc',
      targetPercent: 80,
      currentPercent: 40,
      kWhPerPercent: 1,
      kWhPerDegreeC: null,
      horizonPlan: buildHorizonPlan({
        kind: 'ev_soc',
        objectiveId: 'ev1:ev_soc',
        currentBucket: { bucketId: 'b1', sourceBucketId: 'b1', plannedUsefulEnergyKWh: 0, requestedMinimumStepId: null },
      }),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('ev1')).toEqual({ kind: 'idle', budgetExempt: false, evCommandIntent: 'ev_pause' });
  });

  it('returns idle when the current bucket is missing entirely', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'dev1',
      horizonPlan: buildHorizonPlan({ currentBucket: null }),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'idle', budgetExempt: false });
  });

  it('returns inactive when the goal is already satisfied so the device falls back to its normal behavior', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'dev1',
      status: 'satisfied',
      horizonPlan: buildHorizonPlan({ status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0 }),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'inactive', budgetExempt: false });
  });

  it('emits a terminal ev_pause when an EV objective is satisfied and the device is cap-off', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'ev1',
      objectiveKind: 'ev_soc',
      status: 'satisfied',
      horizonPlan: buildHorizonPlan({ status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0 }),
    });
    const device = buildEvDevice({ id: 'ev1', controllable: false });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('ev1')).toEqual({ kind: 'inactive', budgetExempt: false, evCommandIntent: 'ev_pause' });
  });

  it('keeps inactive without a pause intent for a satisfied EV when the device is cap-on', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'ev1',
      objectiveKind: 'ev_soc',
      status: 'satisfied',
      horizonPlan: buildHorizonPlan({ status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0 }),
    });
    const device = buildEvDevice({ id: 'ev1', controllable: true });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('ev1')).toEqual({ kind: 'inactive', budgetExempt: false });
  });

  it('keeps inactive without a pause intent for a satisfied temperature objective on a cap-off device', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      objectiveKind: 'temperature',
      status: 'satisfied',
      horizonPlan: buildHorizonPlan({ status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0 }),
    });
    const device = buildEvDevice({ id: 'heater1', controllable: false });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('heater1')).toEqual({ kind: 'inactive', budgetExempt: false });
  });

  it('returns inactive for unknown / invalid statuses', () => {
    for (const status of ['unknown', 'invalid'] as const) {
      const diagnostic = buildDiagnostic({
        deviceId: `dev_${status}`,
        status,
        horizonPlan: undefined,
      });
      const decisions = applyDeferredObjectiveAdmission([diagnostic]);
      expect(decisions.get(`dev_${status}`)).toEqual({ kind: 'inactive', budgetExempt: false });
    }
  });

  it('keeps driving the device best-effort when the planner reports cannot_meet', () => {
    // The lowest-step commitment can under-allocate when the user's need exceeds the
    // per-bucket budget headroom (e.g. 1.5 kWh need / 1h on a 1 kW low + 2 kW high
    // device). Even though the planner cannot guarantee the target, the current
    // bucket still carries a positive allocation; we keep the device admitted so it
    // can run at the lowest step and the capacity guard is free to step up when
    // headroom appears at runtime.
    const diagnostic = buildDiagnostic({
      deviceId: 'dev1',
      status: 'cannot_meet',
      horizonPlan: buildHorizonPlan({
        status: 'cannot_meet',
        statusDetail: 'target_cannot_be_met',
        plannedUsefulEnergyKWh: 1,
        unplannedUsefulEnergyKWh: 0.5,
        currentBucket: { bucketId: 'b0', sourceBucketId: 'b0', plannedUsefulEnergyKWh: 1, requestedMinimumStepId: 'low' },
      }),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'planned', requestedMinimumStepId: 'low', budgetExempt: false, engageBoost: false });
  });

  it('returns inactive when the horizon plan is missing', () => {
    const diagnostic = buildDiagnostic({ deviceId: 'dev1', horizonPlan: undefined });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'inactive', budgetExempt: false });
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

  it('marks the decision budget-exempt when exempt-from-budget is applied to the plan', () => {
    const planned = buildDiagnostic({ deviceId: 'dev1', budgetExemptApplied: true, horizonPlan: buildHorizonPlan() });
    expect(applyDeferredObjectiveAdmission([planned]).get('dev1'))
      .toEqual({ kind: 'planned', requestedMinimumStepId: 'low', budgetExempt: true, engageBoost: false });

    // Not applied once the task is no longer being pursued.
    const satisfied = buildDiagnostic({
      deviceId: 'dev2',
      status: 'satisfied',
      budgetExemptApplied: true,
      horizonPlan: buildHorizonPlan({ status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0 }),
    });
    expect(applyDeferredObjectiveAdmission([satisfied]).get('dev2'))
      .toEqual({ kind: 'inactive', budgetExempt: false });
  });

  it('does not turn an idle rescue plan into a standing budget exemption', () => {
    const idle = buildDiagnostic({
      deviceId: 'dev1',
      budgetExemptApplied: true,
      horizonPlan: buildHorizonPlan({
        currentBucket: {
          bucketId: 'b1',
          sourceBucketId: 'b1',
          plannedUsefulEnergyKWh: 0,
          requestedMinimumStepId: null,
        },
      }),
    });
    const decisions = applyDeferredObjectiveAdmission([idle]);
    expect(decisions.get('dev1')).toEqual({ kind: 'idle', budgetExempt: false });

    const device = buildEvDevice({ id: 'dev1', controllable: true });
    const { devices } = applyDeferredAdmissionToInput([device], decisions);
    expect(devices[0]?.budgetExempt).toBeUndefined();
  });

  it('sets budgetExempt on the device input cap-agnostically when the decision is budget-exempt', () => {
    const planned = buildDiagnostic({ deviceId: 'dev1', budgetExemptApplied: true, horizonPlan: buildHorizonPlan() });
    const decisions = applyDeferredObjectiveAdmission([planned]);
    const capOnDevice = buildEvDevice({ id: 'dev1', controllable: true });
    const { devices } = applyDeferredAdmissionToInput([capOnDevice], decisions);
    expect(devices[0]?.budgetExempt).toBe(true);
  });

  it('engages boost on a planned limit-lower-priority task, but not once it is satisfied', () => {
    const planned = buildDiagnostic({ deviceId: 'dev1', limitLowerPriorityApplied: true, horizonPlan: buildHorizonPlan() });
    expect(applyDeferredObjectiveAdmission([planned]).get('dev1'))
      .toEqual({ kind: 'planned', requestedMinimumStepId: 'low', budgetExempt: false, engageBoost: true });

    const satisfied = buildDiagnostic({
      deviceId: 'dev2',
      status: 'satisfied',
      limitLowerPriorityApplied: true,
      horizonPlan: buildHorizonPlan({ status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0 }),
    });
    expect(applyDeferredObjectiveAdmission([satisfied]).get('dev2'))
      .toEqual({ kind: 'inactive', budgetExempt: false });
  });

  it('sets forceBoostActive on the device input for a planned limit-lower-priority task', () => {
    const planned = buildDiagnostic({ deviceId: 'dev1', limitLowerPriorityApplied: true, horizonPlan: buildHorizonPlan() });
    const decisions = applyDeferredObjectiveAdmission([planned]);
    const device = buildEvDevice({ id: 'dev1', controllable: true });
    const { devices } = applyDeferredAdmissionToInput([device], decisions);
    // Admission only requests the boost (kind-agnostic); the boost resolvers decide whether
    // it resolves to temperatureBoost or evBoost by device kind.
    expect(devices[0]?.forceBoostActive).toBe(true);
  });
});

describe('buildDeferredTargetOverrides', () => {
  it('includes the temperature target for a planned temperature diagnostic', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      targetTemperatureC: 65,
      horizonPlan: buildHorizonPlan(),
    });
    expect(buildDeferredTargetOverrides([diagnostic])).toEqual({ heater1: 65 });
  });

  it('skips EV diagnostics', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'ev1',
      objectiveId: 'ev1:ev_soc',
      objectiveKind: 'ev_soc',
      targetPercent: 80,
      currentPercent: 40,
      kWhPerPercent: 1,
      kWhPerDegreeC: null,
      horizonPlan: buildHorizonPlan({ kind: 'ev_soc', objectiveId: 'ev1:ev_soc' }),
    });
    expect(buildDeferredTargetOverrides([diagnostic])).toEqual({});
  });

  it('skips a temperature diagnostic whose current bucket has no planned energy', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      horizonPlan: buildHorizonPlan({
        currentBucket: { bucketId: 'b1', sourceBucketId: 'b1', plannedUsefulEnergyKWh: 0, requestedMinimumStepId: null },
      }),
    });
    expect(buildDeferredTargetOverrides([diagnostic])).toEqual({});
  });

  it('adds the learned thermostat deadband to the commanded target', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      targetTemperatureC: 21,
      horizonPlan: buildHorizonPlan(),
    });
    const result = buildDeferredTargetOverrides(
      [diagnostic],
      (deviceId) => (deviceId === 'heater1' ? 0.3 : 0),
    );
    expect(result.heater1).toBeCloseTo(21.3);
  });

  it('falls back to the raw target when no deadband reader is provided', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      targetTemperatureC: 21,
      horizonPlan: buildHorizonPlan(),
    });
    expect(buildDeferredTargetOverrides([diagnostic])).toEqual({ heater1: 21 });
  });

  it('treats a 0 deadband reader as no over-command', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      targetTemperatureC: 21,
      horizonPlan: buildHorizonPlan(),
    });
    expect(buildDeferredTargetOverrides([diagnostic], () => 0))
      .toEqual({ heater1: 21 });
  });

  it('defensively ignores a non-finite deadband reader return', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      targetTemperatureC: 21,
      horizonPlan: buildHorizonPlan(),
    });
    expect(buildDeferredTargetOverrides([diagnostic], () => Number.NaN))
      .toEqual({ heater1: 21 });
  });

  it('defensively ignores a negative deadband reader return', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      targetTemperatureC: 21,
      horizonPlan: buildHorizonPlan(),
    });
    expect(buildDeferredTargetOverrides([diagnostic], () => -0.5))
      .toEqual({ heater1: 21 });
  });

  it('defensively ignores a deadband reader return above the over-command cap', () => {
    // Belt-and-suspenders against a misbehaving reader (wiring bug, custom
    // helper bypassing the store's clamp). The over-command cap exists to
    // bound the failure mode at +1 °C; an unclamped +1.5 °C reader return
    // would breach that contract, so the consumer treats it as 0.
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      targetTemperatureC: 21,
      horizonPlan: buildHorizonPlan(),
    });
    expect(buildDeferredTargetOverrides([diagnostic], () => 1.5))
      .toEqual({ heater1: 21 });
  });
});
