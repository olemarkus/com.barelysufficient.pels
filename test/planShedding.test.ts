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
    expect(capacityGuard.checkShortfall).toHaveBeenCalledWith(true, 0);
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
});
