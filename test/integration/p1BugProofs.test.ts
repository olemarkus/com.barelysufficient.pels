import { recordPowerSampleForApp } from '../../lib/power/sampleIngest';
import type CapacityGuard from '../../lib/power/capacityGuard';
import { PlanExecutor, type PlanExecutorDeps } from '../../lib/executor/planExecutor';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { buildInitialPlanDevices } from '../../lib/plan/planDevices';
import { getHighestKnownPowerKw } from '../../lib/observer/observedPower';
import { getOffDevices, getSteppedRestoreCandidates } from '../../lib/plan/restore/devices';
import { estimateRestorePower } from '../../lib/plan/restore/accounting';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import { updateGuardState } from '../../lib/plan/admission';
import { splitControlledUsageKw, sumBudgetExemptProjectedUsageKw, sumControlledUsageKw } from '../../lib/plan/planUsage';
import {
  buildPlanDevice,
  steppedInputDevice,
  steppedPlanDevice,
} from '../utils/planTestUtils';
import { withGetSnapshotByDeviceId } from '../utils/deviceObservationMock';
import { fixtureDeviceReason } from '../utils/deviceReasonTestUtils';
import { withHeadroomCurrentOn } from '../../lib/plan/planHeadroomSupport';
import type { SplitControlledUsage, SumBudgetExemptUsage } from '../../lib/power/sampleIngest';

// Mirror the production wiring in `setup/powerSamplePipeline.ts`: raw transport
// snapshots go through `withHeadroomCurrentOn` — the producer boundary that
// resolves `currentDrawKw` — before the usage math sees them.
const splitControlledUsage: SplitControlledUsage = (params) => splitControlledUsageKw({
  ...params,
  devices: params.devices.map(withHeadroomCurrentOn),
});
const sumBudgetExemptUsage: SumBudgetExemptUsage = (devices) => (
  sumBudgetExemptProjectedUsageKw(devices.map(withHeadroomCurrentOn))
);


const buildPlanningContext = (devices: ReturnType<typeof steppedInputDevice>[]) => ({
  devices,
  desiredForMode: {},
  total: 1.25,
  planningTotalKw: 1.25,
  hasLivePowerSample: true,
  powerSampleAgeMs: 0,
  powerFreshnessState: 'fresh' as const,
  hourBucketKey: '2025-01-01T00',
  softLimit: 5,
  capacitySoftLimit: 5,
  dailySoftLimit: null,
  softLimitSource: 'capacity' as const,
  budgetReleasableHeadroomHold: false,
  capacityHeadroomKw: 1,
  budgetHeadroomKw: null,
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  headroomRaw: 1,
  headroom: 1,
  restoreMarginPlanning: 0.2,
  currentHourPriceLevel: { cheap: false, expensive: false },
});

const buildExecutor = (snapshot: Array<Record<string, unknown>>) => {
  const deviceManager = withGetSnapshotByDeviceId({
    getSnapshot: vi.fn().mockReturnValue(snapshot),
    setCapability: vi.fn().mockResolvedValue(undefined),
  });
  const state = createPlanEngineState();
  const deps: PlanExecutorDeps = {
    getHomeDisplayName: () => 'Main home',
    homeId: 'main',
    setCapacityInShortfall: vi.fn(),
    persistLastControlledMs: vi.fn(),
    deviceManager: deviceManager as never,
    getObservedState: (id) => deviceManager.getSnapshotByDeviceId(id),
    // This proof never drives a step write; supply an actuator over the device
    // manager's writes so the executor's stepped binding has a seam to call.
    actuator: createDeviceActuator({
      setCapability: (deviceId, capabilityId, value) => deviceManager.setCapability(deviceId, capabilityId, value),
      applyDeviceTargets: async () => undefined,
      triggerFlowBackedBinaryControl: async () => undefined,
    }),
    getCapacityGuard: () => undefined,
    getCapacitySettings: () => ({ limitKw: 10, marginKw: 0 }),
    getCapacityDryRun: () => false,
    getOperatingMode: () => 'Home',
    getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
    markSteppedLoadDesiredStepIssued: vi.fn(),
    getSteppedLoadCommandSession: () => ({ hasPriorStepCommand: false }),
    logTargetRetryComparison: vi.fn(),
    pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
  };
  return {
    executor: new PlanExecutor(deps, state),
    deviceManager,
  };
};

