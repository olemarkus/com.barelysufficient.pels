import {
  applyDeferredAdmissionToInput,
  applyDeferredObjectiveAdmission,
  buildDeferredTargetOverrides,
} from '../../lib/objectives/deferredObjectives/admission';
import { resolveDeferredAvoidDeviceIds } from '../../lib/objectives/deferredObjectives/decorationController';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives';
import type { DeferredObjectiveHorizonPlan } from '../../lib/objectives/deferredObjectives';
import type { PlanInputDevice } from '../../lib/plan/planTypes';

const buildEvDevice = (overrides: Partial<PlanInputDevice> & { id: string }): PlanInputDevice => ({
  id: overrides.id,
  name: overrides.id,
  targets: [],
  deviceClass: 'evcharger',
  controlCapabilityId: 'evcharger_charging',
  binaryControl: { on: true },
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
  expectedStepId: 'low',
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
  expectedStepId: 'low',
  currentBucket: {
    bucketId: 'b0',
    sourceBucketId: 'b0',
    plannedUsefulEnergyKWh: 1.5,
    expectedStepId: 'low',
  },
  plannedBuckets: [],
  usesDeadlineReserve: false,
  priceDeferralEligible: false,
  ...overrides,
});

describe('applyDeferredObjectiveAdmission', () => {
  it('returns planned with the requested minimum step when the current bucket has planned energy', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'dev1',
      horizonPlan: buildHorizonPlan(),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'planned', expectedStepId: 'low', budgetExempt: false, engageBoost: false });
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
      expectedStepId: 'low',
      releaseIntent: 'binary_restore',
    });
  });

  it('returns idle when the current bucket has no planned energy', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'dev1',
      horizonPlan: buildHorizonPlan({
        currentBucket: { bucketId: 'b1', sourceBucketId: 'b1', plannedUsefulEnergyKWh: 0, expectedStepId: null },
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
        currentBucket: { bucketId: 'b1', sourceBucketId: 'b1', plannedUsefulEnergyKWh: 0, expectedStepId: null },
      }),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('ev1')).toEqual({ kind: 'idle', budgetExempt: false, releaseIntent: 'binary_release' });
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

  it('emits a terminal binary_release when an EV objective is satisfied and the device is cap-off', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'ev1',
      objectiveKind: 'ev_soc',
      status: 'satisfied',
      horizonPlan: buildHorizonPlan({ status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0 }),
    });
    const device = buildEvDevice({ id: 'ev1', controllable: false });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('ev1')).toEqual({ kind: 'inactive', budgetExempt: false, releaseIntent: 'binary_release' });
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

  it('emits a one-shot shed_release for a satisfied non-EV objective on a cap-off device', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      objectiveKind: 'temperature',
      status: 'satisfied',
      horizonPlan: buildHorizonPlan({ status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0 }),
    });
    const device = buildEvDevice({ id: 'heater1', controllable: false });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('heater1')).toEqual({
      kind: 'inactive',
      budgetExempt: false,
      releaseIntent: 'shed_release',
    });
  });

  it('keeps inactive without a release intent for a satisfied non-EV objective on a cap-on device', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater2',
      objectiveKind: 'temperature',
      status: 'satisfied',
      horizonPlan: buildHorizonPlan({ status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0 }),
    });
    // Cap-on devices stay on the planner's normal lane; emitting a release intent there would
    // race the planner's own decisions.
    const device = buildEvDevice({ id: 'heater2', controllable: true });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('heater2')).toEqual({ kind: 'inactive', budgetExempt: false });
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
        currentBucket: { bucketId: 'b0', sourceBucketId: 'b0', plannedUsefulEnergyKWh: 1, expectedStepId: 'low' },
      }),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'planned', expectedStepId: 'low', budgetExempt: false, engageBoost: false });
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
      .toEqual({ kind: 'planned', expectedStepId: 'low', budgetExempt: true, engageBoost: false });

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
          expectedStepId: null,
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
      .toEqual({ kind: 'planned', expectedStepId: 'low', budgetExempt: false, engageBoost: true });

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

  it('idles a price-deferred current hour and emits shed_release for a cap-off device', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      horizonPlan: buildHorizonPlan({ priceDeferralEligible: true }),
    });
    const device = buildEvDevice({ id: 'heater1', controllable: false });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('heater1')).toEqual({ kind: 'idle', budgetExempt: false, releaseIntent: 'shed_release' });
  });

  it('idles a price-deferred current hour with no release intent for a cap-on device', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      horizonPlan: buildHorizonPlan({ priceDeferralEligible: true }),
    });
    const device = buildEvDevice({ id: 'heater1', controllable: true });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('heater1')).toEqual({ kind: 'idle', budgetExempt: false });
  });

  it('pauses a price-deferred EV charger', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'ev1',
      objectiveKind: 'ev_soc',
      horizonPlan: buildHorizonPlan({ kind: 'ev_soc', objectiveId: 'ev1:ev_soc', priceDeferralEligible: true }),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('ev1')).toEqual({ kind: 'idle', budgetExempt: false, releaseIntent: 'binary_release' });
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
        currentBucket: { bucketId: 'b1', sourceBucketId: 'b1', plannedUsefulEnergyKWh: 0, expectedStepId: null },
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

  it('skips a price-deferred temperature diagnostic (no deadline floor while released)', () => {
    // The device is released this cycle (admission idles it), so stamping the
    // deadline floor would lift the setpoint and run it in the very `avoid` hour
    // we deferred out of — defeating the price-deferral release.
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      targetTemperatureC: 65,
      horizonPlan: buildHorizonPlan({ priceDeferralEligible: true }),
    });
    expect(buildDeferredTargetOverrides([diagnostic])).toEqual({});
  });
});

describe('resolveDeferredAvoidDeviceIds', () => {
  it('flags a price-deferred device as waiting for cheaper hours, even when at_risk with a booked current bucket', () => {
    // Price-deferral release: the device is idled because a cheaper hour can carry
    // the load, so it gets the "waiting for cheaper hours" framing — not capacity /
    // daily-budget framing (which would miscount the pause as starvation). The
    // current bucket still carries booked energy and the status may be `at_risk`
    // (e.g. the floor undershoots and only climbing fits), so the price-deferral
    // case must bypass both the no-energy and the on_track gates.
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      status: 'at_risk',
      horizonPlan: buildHorizonPlan({
        status: 'at_risk',
        statusDetail: 'feasible_above_floor',
        priceDeferralEligible: true,
      }),
    });
    expect(resolveDeferredAvoidDeviceIds([diagnostic]).has('heater1')).toBe(true);
  });

  it('does not flag a normally-planned device that is running this hour', () => {
    const diagnostic = buildDiagnostic({ deviceId: 'heater1', horizonPlan: buildHorizonPlan() });
    expect(resolveDeferredAvoidDeviceIds([diagnostic]).has('heater1')).toBe(false);
  });
});
