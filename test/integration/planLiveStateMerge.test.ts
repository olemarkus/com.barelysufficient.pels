import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { isSteppedLoadDevice } from '../../lib/plan/planSteppedLoad';
import { buildLiveStatePlan } from '../../lib/plan/planLiveStateMerge';
import {
  canRefreshPlanSnapshotFromLiveState,
  hasLiveStateDivergedFromSnapshot,
} from '../../lib/executor/executorConvergence';
import {
  asOutputDevice,
  buildBinaryDevice,
  buildPlan,
  buildSteppedDevice,
  inputDevice,
  steppedProfile,
} from '../utils/planConvergenceFixtures';
import { isTemperaturePlanDevice } from '../../lib/plan/planTemperatureDevice';

describe('planLiveStateMerge', () => {
  // The temperature cluster moves as ONE unit, from the LIVE device: the
  // discriminant (`deviceType`) is re-sourced from live alongside it, so the
  // merged snapshot can never pair a stale cluster with a fresh discriminant.
  describe('buildLiveStatePlan — temperature cluster', () => {
    const priorTemperature = () => asOutputDevice({
      id: 'dev-t', name: 'Thermostat', commandableNow: true,
      deviceType: 'temperature' as const,
      currentState: 'on', plannedState: 'keep' as const,
      currentTarget: 21, currentTemperature: 20, plannedTarget: 22,
      currentDrawKw: 0.4, expectedPowerKw: 1, expectedPowerSource: 'default' as const,
      controllable: true, available: true,
      reason: { code: 'keep', detail: null },
    });
    const liveTemperature = (fields: { currentTarget: number; currentTemperature: number }) => inputDevice({
      id: 'dev-t', name: 'Thermostat',
      deviceType: 'temperature',
      targets: [{ id: 'target_temperature', value: fields.currentTarget, unit: '°C' }],
      ...fields,
    });

    it('re-sources observations from live and carries the prior decision', () => {
      const plan = buildPlan([priorTemperature()]);
      const merged = buildLiveStatePlan(plan, [liveTemperature({ currentTarget: 19, currentTemperature: 18.5 })])
        .devices[0];

      if (!isTemperaturePlanDevice(merged)) throw new Error('expected a temperature plan device');
      expect(merged.currentTarget).toBe(19);
      expect(merged.currentTemperature).toBe(18.5);
      // The DECISION is carried — this is a projection, not a re-plan.
      expect(merged.plannedTarget).toBe(22);
    });

    it('drops the whole cluster (and the discriminant) when the live device lost the facet', () => {
      const plan = buildPlan([priorTemperature()]);
      const liveDemoted = inputDevice({
        id: 'dev-t', name: 'Thermostat',
        deviceType: 'onoff',
        targets: [],
        binaryControl: { on: true },
        binaryCapabilityId: 'onoff',
      });
      const merged = buildLiveStatePlan(plan, [liveDemoted]).devices[0];

      expect(isTemperaturePlanDevice(merged)).toBe(false);
      expect(merged.deviceType).toBe('onoff');
      expect('currentTarget' in merged).toBe(false);
      // Losing the tracked setpoint IS execution drift, and the pending target
      // cannot settle against a facet-less live device.
      expect(hasLiveStateDivergedFromSnapshot(plan, buildLiveStatePlan(plan, [liveDemoted]))).toBe(true);
      expect(canRefreshPlanSnapshotFromLiveState(plan, buildLiveStatePlan(plan, [liveDemoted]))).toBe(false);
    });

    it('seeds planned === current for a device that BECAME temperature since the plan was built', () => {
      const priorBinary = asOutputDevice({
        id: 'dev-t', name: 'Thermostat', commandableNow: true,
        currentState: 'on', plannedState: 'keep' as const,
        currentOn: true, binaryCapabilityId: 'onoff' as const,
        currentDrawKw: 0.4, expectedPowerKw: 1, expectedPowerSource: 'default' as const,
        controllable: true, available: true,
        reason: { code: 'keep', detail: null },
      });
      const merged = buildLiveStatePlan(
        buildPlan([priorBinary]),
        [liveTemperature({ currentTarget: 21, currentTemperature: 20 })],
      ).devices[0];

      if (!isTemperaturePlanDevice(merged)) throw new Error('expected a temperature plan device');
      // "No decision yet" materializes as planned === current (executor no-op).
      expect(merged.plannedTarget).toBe(21);
    });
  });

  describe('buildLiveStatePlan', () => {
    it('takes live availability and controllability over prior values', () => {
      const plan = buildPlan([buildBinaryDevice({ available: false, controllable: false })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: true },
        binaryCapabilityId: 'onoff',
        targets: [],
        available: true,
        controllable: true,
      })];

      expect(buildLiveStatePlan(plan, liveDevices).devices[0]).toEqual(expect.objectContaining({
        available: true,
        controllable: true,
      }));
    });

    it('preserves explicit false live availability and controllability', () => {
      const plan = buildPlan([buildBinaryDevice({ available: true, controllable: true })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: true },
        binaryCapabilityId: 'onoff',
        targets: [],
        available: false,
        controllable: false,
      })];

      expect(buildLiveStatePlan(plan, liveDevices).devices[0]).toEqual(expect.objectContaining({
        available: false,
        controllable: false,
      }));
    });

    it('merges live binary state into stepped device plan', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        binaryCapabilityId: 'onoff',
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].currentState).toBe('off');
      expect(isSteppedLoadDevice(result.devices[0]) ? result.devices[0].selectedStepId : undefined).toBe('max');
    });

    it('clears stale reported step evidence when live stepped state only has fallback evidence', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        selectedStepId: 'low',
        reportedStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        // Fallback-only live state: no reported step, selectedStepId is the
        // planning fallback.
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0]).toEqual(expect.objectContaining({
        selectedStepId: 'low',
        reportedStepId: undefined,
      }));
    });

    it('treats cleared step evidence as refresh-worthy even when selected step and binary state match', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        selectedStepId: 'low',
        reportedStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(hasLiveStateDivergedFromSnapshot(plan, result)).toBe(true);
      expect(canRefreshPlanSnapshotFromLiveState(plan, result)).toBe(true);
    });

    it('preserves effective step while clearing stale evidence when live lacks step evidence', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        selectedStepId: 'low',
        reportedStepId: 'low',
      })]);
      // The telemetry gap as the producer emits it: no step evidence resolved
      // this cycle, so the stepped cluster was refused and the live device is
      // non-stepped (`resolveSteppedClusterFields`).
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        targets: [],
        controlModel: 'stepped_load',
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      // No live step evidence at all → reported cleared, but the previous
      // effective step is preserved as the fallback.
      expect(result.devices[0]).toEqual(expect.objectContaining({
        selectedStepId: 'low',
        reportedStepId: undefined,
      }));
    });

    it('keeps fresh reported live step evidence when it replaces older plan evidence', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        selectedStepId: 'low',
        reportedStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'max',
        reportedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0]).toEqual(expect.objectContaining({
        selectedStepId: 'max',
        reportedStepId: 'max',
      }));
    });

    it('keeps stepped off-step classification consistent with initial planning even when currentOn is true', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'off', selectedStepId: 'off' })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'off',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].currentState).toBe('off');
    });

    it('recomputes currentOn from the merged stepped profile when live binary state lacks the profile', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'off',
        currentOn: false,
        selectedStepId: 'off',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        currentOn: true,
        binaryCapabilityId: 'onoff',
        selectedStepId: 'off',
        targets: [],
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      // `binaryControl` no longer rides on the reconciled plan device; `currentOn`
      // is recombined from the binary signal + the preserved (merged) stepped
      // profile, so the 'off' step folds in even though the live snapshot lacked
      // the profile and reported `currentOn: true`.
      expect(result.devices[0]).toEqual(expect.objectContaining({
        currentOn: false,
        currentState: 'off',
        selectedStepId: 'off',
      }));
    });

    it('merges a stale live binary observation to its latched off label (trusts currentOn, not unknown)', () => {
      // The reconcile merge recomputes the label from the producer-resolved
      // `currentOn` (the latched on/off truth) and no longer re-applies staleness:
      // a confirmed-off live binary device merges to 'off', not 'unknown'. Homey
      // reports capabilities on change, so the latched off IS the trusted state.
      const plan = buildPlan([buildBinaryDevice({ currentState: 'on' })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        binaryCapabilityId: 'onoff',
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].currentState).toBe('off');
    });

    it('refreshes binaryCommandPending from live state so cleared pending does not stick', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'off',
        binaryCommandPending: true,
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        binaryCapabilityId: 'onoff',
        binaryCommandPending: false,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].binaryCommandPending).toBe(false);
    });

    it('clamps desiredStepId to the live selectedStepId when a shed device has jumped past its planned target', () => {
      // Previous plan: stepping the device from max down to low (set_step shed, mid-cascade)
      // desiredStepId='low' was the next intermediate target, selectedStepId='max' was the confirmed position
      const plan = buildPlan([buildSteppedDevice({
        plannedState: 'shed',
        shedAction: 'set_step' as const,
        currentState: 'on',
        selectedStepId: 'max',
        desiredStepId: 'low',
      })]);
      // Live: device jumped directly to 'off' (past the 'low' target — hardware overshoot or external control)
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        selectedStepId: 'off',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      // The stale desiredStepId='low' must be clamped to 'off'.
      // Without the fix: desiredStepId stays 'low' while selectedStepId='off',
      // which causes the executor to fire a step-UP restore command for a shed device.
      expect(result.devices[0].desiredStepId).toBe('off');
      expect(isSteppedLoadDevice(result.devices[0]) ? result.devices[0].selectedStepId : undefined).toBe('off');
      expect(result.devices[0].plannedState).toBe('shed');
    });

    it('does not clamp desiredStepId when the device has not yet reached the planned target', () => {
      // Plan: stepping down from max to low — device is still at max (normal in-progress step-down)
      const plan = buildPlan([buildSteppedDevice({
        plannedState: 'shed',
        shedAction: 'set_step' as const,
        currentState: 'on',
        selectedStepId: 'max',
        desiredStepId: 'low',
      })]);
      // Live: device is still at max (has not moved yet)
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      // desiredStepId must stay 'low' — the step-DOWN command should still be issued
      expect(result.devices[0].desiredStepId).toBe('low');
      expect(isSteppedLoadDevice(result.devices[0]) ? result.devices[0].selectedStepId : undefined).toBe('max');
    });

    it('does not clamp desiredStepId for keep devices', () => {
      // A keep device can legitimately have desiredStepId pointing somewhere different from selectedStepId
      const plan = buildPlan([buildSteppedDevice({
        plannedState: 'keep',
        currentState: 'off',
        selectedStepId: 'off',
        desiredStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        selectedStepId: 'off',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].desiredStepId).toBe('low');
    });
  });
});

