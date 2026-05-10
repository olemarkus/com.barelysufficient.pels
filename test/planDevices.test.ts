import { buildInitialPlanDevices } from '../lib/plan/planDevices';
import { createPlanEngineState } from '../lib/plan/planState';
import type { PlanContext } from '../lib/plan/planContext';
import type { PlanDevicesDeps } from '../lib/plan/planDevices';
import { buildPlanInputDevice, steppedInputDevice } from './utils/planTestUtils';
import { reasonText } from './utils/deviceReasonTestUtils';

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

const defaultDeps: PlanDevicesDeps = {
  getPriorityForDevice: () => 100,
  getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
  isCurrentHourCheap: () => false,
  isCurrentHourExpensive: () => false,
  getPriceOptimizationEnabled: () => false,
  getPriceOptimizationSettings: () => ({}),
};

describe('buildInitialPlanDevices', () => {
  it('applies temperature boost hysteresis for stepped temperature devices', () => {
    const state = createPlanEngineState();
    const build = (currentTemperature: number) => buildInitialPlanDevices({
      context: buildContext([steppedInputDevice({
        id: 'tank',
        name: 'Water tank',
        deviceType: 'temperature',
        currentTemperature,
        temperatureBoost: { enabled: true, boostBelowC: 55 },
      })]),
      state,
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    })[0];

    expect(build(54.9).temperatureBoostActive).toBe(true);
    expect(build(56.5).temperatureBoostActive).toBe(true);
    expect(build(57).temperatureBoostActive).toBe(false);
  });

  it('does not enable temperature boost for stale temperature observations', () => {
    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedInputDevice({
        id: 'tank',
        name: 'Water tank',
        deviceType: 'temperature',
        currentTemperature: 50,
        observationStale: true,
        temperatureBoost: { enabled: true, boostBelowC: 55 },
      })]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    });

    expect(planDevice.temperatureBoostActive).toBe(false);
  });

  it('does not enable temperature boost without a target temperature capability', () => {
    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedInputDevice({
        id: 'tank',
        name: 'Water tank',
        deviceType: 'temperature',
        targets: [],
        currentTemperature: 50,
        temperatureBoost: { enabled: true, boostBelowC: 55 },
      })]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    });

    expect(planDevice.temperatureBoostActive).toBe(false);
  });

  it('emits a structured debug event when temperature boost becomes active', () => {
    const debugStructured = vi.fn();
    const state = createPlanEngineState();

    buildInitialPlanDevices({
      context: buildContext([steppedInputDevice({
        id: 'tank',
        name: 'Water tank',
        deviceType: 'temperature',
        currentTemperature: 54.9,
        temperatureBoost: { enabled: true, boostBelowC: 55 },
      })]),
      state,
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: { ...defaultDeps, debugStructured },
    });

    expect(debugStructured).toHaveBeenCalledWith({
      event: 'temperature_boost_state_changed',
      deviceId: 'tank',
      deviceName: 'Water tank',
      active: true,
      previousActive: false,
      currentTemperatureC: 54.9,
      boostBelowC: 55,
      exitThresholdC: 57,
      observationStale: false,
    });
  });

  it('emits a structured debug event when temperature boost ends', () => {
    const debugStructured = vi.fn();
    const state = createPlanEngineState();
    state.temperatureBoostActiveByDevice.tank = true;

    buildInitialPlanDevices({
      context: buildContext([steppedInputDevice({
        id: 'tank',
        name: 'Water tank',
        deviceType: 'temperature',
        currentTemperature: 57,
        temperatureBoost: { enabled: true, boostBelowC: 55 },
      })]),
      state,
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: { ...defaultDeps, debugStructured },
    });

    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'temperature_boost_state_changed',
      deviceId: 'tank',
      active: false,
      previousActive: true,
    }));
  });

  it('does not independently shed devices when hourly budget is exhausted without a shedSet decision', () => {
    const state = createPlanEngineState();
    state.hourlyBudgetExhausted = true;

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([buildPlanInputDevice({
        id: 'dev-1',
        name: 'Heater',
        currentOn: true,
        controllable: true,
        expectedPowerKw: 1.2,
      })]),
      state,
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    });

    expect(planDevice.plannedState).toBe('keep');
    expect(reasonText(planDevice.reason)).toBe('keep');
  });

  it('tracks EV boost on stepped EV chargers without changing budget exemption', () => {
    const state = createPlanEngineState();

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedInputDevice({
        id: 'charger',
        name: 'Driveway charger',
        deviceClass: 'evcharger',
        deviceType: 'onoff',
        targets: [],
        budgetExempt: false,
        evChargingState: 'plugged_in_charging',
        stateOfCharge: { percent: 32, status: 'fresh' },
        evBoost: { enabled: true, boostBelowPercent: 40 },
      })]),
      state,
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    });

    expect(planDevice.evBoostActive).toBe(true);
    expect(planDevice.budgetExempt).toBe(false);
    expect(state.evBoostActiveByDevice.charger).toBe(true);
  });

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

  it('advances past a pending lower stepped shed target during materialization', () => {
    const steppedDevice: PlanInputDevice = {
      id: 'dev-1',
      name: 'Water Heater',
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'mid', planningPowerW: 2000 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
      selectedStepId: 'max',
      desiredStepId: 'mid',
      stepCommandPending: true,
      currentOn: true,
      controllable: true,
      expectedPowerKw: 3,
      measuredPowerKw: 3,
    };

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: new Map([['dev-1', 'shed due to capacity']]),
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
    expect(planDevice.desiredStepId).toBe('low');
  });

  it('forces a shed stepped load to lowest active step while another device is recovering', () => {
    const state = createPlanEngineState();
    state.lastDeviceShedMs.gang = Date.now() - 60_000;
    const steppedDevice: PlanInputDevice = {
      id: 'dev-1',
      name: 'Water Heater',
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'mid', planningPowerW: 2000 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
      selectedStepId: 'max',
      currentOn: true,
      controllable: true,
      expectedPowerKw: 3,
      measuredPowerKw: 3,
    };
    const recoveringDevice = buildPlanInputDevice({
      id: 'gang',
      name: 'Hall thermostat',
      currentOn: false,
      controllable: true,
      measuredPowerKw: 0,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice, recoveringDevice]),
      state,
      shedSet: new Set(['dev-1']),
      shedReasons: new Map([['dev-1', 'shed due to capacity']]),
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
    expect(planDevice.desiredStepId).toBe('low');
  });

  it('uses measured-power fallback for shed stepped loads without a known current step', () => {
    const steppedDevice: PlanInputDevice = {
      id: 'dev-1',
      name: 'Water Heater',
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
      selectedStepId: undefined,
      desiredStepId: undefined,
      currentOn: true,
      controllable: true,
      measuredPowerKw: 3,
    };

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: new Map([['dev-1', 'shed due to capacity']]),
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
    expect(planDevice.desiredStepId).toBe('low');
  });

  it('does not advance from a stale lower desired step when no step command is pending', () => {
    const steppedDevice: PlanInputDevice = {
      id: 'dev-1',
      name: 'Water Heater',
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'mid', planningPowerW: 2000 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
      selectedStepId: 'max',
      desiredStepId: 'low',
      stepCommandPending: false,
      currentOn: true,
      controllable: true,
      expectedPowerKw: 3,
      measuredPowerKw: 3,
    };

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: new Map([['dev-1', 'shed due to capacity']]),
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
    expect(planDevice.desiredStepId).toBe('mid');
  });

  it('does not let stale restore intent raise the shed target for set_step shedding', () => {
    const steppedDevice = steppedInputDevice({
      id: 'dev-1',
      name: 'Water Heater',
      selectedStepId: 'low',
      desiredStepId: 'max',
      currentOn: true,
      controllable: true,
      expectedPowerKw: 1.25,
      measuredPowerKw: 1.19,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([steppedDevice]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: new Map([['dev-1', 'shed due to capacity']]),
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
    expect(planDevice.selectedStepId).toBe('low');
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
    expect(reasonText(planDevice.reason)).toContain('shortfall');
    // Restore need in reason should be based on low step (1.25kW + 0.23kW buffer = 1.48kW), not max (3kW),
    // and shortfall must not retain the non-off set_step target.
    expect(reasonText(planDevice.reason)).toContain('need 1.48kW');
  });

  it('keeps off-state restore analysis out of the public reason field', () => {
    const device = buildPlanInputDevice({
      id: 'dev-1',
      name: 'Hall Heater',
      currentOn: false,
      controllable: true,
      expectedPowerKw: 1,
      measuredPowerKw: 0,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
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

    expect(planDevice.plannedState).toBe('keep');
    expect(reasonText(planDevice.reason)).toBe('keep');
    expect(planDevice.candidateReasons?.offStateAnalysis).toBe('restore (need 1.20kW, headroom -1.00kW)');
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
    expect(reasonText(planDevice.reason)).toBe('shed due to capacity');
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

  it('marks an EV charger inactive when plugged_out even if snapshot reports currentOn=true', () => {
    // Simulates a stale snapshot: device capability last reported as 'on' (charging) but
    // evChargingState was updated to 'plugged_out'. Without the fix, this would produce
    // plannedState='keep' because applyOffStateReason skips non-off devices.
    const charger = buildPlanInputDevice({
      id: 'charger-1',
      name: 'EV Charger',
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_out',
      currentOn: true, // stale: device still looks 'on' in the snapshot
      controllable: true,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([charger]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
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

    expect(planDevice.plannedState).toBe('inactive');
    expect(reasonText(planDevice.reason)).toBe('inactive (charger is unplugged)');
  });

  it('does not mark an actively-charging EV as inactive due to unknown expected power', () => {
    // getInactiveReason also returns a reason when expectedPowerSource==='default'.
    // Moving that check before the currentState guard would incorrectly block shedding
    // of a charging EV. Only the physical state block (plugged_out etc.) should pre-empt
    // the off-state guard.
    const charger = buildPlanInputDevice({
      id: 'charger-1',
      name: 'EV Charger',
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in_charging',
      expectedPowerSource: 'default',
      currentOn: true,
      controllable: true,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([charger]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
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

    expect(planDevice.plannedState).toBe('keep');
  });

  it('does not mark an EV with undefined evChargingState as inactive when currently on', () => {
    // evChargingState===undefined is ambiguous (capability not yet read). It should not
    // pre-empt the off-state guard for an active device — defer until confirmed off.
    const charger = buildPlanInputDevice({
      id: 'charger-1',
      name: 'EV Charger',
      controlCapabilityId: 'evcharger_charging',
      currentOn: true,
      controllable: true,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([charger]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
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

    expect(planDevice.plannedState).toBe('keep');
  });
});

// ---------------------------------------------------------------------------
// Group 1 & 2 & 3: turn_off / turn_on actuation semantics
// These tests lock in the intended shed action selection and step intent rules
// for stepped-load devices. Tests marked it.fails() document desired behavior
// that is not yet implemented.
// ---------------------------------------------------------------------------

const buildTurnOffDeps = (overrides: Partial<PlanDevicesDeps> = {}): PlanDevicesDeps => ({
  getPriorityForDevice: () => 100,
  getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
  isCurrentHourCheap: () => false,
  isCurrentHourExpensive: () => false,
  getPriceOptimizationEnabled: () => false,
  getPriceOptimizationSettings: () => ({}),
  ...overrides,
});

describe('stepped-load turn_off shed action selection (Group 1)', () => {
  // Test 1.1: turn_off is valid for a stepped device that has binary control.
  it('turn_off is a valid shed action for a stepped device with onoff', () => {
    const device = steppedInputDevice({
      id: 'dev-1',
      hasBinaryControl: true,
      selectedStepId: 'max',
      currentOn: true,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: new Map([['dev-1', 'capacity']]),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.shedAction).toBe('turn_off');
  });

  // Test 1.2: turn_off must be rejected when the device has no binary control.
  // Current: shedAction resolves to 'turn_off' regardless of hasBinaryControl.
  it('turn_off must not be selected as shed action for a stepped device without binary control', () => {
    const device = steppedInputDevice({
      id: 'dev-1',
      hasBinaryControl: false,
      selectedStepId: 'max',
      currentOn: true,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: new Map([['dev-1', 'capacity']]),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.shedAction).not.toBe('turn_off');
  });
});

describe('stepped-load turn_off: desiredStepId targets lowest step (Group 2)', () => {
  // Test 2.1: turn_off shed must set desiredStepId to the lowest (off) step, not the
  // current step. Current: desiredStepId stays at the current selectedStepId for turn_off.
  it('turn_off shed sets desiredStepId to the lowest step, not the current medium step', () => {
    const device = steppedInputDevice({
      id: 'dev-1',
      hasBinaryControl: true,
      selectedStepId: 'medium',
      currentOn: true,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: new Map([['dev-1', 'capacity']]),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.shedAction).toBe('turn_off');
    // Lowest step is 'off' (planningPowerW=0); desiredStepId must be 'off', not 'medium'.
    expect(planDevice.desiredStepId).toBe('off');
  });

  // Test 2.2: same assertion when the lowest step is the zero-usage off step.
  it('turn_off shed targets the zero-usage off step when starting from max step', () => {
    const device = steppedInputDevice({
      id: 'dev-1',
      hasBinaryControl: true,
      selectedStepId: 'max',
      currentOn: true,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: new Map([['dev-1', 'capacity']]),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.shedAction).toBe('turn_off');
    // steppedProfile has 'off' at 0 W — that must be the target for turn_off.
    expect(planDevice.desiredStepId).toBe('off');
  });

  // Test 2.3: device is already at the lowest step — desiredStepId must stay 'off'.
  // This passes because initialDesiredStepId returns the current step ('off') which
  // happens to already be correct. The test guards against a regression that over-corrects.
  it('turn_off shed keeps desiredStepId=off when device is already at the lowest step', () => {
    const device = steppedInputDevice({
      id: 'dev-1',
      hasBinaryControl: true,
      selectedStepId: 'off',
      currentOn: false,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(['dev-1']),
      shedReasons: new Map([['dev-1', 'capacity']]),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.shedAction).toBe('turn_off');
    expect(planDevice.desiredStepId).toBe('off');
  });
});

describe('stepped-load turn_on: desiredStepId normalization (Group 3 / planDevices side)', () => {
  // Test 3.4 / Regression 5.2 (planDevices layer): a keep device whose selectedStepId
  // is the off-step must have its desiredStepId normalized to the lowest non-zero step.
  // Current: desiredStepId echoes selectedStepId ('off') because
  // resolveSteppedLoadInitialDesiredStepId just reflects the current step.
  it('restore (keep) normalizes off-step desiredStepId to lowest non-zero step', () => {
    const device = steppedInputDevice({
      id: 'dev-1',
      hasBinaryControl: true,
      selectedStepId: 'off',
      currentOn: false,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.plannedState).toBe('keep');
    // Off-step desiredStepId must be normalized to the lowest non-zero step ('low').
    expect(planDevice.desiredStepId).toBe('low');
  });

  it('preserves runtime stepped restore intent for keep devices while confirmation is still pending', () => {
    const device = steppedInputDevice({
      id: 'dev-1',
      hasBinaryControl: true,
      currentOn: true,
      selectedStepId: 'low',
      desiredStepId: 'max',
      stepCommandPending: true,
      stepCommandStatus: 'pending',
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.plannedState).toBe('keep');
    expect(planDevice.selectedStepId).toBe('low');
    expect(planDevice.desiredStepId).toBe('max');
    expect(planDevice.targetStepId).toBe('max');
    expect(planDevice.lastDesiredStepId).toBe('max');
  });

  it('restore (keep) normalizes unknown-step off devices to lowest non-zero step and expected load', () => {
    const device = steppedInputDevice({
      id: 'dev-1',
      hasBinaryControl: true,
      selectedStepId: undefined,
      desiredStepId: 'max',
      currentOn: false,
      expectedPowerKw: 3,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.plannedState).toBe('keep');
    expect(planDevice.desiredStepId).toBe('low');
    expect(planDevice.expectedPowerKw).toBeCloseTo(1.25);
  });

  it('leaves stepped restore intent unchanged when no positive restore step exists', () => {
    const device = steppedInputDevice({
      id: 'dev-1',
      hasBinaryControl: true,
      currentOn: false,
      selectedStepId: undefined,
      desiredStepId: undefined,
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'idle', planningPowerW: 0 },
        ],
      },
      expectedPowerKw: 0.7,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.desiredStepId).toBeUndefined();
    expect(planDevice.expectedPowerKw).toBe(0.7);
  });

  it('leaves expectedPowerKw undefined when all configured power fields are non-finite', () => {
    const device = buildPlanInputDevice({
      id: 'dev-1',
      name: 'Broken heater',
      measuredPowerKw: Number.NaN,
      expectedPowerKw: Number.POSITIVE_INFINITY,
      planningPowerKw: Number.NaN,
      powerKw: Number.POSITIVE_INFINITY,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildContext([device]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: buildTurnOffDeps(),
    });

    expect(planDevice.expectedPowerKw).toBeUndefined();
  });

  describe('deferred temperature objective override', () => {
    const tempInputDevice = (overrides: Partial<Parameters<typeof buildPlanInputDevice>[0]> = {}) => buildPlanInputDevice({
      id: 'tank',
      name: 'Water tank',
      deviceType: 'temperature',
      currentTemperature: 45,
      targets: [{ id: 'target_temperature', value: 50, unit: '°C', min: 30, max: 70 }],
      ...overrides,
    });

    it('lifts plannedTarget to the deadline target when it exceeds the mode target', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice()]), desiredForMode: { tank: 50 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deferredTargetTempByDeviceId: { tank: 60 },
        deps: defaultDeps,
      });

      expect(planDevice.plannedTarget).toBe(60);
    });

    it('keeps the mode target when it already exceeds the deadline target', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice()]), desiredForMode: { tank: 65 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deferredTargetTempByDeviceId: { tank: 60 },
        deps: defaultDeps,
      });

      expect(planDevice.plannedTarget).toBe(65);
    });

    it('does not double-apply the cheap-hour delta on top of the deadline target', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice()]), desiredForMode: { tank: 50 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deferredTargetTempByDeviceId: { tank: 60 },
        deps: {
          ...defaultDeps,
          isCurrentHourCheap: () => true,
          getPriceOptimizationEnabled: () => true,
          getPriceOptimizationSettings: () => ({ tank: { enabled: true, cheapDelta: 2, expensiveDelta: 0 } }),
        },
      });

      // mode 50 + cheap delta 2 = 52; deadline 60 wins. Delta is not stacked on top of 60.
      expect(planDevice.plannedTarget).toBe(60);
    });

    it('lets mode + cheap delta win when the result still exceeds the deadline target', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice()]), desiredForMode: { tank: 55 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deferredTargetTempByDeviceId: { tank: 56 },
        deps: {
          ...defaultDeps,
          isCurrentHourCheap: () => true,
          getPriceOptimizationEnabled: () => true,
          getPriceOptimizationSettings: () => ({ tank: { enabled: true, cheapDelta: 3, expensiveDelta: 0 } }),
        },
      });

      // mode 55 + cheap delta 3 = 58; deadline 56 — mode side already higher, no override.
      expect(planDevice.plannedTarget).toBe(58);
    });

    it('seeds plannedTarget from the deadline target when no mode target is configured', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice()]), desiredForMode: {} },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deferredTargetTempByDeviceId: { tank: 58 },
        deps: defaultDeps,
      });

      expect(planDevice.plannedTarget).toBe(58);
    });

    it('clips the deadline target to the device capability max', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice()]), desiredForMode: { tank: 50 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deferredTargetTempByDeviceId: { tank: 95 },
        deps: defaultDeps,
      });

      // capability max is 70 per tempInputDevice fixture.
      expect(planDevice.plannedTarget).toBe(70);
    });

    it('does not override when the device has no entry in the override map', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice()]), desiredForMode: { tank: 50 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deferredTargetTempByDeviceId: {},
        deps: defaultDeps,
      });

      expect(planDevice.plannedTarget).toBe(50);
    });

    it('shed temperature still wins over the deadline override when shedding via set_temperature', () => {
      const device = tempInputDevice({ currentOn: true });
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([device]), desiredForMode: { tank: 50 } },
        state: createPlanEngineState(),
        shedSet: new Set(['tank']),
        shedReasons: new Map([['tank', 'shed due to capacity']]),
        guardInShortfall: false,
        deferredTargetTempByDeviceId: { tank: 60 },
        deps: {
          ...defaultDeps,
          getShedBehavior: () => ({ action: 'set_temperature', temperature: 40, stepId: null }),
        },
      });

      expect(planDevice.plannedState).toBe('shed');
      expect(planDevice.plannedTarget).toBe(40);
    });
  });
});
