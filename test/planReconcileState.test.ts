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
  });
});