// An `inactive` device carries no shed target, exactly like a device the plan is
// keeping — so "no shed target" alone must not be read as "restore this". An
// external-off hold that is already observed off is settled, not pending, and
// demanding `on` for it would block the post-actuation snapshot from ever being
// adopted whenever some other device settled in the same apply.
describe('inactive devices do not demand a binary restore', () => {
  const inactiveHold = () => buildBinaryDevice({
    id: 'dev-inactive',
    name: 'External hold',
    plannedState: 'inactive' as const,
    currentState: 'off',
  });

  const settledShed = () => buildBinaryDevice({
    id: 'dev-shed',
    name: 'Tank',
    plannedState: 'shed' as const,
    shedAction: 'turn_off' as const,
    currentState: 'on',
  });

  const liveDevices = (): PlanInputDevice[] => [
    inputDevice({
      id: 'dev-inactive',
      name: 'External hold',
      binaryControl: { on: false },
      binaryCapabilityId: 'onoff' as const,
      targets: [],
    }),
    inputDevice({
      id: 'dev-shed',
      name: 'Tank',
      binaryControl: { on: false },
      binaryCapabilityId: 'onoff' as const,
      targets: [],
    }),
  ];

  it('adopts the live snapshot once the shed settles, despite an inactive device observed off', () => {
    const plan = buildPlan([inactiveHold(), settledShed()]);
    const live = buildLiveStatePlan(plan, liveDevices());

    // The shed device moved on -> off, so there is drift to settle against.
    expect(hasLiveStateDivergedFromSnapshot(plan, live)).toBe(true);
    expect(canRefreshPlanSnapshotFromLiveState(plan, live)).toBe(true);
  });
});
