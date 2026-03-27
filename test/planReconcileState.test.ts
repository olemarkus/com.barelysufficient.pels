import type { DevicePlan } from '../lib/plan/planTypes';
import type { PlanInputDevice } from '../lib/plan/planTypes';
import {
  hasPlanExecutionDrift,
  hasPlanExecutionDriftForDevice,
  buildLiveStatePlan,
} from '../lib/plan/planReconcileState';

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
  plannedTarget: null,
  controllable: true,
  controlModel: 'stepped_load',
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
  ...overrides,
});

const buildPlan = (devices: DevicePlan['devices']): DevicePlan => ({
  meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
  devices,
});

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
        currentOn: false,
        hasBinaryControl: true,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
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
        currentOn: false,
        hasBinaryControl: true,
        binaryCommandPending: true,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });

    it('treats fresh off binary state as keep-plan drift', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'on',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        currentOn: false,
        hasBinaryControl: true,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(true);
    });

    it('does not treat stale live binary observations as drift', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'on',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        currentOn: false,
        hasBinaryControl: true,
        observationStale: true,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });

    it('detects binary drift for a stepped device via live input', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        currentOn: false,
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(true);
    });

    it('detects step drift for a stepped device via live input', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        currentOn: true,
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
        currentOn: true,
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
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
        currentOn: true,
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
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
        currentOn: true,
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
        currentOn: false,
        hasBinaryControl: true,
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
        currentOn: false,
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].currentState).toBe('off');
      expect(result.devices[0].selectedStepId).toBe('max');
    });

    it('keeps stepped off-step classification consistent with initial planning even when currentOn is true', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'off', selectedStepId: 'off' })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        currentOn: true,
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
        currentOn: false,
        hasBinaryControl: true,
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
        currentOn: false,
        hasBinaryControl: true,
        binaryCommandPending: false,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].binaryCommandPending).toBe(false);
    });
  });
});
