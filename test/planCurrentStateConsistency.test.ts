import type { PowerTrackerState } from '../lib/core/powerTracker';
import type { PlanContext } from '../lib/plan/planContext';
import { buildLiveStatePlan } from '../lib/plan/planReconcileState';
import { isBinaryRestoreCandidate } from '../lib/plan/planRestoreDevices';
import { buildSheddingPlan } from '../lib/plan/planShedding';
import { createPlanEngineState } from '../lib/plan/planState';
import type { DevicePlan, PlanInputDevice } from '../lib/plan/planTypes';

const buildLiveDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => ({
  id: 'dev-1',
  name: 'Heater',
  targets: [],
  currentOn: false,
  hasBinaryControl: true,
  controllable: true,
  expectedPowerKw: 1.8,
  ...overrides,
});

const buildPlan = (overrides: Partial<DevicePlan['devices'][number]> = {}): DevicePlan => ({
  meta: {
    totalKw: 5,
    softLimitKw: 4,
    headroomKw: -1,
  },
  devices: [{
    id: 'dev-1',
    name: 'Heater',
    currentOn: false,
    currentState: 'off',
    plannedState: 'keep',
    currentTarget: null,
    plannedTarget: null,
    controllable: true,
    ...overrides,
  }],
});

const buildContext = (device: PlanInputDevice): PlanContext => ({
  devices: [device],
  desiredForMode: {},
  total: 5,
  softLimit: 4,
  capacitySoftLimit: 4,
  dailySoftLimit: null,
  softLimitSource: 'capacity',
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  headroomRaw: -1,
  headroom: -1,
  restoreMarginPlanning: 0.2,
});

describe('planner current-state consistency', () => {
  async function resolvePhaseAnswers(params: {
    liveDevice: PlanInputDevice;
    pendingRestore?: boolean;
  }): Promise<{
    mergedCurrentState: string;
    restoreCandidate: boolean;
    shedCandidate: boolean;
  }> {
    const { liveDevice, pendingRestore = false } = params;
    const plan = buildPlan();
    const state = createPlanEngineState();
    if (pendingRestore) {
      state.pendingBinaryCommands[liveDevice.id] = {
        capabilityId: 'onoff',
        desired: true,
        startedMs: Date.now(),
      };
    }

    const mergedPlan = buildLiveStatePlan(plan, [liveDevice]);
    const sheddingPlan = await buildSheddingPlan(
      buildContext(liveDevice),
      state,
      {
        capacityGuard: undefined,
        powerTracker: { lastTimestamp: 100 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriorityForDevice: () => 100,
        log: vi.fn(),
        logDebug: vi.fn(),
      },
      true,
    );

    return {
      mergedCurrentState: mergedPlan.devices[0].currentState,
      restoreCandidate: isBinaryRestoreCandidate(mergedPlan.devices[0]),
      shedCandidate: sheddingPlan.shedSet.has(liveDevice.id),
    };
  }

  it('keeps an observed-off binary device off across reconcile, restore, and shedding without pending commands', async () => {
    const phaseAnswers = await resolvePhaseAnswers({
      liveDevice: buildLiveDevice(),
    });

    expect(phaseAnswers).toEqual({
      mergedCurrentState: 'off',
      restoreCandidate: true,
      shedCandidate: false,
    });
  });

  it('does not let a pending restore make an observed-off binary device look shed-eligible', async () => {
    const phaseAnswers = await resolvePhaseAnswers({
      liveDevice: buildLiveDevice(),
      pendingRestore: true,
    });

    expect(phaseAnswers).toEqual({
      mergedCurrentState: 'off',
      restoreCandidate: true,
      shedCandidate: false,
    });
  });
});
