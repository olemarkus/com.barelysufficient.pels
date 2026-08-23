import { planContextPower } from '../utils/planContextPowerFixture';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { PlanContext } from '../../lib/plan/planContext';
import { buildLiveStatePlan } from '../../lib/plan/planLiveStateMerge';
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
import { buildPlanMeta, withFixtureResidualKw } from '../utils/planTestUtils';

// A plain, unremarkable meter reading: fixtures that only need power to be
// MEASURED say so through the reading, the way production does.
const FIXTURE_TOTAL_KW = 3;

const buildLiveDevice = (
  overrides: Partial<PlanInputDevice> & BinaryControlDiscriminantProbe = {},
): PlanInputDevice => withBinaryDiscriminant(withFixtureResidualKw({
  id: 'dev-1',
  name: 'Heater',
  targets: [],
  binaryControl: { on: false },
  currentOn: false,
  binaryCapabilityId: 'onoff',
  controllable: true,
  expectedPowerKw: 1.8,
  ...overrides,
})) as PlanInputDevice;

const buildPlan = (
  overrides: Partial<DevicePlanDevice> & BinaryControlDiscriminantProbe & TemperatureDiscriminantProbe = {},
): DevicePlan => ({
  meta: buildPlanMeta({
    totalKw: 5,
    softLimitKw: 4,
    headroomKw: -1}),
  devices: [withBinaryDiscriminant(withTemperatureDiscriminant(withFixtureResidualKw({
    id: 'dev-1',
    name: 'Heater',
    binaryControl: { on: false },
    currentOn: false,
    currentState: 'off',
    plannedState: 'keep',
    binaryCapabilityId: 'onoff',
    ...overrides,
  }))) as DevicePlanDevice],
});

const buildContext = (device: PlanInputDevice): PlanContext => ({
  devices: [device],
  desiredForMode: {},
  ...planContextPower(FIXTURE_TOTAL_KW),
  hourBucketKey: '2025-01-01T00',
  softLimit: 4,
  capacitySoftLimit: 4,
  dailySoftLimit: null,
  budgetPaceKw: null,
  projectedExemptKw: null,
  softLimitSource: 'capacity',
  budgetReleasableHeadroomHold: false,
  capacityHeadroomKw: 1,
  budgetHeadroomKw: null,
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  headroomRaw: -1,
  headroom: -1,
  restoreMarginPlanning: 0.2,
  currentHourPriceLevel: { cheap: false, expensive: false },
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
        dispatchState: 'accepted',
        desired: true,
        startedMs: Date.now(),
        pendingMs: 90_000,
      };
    }

    const mergedPlan = buildLiveStatePlan(plan, [liveDevice]);
    const sheddingPlan = await buildSheddingPlan(
      buildContext(liveDevice),
      state,
      {
        capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
        shortfallThresholdKw: Number.POSITIVE_INFINITY,
        powerTracker: { lastTimestamp: 100 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' }),
        getPriorityForDevice: () => 100,
        pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
        log: vi.fn(),
      },
      { actionable: true, shedActionable: true },
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
