import { buildPlanCycleObject, type PlanCycle } from '../utils/planContextPowerFixture';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { buildLiveStatePlan } from '../../lib/plan/planLiveStateMerge';
import { isShedPostureBinaryRestoreCandidate } from '../../lib/plan/restore/devices';
import { ShedDecisions } from '../../lib/plan/shedDecisions';
import { buildSheddingPlanForSpec } from '../helpers/sheddingPlanForSpec';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
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
  // Observed off and measured drawing nothing: a device PELS may resume has a
  // power reading.
  currentDrawKw: 0,
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

const buildContext = (device: PlanInputDevice): PlanCycle => buildPlanCycleObject({
  devices: [device],
  total: FIXTURE_TOTAL_KW,
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
});

// The merge asks the pending-command store whether a turn-ON is in flight;
// these specs issue no commands.
const noPendingBinary = (): boolean => false;

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
      };
    }

    const mergedPlan = buildLiveStatePlan(plan, [liveDevice], noPendingBinary);
    const cycle = buildContext(liveDevice);
    const sheddingPlan = await buildSheddingPlanForSpec(
      cycle,
      cycle,
      state,
      {
        capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
        shortfallThresholdKw: Number.POSITIVE_INFINITY,
        powerTracker: { lastTimestamp: 100 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' }),
        pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
        log: vi.fn(),
      },
      { actionable: true, shedActionable: true },
    );

    return {
      mergedCurrentState: mergedPlan.devices[0].currentState,
      restoreCandidate: isShedPostureBinaryRestoreCandidate(mergedPlan.devices[0], previousKeepHistory(liveDevice.id)),
      shedCandidate: sheddingPlan.shedSet.has(liveDevice.id),
    };
}

function previousKeepHistory(deviceId: string): ShedDecisions {
  const history = new ShedDecisions();
  history.lastPlannedDeviceIds = new Set([deviceId]);
  history.lastPlannedKeptIds = new Set([deviceId]);
  return history;
}

  it('does not classify off/keep as a restore without a previous shed decision', async () => {
    const phaseAnswers = await resolvePhaseAnswers({
      liveDevice: buildLiveDevice(),
    });

    expect(phaseAnswers).toEqual({
      mergedCurrentState: 'off',
      restoreCandidate: false,
      shedCandidate: false,
    });
  });

  it('does not let a pending restore change the previous-plan restore classification', async () => {
    const phaseAnswers = await resolvePhaseAnswers({
      liveDevice: buildLiveDevice(),
      pendingRestore: true,
    });

    expect(phaseAnswers).toEqual({
      mergedCurrentState: 'off',
      restoreCandidate: false,
      shedCandidate: false,
    });
  });
});
