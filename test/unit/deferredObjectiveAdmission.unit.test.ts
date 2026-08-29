import { resolvedTrajectoryStatus } from '../../lib/objectives/deferredObjectives/diagnosticTypes';
import {
  applyDeferredAdmissionToInput,
  applyDeferredObjectiveAdmission,
  buildDeferredReleaseIntents,
  buildDeferredTargetOverrides,
} from '../../lib/objectives/deferredObjectives/admission';
import { resolveDeferredAvoidDeviceIds } from '../../lib/objectives/deferredObjectives/decorationController';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives';
import type { DeferredObjectiveHorizonPlan } from '../../lib/objectives/deferredObjectives';
import type { PlanInputDevice, BinaryControlDiscriminantProbe } from '../../lib/plan/planTypes';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { withFixtureResidualKw } from '../utils/planTestUtils';

const buildEvDevice = (
  overrides: Partial<PlanInputDevice> & BinaryControlDiscriminantProbe & { id: string },
): PlanInputDevice => withBinaryDiscriminant(withFixtureResidualKw({
  name: overrides.id,
  targets: [],
  deviceClass: 'evcharger',
  binaryCapabilityId: 'evcharger_charging',
  binaryControl: { on: true },
  ...overrides,
  controllable: overrides.controllable ?? true,
  available: overrides.available ?? true,
})) as PlanInputDevice;

const buildDiagnostic = (overrides: Partial<DeferredObjectiveDiagnostic> & { deviceId: string }): DeferredObjectiveDiagnostic => ({
  objectiveId: `${overrides.deviceId}:temperature`,
  objectiveKind: 'temperature',
  enforcement: 'soft',
  trajectory: { kind: 'resolved', status: 'on_track' },
  reasonCode: 'planned_with_margin',
  targetPercent: null,
  currentPercent: null,
  targetTemperatureC: 65,
  currentTemperatureC: 50,
  deadlineAtMs: Date.UTC(2026, 4, 11, 7, 0, 0),
  deadlineLocalTime: '07:00',
  energyNeededKWh: 1.5,
  kWhPerUnitBanded: 0.5,
  rateConfidence: 'high',
  kwhPerUnitSource: 'learned',
  horizonBucketCount: 6,
  expectedStepId: 'low',
  ...overrides,
} as DeferredObjectiveDiagnostic);

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
  // Self-consistent with the booked current bucket above. Cases that mean "the task
  // booked nothing here" override the bucket and the claim together — the producer
  // resolves both from the same allocation, so a fixture that moved only one would
  // describe a plan the producers cannot emit.
  currentHourClaim: 'claimed',
  ...overrides,
});

