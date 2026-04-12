import { recordPowerSampleForApp } from '../lib/app/appPowerHelpers';
import type CapacityGuard from '../lib/core/capacityGuard';
import { PlanExecutor, type PlanExecutorDeps } from '../lib/plan/planExecutor';
import { resolveCandidatePower } from '../lib/plan/planCandidatePower';
import { buildInitialPlanDevices } from '../lib/plan/planDevices';
import { getOffDevices, getSteppedRestoreCandidates } from '../lib/plan/planRestoreDevices';
import { estimateRestorePower } from '../lib/plan/planRestoreSwap';
import { createPlanEngineState } from '../lib/plan/planState';
import { updateGuardState } from '../lib/plan/planSheddingGuard';
import { sumControlledUsageKw } from '../lib/plan/planUsage';
import { mockHomeyInstance } from './mocks/homey';
import {
  buildPlanDevice,
  steppedInputDevice,
} from './utils/planTestUtils';

const buildPlanningContext = (devices: ReturnType<typeof steppedInputDevice>[]) => ({
  devices,
  desiredForMode: {},
  total: 1.25,
  softLimit: 5,
  capacitySoftLimit: 5,
  dailySoftLimit: null,
  softLimitSource: 'capacity' as const,
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  headroomRaw: 1,
  headroom: 1,
  restoreMarginPlanning: 0.2,
});

const buildExecutor = (snapshot: Array<Record<string, unknown>>) => {
  const desiredSteppedTrigger = { trigger: vi.fn().mockResolvedValue(true) };
  const deviceManager = {
    getSnapshot: vi.fn().mockReturnValue(snapshot),
    setCapability: vi.fn().mockResolvedValue(undefined),
  };
  const deps: PlanExecutorDeps = {
    homey: {
      ...mockHomeyInstance,
      flow: { getTriggerCard: vi.fn(() => desiredSteppedTrigger) },
    } as never,
    deviceManager: deviceManager as never,
    getCapacityGuard: () => undefined,
    getCapacitySettings: () => ({ limitKw: 10, marginKw: 0 }),
    getCapacityDryRun: () => false,
    getOperatingMode: () => 'Home',
    getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
    updateLocalSnapshot: vi.fn(),
    markSteppedLoadDesiredStepIssued: vi.fn(),
    logTargetRetryComparison: vi.fn(),
    log: vi.fn(),
    logDebug: vi.fn(),
    error: vi.fn(),
  };
  return {
    executor: new PlanExecutor(deps, createPlanEngineState()),
    deviceManager,
  };
};

