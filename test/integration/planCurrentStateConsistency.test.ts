import type { PowerTrackerState } from '../../lib/power/tracker';
import type { PlanContext } from '../../lib/plan/planContext';
import { buildLiveStatePlan } from '../../lib/plan/planReconcileState';
import { isBinaryRestoreCandidate } from '../../lib/plan/restore/devices';
import { buildSheddingPlan } from '../../lib/plan/shedding';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type {
  BinaryControlDiscriminantProbe,
  DevicePlan,
  DevicePlanDevice,
  PlanInputDevice,
  TemperatureDiscriminantProbe,
} from '../../lib/plan/planTypes';
import { withBinaryDiscriminant, withTemperatureDiscriminant } from '../../lib/plan/planTypes';

const buildLiveDevice = (
  overrides: Partial<PlanInputDevice> & BinaryControlDiscriminantProbe = {},
): PlanInputDevice => withBinaryDiscriminant({
  id: 'dev-1',
  name: 'Heater',
  targets: [],
  binaryControl: { on: false },
  controlCapabilityId: 'onoff',
  controllable: true,
  expectedPowerKw: 1.8,
  ...overrides,
}) as PlanInputDevice;

const buildPlan = (
  overrides: Partial<DevicePlanDevice> & BinaryControlDiscriminantProbe & TemperatureDiscriminantProbe = {},
): DevicePlan => ({
  meta: {
    totalKw: 5,
    softLimitKw: 4,
    headroomKw: -1,
  },
  devices: [withBinaryDiscriminant(withTemperatureDiscriminant({
    id: 'dev-1',
    name: 'Heater',
    binaryControl: { on: false },
    currentState: 'off',
    plannedState: 'keep',
    currentTarget: null,
    controlCapabilityId: 'onoff',
    ...overrides,
  })) as DevicePlanDevice],
});

const buildContext = (device: PlanInputDevice): PlanContext => ({
  devices: [device],
  desiredForMode: {},
  total: 5,
  powerKnown: true,
  hasLivePowerSample: true,
  powerSampleAgeMs: 0,
  powerFreshnessState: 'fresh',
  hourBucketKey: '2025-01-01T00',
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
        pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
        log: vi.fn(),
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