describe('applyDeferredObjectiveAdmission', () => {
  it('returns planned with the requested minimum step when the current bucket has planned energy', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'dev1',
      horizonPlan: buildHorizonPlan(),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'planned', expectedStepId: 'low', budgetExempt: false, engageBoost: false, reservesStartupPower: false });
  });

  it('adds an EV resume intent for an EV objective in a planned bucket', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'ev1',
      objectiveId: 'ev1:ev_soc',
      objectiveKind: 'ev_soc',
      targetPercent: 80,
      currentPercent: 40,
      kWhPerUnitBanded: 1,
      horizonPlan: buildHorizonPlan({ kind: 'ev_soc', objectiveId: 'ev1:ev_soc' }),
    });
    const device = buildEvDevice({ id: 'ev1', controlModel: 'binary_power' });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('ev1')).toEqual({
      kind: 'planned',
      budgetExempt: false,
      engageBoost: false,
      reservesStartupPower: false,
      expectedStepId: 'low',
      releaseIntent: 'binary_restore',
    });
  });

  it('returns idle when the current bucket has no planned energy', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'dev1',
      horizonPlan: buildHorizonPlan({
        currentBucket: { bucketId: 'b1', sourceBucketId: 'b1', plannedUsefulEnergyKWh: 0, expectedStepId: null },
        currentHourClaim: 'released',
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
      kWhPerUnitBanded: 1,
      horizonPlan: buildHorizonPlan({
        kind: 'ev_soc',
        objectiveId: 'ev1:ev_soc',
        currentBucket: { bucketId: 'b1', sourceBucketId: 'b1', plannedUsefulEnergyKWh: 0, expectedStepId: null },
        currentHourClaim: 'released',
      }),
    });
    const device = buildEvDevice({ id: 'ev1', controlModel: 'binary_power' });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('ev1')).toEqual({ kind: 'idle', budgetExempt: false, releaseIntent: 'binary_release' });
  });

  it('routes a stepped-load EV charger by control modality, not as binary', () => {
    // A stepped EV charger (controlModel 'stepped_load') with an ev_soc objective: release
    // routing keys on control modality, so it does NOT use the binary release/restore path.
    // Idle → shed_release (the executor disables via the binary handle); planned → no
    // releaseIntent (the planner's normal stepped lane restores it at the planned step).
    const device = buildEvDevice({ id: 'ev1', controllable: false, controlModel: 'stepped_load' });
    const idle = buildDiagnostic({
      deviceId: 'ev1',
      objectiveKind: 'ev_soc',
      horizonPlan: buildHorizonPlan({
        kind: 'ev_soc',
        objectiveId: 'ev1:ev_soc',
        currentBucket: { bucketId: 'b1', sourceBucketId: 'b1', plannedUsefulEnergyKWh: 0, expectedStepId: null },
        currentHourClaim: 'released',
      }),
    });
    expect(applyDeferredObjectiveAdmission([idle], [device]).get('ev1'))
      .toEqual({ kind: 'idle', budgetExempt: false, releaseIntent: 'shed_release' });

    const planned = buildDiagnostic({
      deviceId: 'ev1',
      objectiveKind: 'ev_soc',
      horizonPlan: buildHorizonPlan({ kind: 'ev_soc', objectiveId: 'ev1:ev_soc' }),
    });
    const plannedDecision = applyDeferredObjectiveAdmission([planned], [device]).get('ev1');
    expect(plannedDecision).toMatchObject({ kind: 'planned' });
    expect(plannedDecision).not.toHaveProperty('releaseIntent');
  });

  it('routes a stepped EV charger and a stepped water heater through identical branches', () => {
    // Non-negotiable: when it comes to stepped-load / shedding, the planner must not tell an EV
    // charger apart from a stepped water heater (e.g. Connected 300). Both are controlModel
    // 'stepped_load'; only their objective unit (SoC% vs °C) differs, which never reaches the
    // release routing. So their admission decisions must be byte-identical across buckets.
    const evCharger = buildEvDevice({ id: 'dev', controllable: false, controlModel: 'stepped_load' });
    const waterHeater: PlanInputDevice = withFixtureResidualKw({
      available: true,
      id: 'dev', name: 'dev', targets: [], controllable: false, controlModel: 'stepped_load',
      expectedPowerKw: 1, expectedPowerSource: 'default',
      commandableNow: true, objectiveSessionInactive: false,
      currentDrawKw: 0,
      boostSupported: false,
      boostRequested: false,
      hasStandingDemand: true,
      surplusTracking: false,
      surplusFloor: 'off' as const,
      confirmedNotDrawing: false,
    });
    const idleHorizon = {
      currentBucket: { bucketId: 'b1', sourceBucketId: 'b1', plannedUsefulEnergyKWh: 0, expectedStepId: null },
      currentHourClaim: 'released' as const,
    };
    for (const horizon of [{}, idleHorizon]) {
      const evDecision = applyDeferredObjectiveAdmission(
        [buildDiagnostic({ deviceId: 'dev', objectiveKind: 'ev_soc', horizonPlan: buildHorizonPlan({ kind: 'ev_soc', ...horizon }) })],
        [evCharger],
      ).get('dev');
      const heaterDecision = applyDeferredObjectiveAdmission(
        [buildDiagnostic({ deviceId: 'dev', objectiveKind: 'temperature', horizonPlan: buildHorizonPlan({ kind: 'temperature', ...horizon }) })],
        [waterHeater],
      ).get('dev');
      expect(evDecision).toEqual(heaterDecision);
    }
  });

  it('returns idle when the current bucket is missing entirely', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'dev1',
      horizonPlan: buildHorizonPlan({ currentBucket: null, currentHourClaim: 'released' }),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'idle', budgetExempt: false });
  });

  // An hour can be booked at 0 simply because the soft daily budget's forecast
  // controlled share for it was 0, which is not a reason to stop a task that is
  // behind. These four pin the split: the same unbooked hour releases the device
  // when the plan is covered, and leaves it on the planner's normal lane when it
  // is not.
  const shortUnbookedHour = {
    currentBucket: { bucketId: 'b1', sourceBucketId: 'b1', plannedUsefulEnergyKWh: 0, expectedStepId: null },
    status: 'cannot_meet' as const,
    statusDetail: 'target_cannot_be_met' as const,
    plannedUsefulEnergyKWh: 0.5,
    unplannedUsefulEnergyKWh: 1,
    currentHourClaim: 'unclaimed' as const,
  };

  it('returns unclaimed for an unbooked hour while the booked hours do not cover the need', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'dev1',
      trajectory: { kind: 'resolved', status: 'cannot_meet' },
      horizonPlan: buildHorizonPlan(shortUnbookedHour),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'unclaimed', budgetExempt: false });
  });

  it('does not command a binary EV charger off in an unbooked hour while the task is short', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'ev1',
      objectiveId: 'ev1:ev_soc',
      objectiveKind: 'ev_soc',
      trajectory: { kind: 'resolved', status: 'cannot_meet' },
      horizonPlan: buildHorizonPlan({ kind: 'ev_soc', objectiveId: 'ev1:ev_soc', ...shortUnbookedHour }),
    });
    const device = buildEvDevice({ id: 'ev1', controllable: false, controlModel: 'binary_power' });
    const decision = applyDeferredObjectiveAdmission([diagnostic], [device]).get('ev1');
    expect(decision).toEqual({ kind: 'unclaimed', budgetExempt: false });
    expect(decision).not.toHaveProperty('releaseIntent');
  });

  it('hands an unclaimed cap-off device to the planner as managed without seeding the shed set', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'ev1',
      objectiveId: 'ev1:ev_soc',
      objectiveKind: 'ev_soc',
      trajectory: { kind: 'resolved', status: 'cannot_meet' },
      horizonPlan: buildHorizonPlan({ kind: 'ev_soc', objectiveId: 'ev1:ev_soc', ...shortUnbookedHour }),
    });
    const device = buildEvDevice({ id: 'ev1', controllable: false, controlModel: 'binary_power' });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    const applied = applyDeferredAdmissionToInput([device], decisions);
    // Managed, so it competes on its own priority in the normal shed/restore lane.
    expect(applied.devices[0]?.controllable).toBe(true);
    // Not force-shed, and none of the claims a planned hour would carry.
    expect(applied.forceShedSet.has('ev1')).toBe(false);
    expect(applied.devices[0]).not.toHaveProperty('forceBoostActive');
    expect(applied.devices[0]?.budgetExempt).toBeUndefined();
    expect(applied.devices[0]?.reservesStartupPower).toBeUndefined();
    expect(buildDeferredReleaseIntents(decisions)).toEqual({});
  });

  it('stamps no deadline floor target on an unclaimed hour', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      objectiveKind: 'temperature',
      targetTemperatureC: 70,
      trajectory: { kind: 'resolved', status: 'cannot_meet' },
      horizonPlan: buildHorizonPlan(shortUnbookedHour),
    });
    expect(buildDeferredTargetOverrides([diagnostic])).toEqual({});
  });

  it('returns inactive when the goal is already satisfied so the device falls back to its normal behavior', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'dev1',
      trajectory: { kind: 'resolved', status: 'satisfied' },
      horizonPlan: buildHorizonPlan({
        status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0, currentHourClaim: 'released',
      }),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'inactive', budgetExempt: false });
  });

  it('leaves terminal EV fallback actuation to the lifecycle clock when the device is cap-off', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'ev1',
      objectiveKind: 'ev_soc',
      trajectory: { kind: 'resolved', status: 'satisfied' },
      horizonPlan: buildHorizonPlan({
        status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0, currentHourClaim: 'released',
      }),
    });
    const device = buildEvDevice({ id: 'ev1', controllable: false, controlModel: 'binary_power' });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('ev1')).toEqual({ kind: 'inactive', budgetExempt: false });
  });

  it('keeps inactive without a pause intent for a satisfied EV when the device is cap-on', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'ev1',
      objectiveKind: 'ev_soc',
      trajectory: { kind: 'resolved', status: 'satisfied' },
      horizonPlan: buildHorizonPlan({
        status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0, currentHourClaim: 'released',
      }),
    });
    const device = buildEvDevice({ id: 'ev1', controllable: true });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('ev1')).toEqual({ kind: 'inactive', budgetExempt: false });
  });

  it('leaves terminal non-EV fallback actuation to the lifecycle clock when the device is cap-off', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      objectiveKind: 'temperature',
      trajectory: { kind: 'resolved', status: 'satisfied' },
      horizonPlan: buildHorizonPlan({
        status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0, currentHourClaim: 'released',
      }),
    });
    const device = buildEvDevice({ id: 'heater1', controllable: false });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('heater1')).toEqual({ kind: 'inactive', budgetExempt: false });
  });

  it('keeps inactive without a release intent for a satisfied non-EV objective on a cap-on device', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater2',
      objectiveKind: 'temperature',
      trajectory: { kind: 'resolved', status: 'satisfied' },
      horizonPlan: buildHorizonPlan({
        status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0, currentHourClaim: 'released',
      }),
    });
    // Cap-on devices stay on the planner's normal lane; emitting a release intent there would
    // race the planner's own decisions.
    const device = buildEvDevice({ id: 'heater2', controllable: true });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('heater2')).toEqual({ kind: 'inactive', budgetExempt: false });
  });

  it('returns inactive for an invalid verdict and for no verdict at all', () => {
    const trajectories = [
      { label: 'invalid', trajectory: { kind: 'resolved', status: 'invalid' } as const },
      {
        label: 'unavailable',
        trajectory: { kind: 'unavailable', reasonCode: 'objective_progress_stale' } as const,
      },
    ];
    for (const { label, trajectory } of trajectories) {
      const diagnostic = buildDiagnostic({
        deviceId: `dev_${label}`,
        trajectory,
        horizonPlan: undefined,
      });
      const decisions = applyDeferredObjectiveAdmission([diagnostic]);
      expect(decisions.get(`dev_${label}`)).toEqual({ kind: 'inactive', budgetExempt: false });
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
      trajectory: { kind: 'resolved', status: 'cannot_meet' },
      horizonPlan: buildHorizonPlan({
        status: 'cannot_meet',
        statusDetail: 'target_cannot_be_met',
        plannedUsefulEnergyKWh: 1,
        unplannedUsefulEnergyKWh: 0.5,
        currentBucket: { bucketId: 'b0', sourceBucketId: 'b0', plannedUsefulEnergyKWh: 1, expectedStepId: 'low' },
      }),
    });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'planned', expectedStepId: 'low', budgetExempt: false, engageBoost: false, reservesStartupPower: false });
  });

  it('returns inactive when the horizon plan is missing', () => {
    const diagnostic = buildDiagnostic({ deviceId: 'dev1', horizonPlan: undefined });
    const decisions = applyDeferredObjectiveAdmission([diagnostic]);
    expect(decisions.get('dev1')).toEqual({ kind: 'inactive', budgetExempt: false });
  });

  it('produces one decision per diagnostic device id', () => {
    const decisions = applyDeferredObjectiveAdmission([
      buildDiagnostic({ deviceId: 'dev_a', horizonPlan: buildHorizonPlan() }),
      buildDiagnostic({ deviceId: 'dev_b', trajectory: { kind: 'unavailable', reasonCode: 'objective_progress_stale' }, horizonPlan: undefined }),
    ]);
    expect(decisions.size).toBe(2);
    expect(decisions.get('dev_a')?.kind).toBe('planned');
    expect(decisions.get('dev_b')?.kind).toBe('inactive');
  });

  it('marks the decision budget-exempt when exempt-from-budget is applied to the plan', () => {
    const planned = buildDiagnostic({ deviceId: 'dev1', budgetExemptApplied: true, horizonPlan: buildHorizonPlan() });
    expect(applyDeferredObjectiveAdmission([planned]).get('dev1'))
      .toEqual({ kind: 'planned', expectedStepId: 'low', budgetExempt: true, engageBoost: false, reservesStartupPower: false });

    // Not applied once the task is no longer being pursued.
    const satisfied = buildDiagnostic({
      deviceId: 'dev2',
      trajectory: { kind: 'resolved', status: 'satisfied' },
      budgetExemptApplied: true,
      horizonPlan: buildHorizonPlan({
        status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0, currentHourClaim: 'released',
      }),
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
        currentHourClaim: 'released',
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
      .toEqual({ kind: 'planned', expectedStepId: 'low', budgetExempt: false, engageBoost: true, reservesStartupPower: false });

    const satisfied = buildDiagnostic({
      deviceId: 'dev2',
      trajectory: { kind: 'resolved', status: 'satisfied' },
      limitLowerPriorityApplied: true,
      horizonPlan: buildHorizonPlan({
        status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0, currentHourClaim: 'released',
      }),
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

  it('sets reservesStartupPower (boost-free) on a planned pause-lower-priority task, not once satisfied', () => {
    const planned = buildDiagnostic({ deviceId: 'dev1', pauseLowerPriorityApplied: true, horizonPlan: buildHorizonPlan() });
    expect(applyDeferredObjectiveAdmission([planned]).get('dev1'))
      .toEqual({ kind: 'planned', expectedStepId: 'low', budgetExempt: false, engageBoost: false, reservesStartupPower: true });

    const satisfied = buildDiagnostic({
      deviceId: 'dev2',
      trajectory: { kind: 'resolved', status: 'satisfied' },
      pauseLowerPriorityApplied: true,
      horizonPlan: buildHorizonPlan({
        status: 'satisfied', currentBucket: null, plannedUsefulEnergyKWh: 0, currentHourClaim: 'released',
      }),
    });
    expect(applyDeferredObjectiveAdmission([satisfied]).get('dev2'))
      .toEqual({ kind: 'inactive', budgetExempt: false });
  });

  it('sets reservesStartupPower on the device input WITHOUT forceBoostActive (pause is boost-free)', () => {
    const planned = buildDiagnostic({ deviceId: 'dev1', pauseLowerPriorityApplied: true, horizonPlan: buildHorizonPlan() });
    const decisions = applyDeferredObjectiveAdmission([planned]);
    const device = buildEvDevice({ id: 'dev1', controllable: true });
    const { devices } = applyDeferredAdmissionToInput([device], decisions);
    expect(devices[0]?.reservesStartupPower).toBe(true);
    expect(devices[0]?.forceBoostActive).toBeUndefined();
  });

  it('keeps pause and boost independent when both permissions are applied', () => {
    const planned = buildDiagnostic({
      deviceId: 'dev1', limitLowerPriorityApplied: true, pauseLowerPriorityApplied: true, horizonPlan: buildHorizonPlan(),
    });
    const decisions = applyDeferredObjectiveAdmission([planned]);
    const device = buildEvDevice({ id: 'dev1', controllable: true });
    const { devices } = applyDeferredAdmissionToInput([device], decisions);
    expect(devices[0]?.reservesStartupPower).toBe(true);
    expect(devices[0]?.forceBoostActive).toBe(true);
  });

  it('idles a price-deferred current hour and emits shed_release for a cap-off device', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      horizonPlan: buildHorizonPlan({ priceDeferralEligible: true, currentHourClaim: 'released' }),
    });
    const device = buildEvDevice({ id: 'heater1', controllable: false });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('heater1')).toEqual({ kind: 'idle', budgetExempt: false, releaseIntent: 'shed_release' });
  });

  it('idles a price-deferred current hour with no release intent for a cap-on device', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      horizonPlan: buildHorizonPlan({ priceDeferralEligible: true, currentHourClaim: 'released' }),
    });
    const device = buildEvDevice({ id: 'heater1', controllable: true });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    expect(decisions.get('heater1')).toEqual({ kind: 'idle', budgetExempt: false });
  });

  it('pauses a price-deferred EV charger', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'ev1',
      objectiveKind: 'ev_soc',
      horizonPlan: buildHorizonPlan({ kind: 'ev_soc', objectiveId: 'ev1:ev_soc', priceDeferralEligible: true, currentHourClaim: 'released' }),
    });
    const device = buildEvDevice({ id: 'ev1', controlModel: 'binary_power' });
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
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
      kWhPerUnitBanded: 1,
      horizonPlan: buildHorizonPlan({ kind: 'ev_soc', objectiveId: 'ev1:ev_soc' }),
    });
    expect(buildDeferredTargetOverrides([diagnostic])).toEqual({});
  });

  it('skips a temperature diagnostic whose current bucket has no planned energy', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      horizonPlan: buildHorizonPlan({
        currentBucket: { bucketId: 'b1', sourceBucketId: 'b1', plannedUsefulEnergyKWh: 0, expectedStepId: null },
        currentHourClaim: 'released',
      }),
    });
    expect(buildDeferredTargetOverrides([diagnostic])).toEqual({});
  });

  it('skips a price-deferred temperature diagnostic (no deadline floor while released)', () => {
    // The device is released this cycle (admission idles it), so stamping the
    // deadline floor would lift the setpoint and run it in the very `avoid` hour
    // we deferred out of — defeating the price-deferral release.
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      targetTemperatureC: 65,
      horizonPlan: buildHorizonPlan({ priceDeferralEligible: true, currentHourClaim: 'released' }),
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
      trajectory: { kind: 'resolved', status: 'at_risk' },
      horizonPlan: buildHorizonPlan({
        status: 'at_risk',
        statusDetail: 'feasible_above_floor',
        priceDeferralEligible: true,
        currentHourClaim: 'released',
      }),
    });
    expect(resolveDeferredAvoidDeviceIds([diagnostic]).has('heater1')).toBe(true);
  });

  it('does not flag a normally-planned device that is running this hour', () => {
    const diagnostic = buildDiagnostic({ deviceId: 'heater1', horizonPlan: buildHorizonPlan() });
    expect(resolveDeferredAvoidDeviceIds([diagnostic]).has('heater1')).toBe(false);
  });
});

/**
 * The property the split exists for: a diagnostic that could not be computed
 * carries no verdict at all, so no consumer can read a data problem as a
 * trajectory claim. Before the split this was a `status: 'unknown'` arm sitting
 * beside the real verdicts, and forgetting to branch on it shipped a bug —
 * gating the external-off overlay on the live status reverted every surface to a
 * cached "On track" while the device was held off.
 */
describe('a diagnostic with no trajectory', () => {
  it('answers no verdict, not a wrong one', () => {
    const diagnostic = buildDiagnostic({
      deviceId: 'heater1',
      trajectory: { kind: 'unavailable', reasonCode: 'objective_missing_charge_rate' },
      horizonPlan: undefined,
    });

    expect(resolvedTrajectoryStatus(diagnostic)).toBeUndefined();
    // Not `on_track`, not `satisfied`, not `cannot_meet` — no status at all.
    for (const status of ['on_track', 'at_risk', 'cannot_meet', 'satisfied', 'invalid'] as const) {
      expect(resolvedTrajectoryStatus(diagnostic)).not.toBe(status);
    }
    expect(applyDeferredObjectiveAdmission([diagnostic]).get('heater1'))
      .toEqual({ kind: 'inactive', budgetExempt: false });
  });
});
