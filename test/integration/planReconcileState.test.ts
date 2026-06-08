import type { DevicePlan } from '../../lib/plan/planTypes';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import {
  canRefreshPlanSnapshotFromLiveState,
  hasPlanExecutionDrift,
  buildLiveStatePlan,
} from '../../lib/plan/planReconcileState';
import { hasPlanExecutionDriftForDevice as hasExecutorPlanExecutionDriftForDevice } from '../../lib/executor/planExecutionDrift';
import { buildBinaryObservation } from '../utils/binaryObservationTestUtils';

const steppedProfile = {
  model: 'stepped_load' as const,
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

const buildSteppedDevice = (
  overrides: Partial<DevicePlan['devices'][number]> = {},
): DevicePlan['devices'][number] => ({
  id: 'dev-1',
  name: 'Tank',
  currentState: 'on',
  plannedState: 'keep',
  currentTarget: null,
  controllable: true,
  steppedLoadProfile: steppedProfile,
  selectedStepId: 'low',
  desiredStepId: 'low',
  ...overrides,
});

const buildBinaryDevice = (
  overrides: Partial<DevicePlan['devices'][number]> = {},
): DevicePlan['devices'][number] => ({
  id: 'dev-2',
  name: 'Heater',
  currentState: 'on',
  plannedState: 'keep',
  currentTarget: 21,
  plannedTarget: 21,
  controllable: true,
  controlCapabilityId: 'onoff',
  ...overrides,
});

const buildEvDevice = (
  overrides: Partial<DevicePlan['devices'][number]> = {},
): DevicePlan['devices'][number] => buildBinaryDevice({
  id: 'ev-1',
  name: 'EV Charger',
  currentTarget: null,
  plannedTarget: undefined,
  deviceClass: 'evcharger',
  controlCapabilityId: 'evcharger_charging',
  evChargingState: 'plugged_in_paused',
  deferredReleaseIntent: 'binary_restore',
  ...overrides,
});

const buildPlan = (devices: DevicePlan['devices']): DevicePlan => ({
  meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
  devices,
});

const hasPlanExecutionDriftForDevice = (
  plan: DevicePlan,
  liveDevices: PlanInputDevice[],
  deviceId: string,
): boolean => hasExecutorPlanExecutionDriftForDevice({ plan, liveDevices, deviceId });

describe('planReconcileState stepped device drift', () => {
  describe('hasPlanExecutionDrift', () => {
    it('detects step drift for a stepped device', () => {
      const previous = buildPlan([buildSteppedDevice({ selectedStepId: 'low' })]);
      const live = buildPlan([buildSteppedDevice({ selectedStepId: 'max' })]);

      expect(hasPlanExecutionDrift(previous, live)).toBe(true);
    });

    it('detects binary (onoff) drift for a stepped device', () => {
      const previous = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const live = buildPlan([buildSteppedDevice({ currentState: 'off', selectedStepId: 'low' })]);

      expect(hasPlanExecutionDrift(previous, live)).toBe(true);
    });

    it('detects combined step and binary drift for a stepped device', () => {
      const previous = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const live = buildPlan([buildSteppedDevice({ currentState: 'off', selectedStepId: 'max' })]);

      expect(hasPlanExecutionDrift(previous, live)).toBe(true);
    });

    it('reports no drift when both step and binary state match', () => {
      const previous = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const live = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);

      expect(hasPlanExecutionDrift(previous, live)).toBe(false);
    });

    it('still detects binary drift for non-stepped devices', () => {
      const previous = buildPlan([buildBinaryDevice({ currentState: 'on' })]);
      const live = buildPlan([buildBinaryDevice({ currentState: 'off' })]);

      expect(hasPlanExecutionDrift(previous, live)).toBe(true);
    });
  });

  describe('hasPlanExecutionDriftForDevice', () => {
    it('treats a keep device that is still observed off as drift even if the stored snapshot is stale', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'off',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        binaryControlObservation: buildBinaryObservation('onoff', false),
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(true);
    });

    it('does not treat target-only keep devices as binary drift', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'not_applicable',
        plannedState: 'keep',
        controlCapabilityId: undefined,
        currentTarget: 21,
        plannedTarget: 21,
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: undefined,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });

    it('still detects target drift for target-only keep devices', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'not_applicable',
        plannedState: 'keep',
        controlCapabilityId: undefined,
        currentTarget: 21,
        plannedTarget: 21,
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: undefined,
        targets: [{ id: 'target_temperature', value: 19, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(true);
    });

    it('does not treat target divergence as drift while a matching target command is still pending', () => {
      // Symmetric with the binary dampener: `targetExecutor` reconcile mode
      // bypasses pending-target retry suppression, so without this dampener a
      // stale observation would re-fire drift every cycle until the circuit
      // breaker tripped.
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'not_applicable',
        plannedState: 'keep',
        controlCapabilityId: undefined,
        currentTarget: 21,
        plannedTarget: 21,
        pendingTargetCommand: {
          desired: 21,
          retryCount: 0,
          nextRetryAtMs: 0,
          status: 'waiting_confirmation',
        },
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: undefined,
        observationStale: true,
        targets: [{ id: 'target_temperature', value: 19, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });

    it('treats a mismatched pending target command as drift', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'not_applicable',
        plannedState: 'keep',
        controlCapabilityId: undefined,
        currentTarget: 21,
        plannedTarget: 21,
        pendingTargetCommand: {
          desired: 18,
          retryCount: 0,
          nextRetryAtMs: 0,
          status: 'waiting_confirmation',
        },
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: undefined,
        targets: [{ id: 'target_temperature', value: 19, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(true);
    });

    it('does not treat a keep device as drift while a matching binary command is still pending', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'off',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        binaryCommandPending: true,
        binaryCommandPendingDesired: true,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });

    it('treats a mismatched pending binary command as drift', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'off',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        binaryControlObservation: buildBinaryObservation('onoff', false),
        binaryCommandPending: true,
        binaryCommandPendingDesired: false,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(true);
    });

    it('treats fresh off binary state as keep-plan drift', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'on',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        binaryControlObservation: buildBinaryObservation('onoff', false),
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(true);
    });

    it('treats paused EV state as drift when a deadline resume is expected', () => {
      const plan = buildPlan([buildEvDevice()]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'ev-1',
        name: 'EV Charger',
        binaryControl: { on: false },
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_paused',
        targets: [],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'ev-1')).toBe(true);
    });

    it('dampens EV deadline resume drift while the matching binary command is pending', () => {
      const plan = buildPlan([buildEvDevice()]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'ev-1',
        name: 'EV Charger',
        binaryControl: { on: true },
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_paused',
        binaryCommandPending: true,
        binaryCommandPendingDesired: true,
        targets: [],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'ev-1')).toBe(false);
    });

    it('treats charging EV state as drift when a deadline pause is expected', () => {
      const plan = buildPlan([buildEvDevice({
        evChargingState: 'plugged_in_charging',
        deferredReleaseIntent: 'binary_release',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'ev-1',
        name: 'EV Charger',
        binaryControl: { on: true },
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_charging',
        targets: [],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'ev-1')).toBe(true);
    });

    it('dampens EV deadline pause drift while the matching binary command is pending', () => {
      const plan = buildPlan([buildEvDevice({
        evChargingState: 'plugged_in_charging',
        deferredReleaseIntent: 'binary_release',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'ev-1',
        name: 'EV Charger',
        binaryControl: { on: true },
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_charging',
        binaryCommandPending: true,
        binaryCommandPendingDesired: false,
        targets: [],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'ev-1')).toBe(false);
    });

    it('does not treat capacity-control-off keep state as drift without executor restore context', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'off',
        plannedState: 'keep',
        controllable: false,
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        controllable: false,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });

    it('still detects drift against a stale live binary observation — observer data wins over planner data', () => {
      // Drift compares what we asked for against what observer reports. Even a
      // stale observation is the device's most recently observed (possibly
      // outdated) state; suppressing drift on staleness would hide a real
      // divergence. Re-actuating against the drift is idempotent, so the worst
      // case is a redundant command.
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'on',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        observationStale: true,
        // Stale observation still counts as evidence — `binaryControlObservation`
        // is present, just old.
        binaryControlObservation: buildBinaryObservation('onoff', false),
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(true);
    });

    it('detects binary drift for a stepped device via live input', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
        binaryControlObservation: buildBinaryObservation('onoff', false),
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(true);
    });

    it('detects step drift for a stepped device via live input', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(true);
    });

    it('reports no drift when stepped device state matches', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
    });

    it('does not treat restore preparation at low with pending confirmation as binary drift', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'off',
        plannedState: 'keep',
        selectedStepId: 'off',
        desiredStepId: 'low',
        controlCapabilityId: 'onoff',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
        binaryControlObservation: buildBinaryObservation('onoff', false),
        stepCommandPending: true,
        binaryCommandPending: true,
        binaryCommandPendingDesired: true,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
    });

    it('does not treat full-shed step preparation as binary drift before low is confirmed', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        plannedState: 'shed',
        shedAction: 'turn_off',
        selectedStepId: 'max',
        desiredStepId: 'off',
        controlCapabilityId: 'onoff',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
        stepCommandPending: true,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
    });

    it('does not let a stale off-step identity mask fresh binary on drift', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'off',
        plannedState: 'shed',
        shedAction: 'turn_off',
        selectedStepId: 'off',
        desiredStepId: 'off',
        controlCapabilityId: 'onoff',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'off',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
        binaryControlObservation: buildBinaryObservation('onoff', true),
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(true);
    });

    it('treats restore preparation as drift when the pending step jumps to an unexpected value', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'off',
        plannedState: 'keep',
        selectedStepId: 'off',
        desiredStepId: 'low',
        controlCapabilityId: 'onoff',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
        stepCommandPending: true,
        binaryCommandPending: true,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(true);
    });

    it('does not force stepped set_step shedding to look binary-off when the device is correctly on at the shed step', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        plannedState: 'shed',
        shedAction: 'set_step',
        selectedStepId: 'low',
        desiredStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
    });

    it('ignores target drift for stepped set_step shedding but still checks binary state', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        plannedState: 'shed',
        shedAction: 'set_step',
        selectedStepId: 'low',
        desiredStepId: 'low',
        currentTarget: 21,
        plannedTarget: 21,
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'low',
        targets: [{ id: 'target_temperature', value: 23, unit: '°C' }],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
        binaryControlObservation: buildBinaryObservation('onoff', true),
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
      expect(hasPlanExecutionDriftForDevice(
        plan,
        [{ ...liveDevices[0], binaryControl: { on: false }, binaryControlObservation: buildBinaryObservation('onoff', false) }],
        'dev-1',
      )).toBe(true);
    });

    it('does not treat stepped set_step shedding as drift when the stored snapshot is stale off but the live device is on at the shed step', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'off',
        plannedState: 'shed',
        shedAction: 'set_step',
        selectedStepId: 'low',
        desiredStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
    });

    it('does not treat fresh off binary state as drift for shed-off intent', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'on',
        plannedState: 'shed',
        shedAction: 'turn_off',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });
  });

  describe('buildLiveStatePlan', () => {
    it('merges live binary state into stepped device plan', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].currentState).toBe('off');
      expect(result.devices[0].selectedStepId).toBe('max');
    });

    it('clears stale reported step evidence when live stepped state only has fallback evidence', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        selectedStepId: 'low',
        reportedStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        // Fallback-only live state: no reported step, selectedStepId is the
        // planning fallback.
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

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
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(hasPlanExecutionDrift(plan, result)).toBe(true);
      expect(canRefreshPlanSnapshotFromLiveState(plan, result)).toBe(true);
    });

    it('preserves effective step while clearing stale evidence when live lacks step evidence', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        selectedStepId: 'low',
        reportedStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

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
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'max',
        reportedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0]).toEqual(expect.objectContaining({
        selectedStepId: 'max',
        reportedStepId: 'max',
      }));
    });

    it('keeps stepped off-step classification consistent with initial planning even when currentOn is true', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'off', selectedStepId: 'off' })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'off',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].currentState).toBe('off');
    });

    it('treats stale live binary observations as unknown in the merged plan', () => {
      const plan = buildPlan([buildBinaryDevice({ currentState: 'on' })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        observationStale: true,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].currentState).toBe('unknown');
      expect(result.devices[0].observationStale).toBe(true);
    });

    it('refreshes binaryCommandPending from live state so cleared pending does not stick', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'off',
        binaryCommandPending: true,
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        binaryCommandPending: false,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

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
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        selectedStepId: 'off',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      const result = buildLiveStatePlan(plan, liveDevices);

      // The stale desiredStepId='low' must be clamped to 'off'.
      // Without the fix: desiredStepId stays 'low' while selectedStepId='off',
      // which causes the executor to fire a step-UP restore command for a shed device.
      expect(result.devices[0].desiredStepId).toBe('off');
      expect(result.devices[0].selectedStepId).toBe('off');
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
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      const result = buildLiveStatePlan(plan, liveDevices);

      // desiredStepId must stay 'low' — the step-DOWN command should still be issued
      expect(result.devices[0].desiredStepId).toBe('low');
      expect(result.devices[0].selectedStepId).toBe('max');
    });

    it('does not clamp desiredStepId for keep devices', () => {
      // A keep device can legitimately have desiredStepId pointing somewhere different from selectedStepId
      const plan = buildPlan([buildSteppedDevice({
        plannedState: 'keep',
        currentState: 'off',
        selectedStepId: 'off',
        desiredStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        selectedStepId: 'off',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].desiredStepId).toBe('low');
    });
  });
});

