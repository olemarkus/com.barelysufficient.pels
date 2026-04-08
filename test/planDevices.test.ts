import { buildInitialPlanDevices } from '../lib/plan/planDevices';
import { createPlanEngineState } from '../lib/plan/planState';
import type { PlanContext } from '../lib/plan/planContext';
import { buildPlanInputDevice, steppedInputDevice } from './utils/planTestUtils';

const buildContext = (devices: PlanContext['devices']): PlanContext => ({
  devices,
  desiredForMode: {},
  total: 3,
  softLimit: 2,
  capacitySoftLimit: 2,
  dailySoftLimit: null,
  softLimitSource: 'capacity',
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  headroomRaw: -1,
  headroom: -1,
  restoreMarginPlanning: 0.2,
});

describe('buildInitialPlanDevices', () => {
  it('keeps stepped loads on temperature shedding when that is the chosen shed behavior', () => {
    const steppedDevice = steppedInputDevice({
      id: 'dev-1',
      name: 'Water Heater',
      deviceType: 'temperature',
      selectedStepId: 'max',
      desiredStepId: 'max',
      targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
      currentOn: true,
      controllable: true,
      expectedPowerKw: 3,
      measuredPowerKw: 0.5,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: new Map([['dev-1', 'shed due to capacity']]),
      steppedDesiredStepByDeviceId: new Map(),
      temperatureShedTargets: new Map([['dev-1', { temperature: 55, capabilityId: 'target_temperature' }]]),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_temperature', temperature: 55, stepId: null }),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(planDevice.shedAction).toBe('set_temperature');
    expect(planDevice.shedTemperature).toBe(55);
    expect(planDevice.shedStepId).toBeNull();
    expect(planDevice.plannedTarget).toBe(55);
    expect(planDevice.desiredStepId).toBe('max');
  });

  it('preserves stepped set_step shed action without requiring a configured step id', () => {
    const steppedDevice: PlanInputDevice = {
      id: 'dev-1',
      name: 'Water Heater',
      deviceType: 'temperature',
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
      selectedStepId: 'max',
      desiredStepId: 'max',
      targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
      currentOn: true,
      controllable: true,
      expectedPowerKw: 3,
      measuredPowerKw: 0.5,
    };

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: new Map([['dev-1', 'shed due to capacity']]),
      steppedDesiredStepByDeviceId: new Map([['dev-1', 'low']]),
      temperatureShedTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: null }),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(planDevice.shedAction).toBe('set_step');
    expect(planDevice.shedStepId).toBeNull();
    expect(planDevice.desiredStepId).toBe('low');
  });

  it('exposes binaryCommandPending when a pending binary command exists for the device', () => {
    const device = buildPlanInputDevice({ id: 'dev-1', name: 'Heater', currentOn: false });

    const state = createPlanEngineState();
    state.pendingBinaryCommands['dev-1'] = {
      capabilityId: 'onoff',
      desired: true,
      startedMs: Date.now(),
    };

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state,
      shedSet: new Set(),
      shedReasons: new Map(),
      steppedDesiredStepByDeviceId: new Map(),
      temperatureShedTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
      },
    });

    expect(planDevice.binaryCommandPending).toBe(true);
  });

  it('propagates communicationModel into planned devices', () => {
    const device = steppedInputDevice({
      id: 'dev-1',
      name: 'Cloud Heater',
      communicationModel: 'cloud',
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      steppedDesiredStepByDeviceId: new Map(),
      temperatureShedTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: 'low' }),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
      },
    });

    expect(planDevice.communicationModel).toBe('cloud');
  });

  it('omits binaryCommandPending when no pending binary command exists', () => {
    const device = buildPlanInputDevice({ id: 'dev-1', name: 'Heater', currentOn: true });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      steppedDesiredStepByDeviceId: new Map(),
      temperatureShedTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
      },
    });

    expect(planDevice.binaryCommandPending).toBeUndefined();
  });

  it('omits binaryCommandPending when pending command is a shed (desired=false)', () => {
    const device = buildPlanInputDevice({ id: 'dev-1', name: 'Heater', currentOn: true });

    const state = createPlanEngineState();
    state.pendingBinaryCommands['dev-1'] = {
      capabilityId: 'onoff',
      desired: false,
      startedMs: Date.now(),
    };

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state,
      shedSet: new Set(),
      shedReasons: new Map(),
      steppedDesiredStepByDeviceId: new Map(),
      temperatureShedTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
      },
    });

    expect(planDevice.binaryCommandPending).toBeUndefined();
  });

  it('treats stale binary observations as unknown instead of confirmed off', () => {
    const device = buildPlanInputDevice({
      id: 'dev-1',
      name: 'Heater',
      currentOn: false,
      hasBinaryControl: true,
      observationStale: true,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      steppedDesiredStepByDeviceId: new Map(),
      temperatureShedTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
      },
    });

    expect(planDevice.currentState).toBe('unknown');
    expect(planDevice.observationStale).toBe(true);
  });

  it('detects shed drift for off stepped devices and drives them to the off-step during shortfall', () => {
    const steppedDevice = steppedInputDevice({
      id: 'dev-1',
      name: 'Water Heater',
      selectedStepId: 'max',
      currentOn: false, // OFF at binary level
      controllable: true,
      expectedPowerKw: 3,
      measuredPowerKw: 0,
    });

    const context = buildContext([steppedDevice]);
    context.headroomRaw = -1;
    context.headroom = -1; // Shortfall

    const [planDevice] = buildInitialPlanDevices({
      context,
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      steppedDesiredStepByDeviceId: new Map(),
      temperatureShedTargets: new Map(),
      guardInShortfall: true, // Shortfall!
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: 'low' }),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
      },
    });

    expect(planDevice.currentState).toBe('off');
    expect(planDevice.plannedState).toBe('shed'); // Should be shed because of shortfall
    expect(planDevice.desiredStepId).toBe('off'); // Should be driven to off-step!
    expect(planDevice.reason).toContain('shortfall');
    // Restore need in reason should be based on low step (1.25kW + 0.23kW buffer = 1.48kW), not max (3kW),
    // and shortfall must not retain the non-off set_step target.
    expect(planDevice.reason).toContain('need 1.48kW');
  });

  it('forces already-shed off stepped devices to keep the off-step during shortfall', () => {
    const steppedDevice = steppedInputDevice({
      id: 'dev-1',
      name: 'Water Heater',
      selectedStepId: 'max',
      currentOn: false,
      controllable: true,
      expectedPowerKw: 3,
      measuredPowerKw: 0,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: new Map([['dev-1', 'shed due to capacity']]),
      steppedDesiredStepByDeviceId: new Map(),
      temperatureShedTargets: new Map(),
      guardInShortfall: true,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: 'low' }),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(planDevice.reason).toBe('shed due to capacity');
    expect(planDevice.desiredStepId).toBe('off');
  });

  it('sets desiredStepId=off and expectedPowerKw=lowest-positive-step for a turn_off shed device already at off-step', () => {
    // Device has already arrived at the off step (selectedStepId='off', currentOn=false).
    // The plan must normalize desiredStepId to 'off' (not an intermediate shed step)
    // and set expectedPowerKw to the lowest positive step power (1.25 kW), not zero,
    // so that restore planning uses a realistic power estimate.
    const steppedDevice = steppedInputDevice({
      id: 'dev-1',
      name: 'Tank Heater',
      selectedStepId: 'off',
      currentOn: false,
      controllable: true,
      expectedPowerKw: 0,
      measuredPowerKw: 0,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: new Map([['dev-1', 'shed due to capacity']]),
      steppedDesiredStepByDeviceId: new Map(),
      temperatureShedTargets: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(planDevice.desiredStepId).toBe('off');
    // Restore expectation should be the lowest positive step (low = 1250 W = 1.25 kW), not zero
    expect(planDevice.expectedPowerKw).toBeCloseTo(1.25);
  });
});