describe('P1 bug proofs', () => {
  it.fails('uses one power resolution model for an off keep device across restore, shedding, and live usage accounting', () => {
    const device = buildPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      expectedPowerKw: 2,
      planningPowerKw: 4,
      powerKw: 1,
    });

    const candidatePower = resolveCandidatePower(device);
    const restorePower = estimateRestorePower(device);
    const liveUsage = sumControlledUsageKw([device]);

    expect(candidatePower).toBe(restorePower);
    expect(liveUsage).not.toBeNull();
    expect(liveUsage).toBe(candidatePower);
  });

  it.fails('keeps shedding active after a single sample just above the restore margin', async () => {
    let active = false;
    const transitions: boolean[] = [];
    const capacityGuard = {
      isSheddingActive: vi.fn(() => active),
      setSheddingActive: vi.fn(async (next: boolean) => {
        active = next;
        transitions.push(next);
      }),
      checkShortfall: vi.fn().mockResolvedValue(undefined),
      getRestoreMargin: vi.fn().mockReturnValue(0.2),
      getShortfallThreshold: vi.fn().mockReturnValue(5),
    } as unknown as CapacityGuard;

    await updateGuardState({
      headroom: -0.05,
      capacitySoftLimit: 5,
      total: 5.05,
      devices: [],
      shedSet: new Set(),
      softLimitSource: 'capacity',
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      capacityGuard,
    });
    await updateGuardState({
      headroom: 0.21,
      capacitySoftLimit: 5,
      total: 4.79,
      devices: [],
      shedSet: new Set(),
      softLimitSource: 'capacity',
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      capacityGuard,
    });
    await updateGuardState({
      headroom: -0.05,
      capacitySoftLimit: 5,
      total: 5.05,
      devices: [],
      shedSet: new Set(),
      softLimitSource: 'capacity',
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      capacityGuard,
    });

    expect(transitions).toEqual([true]);
    expect(active).toBe(true);
  });

  it('passes the in-flight shed summary to shortfall logging', async () => {
    const capacityGuard = {
      isSheddingActive: vi.fn(() => false),
      setSheddingActive: vi.fn().mockResolvedValue(undefined),
      checkShortfall: vi.fn().mockResolvedValue(undefined),
      getRestoreMargin: vi.fn().mockReturnValue(0.2),
      getShortfallThreshold: vi.fn().mockReturnValue(5),
    } as unknown as CapacityGuard;

    await updateGuardState({
      headroom: -1,
      capacitySoftLimit: 5,
      total: 6,
      devices: [
        {
          id: 'shed',
          name: 'Shed',
          targets: [],
          currentOn: true,
          controllable: true,
          measuredPowerKw: 0,
          binaryCommandPending: true,
        },
        {
          id: 'stale',
          name: 'Stale',
          targets: [],
          currentOn: true,
          controllable: true,
          observationStale: true,
        },
      ],
      shedSet: new Set(['shed']),
      softLimitSource: 'capacity',
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      capacityGuard,
    });

    expect(capacityGuard.checkShortfall).toHaveBeenCalledWith(true, 1, expect.objectContaining({
      controlledDevices: 2,
      shedDevices: 1,
      activeControlledDevices: 1,
      zeroDrawControlledDevices: 1,
      staleControlledDevices: 1,
      pendingControlledDevices: 1,
    }));
  });

  it.fails('applies the same unknown-state restore eligibility rules to stepped and non-stepped devices', () => {
    const devices = [
      buildPlanDevice({
        id: 'binary',
        name: 'Binary heater',
        currentState: 'unknown',
        plannedState: 'keep',
      }),
      buildPlanDevice({
        id: 'stepped',
        name: 'Tank',
        currentState: 'unknown',
        plannedState: 'keep',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'low',
        desiredStepId: 'low',
      }),
    ];

    expect(getOffDevices(devices)).toHaveLength(0);
    expect(getSteppedRestoreCandidates(devices)).toHaveLength(0);
  });

  it.fails('uses the same controlled/uncontrolled split in planning and power tracking for stepped off-step devices', async () => {
    let tracker = {};
    const rawDevice = steppedInputDevice({
      id: 'dev-step',
      name: 'Tank',
      selectedStepId: 'off',
      currentOn: true,
      expectedPowerKw: 1.25,
      measuredPowerKw: undefined,
    });

    const [planDevice] = buildInitialPlanDevices({
      context: buildPlanningContext([rawDevice]),
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

    const plannerControlledKw = sumControlledUsageKw([planDevice]) ?? 0;
    await recordPowerSampleForApp({
      currentPowerW: 1250,
      nowMs: Date.UTC(2025, 0, 1, 0, 0, 0),
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot: () => [rawDevice],
      powerTracker: tracker,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    expect(plannerControlledKw).toBeCloseTo(((tracker as { lastControlledPowerW?: number }).lastControlledPowerW ?? 0) / 1000, 6);
    expect(1.25 - plannerControlledKw).toBeCloseTo(
      ((tracker as { lastUncontrolledPowerW?: number }).lastUncontrolledPowerW ?? 0) / 1000,
      6,
    );
  });

  it.fails('uses raw onoff state, not stale currentState, when deciding whether a shed device still needs an off command', async () => {
    const { executor, deviceManager } = buildExecutor([{
      id: 'dev-1',
      name: 'Heater',
      controlCapabilityId: 'onoff',
      canSetControl: true,
      available: true,
      currentOn: true,
    }]);

    await executor.applyPlanActions({
      meta: {
        totalKw: 5,
        softLimitKw: 4,
        headroomKw: -1,
      },
      devices: [{
        id: 'dev-1',
        name: 'Heater',
        currentState: 'off',
        plannedState: 'shed',
        currentTarget: 21,
        plannedTarget: 21,
        controllable: true,
      }],
    });

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', false);
  });
});