// ---------------------------------------------------------------------------
// Group 4: expected binary state for stepped turn_off / turn_on
// Tests probe expected-binary-state logic indirectly through drift detection.
// hasPlanExecutionDriftForDevice returns true when the live state does not
// match the expected binary state derived from the plan.
// ---------------------------------------------------------------------------

describe('expected binary state for stepped turn_off / turn_on (Group 4)', () => {
  const buildSteppedShedDevice = (
    overrides: Partial<DevicePlan['devices'][number]> = {},
  ): DevicePlan['devices'][number] => ({
    id: 'dev-1',
    name: 'Tank',
    currentState: 'on',
    plannedState: 'shed',
    currentTarget: null,
    controllable: true,
    steppedLoadProfile: steppedProfile,
    selectedStepId: 'low',
    desiredStepId: 'low',
    shedAction: 'turn_off',
    ...overrides,
  });

  const buildKeepDevice = (
    overrides: Partial<DevicePlan['devices'][number]> = {},
  ): DevicePlan['devices'][number] => ({
    id: 'dev-1',
    name: 'Tank',
    currentState: 'off',
    plannedState: 'keep',
    currentTarget: null,
    controllable: true,
    steppedLoadProfile: steppedProfile,
    selectedStepId: 'low',
    desiredStepId: 'low',
    ...overrides,
  });

  const buildLiveInput = (
    overrides: Partial<PlanInputDevice> = {},
  ): PlanInputDevice => {
    const merged: PlanInputDevice = {
      id: 'dev-1',
      name: 'Tank',
      targets: [],
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'low',
      ...overrides,
    };
    // Group 4 covers the binary-state side of stepped drift detection. Each
    // case toggles `currentOn` to model an observed binary value, so default
    // a matching `binaryControlObservation` unless an override supplies one.
    return merged.binaryControlObservation
      ? merged
      : { ...merged, binaryControlObservation: buildBinaryObservation('onoff', merged.binaryControl?.on) };
  };

  const buildPlanWith = (device: DevicePlan['devices'][number]): DevicePlan => ({
    meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
    devices: [device],
  });

  // Test 4.1: stepped turn_off shed → expected binary state is always 'off'.
  // Detected as drift when live state is 'on'; no drift when live state is 'off'.
  it('expectedBinaryState is off for stepped turn_off shed (detected via drift)', () => {
    const plan = buildPlanWith(buildSteppedShedDevice({ shedAction: 'turn_off', selectedStepId: 'low' }));

    // Live currentOn=true → current state is 'on' → differs from expected 'off' → drift
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ binaryControl: { on: true }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(true);

    // Live currentOn=false → current state is 'off' → matches expected 'off' → no binary drift
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ binaryControl: { on: false }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(false);
  });

  // Test 4.2: stepped keep (turn_on intent) → expected binary state is always 'on'.
  // Detected as drift when live state is 'off'; no drift when live state is 'on'.
  it('expectedBinaryState is on for stepped keep (turn_on intent), detected via drift', () => {
    const plan = buildPlanWith(buildKeepDevice({ currentState: 'off', selectedStepId: 'low' }));

    // Live currentOn=false → current state is 'off' → differs from expected 'on' → drift
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ binaryControl: { on: false }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(true);

    // Live currentOn=true → current state is 'on' → matches expected 'on' → no binary drift
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ binaryControl: { on: true }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(false);
  });

  // Test 4.4 / Regression 5.3: for set_step shed, expected binary state follows the
  // desired step: 'off' when at off-step, 'on' when at non-off step.
  // Critically, turn_off must NOT route through this set_step logic — it must always
  // resolve to 'off' directly.
  it('set_step shed expectedBinaryState is on for non-off step, off for off step', () => {
    // set_step shed at non-off step → expected 'on'
    const setStepAtLow = buildPlanWith(buildSteppedShedDevice({
      shedAction: 'set_step',
      selectedStepId: 'low',
      desiredStepId: 'low',
    }));
    // Live currentOn=true (step at 'low', non-off) → liveCurrentState='on' → no drift
    expect(hasPlanExecutionDriftForDevice(setStepAtLow, [buildLiveInput({ binaryControl: { on: true }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(false);
    // Live currentOn=false (step at 'low', non-off) → liveCurrentState='off' → drift
    // (expected='on' from set_step at non-off, live='off')
    expect(hasPlanExecutionDriftForDevice(setStepAtLow, [buildLiveInput({ binaryControl: { on: false }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(true);

    // set_step shed at off-step → expected 'off'.
    // Note: for stepped devices, resolveSteppedLoadCurrentState returns 'off' for
    // the off-step regardless of currentOn, so both currentOn=true and currentOn=false
    // produce liveCurrentState='off' when selectedStepId='off'. Binary drift cannot
    // be triggered by toggling currentOn alone at the off-step.
    // Instead, test that step drift is detected when selectedStepId changes.
    const setStepAtOff = buildPlanWith(buildSteppedShedDevice({
      shedAction: 'set_step',
      selectedStepId: 'off',
      desiredStepId: 'off',
    }));
    // Live at off-step with binary off → no drift (expected='off', live='off')
    expect(hasPlanExecutionDriftForDevice(setStepAtOff, [buildLiveInput({ binaryControl: { on: false }, selectedStepId: 'off' })], 'dev-1'))
      .toBe(false);
    // Live step changed to 'low' → step drift (live selectedStepId ≠ previous selectedStepId)
    expect(hasPlanExecutionDriftForDevice(setStepAtOff, [buildLiveInput({ binaryControl: { on: true }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(true);
  });

  it('does not infer set_step shed binary drift when the requested step is missing', () => {
    const plan = buildPlanWith(buildSteppedShedDevice({
      shedAction: 'set_step',
      selectedStepId: undefined,
      desiredStepId: undefined,
    }));

    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ binaryControl: { on: false }, selectedStepId: undefined })], 'dev-1'))
      .toBe(false);
  });

  // Regression 5.3: turn_off shed with a non-off desiredStepId must still resolve to
  // expected binary state 'off' — it must never be contaminated by the set_step logic
  // that would return 'on' for a non-off desiredStep.
  it('turn_off shed is never treated as set_step for expected binary state: always resolves to off', () => {
    // Device has turn_off but desiredStepId is 'low' (non-off). If the code accidentally
    // routed this through resolveSteppedShedBinaryState, it would return 'on'. It must not.
    const plan = buildPlanWith(buildSteppedShedDevice({
      shedAction: 'turn_off',
      selectedStepId: 'low',
      desiredStepId: 'low', // non-off desiredStep — must not contaminate the 'off' result
    }));

    // Expected binary is 'off' for turn_off regardless of desiredStepId.
    // Live currentOn=true → drift (expected='off', observed='on')
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ binaryControl: { on: true }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(true);
    // Live currentOn=false → no drift (expected='off', observed='off')
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ binaryControl: { on: false }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(false);
  });
});
