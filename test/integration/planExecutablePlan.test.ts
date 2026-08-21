import { describe, expect, it } from 'vitest';
import {
  buildExecutableObservedDeviceStateFromSnapshot,
  buildExecutablePlan,
  hasExecutableShedDevices,
} from '../../lib/executor/executablePlanProjection';
import {
  buildExecutableTargetIntent,
  buildExecutableTargetUpdate,
} from '../../lib/executor/executableTargetProjection';
import { hasReleaseCommand, hasSteppedCommand } from '../../lib/executor/executablePlan';
import type { DevicePlan } from '../../lib/plan/planTypes';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { buildPlanDevice, buildPlanMeta, steppedPlanDevice } from '../utils/planTestUtils';
import { fixtureDeviceReason } from '../utils/deviceReasonTestUtils';

const planWithDevices = (devices: DevicePlan['devices']): DevicePlan => ({
  meta: buildPlanMeta({
    totalKw: 1,
    softLimitKw: 5,
    headroomKw: 4}),
  devices,
});

describe('planExecutablePlan', () => {
  describe('observed binary axis vs effective on', () => {
    // These two fields were ONE field whose meaning depended on which path
    // constructed it. They are separate because two different questions are
    // asked of the same device, and for a binary+stepped device parked at its
    // off step the honest answers differ.
    const steppedProfileAtOff = {
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'low', planningPowerW: 1250 },
      ],
    };

    it('answers both questions for a stepped device parked at its off rung with the switch armed', () => {
      const observed = buildExecutableObservedDeviceStateFromSnapshot({
        available: true,
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        steppedLoadProfile: steppedProfileAtOff,
        selectedStepId: 'off',
        targets: [],
      });

      // The handle IS on — `shedReleaseActuation` must not treat a binary-off
      // write as a no-op here.
      expect(observed.observedBinaryAxis).toBe('on');
      // ...and the device is nonetheless off, so convergence has nothing to fix.
      expect(observed.observedEffectiveOn).toBe(false);
    });

    it('agrees on both fields for a pure-binary device', () => {
      const on = buildExecutableObservedDeviceStateFromSnapshot({
        available: true, id: 'dev-1', name: 'Tank', binaryControl: { on: true }, targets: [],
      });
      expect(on.observedBinaryAxis).toBe('on');
      expect(on.observedEffectiveOn).toBe(true);

      const off = buildExecutableObservedDeviceStateFromSnapshot({
        available: true, id: 'dev-1', name: 'Tank', binaryControl: { on: false }, targets: [],
      });
      expect(off.observedBinaryAxis).toBe('off');
      expect(off.observedEffectiveOn).toBe(false);
    });

    it('reads an unobserved binary control as on — "may draw, stays sheddable"', () => {
      const unobserved = buildExecutableObservedDeviceStateFromSnapshot({
        available: true, id: 'dev-1', name: 'Tank', targets: [],
      });
      expect(unobserved.observedBinaryAxis).toBe('on');
      expect(unobserved.observedEffectiveOn).toBe(true);
    });
  });

  it('projects executable plan devices as intent, not planner-device wrappers', () => {
    const steppedDevice = steppedPlanDevice({
      id: 'step-1',
      selectedStepId: 'low',
      desiredStepId: 'max',
      reportedStepId: 'low',
    });
    const binaryDevice = buildPlanDevice({
      id: 'binary-1',
    });

    const executablePlan = buildExecutablePlan(planWithDevices([steppedDevice, binaryDevice]));

    expect(executablePlan.devices).toHaveLength(2);
    expect(executablePlan.devices[0]).toMatchObject({
      id: 'step-1',
      name: steppedDevice.name,
      controllable: true,
      steppedLoad: {
        id: 'step-1',
        desired: {
          stepId: 'max',
        },
      },
    });
    expect(executablePlan.devices[0]).not.toHaveProperty('planDevice');
    // Narrow FIRST and assert the narrowing succeeded, so the `current` check
    // cannot pass vacuously. The path form (`not.toHaveProperty('steppedLoad.current')`)
    // would: `toHaveProperty` throws on a null/undefined receiver and `.not` does
    // not invert a matcher error, so an absent `steppedLoad` would satisfy it.
    const steppedIntent = executablePlan.devices[0];
    expect(steppedIntent !== undefined && hasSteppedCommand(steppedIntent)).toBe(true);
    if (steppedIntent !== undefined && hasSteppedCommand(steppedIntent)) {
      expect(steppedIntent.steppedLoad).not.toHaveProperty('current');
    }
    // A stepped device gets no binary COMMAND this cycle: absence of the key is
    // the answer, replacing the old `binary: null` slot.
    expect(executablePlan.devices[0]).not.toHaveProperty('binary');
    expect(executablePlan.devices[1]).toMatchObject({
      id: 'binary-1',
      binary: {
        desiredOn: true,
        source: 'controlled',
      },
    });
    expect(executablePlan.devices[1]).not.toHaveProperty('steppedLoad');
  });

  it('projects target updates into the executor-facing command shape', () => {
    const thermostat = buildPlanDevice({
      id: 'thermostat-1',
      name: 'Thermostat',
      currentTarget: 16,
      plannedTarget: 21,
    });
    const intent = buildExecutableTargetIntent(thermostat);
    const observed = buildExecutableObservedDeviceStateFromSnapshot({
      available: true,
      id: 'thermostat-1',
      name: 'Thermostat',
      binaryControl: { on: true },
      targets: [{ id: 'target_temperature', value: 16, unit: '°C' }],
    });

    expect(buildExecutableTargetUpdate(
      intent,
      observed,
      () => ({ action: 'set_temperature', temperature: 16 }),
    )).toEqual({
      deviceId: 'thermostat-1',
      name: 'Thermostat',
      target: 'temperature',
      desired: 21,
      observedValue: 16,
      isRestoring: true,
      communicationModel: undefined,
    });
  });

  it('does not project binary intent for target-only devices', () => {
    const targetOnly = buildPlanDevice({
      id: 'target-only-1',
      name: 'Target only',
      currentState: 'not_applicable',
      plannedState: 'keep',
      binaryCapabilityId: undefined,
      currentTarget: 19,
      plannedTarget: 21,
    });

    const executablePlan = buildExecutablePlan(planWithDevices([targetOnly]));

    expect(executablePlan.devices[0]).toMatchObject({
      id: 'target-only-1',
      target: {
        deviceId: 'target-only-1',
        desired: 21,
        purpose: 'target_update',
      },
    });
    // The point of this case: a target-only device drives neither other axis.
    expect(executablePlan.devices[0]).not.toHaveProperty('binary');
    expect(executablePlan.devices[0]).not.toHaveProperty('steppedLoad');
  });

  it.each([
    [{ code: PLAN_REASON_CODES.startupStabilization }],
    [{ code: PLAN_REASON_CODES.waitingForOtherDevices }],
  ] as const)('does not project EV deadline resume while restore admission is held by %s', (reason) => {
    const evCharger = buildPlanDevice({
      id: 'ev-1',
      name: 'EV Charger',
      deviceClass: 'evcharger',
      binaryCapabilityId: 'evcharger_charging',
      plannedState: 'keep',
      currentState: 'on',
      evChargingState: 'plugged_in_paused',
      deferredReleaseIntent: 'binary_restore',
      reason,
    });

    const executablePlan = buildExecutablePlan({
      meta: buildPlanMeta({
        totalKw: 1,
        softLimitKw: 5,
        headroomKw: 4,
        powerFreshnessState: 'fresh'}),
      devices: [evCharger],
    });

    expect(executablePlan.devices[0]).not.toHaveProperty('release');
  });

  // The POSITIVE release case. Without this, `release` is the only command axis
  // with no projection test asserting it is ever attached — and since every
  // axis is now a conditional spread, dropping
  // `...(release ? { release } : {})` from `buildExecutableDeviceIntent` would
  // compile cleanly and silently stop the whole smart-task lifecycle release
  // path from actuating. It used to be a required `| null` property, so the
  // compiler caught that; now only this test does.
  it('projects a deferred release intent when restore admission is not held', () => {
    const evCharger = buildPlanDevice({
      id: 'ev-1',
      name: 'EV Charger',
      deviceClass: 'evcharger',
      binaryCapabilityId: 'evcharger_charging',
      plannedState: 'keep',
      currentState: 'on',
      evChargingState: 'plugged_in_paused',
      deferredReleaseIntent: 'binary_restore',
    });

    const executablePlan = buildExecutablePlan({
      meta: buildPlanMeta({
        totalKw: 1,
        softLimitKw: 5,
        headroomKw: 4,
        powerFreshnessState: 'fresh'}),
      devices: [evCharger],
    });

    const intent = executablePlan.devices[0];
    expect(intent !== undefined && hasReleaseCommand(intent)).toBe(true);
    if (intent !== undefined && hasReleaseCommand(intent)) {
      expect(intent.release.kind).toBe('binary_restore');
      expect(intent.release.deviceId).toBe('ev-1');
    }
  });

  describe('hasExecutableShedDevices', () => {
    const shedReason = fixtureDeviceReason('shed due to capacity')!;

    it('detects shed posture from binary shed intent', () => {
      const plan = planWithDevices([
        buildPlanDevice({
          id: 'binary-shed',
          plannedState: 'shed',
          reason: shedReason,
        }),
      ]);
      expect(hasExecutableShedDevices(plan, buildExecutablePlan(plan))).toBe(true);
    });

    it('detects shed posture from stepped shed intent', () => {
      const plan = planWithDevices([
        steppedPlanDevice({
          id: 'stepped-shed',
          plannedState: 'shed',
          shedAction: 'turn_off',
          selectedStepId: 'low',
          reason: shedReason,
        }),
      ]);
      expect(hasExecutableShedDevices(plan, buildExecutablePlan(plan))).toBe(true);
    });

    it('detects shed posture from shed_temperature target intent', () => {
      const plan = planWithDevices([
        buildPlanDevice({
          id: 'thermostat-shed',
          plannedState: 'shed',
          shedAction: 'set_temperature',
          currentTarget: 21,
          plannedTarget: 16,
          reason: shedReason,
        }),
      ]);
      expect(hasExecutableShedDevices(plan, buildExecutablePlan(plan))).toBe(true);
    });

    it('does not count an underspecified set_step shed because its executable intent is null', () => {
      const plan = planWithDevices([
        steppedPlanDevice({
          id: 'underspecified',
          plannedState: 'shed',
          shedAction: 'set_step',
          selectedStepId: undefined,
          desiredStepId: undefined,
          reason: shedReason,
        }),
      ]);
      expect(hasExecutableShedDevices(plan, buildExecutablePlan(plan))).toBe(false);
    });

    it('counts a planner-shed device held by restore admission (cooldown) as shed posture', () => {
      // Cooldown-held shed devices are uncommandable but still semantically shed; the gate
      // must keep them in posture so unrelated stepped restores remain bounded.
      const plan = planWithDevices([
        buildPlanDevice({
          id: 'held-shed',
          plannedState: 'shed',
          reason: fixtureDeviceReason('meter settling (30s remaining)')!,
        }),
      ]);
      expect(hasExecutableShedDevices(plan, buildExecutablePlan(plan))).toBe(true);
    });

    it('returns false for a plan with only keep devices', () => {
      const plan = planWithDevices([buildPlanDevice()]);
      expect(hasExecutableShedDevices(plan, buildExecutablePlan(plan))).toBe(false);
    });

    it('does NOT count a "Run on solar surplus" hold as capacity-shed posture', () => {
      // A dump load merely waiting for export is an opt-in posture, not capacity
      // pressure — it must not bound unrelated stepped restores at their lowest step.
      const plan = planWithDevices([
        buildPlanDevice({
          id: 'pool-pump',
          plannedState: 'shed',
          surplusOnly: true,
          reason: { code: PLAN_REASON_CODES.awaitingSolarSurplus },
        }),
      ]);
      expect(hasExecutableShedDevices(plan, buildExecutablePlan(plan))).toBe(false);
    });

    it('still counts a surplusOnly device that is GENUINELY capacity-shed as posture', () => {
      // Discriminated on the reason code, not the surplusOnly flag: an engaged dump
      // load shed for capacity carries a `capacity` reason and MUST still block.
      const plan = planWithDevices([
        buildPlanDevice({
          id: 'pool-pump',
          plannedState: 'shed',
          surplusOnly: true,
          reason: shedReason,
        }),
      ]);
      expect(hasExecutableShedDevices(plan, buildExecutablePlan(plan))).toBe(true);
    });
  });

  it('uses observed state when projecting target updates', () => {
    const thermostat = buildPlanDevice({
      id: 'thermostat-1',
      name: 'Thermostat',
      currentTarget: 18,
      plannedTarget: 20,
    });
    const intent = buildExecutableTargetIntent(thermostat);
    const observed = buildExecutableObservedDeviceStateFromSnapshot({
      available: true,
      id: 'thermostat-1',
      name: 'Thermostat',
      binaryControl: { on: true },
      targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
    });

    expect(buildExecutableTargetUpdate(
      intent,
      observed,
      () => ({ action: 'turn_off' }),
    )).toEqual({
      deviceId: 'thermostat-1',
      name: 'Thermostat',
      target: 'temperature',
      desired: 20,
      observedValue: 18,
      isRestoring: false,
      communicationModel: undefined,
    });
  });
});
