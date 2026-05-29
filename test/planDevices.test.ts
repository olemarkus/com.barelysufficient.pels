import { captureLogger, type LoggerCapture } from './utils/loggerCapture';
import { buildInitialPlanDevices } from '../lib/plan/planDevices';
import {
  MISSING_MODE_TARGET_EMIT_INTERVAL_MS,
  MODE_TARGET_GRACE_CYCLES,
  cleanupMissingModeTargetDevices,
} from '../lib/plan/planModeTargetGuard';
import { createPlanEngineState } from '../lib/plan/planState';
import type { PlanContext } from '../lib/plan/planContext';
import type { PlanDevicesDeps } from '../lib/plan/planDevices';
import { buildExecutableTargetIntent } from '../lib/executor/executableTargetProjection';
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

let logCapture: LoggerCapture;
beforeEach(() => { logCapture = captureLogger(); });
afterEach(() => { logCapture.restore(); });

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
      deps: defaultDeps,
    });

    expect(logCapture.findEvent('temperature_boost_state_changed')).toMatchObject({
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
      deps: defaultDeps,
    });

    expect(logCapture.findEvent('temperature_boost_state_changed')).toMatchObject({
      deviceId: 'tank',
      active: false,
      previousActive: true,
    });
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
    expect(planDevice.releaseShedStepId).toBeNull();
    expect(planDevice.plannedTarget).toBe(55);
    expect(planDevice.desiredStepId).toBe('max');
  });

  it('resolves stepped set_step shed action via the producer cascade when no step id is configured', () => {
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
    // Producer fills releaseShedStepId from its release cascade (lowest-active step) when
    // shedBehavior.stepId is null. The cap-driven shed path in planSteppedLoad ignores
    // this field, but it must still be present on the materialised triple so the
    // lifecycle-end release executor can read it.
    expect(planDevice.releaseShedStepId).toBe('low');
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
        context: { ...buildContext([tempInputDevice({ deadlineFloorTargetC: 60 })]), desiredForMode: { tank: 50 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      expect(planDevice.plannedTarget).toBe(60);
    });

    it('keeps the mode target when it already exceeds the deadline target', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice({ deadlineFloorTargetC: 60 })]), desiredForMode: { tank: 65 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      expect(planDevice.plannedTarget).toBe(65);
    });

    it('does not double-apply the cheap-hour delta on top of the deadline target', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice({ deadlineFloorTargetC: 60 })]), desiredForMode: { tank: 50 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
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
        context: { ...buildContext([tempInputDevice({ deadlineFloorTargetC: 56 })]), desiredForMode: { tank: 55 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
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
        context: { ...buildContext([tempInputDevice({ deadlineFloorTargetC: 58 })]), desiredForMode: {} },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      expect(planDevice.plannedTarget).toBe(58);
    });

    it('clips the deadline target to the device capability max', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice({ deadlineFloorTargetC: 95 })]), desiredForMode: { tank: 50 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      // capability max is 70 per tempInputDevice fixture.
      expect(planDevice.plannedTarget).toBe(70);
    });

    it('does not override when the device has no deadline floor stamped', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice()]), desiredForMode: { tank: 50 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      expect(planDevice.plannedTarget).toBe(50);
    });

    it('shed temperature still wins over the deadline override when shedding via set_temperature', () => {
      const device = tempInputDevice({ currentOn: true, deadlineFloorTargetC: 60 });
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([device]), desiredForMode: { tank: 50 } },
        state: createPlanEngineState(),
        shedSet: new Set(['tank']),
        shedReasons: new Map([['tank', 'shed due to capacity']]),
        guardInShortfall: false,
        deps: {
          ...defaultDeps,
          getShedBehavior: () => ({ action: 'set_temperature', temperature: 40, stepId: null }),
        },
      });

      expect(planDevice.plannedState).toBe('shed');
      expect(planDevice.plannedTarget).toBe(40);
    });
  });

  describe('mode target fallback', () => {
    const tempInputDevice = (overrides: Partial<Parameters<typeof buildPlanInputDevice>[0]> = {}) => buildPlanInputDevice({
      id: 'tank',
      name: 'Water tank',
      deviceType: 'temperature',
      currentTemperature: 45,
      targets: [{ id: 'target_temperature', value: 50, unit: '°C', min: 30, max: 70 }],
      ...overrides,
    });

    it('uses the mode target when present', () => {
      const debugStructured = vi.fn();
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice()]), desiredForMode: { tank: 55 } },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' },
      });

      expect(planDevice.plannedTarget).toBe(55);
      expect(debugStructured).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'missing_mode_target' }),
      );
    });

    it('falls back to the current target capability and emits missing_mode_target', () => {
      const debugStructured = vi.fn();
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice()]), desiredForMode: {} },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' },
      });

      expect(planDevice.plannedTarget).toBe(50);
      expect(debugStructured).toHaveBeenCalledWith({
        event: 'missing_mode_target',
        deviceId: 'tank',
        deviceName: 'Water tank',
        operatingMode: 'home',
      });
    });

    it('skips the device and emits missing_mode_target_and_current_target when both are missing', () => {
      const debugStructured = vi.fn();
      const result = buildInitialPlanDevices({
        context: {
          ...buildContext([tempInputDevice({
            targets: [{ id: 'target_temperature', unit: '°C', min: 30, max: 70 }],
          })]),
          desiredForMode: {},
        },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' },
      });

      expect(result).toHaveLength(0);
      expect(debugStructured).toHaveBeenCalledWith({
        event: 'missing_mode_target_and_current_target',
        deviceId: 'tank',
        deviceName: 'Water tank',
        operatingMode: 'home',
      });
    });

    it('combines the current-target fallback with an active deferred objective', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice({ deadlineFloorTargetC: 58 })]), desiredForMode: {} },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      // currentTarget = 50, deferred = 58 — max wins.
      expect(planDevice.plannedTarget).toBe(58);
    });

    it('does not apply price-opt delta when the seed comes from the current-target fallback', () => {
      const [planDevice] = buildInitialPlanDevices({
        context: { ...buildContext([tempInputDevice()]), desiredForMode: {} },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: {
          ...defaultDeps,
          isCurrentHourCheap: () => true,
          getPriceOptimizationEnabled: () => true,
          getPriceOptimizationSettings: () => ({ tank: { enabled: true, cheapDelta: 2, expensiveDelta: -1 } }),
          getOperatingMode: () => 'home',
        },
      });

      // currentTarget = 50; no mode target → fallback path. Cheap-hour delta of +2 must NOT
      // apply, so PELS remains a no-op against the existing setpoint.
      expect(planDevice.plannedTarget).toBe(50);
    });

    it('rescues a device with no mode target and no current target value via an active deferred objective', () => {
      const debugStructured = vi.fn();
      const [planDevice] = buildInitialPlanDevices({
        context: {
          ...buildContext([tempInputDevice({
            targets: [{ id: 'target_temperature', unit: '°C', min: 30, max: 70 }],
            deadlineFloorTargetC: 58,
          })]),
          desiredForMode: {},
        },
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' },
      });

      expect(planDevice).toBeDefined();
      expect(planDevice.plannedTarget).toBe(58);
      expect(debugStructured).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'missing_mode_target_and_current_target' }),
      );
    });
  });

  // Two related fixes for the `missing_mode_target` path:
  // 1. Abandon-grace on transient capability reads so a single Homey SDK miss
  //    does not drop the device from the plan for that cycle.
  // 2. Per-device emit-on-transition + 15-minute heartbeat so a stuck
  //    misconfigured device does not flood the log buffer when the `plan`
  //    debug topic is enabled.
  describe('mode-target abandon-grace and emit throttle', () => {
    const tempDeviceWithValue = (value: number | undefined) => buildPlanInputDevice({
      id: 'tank',
      name: 'Water tank',
      deviceType: 'temperature',
      currentTemperature: 45,
      targets: value !== undefined
        ? [{ id: 'target_temperature', value, unit: '°C', min: 30, max: 70 }]
        : [{ id: 'target_temperature', unit: '°C', min: 30, max: 70 }],
    });

    it('reuses the cached capability value during the grace window and skips on the cycle after', () => {
      const state = createPlanEngineState();
      const debugStructured = vi.fn();
      const deps = { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' };

      // Cycle 0: capability read succeeds → cache 50, emit `missing_mode_target`
      // because the mode target is missing too.
      const [primed] = buildInitialPlanDevices({
        context: { ...buildContext([tempDeviceWithValue(50)]), desiredForMode: {} },
        state,
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps,
      });
      expect(primed.plannedTarget).toBe(50);
      expect(debugStructured).toHaveBeenCalledTimes(1);
      expect(debugStructured).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'missing_mode_target' }),
      );

      // Cycles 1..MODE_TARGET_GRACE_CYCLES: capability read transiently misses.
      // Device is retained in the plan (so cascade math still accounts for its
      // measured power), but no `plannedTarget` is set — emitting one would
      // mismatch the missing `currentTarget` and queue a spurious actuation
      // each cycle. No skip event emitted while grace is still in effect.
      debugStructured.mockClear();
      for (let cycle = 1; cycle <= MODE_TARGET_GRACE_CYCLES; cycle += 1) {
        const [planDevice] = buildInitialPlanDevices({
          context: { ...buildContext([tempDeviceWithValue(undefined)]), desiredForMode: {} },
          state,
          shedSet: new Set(),
          shedReasons: new Map(),
          guardInShortfall: false,
          deps,
        });
        expect(planDevice).toBeDefined();
        expect(planDevice.plannedTarget).toBeUndefined();
      }
      expect(debugStructured).not.toHaveBeenCalled();

      // Cycle (grace + 1): grace exhausted, fall through to the existing skip
      // path. Emits the `missing_mode_target_and_current_target` event.
      const exhausted = buildInitialPlanDevices({
        context: { ...buildContext([tempDeviceWithValue(undefined)]), desiredForMode: {} },
        state,
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps,
      });
      expect(exhausted).toHaveLength(0);
      expect(debugStructured).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'missing_mode_target_and_current_target' }),
      );
    });

    it('does NOT queue an actuation during the grace window when capability read missed', () => {
      const state = createPlanEngineState();
      const debugStructured = vi.fn();
      const deps = { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' };

      // Cycle 0: capability read succeeds → cache 50.
      buildInitialPlanDevices({
        context: { ...buildContext([tempDeviceWithValue(50)]), desiredForMode: {} },
        state,
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps,
      });

      // Cycles 1..3: capability read misses but grace window holds the device.
      // Without the grace-fallback no-actuation fix, plannedTarget=50 would
      // mismatch currentTarget=null and the executor entry point would emit a
      // set_temperature intent each cycle (Object.is(undefined, 50) === false).
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        const [planDevice] = buildInitialPlanDevices({
          context: { ...buildContext([tempDeviceWithValue(undefined)]), desiredForMode: {} },
          state,
          shedSet: new Set(),
          shedReasons: new Map(),
          guardInShortfall: false,
          deps,
        });

        // Device is still in the plan (not dropped) so cascade math can include
        // its measured power — it is just held with no actuation intent.
        expect(planDevice).toBeDefined();
        expect(planDevice.id).toBe('tank');
        expect(planDevice.plannedTarget).toBeUndefined();
        expect(planDevice.currentTarget).toBeNull();

        // Executor entry point: no target intent → no ExecutableTargetUpdate
        // is produced for this device during grace.
        expect(buildExecutableTargetIntent(planDevice)).toBeNull();
      }
    });

    it('skips immediately when the capability read misses and there is no cached value', () => {
      const state = createPlanEngineState();
      const debugStructured = vi.fn();
      const deps = { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' };

      // No prior successful read means grace has nothing to ride out on; the
      // existing skip path runs on the very first cycle.
      const result = buildInitialPlanDevices({
        context: { ...buildContext([tempDeviceWithValue(undefined)]), desiredForMode: {} },
        state,
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps,
      });
      expect(result).toHaveLength(0);
      expect(debugStructured).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'missing_mode_target_and_current_target' }),
      );
    });

    it('bounds emit count for 100 consecutive missing-mode cycles via 15-minute heartbeat', () => {
      const state = createPlanEngineState();
      const debugStructured = vi.fn();
      const deps = { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' };

      // Drive 100 cycles spaced 1 minute apart so the heartbeat (15 min) emits
      // a bounded number of times. Capability stays fresh so we exercise the
      // `missing_mode_target` (fallback) emit path, not the skip path.
      const cycleSpacingMs = 60 * 1000;
      const baseMs = Date.now();
      const dateNowSpy = vi.spyOn(Date, 'now');
      try {
        for (let cycle = 0; cycle < 100; cycle += 1) {
          dateNowSpy.mockReturnValue(baseMs + cycle * cycleSpacingMs);
          buildInitialPlanDevices({
            context: { ...buildContext([tempDeviceWithValue(50)]), desiredForMode: {} },
            state,
            shedSet: new Set(),
            shedReasons: new Map(),
            guardInShortfall: false,
            deps,
          });
        }
      } finally {
        dateNowSpy.mockRestore();
      }

      const emits = debugStructured.mock.calls.filter(([entry]) => (
        (entry as { event?: string }).event === 'missing_mode_target'
      ));
      // 100 minutes at a 15-minute heartbeat = first emit + 6 heartbeat re-emits = 7.
      expect(emits.length).toBeLessThanOrEqual(7);
      expect(emits.length).toBeGreaterThanOrEqual(6);
    });

    it('resets the grace counter and re-emits after the mode target transitions back to fresh', () => {
      const state = createPlanEngineState();
      const debugStructured = vi.fn();
      const deps = { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' };

      // Phase 1: mode-and-capability missing → emit skip event. Cache absent
      // initially, so the skip fires on cycle 0.
      buildInitialPlanDevices({
        context: { ...buildContext([tempDeviceWithValue(undefined)]), desiredForMode: {} },
        state,
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps,
      });
      expect(debugStructured).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'missing_mode_target_and_current_target' }),
      );

      // Phase 2: mode target is configured again → no emit, missing-cycle
      // tracking should clear.
      debugStructured.mockClear();
      buildInitialPlanDevices({
        context: { ...buildContext([tempDeviceWithValue(50)]), desiredForMode: { tank: 55 } },
        state,
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps,
      });
      expect(debugStructured).not.toHaveBeenCalled();
      expect(state.modeTargetMissingByDevice.tank?.missingCycles ?? 0).toBe(0);

      // Phase 3: mode target disappears again → re-emit immediately because
      // the per-device throttle was cleared on the transition back to fresh.
      buildInitialPlanDevices({
        context: { ...buildContext([tempDeviceWithValue(50)]), desiredForMode: {} },
        state,
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps,
      });
      expect(debugStructured).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'missing_mode_target' }),
      );
    });

    it('emits a 15-minute heartbeat while the device stays in skip after grace exhausts', () => {
      const state = createPlanEngineState();
      const debugStructured = vi.fn();
      const deps = { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' };
      const baseMs = Date.now();
      const dateNowSpy = vi.spyOn(Date, 'now');

      try {
        // Cycle 0: capability read succeeds → cache value, fallback emit.
        dateNowSpy.mockReturnValue(baseMs);
        buildInitialPlanDevices({
          context: { ...buildContext([tempDeviceWithValue(50)]), desiredForMode: {} },
          state,
          shedSet: new Set(),
          shedReasons: new Map(),
          guardInShortfall: false,
          deps,
        });
        expect(debugStructured).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'missing_mode_target' }),
        );

        // Cycles 1..(grace+1): capability read transiently misses. First
        // `MODE_TARGET_GRACE_CYCLES` cycles ride out grace (no emit), then
        // grace exhausts and the skip event fires once. Counter caps at
        // `MODE_TARGET_GRACE_CYCLES + 1` so it doesn't grow unbounded.
        debugStructured.mockClear();
        for (let cycle = 1; cycle <= MODE_TARGET_GRACE_CYCLES + 1; cycle += 1) {
          dateNowSpy.mockReturnValue(baseMs + cycle * 1000);
          buildInitialPlanDevices({
            context: { ...buildContext([tempDeviceWithValue(undefined)]), desiredForMode: {} },
            state,
            shedSet: new Set(),
            shedReasons: new Map(),
            guardInShortfall: false,
            deps,
          });
        }
        const skipEventsAfterExhaust = debugStructured.mock.calls.filter(([entry]) => (
          (entry as { event?: string }).event === 'missing_mode_target_and_current_target'
        ));
        expect(skipEventsAfterExhaust).toHaveLength(1);
        // Counter cap: should be frozen at `MODE_TARGET_GRACE_CYCLES + 1`.
        expect(state.modeTargetMissingByDevice.tank?.missingCycles).toBe(
          MODE_TARGET_GRACE_CYCLES + 1,
        );

        // Advance well past the throttle interval and run one more cycle.
        // Still in skip → heartbeat re-emit fires once.
        debugStructured.mockClear();
        dateNowSpy.mockReturnValue(baseMs + MISSING_MODE_TARGET_EMIT_INTERVAL_MS + 60_000);
        buildInitialPlanDevices({
          context: { ...buildContext([tempDeviceWithValue(undefined)]), desiredForMode: {} },
          state,
          shedSet: new Set(),
          shedReasons: new Map(),
          guardInShortfall: false,
          deps,
        });
        expect(debugStructured).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'missing_mode_target_and_current_target' }),
        );
        const heartbeatEvents = debugStructured.mock.calls.filter(([entry]) => (
          (entry as { event?: string }).event === 'missing_mode_target_and_current_target'
        ));
        expect(heartbeatEvents).toHaveLength(1);
        // Cap still holds across the heartbeat re-emit.
        expect(state.modeTargetMissingByDevice.tank?.missingCycles).toBe(
          MODE_TARGET_GRACE_CYCLES + 1,
        );

        // Run another cycle immediately. Still within throttle window → no
        // new emit despite still being in skip.
        debugStructured.mockClear();
        dateNowSpy.mockReturnValue(baseMs + MISSING_MODE_TARGET_EMIT_INTERVAL_MS + 70_000);
        buildInitialPlanDevices({
          context: { ...buildContext([tempDeviceWithValue(undefined)]), desiredForMode: {} },
          state,
          shedSet: new Set(),
          shedReasons: new Map(),
          guardInShortfall: false,
          deps,
        });
        expect(debugStructured).not.toHaveBeenCalled();
      } finally {
        dateNowSpy.mockRestore();
      }
    });

    it('invalidates the grace cache when the primary target capability ID changes', () => {
      const state = createPlanEngineState();
      const debugStructured = vi.fn();
      const deps = { ...defaultDeps, debugStructured, getOperatingMode: () => 'home' };

      // Cycle 0: primary target capability is `target_temperature` with value
      // 50. The second target lets the device still satisfy
      // `hasTemperatureBoostTarget` after the primary capability re-orders.
      buildInitialPlanDevices({
        context: {
          ...buildContext([buildPlanInputDevice({
            id: 'tank',
            name: 'Water tank',
            deviceType: 'temperature',
            targets: [
              { id: 'target_temperature', value: 50, unit: '°C', min: 30, max: 70 },
              { id: 'aux_setpoint', unit: '°C', min: 30, max: 70 },
            ],
          })]),
          desiredForMode: {},
        },
        state,
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps,
      });
      expect(state.modeTargetMissingByDevice.tank?.cachedTargetValue).toBe(50);
      expect(state.modeTargetMissingByDevice.tank?.cachedTargetCapabilityId)
        .toBe('target_temperature');

      // Cycle 1: a re-pair reordered the targets so the primary capability is
      // now `aux_setpoint` and its current value is missing. The cached value
      // (read from `target_temperature`) must NOT be reused under grace —
      // fall through to skip even though grace cycles haven't been exhausted.
      debugStructured.mockClear();
      const reorderedDevice = buildPlanInputDevice({
        id: 'tank',
        name: 'Water tank',
        deviceType: 'temperature',
        targets: [
          { id: 'aux_setpoint', unit: '°C', min: 30, max: 70 },
          { id: 'target_temperature', unit: '°C', min: 30, max: 70 },
        ],
      });
      const result = buildInitialPlanDevices({
        context: { ...buildContext([reorderedDevice]), desiredForMode: {} },
        state,
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps,
      });
      expect(result).toHaveLength(0);
      expect(debugStructured).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'missing_mode_target_and_current_target' }),
      );
      // Cache should have been invalidated on the capability mismatch.
      expect(state.modeTargetMissingByDevice.tank?.cachedTargetValue).toBeUndefined();
      expect(state.modeTargetMissingByDevice.tank?.cachedTargetCapabilityId).toBeUndefined();
    });
  });

  describe('cleanupMissingModeTargetDevices', () => {
    it('deletes tracking entries for devices no longer in the snapshot', () => {
      const state = createPlanEngineState();
      state.modeTargetMissingByDevice['tank'] = { missingCycles: 1, cachedTargetValue: 50 };
      state.modeTargetMissingByDevice['ev'] = { missingCycles: 0 };

      const removed = cleanupMissingModeTargetDevices(state, new Set(['ev']));

      expect(removed).toBe(true);
      expect(state.modeTargetMissingByDevice.tank).toBeUndefined();
      expect(state.modeTargetMissingByDevice.ev).toBeDefined();
    });

    it('returns false and leaves state untouched when no entries are stale', () => {
      const state = createPlanEngineState();
      state.modeTargetMissingByDevice['tank'] = { missingCycles: 2 };

      const removed = cleanupMissingModeTargetDevices(state, ['tank']);

      expect(removed).toBe(false);
      expect(state.modeTargetMissingByDevice.tank).toBeDefined();
    });
  });

  // docs/technical.md:222 — while any other managed device is limited, a stepped device on
  // keep is capped at its lowest non-zero step. Wires through buildInitialPlanDevices to
  // confirm the shedSet-derived flag flows into resolveSteppedKeepDesiredStepId end-to-end.
  describe('stepped keep invariant (shed side)', () => {
    const buildStepped = (overrides = {}) => steppedInputDevice({
      id: 'heater',
      name: 'Water heater',
      selectedStepId: 'medium',
      desiredStepId: 'medium',
      currentOn: true,
      ...overrides,
    });

    const buildBinary = (id: string) => buildPlanInputDevice({
      id,
      name: id,
      currentOn: true,
    });

    it('clamps a stepped keep device to lowest non-zero step when another device is shed', () => {
      const [stepped] = buildInitialPlanDevices({
        context: buildContext([buildStepped(), buildBinary('thermostat')]),
        state: createPlanEngineState(),
        shedSet: new Set(['thermostat']),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      expect(stepped.id).toBe('heater');
      expect(stepped.plannedState).toBe('keep');
      expect(stepped.desiredStepId).toBe('low');
    });

    it('leaves a stepped keep device alone when shedSet is empty', () => {
      const [stepped] = buildInitialPlanDevices({
        context: buildContext([buildStepped(), buildBinary('thermostat')]),
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      expect(stepped.desiredStepId).toBe('medium');
    });

    it('ignores phantom underspecified set_step shed entries when deciding the invariant', () => {
      // Device B is in shedSet with set_step shed action, but it's already at the lowest active
      // step — resolveSteppedLoadDirectShedStepId returns the same step (no change). Mirrors the
      // phantom case that hasExecutableShedDevices filters out of keep-invariant posture.
      const keepStepped = buildStepped({ id: 'heater' });
      const phantomStepped = steppedInputDevice({
        id: 'phantom',
        name: 'phantom',
        selectedStepId: 'low',
        desiredStepId: 'low',
        currentOn: true,
      });

      const [stepped] = buildInitialPlanDevices({
        context: buildContext([keepStepped, phantomStepped]),
        state: createPlanEngineState(),
        shedSet: new Set(['phantom']),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: {
          ...defaultDeps,
          getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: null }),
        },
      });

      expect(stepped.id).toBe('heater');
      expect(stepped.plannedState).toBe('keep');
      // Phantom shedSet entry doesn't count as posture, so the keep device stays at medium.
      expect(stepped.desiredStepId).toBe('medium');
    });

    it('does not trigger the invariant when the only shed device is the stepped device itself', () => {
      const [stepped] = buildInitialPlanDevices({
        context: buildContext([buildStepped()]),
        state: createPlanEngineState(),
        shedSet: new Set(['heater']),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: defaultDeps,
      });

      // Self-shed: plannedState becomes shed, not keep — the invariant clamp doesn't apply.
      expect(stepped.plannedState).toBe('shed');
    });
  });
});