describe('P1 bug proofs', () => {
  it('separates what an off device will draw when restored from what it is drawing now', () => {
    // The original proof asserted these were the SAME number — live usage equal to
    // the highest known configured demand. That is the defect: an off device
    // measuring a true 0 W was booked at its nameplate, and `sampleIngest` wrote
    // that into the persisted managed/background split. Restore admission still
    // reserves the configured demand (it is about to be switched on); live usage
    // reports the meter.
    const device = buildPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      currentDrawKw: 0,
      expectedPowerKw: 2,
      planningPowerKw: 4,
    });

    const highestKnown = getHighestKnownPowerKw(device)?.kw ?? 0;
    expect(estimateRestorePower(device)).toBe(highestKnown);
    expect(sumControlledUsageKw([device])).toBe(0);
  });

  it('keeps shedding active after a single sample just above the restore margin', async () => {
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
      overshootActionable: true,
      capacitySoftLimit: 5,
      planningTotalKw: 5.05,
      devices: [],
      shedSet: new Set(),
      softLimitSource: 'capacity',
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      capacityGuard,
    });
    await updateGuardState({
      headroom: 0.21,
      overshootActionable: false,
      capacitySoftLimit: 5,
      planningTotalKw: 4.79,
      devices: [],
      shedSet: new Set(),
      softLimitSource: 'capacity',
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      capacityGuard,
    });
    await updateGuardState({
      headroom: -0.05,
      overshootActionable: true,
      capacitySoftLimit: 5,
      planningTotalKw: 5.05,
      devices: [],
      shedSet: new Set(),
      softLimitSource: 'capacity',
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      capacityGuard,
    });

    expect(transitions[0]).toBe(true);
    expect(transitions).not.toContain(false);
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
      overshootActionable: true,
      capacitySoftLimit: 5,
      planningTotalKw: 6,
      devices: [
        withBinaryDiscriminant({
          id: 'shed',
          expectedPowerKw: 1, expectedPowerSource: 'default',
          name: 'Shed',
          commandableNow: true,
          targets: [],
          binaryControl: { on: true },
          controllable: true,
          controlCapabilityId: 'onoff',
          currentDrawKw: 0,
          binaryCommandPending: true,
        }) as PlanInputDevice,
        withBinaryDiscriminant({
          currentDrawKw: 1,
          id: 'stale',
          expectedPowerKw: 1, expectedPowerSource: 'default',
          name: 'Stale',
          commandableNow: true,
          targets: [],
          binaryControl: { on: true },
          controllable: true,
          controlCapabilityId: 'onoff',
        }) as PlanInputDevice,
      ],
      shedSet: new Set(['shed']),
      softLimitSource: 'capacity',
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      capacityGuard,
    });

    expect(capacityGuard.checkShortfall).toHaveBeenCalledWith(true, 1, expect.objectContaining({
      controlledDevices: 2,
      plannedShedDevices: 1,
      pendingPlannedShedDevices: 1,
      activePlannedShedDevices: 1,
      // The 'stale' device is trusted-on via its latched binary state, so it counts active.
      activeControlledDevices: 2,
      zeroDrawControlledDevices: 1,
      pendingControlledDevices: 1,
      summarySource: 'plan_input',
    }));
  });

  // Behaviour change (resolved-control refactor): binary/stepped devices have no
  // 'unknown' on/off state — 'unknown' is only a label. With no off-evidence the
  // device resolves to `currentOn: true`, so the stepped device at an active step
  // below its top is an eligible step-up restore candidate.
  it('treats unknown-label stepped devices as on (no unknown state) for restore eligibility', () => {
    const devices = [
      buildPlanDevice({
        id: 'binary',
        name: 'Binary heater',
        currentState: 'unknown',
        plannedState: 'keep',
      }),
      steppedPlanDevice({
        id: 'stepped',
        name: 'Tank',
        currentState: 'unknown',
        plannedState: 'keep',
        steppedLoadProfile: {
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
    expect(getSteppedRestoreCandidates(devices)).toHaveLength(1);
  });

  it('uses the same controlled/uncontrolled split in planning and power tracking for stepped off-step devices', async () => {
    let tracker = {};
    const rawDevice = withBinaryDiscriminant({
      ...steppedInputDevice({
        id: 'dev-step',
        name: 'Tank',
        selectedStepId: 'off',
        currentState: 'off',
        expectedPowerKw: 1.25,
        // Parked at its off step and drawing nothing — its own meter says so.
        currentDrawKw: 0,
      }),
      binaryControl: { on: false },
    }) as PlanInputDevice;

    const planState = createPlanEngineState();
    const [planDevice] = buildInitialPlanDevices({
      context: buildPlanningContext([rawDevice]),
      state: planState,
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: {
        getPriorityForDevice: () => 100,
        getShedBehavior: () => ({ action: 'set_step', temperature: null, stepId: 'low' }),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: createPendingBinaryCommandStore(planState.pendingBinaryCommands),
      },
    });

    const plannerControlledKw = sumControlledUsageKw([planDevice]);
    await recordPowerSampleForApp({
      currentPowerW: 1250,
      nowMs: Date.UTC(2025, 0, 1, 0, 0, 0),
      capacitySettings: { limitKw: 10, marginKw: 0.2 },
      getLatestTargetSnapshot: () => [rawDevice],
      powerTracker: tracker,
      splitControlledUsage,
      sumBudgetExemptUsage,
      updateObjectiveProfiles: ({ state }) => state,
      schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
      saveState: (nextState) => {
        tracker = nextState;
      },
    });

    // The proof is AGREEMENT between the two paths: the planner's managed sum and
    // the power tracker's split must describe this device the same way. The tank
    // is off and drawing nothing, so it contributes 0 to managed usage and the
    // whole 1.25 kW house reading lands in background — where it belongs.
    expect(plannerControlledKw).toBeCloseTo(
      ((tracker as { lastControlledPowerW?: number }).lastControlledPowerW ?? 0) / 1000,
      6,
    );
    expect(1.25 - plannerControlledKw).toBeCloseTo(
      ((tracker as { lastUncontrolledPowerW?: number }).lastUncontrolledPowerW ?? 0) / 1000,
      6,
    );
  });

  it('uses raw onoff state, not stale currentState, when deciding whether a shed device still needs an off command', async () => {
    const { executor, deviceManager } = buildExecutor([{
      id: 'dev-1',
      name: 'Heater',
      controlCapabilityId: 'onoff',
      canSetControl: true,
      available: true,
      binaryControl: { on: true },
    }]);

    await executor.applyPlanActions({
      meta: {
        totalKw: 5,
        softLimitKw: 4,
        headroomKw: -1,
      },
      devices: [buildPlanDevice({
        id: 'dev-1',
        name: 'Heater',
        currentState: 'off',
        plannedState: 'shed',
        currentTarget: 21,
        plannedTarget: 21,
        controlCapabilityId: 'onoff',
        reason: fixtureDeviceReason('shed due to capacity'),
      })],
    });

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', false);
  });
});
