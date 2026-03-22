import type CapacityGuard from '../lib/core/capacityGuard';
import type { PowerTrackerState } from '../lib/core/powerTracker';
import type { PlanContext } from '../lib/plan/planContext';
import { createPlanEngineState } from '../lib/plan/planState';
import type { PlanInputDevice } from '../lib/plan/planTypes';
import { buildSheddingPlan } from '../lib/plan/planShedding';

const buildDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => ({
  id: 'dev',
  name: 'Device',
  targets: [],
  ...overrides,
});

const buildContext = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  devices: [],
  desiredForMode: {},
  total: null,
  softLimit: 0,
  capacitySoftLimit: 0,
  dailySoftLimit: null,
  softLimitSource: 'capacity',
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  headroomRaw: null,
  headroom: null,
  restoreMarginPlanning: 0.2,
  ...overrides,
});

describe('buildSheddingPlan', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('deprioritizes recently restored devices when same-priority alternatives exist', async () => {
    const state = createPlanEngineState();
    state.lastDeviceRestoreMs['dev-recent'] = Date.now() - 60 * 1000;

    const devices = [
      buildDevice({
        id: 'dev-nonrecent',
        name: 'NonRecent',
        expectedPowerKw: 1.5,
        currentOn: true,
        controllable: true,
      }),
      buildDevice({
        id: 'dev-recent',
        name: 'Recent',
        expectedPowerKw: 1,
        currentOn: true,
        controllable: true,
      }),
      buildDevice({
        id: 'dev-at-temp',
        name: 'AtTemp',
        expectedPowerKw: 1,
        currentOn: true,
        controllable: true,
        targets: [{ id: 'target_temperature', value: 15, unit: 'C' }],
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(4),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 4.4,
        softLimit: 4,
        capacitySoftLimit: 4,
        headroomRaw: -0.4,
        headroom: -0.4,
        softLimitSource: 'daily',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: (deviceId: string) => (
          deviceId === 'dev-at-temp'
            ? { action: 'set_temperature', temperature: 15 }
            : { action: 'turn_off', temperature: null }
        ),
        getPriorityForDevice: (deviceId: string) => (
          { 'dev-nonrecent': 100, 'dev-recent': 100, 'dev-at-temp': 80 }[deviceId] ?? 100
        ),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(result.shedReasons.get('dev-nonrecent')).toBe('shed due to daily budget');
    expect(result.shedSet.has('dev-recent')).toBe(false);
    expect(result.shedSet.has('dev-at-temp')).toBe(false);
    expect(capacityGuard.checkShortfall).toHaveBeenCalledTimes(1);
    const [hasCandidates, deficitKw] = (capacityGuard.checkShortfall as unknown as jest.Mock).mock.calls[0];
    expect(hasCandidates).toBe(true);
    expect(deficitKw).toBeCloseTo(0.4, 6);
  });

  it('allows shedding recently restored devices when they are lower priority', async () => {
    const state = createPlanEngineState();
    state.lastDeviceRestoreMs['dev-low'] = Date.now() - 60 * 1000;

    const devices = [
      buildDevice({
        id: 'dev-high',
        name: 'High',
        measuredPowerKw: 0.4,
        currentOn: true,
        controllable: true,
      }),
      buildDevice({
        id: 'dev-low',
        name: 'Low',
        measuredPowerKw: 0.6,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(4.5),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 5,
        softLimit: 4.5,
        capacitySoftLimit: 4.5,
        headroomRaw: -0.5,
        headroom: -0.5,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 789 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null }),
        getPriorityForDevice: (deviceId: string) => (deviceId === 'dev-high' ? 1 : 3),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(result.shedSet.has('dev-low')).toBe(true);
    expect(result.shedSet.has('dev-high')).toBe(false);
  });

  it('allows recently restored devices when overshoot is severe', async () => {
    const state = createPlanEngineState();
    state.lastDeviceRestoreMs['dev-restore'] = Date.now() - 60 * 1000;

    const devices = [
      buildDevice({
        id: 'dev-restore',
        name: 'Restore',
        measuredPowerKw: 0.8,
        currentOn: true,
        controllable: true,
      }),
      buildDevice({
        id: 'dev-extra',
        name: 'Extra',
        powerKw: 0.4,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(4),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 6,
        softLimit: 4,
        capacitySoftLimit: 4,
        headroomRaw: -0.6,
        headroom: -0.6,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 456 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null }),
        getPriorityForDevice: (deviceId: string) => (deviceId === 'dev-restore' ? 100 : 50),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(result.shedSet.has('dev-restore')).toBe(true);
    expect(result.shedReasons.get('dev-restore')).toBe('shed due to capacity');
    expect(capacityGuard.checkShortfall).toHaveBeenCalledWith(true, 2);
  });

  it('treats stepped loads with temperature shedding like target-based shed devices instead of stepping them down', async () => {
    const state = createPlanEngineState();

    const devices = [
      buildDevice({
        id: 'dev-stepped',
        name: 'Stepped Heater',
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
        targets: [{ id: 'target_temperature', value: 65, unit: 'C' }],
        expectedPowerKw: 3,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(4),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 3,
        softLimit: 2.4,
        capacitySoftLimit: 2.4,
        headroomRaw: -0.6,
        headroom: -0.6,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 999 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'set_temperature', temperature: 55, stepId: null }),
        getPriorityForDevice: () => 100,
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(result.shedSet.has('dev-stepped')).toBe(true);
    expect(result.steppedDesiredStepByDeviceId.size).toBe(0);
  });

  it('steps down a stepped load with turn_off behavior before shedding any other device', async () => {
    const state = createPlanEngineState();

    const devices = [
      buildDevice({
        id: 'connected-300',
        name: 'Connected 300',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1000 },
            { id: 'mid', planningPowerW: 2000 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'max',
        measuredPowerKw: 2.8,
        currentOn: true,
        controllable: true,
      }),
      buildDevice({
        id: 'bath',
        name: 'Bathroom thermostat',
        measuredPowerKw: 1.2,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(6),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 4.1,
        softLimit: 3,
        capacitySoftLimit: 3,
        headroomRaw: -1.1,
        headroom: -1.1,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 111 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriorityForDevice: (deviceId: string) => (deviceId === 'connected-300' ? 1 : 10),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    // Preemptive step-down should happen even with turn_off behavior
    expect(result.shedSet.has('connected-300')).toBe(true);
    expect(result.shedSet.has('bath')).toBe(false);
    expect(result.steppedDesiredStepByDeviceId.get('connected-300')).toBe('mid');
  });

  it('steps down a stepped load without measured power using planning power fallback', async () => {
    const state = createPlanEngineState();

    const devices = [
      buildDevice({
        id: 'connected-300',
        name: 'Connected 300',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1000 },
            { id: 'mid', planningPowerW: 2000 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'max',
        measuredPowerKw: undefined,
        expectedPowerKw: 3,
        currentOn: true,
        controllable: true,
      }),
      buildDevice({
        id: 'bath',
        name: 'Bathroom thermostat',
        measuredPowerKw: 1.2,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(6),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 4.1,
        softLimit: 3,
        capacitySoftLimit: 3,
        headroomRaw: -1.1,
        headroom: -1.1,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 113 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriorityForDevice: (deviceId: string) => (deviceId === 'connected-300' ? 1 : 10),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    // Should use planning power fallback and still get preemptive step-down
    expect(result.shedSet.has('connected-300')).toBe(true);
    expect(result.shedSet.has('bath')).toBe(false);
    expect(result.steppedDesiredStepByDeviceId.get('connected-300')).toBe('mid');
  });

  it('does not use planning power fallback when measured power is a valid zero', async () => {
    const state = createPlanEngineState();

    const devices = [
      buildDevice({
        id: 'connected-300',
        name: 'Connected 300',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1000 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'max',
        measuredPowerKw: 0,
        expectedPowerKw: 3,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(6),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 4.1,
        softLimit: 3,
        capacitySoftLimit: 3,
        headroomRaw: -1.1,
        headroom: -1.1,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 115 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriorityForDevice: () => 1,
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    // measuredPowerKw=0 is a valid reading indicating no draw — should not
    // fall back to planning power and should not produce a stepped candidate.
    expect(result.shedSet.has('connected-300')).toBe(false);
  });

  it('advances to the next step-down when a previous step command is still pending', async () => {
    const state = createPlanEngineState();

    const devices = [
      buildDevice({
        id: 'connected-300',
        name: 'Connected 300',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1000 },
            { id: 'mid', planningPowerW: 2000 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        // selectedStepId stuck at 'max' because device has no reported step or power meter
        selectedStepId: 'max',
        // Previous cycle already commanded step-down to 'mid'
        desiredStepId: 'mid',
        stepCommandPending: true,
        measuredPowerKw: undefined,
        expectedPowerKw: 3,
        currentOn: true,
        controllable: true,
      }),
      buildDevice({
        id: 'bath',
        name: 'Bathroom thermostat',
        measuredPowerKw: 1.2,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(6),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 4.1,
        softLimit: 3,
        capacitySoftLimit: 3,
        headroomRaw: -1.1,
        headroom: -1.1,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 114 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriorityForDevice: (deviceId: string) => (deviceId === 'connected-300' ? 1 : 10),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    // Should advance to 'low' (next step below pending 'mid'), not re-issue 'mid'
    expect(result.shedSet.has('connected-300')).toBe(true);
    expect(result.steppedDesiredStepByDeviceId.get('connected-300')).toBe('low');
  });

  it('steps down a stepped load with set_step behavior before shedding any other device', async () => {
    const state = createPlanEngineState();

    const devices = [
      buildDevice({
        id: 'connected-300',
        name: 'Connected 300',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1000 },
            { id: 'mid', planningPowerW: 2000 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'max',
        measuredPowerKw: 2.8,
        currentOn: true,
        controllable: true,
      }),
      buildDevice({
        id: 'bath',
        name: 'Bathroom thermostat',
        measuredPowerKw: 1.2,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(6),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 4.1,
        softLimit: 3,
        capacitySoftLimit: 3,
        headroomRaw: -1.1,
        headroom: -1.1,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 112 } as PowerTrackerState,
        getShedBehavior: (deviceId: string) => (
          deviceId === 'connected-300'
            ? { action: 'set_step', temperature: null, stepId: 'off' }
            : { action: 'turn_off', temperature: null, stepId: null }
        ),
        getPriorityForDevice: (deviceId: string) => (deviceId === 'connected-300' ? 1 : 10),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(result.shedSet.has('connected-300')).toBe(true);
    expect(result.shedSet.has('bath')).toBe(false);
    expect(result.steppedDesiredStepByDeviceId.get('connected-300')).toBe('mid');
  });

  it('keeps stepping a stepped load down to its lowest active step before shedding other devices', async () => {
    const state = createPlanEngineState();

    const devices = [
      buildDevice({
        id: 'connected-300',
        name: 'Connected 300',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1000 },
            { id: 'mid', planningPowerW: 2000 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'mid',
        measuredPowerKw: 1.9,
        currentOn: true,
        controllable: true,
      }),
      buildDevice({
        id: 'bath',
        name: 'Bathroom thermostat',
        measuredPowerKw: 1.2,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(6),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 3.6,
        softLimit: 2.8,
        capacitySoftLimit: 2.8,
        headroomRaw: -0.8,
        headroom: -0.8,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 222 } as PowerTrackerState,
        getShedBehavior: (deviceId: string) => (
          deviceId === 'connected-300'
            ? { action: 'set_step', temperature: null, stepId: 'off' }
            : { action: 'turn_off', temperature: null, stepId: null }
        ),
        getPriorityForDevice: (deviceId: string) => (deviceId === 'connected-300' ? 1 : 10),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(result.shedSet.has('connected-300')).toBe(true);
    expect(result.shedSet.has('bath')).toBe(false);
    expect(result.steppedDesiredStepByDeviceId.get('connected-300')).toBe('low');
  });

  it('allows other devices to shed first once the stepped load is already at its lowest active step', async () => {
    const state = createPlanEngineState();

    const devices = [
      buildDevice({
        id: 'connected-300',
        name: 'Connected 300',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1000 },
            { id: 'mid', planningPowerW: 2000 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'low',
        measuredPowerKw: 0.9,
        currentOn: true,
        controllable: true,
      }),
      buildDevice({
        id: 'bath',
        name: 'Bathroom thermostat',
        measuredPowerKw: 1.2,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(6),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 2.9,
        softLimit: 2.3,
        capacitySoftLimit: 2.3,
        headroomRaw: -0.6,
        headroom: -0.6,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 333 } as PowerTrackerState,
        getShedBehavior: (deviceId: string) => (
          deviceId === 'connected-300'
            ? { action: 'set_step', temperature: null, stepId: 'off' }
            : { action: 'turn_off', temperature: null, stepId: null }
        ),
        getPriorityForDevice: (deviceId: string) => (deviceId === 'connected-300' ? 1 : 10),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(result.shedSet.has('bath')).toBe(true);
    expect(result.shedSet.has('connected-300')).toBe(false);
  });

  it('steps a turn_off device at lowest active step to the off step via stepped path', async () => {
    const state = createPlanEngineState();

    const devices = [
      buildDevice({
        id: 'connected-300',
        name: 'Connected 300',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1000 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'low',
        measuredPowerKw: 0.9,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(6),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 1.5,
        softLimit: 0.8,
        capacitySoftLimit: 0.8,
        headroomRaw: -0.7,
        headroom: -0.7,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 334 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriorityForDevice: () => 100,
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    // Stepped-load devices must use the stepped path (executor skips applyShedAction
    // for them), so turn_off at lowest active step should step to 'off', not binary.
    expect(result.shedSet.has('connected-300')).toBe(true);
    expect(result.steppedDesiredStepByDeviceId.get('connected-300')).toBe('off');
  });

  it('keeps shedding other devices when a lower stepped-load target is already pending but unconfirmed', async () => {
    const state = createPlanEngineState();

    const devices = [
      buildDevice({
        id: 'connected-300',
        name: 'Connected 300',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1000 },
            { id: 'mid', planningPowerW: 2000 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'max',
        desiredStepId: 'mid',
        stepCommandPending: true,
        stepCommandStatus: 'pending',
        measuredPowerKw: 2.8,
        currentOn: true,
        controllable: true,
      }),
      buildDevice({
        id: 'bath',
        name: 'Bathroom thermostat',
        measuredPowerKw: 1.2,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(6),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 4.1,
        softLimit: 3,
        capacitySoftLimit: 3,
        headroomRaw: -1.1,
        headroom: -1.1,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 444 } as PowerTrackerState,
        getShedBehavior: (deviceId: string) => (
          deviceId === 'connected-300'
            ? { action: 'set_step', temperature: null, stepId: 'off' }
            : { action: 'turn_off', temperature: null, stepId: null }
        ),
        getPriorityForDevice: (deviceId: string) => (deviceId === 'connected-300' ? 1 : 10),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    // The system should advance past the pending 'mid' to 'low'
    expect(result.shedSet.has('connected-300')).toBe(true);
    expect(result.shedSet.has('bath')).toBe(true);
    expect(result.steppedDesiredStepByDeviceId.get('connected-300')).toBe('low');
  });

  it('does not raise a stepped-load shed target above a deeper pending unconfirmed step', async () => {
    const state = createPlanEngineState();

    const devices = [
      buildDevice({
        id: 'connected-300',
        name: 'Connected 300',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1000 },
            { id: 'mid', planningPowerW: 2000 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'max',
        desiredStepId: 'low',
        stepCommandPending: true,
        stepCommandStatus: 'pending',
        measuredPowerKw: 2.8,
        currentOn: true,
        controllable: true,
      }),
      buildDevice({
        id: 'bath',
        name: 'Bathroom thermostat',
        measuredPowerKw: 1.2,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(6),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 4.1,
        softLimit: 3,
        capacitySoftLimit: 3,
        headroomRaw: -1.1,
        headroom: -1.1,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 445 } as PowerTrackerState,
        getShedBehavior: (deviceId: string) => (
          deviceId === 'connected-300'
            ? { action: 'set_step', temperature: null, stepId: 'off' }
            : { action: 'turn_off', temperature: null, stepId: null }
        ),
        getPriorityForDevice: (deviceId: string) => (deviceId === 'connected-300' ? 1 : 10),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    // With pending desired='low', the system advances to 'off' and keeps
    // preemptive priority since selectedStep 'max' is still above lowestActive.
    expect(result.shedSet.has('connected-300')).toBe(true);
    expect(result.shedSet.has('bath')).toBe(true);
    expect(result.steppedDesiredStepByDeviceId.get('connected-300')).toBe('off');
  });

  it('keeps shedding other devices when a previous stepped-load shed command went stale', async () => {
    const state = createPlanEngineState();

    const devices = [
      buildDevice({
        id: 'connected-300',
        name: 'Connected 300',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1000 },
            { id: 'mid', planningPowerW: 2000 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'max',
        desiredStepId: 'mid',
        stepCommandPending: false,
        stepCommandStatus: 'stale',
        measuredPowerKw: 2.8,
        currentOn: true,
        controllable: true,
      }),
      buildDevice({
        id: 'bath',
        name: 'Bathroom thermostat',
        measuredPowerKw: 1.2,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(6),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 4.1,
        softLimit: 3,
        capacitySoftLimit: 3,
        headroomRaw: -1.1,
        headroom: -1.1,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 555 } as PowerTrackerState,
        getShedBehavior: (deviceId: string) => (
          deviceId === 'connected-300'
            ? { action: 'set_step', temperature: null, stepId: 'off' }
            : { action: 'turn_off', temperature: null, stepId: null }
        ),
        getPriorityForDevice: (deviceId: string) => (deviceId === 'connected-300' ? 1 : 10),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(result.shedSet.has('connected-300')).toBe(true);
    expect(result.shedSet.has('bath')).toBe(true);
    expect(result.steppedDesiredStepByDeviceId.get('connected-300')).toBe('mid');
  });

  it('keeps shedding other devices when a binary shed command is still unconfirmed', async () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.bath = {
      capabilityId: 'onoff',
      desired: false,
      startedMs: Date.now() - 5_000,
    };

    const devices = [
      buildDevice({
        id: 'bath',
        name: 'Bathroom thermostat',
        measuredPowerKw: 1.2,
        currentOn: true,
        controllable: true,
      }),
      buildDevice({
        id: 'hall',
        name: 'Hall thermostat',
        measuredPowerKw: 0.5,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(6),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 3.1,
        softLimit: 2.3,
        capacitySoftLimit: 2.3,
        headroomRaw: -0.8,
        headroom: -0.8,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 666 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriorityForDevice: (deviceId: string) => (deviceId === 'bath' ? 10 : 5),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(result.shedSet.has('bath')).toBe(true);
    expect(result.shedSet.has('hall')).toBe(true);
  });

  it('checks shortfall in daily mode when hard-cap deficit exists and no candidates remain', async () => {
    const state = createPlanEngineState();

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(6),
    } as unknown as CapacityGuard;

    await buildSheddingPlan(
      buildContext({
        devices: [],
        total: 7,
        softLimit: 5,
        capacitySoftLimit: 8,
        headroomRaw: -2,
        headroom: -2,
        softLimitSource: 'daily',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 999 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null }),
        getPriorityForDevice: () => 100,
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    // Daily soft-limit hours should still evaluate hourly shortfall risk.
    expect(capacityGuard.checkShortfall).toHaveBeenCalledWith(false, 1);
  });

  it('does not count zero-power devices as remaining shortfall candidates', async () => {
    const state = createPlanEngineState();

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(6),
    } as unknown as CapacityGuard;

    await buildSheddingPlan(
      buildContext({
        devices: [
          buildDevice({
            id: 'zero',
            name: 'Zero',
            expectedPowerKw: 0,
            powerKw: 0,
            controllable: true,
            currentOn: true,
          }),
        ],
        total: 7,
        softLimit: 5,
        capacitySoftLimit: 8,
        headroomRaw: -2,
        headroom: -2,
        softLimitSource: 'daily',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 1001 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null }),
        getPriorityForDevice: () => 100,
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(capacityGuard.checkShortfall).toHaveBeenCalledWith(false, 1);
  });

  it('excludes zero-power devices from shed candidate stats', async () => {
    const state = createPlanEngineState();

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(4.5),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices: [
          buildDevice({
            id: 'positive',
            name: 'Positive',
            expectedPowerKw: 1,
            currentOn: true,
            controllable: true,
          }),
          buildDevice({
            id: 'zero',
            name: 'Zero',
            expectedPowerKw: 0,
            powerKw: 0,
            currentOn: true,
            controllable: true,
          }),
        ],
        total: 5,
        softLimit: 4.5,
        capacitySoftLimit: 4.5,
        headroomRaw: -0.5,
        headroom: -0.5,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 1002 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null }),
        getPriorityForDevice: () => 100,
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(result.overshootStats?.candidates).toBe(1);
    expect(result.overshootStats?.totalSheddable).toBeCloseTo(1, 6);
  });

  it('skips budget-exempt devices when shedding due to the daily budget', async () => {
    const state = createPlanEngineState();

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(8),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices: [
          buildDevice({
            id: 'exempt',
            name: 'Budget Exempt',
            measuredPowerKw: 2,
            currentOn: true,
            controllable: true,
            budgetExempt: true,
          }),
          buildDevice({
            id: 'regular',
            name: 'Regular',
            measuredPowerKw: 1,
            currentOn: true,
            controllable: true,
          }),
        ],
        total: 3,
        softLimit: 2.5,
        capacitySoftLimit: 8,
        headroomRaw: -0.5,
        headroom: -0.5,
        softLimitSource: 'daily',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 1003 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null }),
        getPriorityForDevice: (deviceId: string) => (deviceId === 'exempt' ? 100 : 10),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(result.shedSet.has('exempt')).toBe(false);
    expect(result.shedSet.has('regular')).toBe(true);
    expect(result.shedReasons.get('regular')).toBe('shed due to daily budget');
  });

  it('still allows budget-exempt devices to be shed for capacity protection', async () => {
    const state = createPlanEngineState();

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(2.5),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices: [
          buildDevice({
            id: 'exempt',
            name: 'Budget Exempt',
            measuredPowerKw: 2,
            currentOn: true,
            controllable: true,
            budgetExempt: true,
          }),
          buildDevice({
            id: 'regular',
            name: 'Regular',
            measuredPowerKw: 1,
            currentOn: true,
            controllable: true,
          }),
        ],
        total: 3,
        softLimit: 2.5,
        capacitySoftLimit: 2.5,
        headroomRaw: -0.5,
        headroom: -0.5,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 1004 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null }),
        getPriorityForDevice: (deviceId: string) => (deviceId === 'exempt' ? 100 : 10),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(result.shedSet.has('exempt')).toBe(true);
    expect(result.shedReasons.get('exempt')).toBe('shed due to capacity');
  });

  it('still considers budget-exempt devices when daily shedding also exceeds the capacity soft limit', async () => {
    const state = createPlanEngineState();

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(2.5),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices: [
          buildDevice({
            id: 'exempt',
            name: 'Budget Exempt',
            measuredPowerKw: 2,
            currentOn: true,
            controllable: true,
            budgetExempt: true,
          }),
          buildDevice({
            id: 'regular',
            name: 'Regular',
            measuredPowerKw: 1,
            currentOn: true,
            controllable: true,
          }),
        ],
        total: 3,
        softLimit: 1.5,
        capacitySoftLimit: 2.5,
        headroomRaw: -1.5,
        headroom: -1.5,
        softLimitSource: 'daily',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 1005 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null }),
        getPriorityForDevice: (deviceId: string) => (deviceId === 'exempt' ? 100 : 10),
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(result.shedSet.has('exempt')).toBe(true);
  });

  it('does not use a pending step-up as the effective current step for shedding', async () => {
    const state = createPlanEngineState();

    const devices = [
      buildDevice({
        id: 'connected-300',
        name: 'Connected 300',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1000 },
            { id: 'mid', planningPowerW: 2000 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        // Device is at 'low', but a restore to 'max' is pending
        selectedStepId: 'low',
        desiredStepId: 'max',
        stepCommandPending: true,
        measuredPowerKw: 0.9,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(6),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices,
        total: 1.5,
        softLimit: 0.8,
        capacitySoftLimit: 0.8,
        headroomRaw: -0.7,
        headroom: -0.7,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 200 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriorityForDevice: () => 1,
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    // Should shed from 'low' (current), not from 'max' (pending restore)
    expect(result.shedSet.has('connected-300')).toBe(true);
    expect(result.steppedDesiredStepByDeviceId.get('connected-300')).toBe('off');
  });

  it('counts remaining stepped-load turn_off candidates using stepped targets', async () => {
    const state = createPlanEngineState();

    // Device already at off step — no further step-down possible.
    // countRemainingCandidates should NOT count it even though expectedPowerKw > 0,
    // because the stepped target equals selectedStepId (no further step to shed to).
    const devices = [
      buildDevice({
        id: 'stepped-at-off',
        name: 'Stepped at off',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1000 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'off',
        expectedPowerKw: 1,
        currentOn: true,
        controllable: true,
      }),
    ];

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getShortfallThreshold: jest.fn().mockReturnValue(2),
    } as unknown as CapacityGuard;

    await buildSheddingPlan(
      buildContext({
        devices,
        total: 2.5,
        softLimit: 2,
        capacitySoftLimit: 2,
        headroomRaw: -0.5,
        headroom: -0.5,
        softLimitSource: 'capacity',
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 300 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriorityForDevice: () => 1,
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    // With no remaining candidates, shortfall check should report remaining=0
    expect(capacityGuard.checkShortfall).toHaveBeenCalledWith(false, 0.5);
  });

  it('emits lastRecoveryMs when guard transitions from active to inactive', async () => {
    const state = createPlanEngineState();

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(true),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getRestoreMargin: jest.fn().mockReturnValue(0.2),
      getShortfallThreshold: jest.fn().mockReturnValue(5),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices: [],
        total: 1,
        softLimit: 5,
        capacitySoftLimit: 5,
        headroomRaw: 1,
        headroom: 1,
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 100 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriorityForDevice: () => 100,
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(result.sheddingActive).toBe(false);
    expect(result.updates.lastRecoveryMs).toBeGreaterThan(0);
  });

  it('does not emit lastRecoveryMs when guard stays inactive', async () => {
    const state = createPlanEngineState();

    const capacityGuard = {
      isSheddingActive: jest.fn().mockReturnValue(false),
      setSheddingActive: jest.fn().mockResolvedValue(undefined),
      checkShortfall: jest.fn().mockResolvedValue(undefined),
      isInShortfall: jest.fn().mockReturnValue(false),
      getRestoreMargin: jest.fn().mockReturnValue(0.2),
      getShortfallThreshold: jest.fn().mockReturnValue(5),
    } as unknown as CapacityGuard;

    const result = await buildSheddingPlan(
      buildContext({
        devices: [],
        total: 1,
        softLimit: 5,
        capacitySoftLimit: 5,
        headroomRaw: 1,
        headroom: 1,
      }),
      state,
      {
        capacityGuard,
        powerTracker: { lastTimestamp: 200 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriorityForDevice: () => 100,
        log: jest.fn(),
        logDebug: jest.fn(),
      },
    );

    expect(result.sheddingActive).toBe(false);
    expect(result.updates.lastRecoveryMs).toBeUndefined();
  });
});
