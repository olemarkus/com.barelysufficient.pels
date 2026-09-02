import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
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
  buildPlanMeta,
  steppedInputDevice,
  steppedPlanDevice,
  withFixtureResidualKw,
} from '../utils/planTestUtils';
import { withGetSnapshotByDeviceId } from '../utils/deviceObservationMock';
import { fixtureDeviceReason } from '../utils/deviceReasonTestUtils';
import { withHeadroomCurrentOn } from '../../lib/plan/planHeadroomSupport';
import type { SplitControlledUsage, SumBudgetExemptUsage, SumControlledUsage } from '../../lib/power/sampleIngest';
import type { TemperaturePlanInputKind } from '../../packages/planner-types/src/planInputDevice';
import { PriceLevel } from '../../lib/price/priceLevels';

// Mirror the production wiring in `setup/powerSamplePipeline.ts`: raw transport
// snapshots go through `withHeadroomCurrentOn` — the producer boundary that
// resolves `currentDrawKw` — before the usage math sees them.
const splitControlledUsage: SplitControlledUsage = (params) => splitControlledUsageKw({
  ...params,
  devices: params.devices.map(withHeadroomCurrentOn),
});
const sumControlledUsage: SumControlledUsage = (devices) => (
  sumControlledUsageKw(devices.map(withHeadroomCurrentOn))
);
const sumBudgetExemptUsage: SumBudgetExemptUsage = (devices) => (
  sumBudgetExemptProjectedUsageKw(devices.map(withHeadroomCurrentOn))
);


const buildPlanningContext = (devices: ReturnType<typeof steppedInputDevice>[]) => ({
  devices,
  modeTargetCFor: (d: PlanInputDevice & TemperaturePlanInputKind) => d.currentTarget,
  total: 1.25,
  hourBucketKey: '2025-01-01T00',
  softLimit: 5,
  capacitySoftLimit: 5,
  dailySoftLimit: null,
  budgetPaceKw: null,
  projectedExemptKw: null,
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
  currentHourPriceLevel: PriceLevel.UNKNOWN,
});

const buildExecutor = (snapshot: Array<Record<string, unknown>>) => {
  const deviceManager = withGetSnapshotByDeviceId({
    getSnapshot: vi.fn().mockReturnValue(snapshot),
    setCapability: vi.fn().mockResolvedValue(undefined),
  });
  const state = createPlanEngineState();
  const deps: PlanExecutorDeps = {
    getShedBehavior: () => ({ action: 'turn_off' }),
    getHomeDisplayName: () => 'Main home',
    homeId: 'main',
    setCapacityInShortfall: vi.fn(),
    persistLastControlledMs: vi.fn(),
    deviceManager: deviceManager as never,
    getObservationRevision: () => 0,
    getObservedState: (id) => deviceManager.getSnapshotByDeviceId(id),
    // This proof never drives a step write; supply an actuator over the device
    // manager's writes so the executor's stepped binding has a seam to call.
      actuator: createDeviceActuator({
        resolveTemperatureTarget: (_deviceId, desired) => desired,
        requestSteppedLoadStep: async () => ({ requested: false }),
      requestBinaryControl: async (deviceId, desired) => {
        await deviceManager.setCapability(deviceId, 'onoff', desired);
        return undefined;
      },
      requestTemperatureTarget: async (_deviceId, desired) => desired,
    }),
    capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
    getCapacitySettings: () => ({ limitKw: 10, marginKw: 0 }),
    getPowerTracker: () => ({}),
    getCapacityPaceKw: () => 9.5,
    getShortfallThresholdKw: () => 0,
    getCapacityDryRun: () => false,
    getOperatingMode: () => 'Home',
    markSteppedLoadDesiredStepIssued: vi.fn(),
    getSteppedLoadCommandSession: () => ({ hasPriorStepCommand: false, stepCommandPending: false }),
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
      boostActive: false,
      currentDrawKw: 0,
      expectedPowerKw: 2,
      planningPowerKw: 4,
    });

    const highestKnown = getHighestKnownPowerKw(device)?.kw ?? 0;
    expect(estimateRestorePower(device)).toBe(highestKnown);
    expect(sumControlledUsageKw([device])).toBe(0);
  });

  it('keeps shedding active after a single sample just above the restore margin', async () => {
    const capacityGuard = {
      checkShortfall: vi.fn().mockResolvedValue(undefined),
    } as unknown as CapacityGuard;
    const base = {
      shortfallThresholdKw: 5,
      capacityGuard,
      devices: [],
      shedSet: new Set<string>(),
      softLimitSource: 'capacity' as const,
      hourlyBudgetExhausted: false,
      isBinaryCommandPending: () => false,
    };

    // The latch is threaded build to build now, so the proof is that a single
    // sample 0.21 kW above the restore margin — short of the 0.4 kW clear
    // threshold — does not release it.
    const shed = await updateGuardState({
      ...base, sheddingActive: false, headroom: -0.05, overshootActionable: true, drawKw: 5.05, capacityBreached: true,
    });
    expect(shed.sheddingActive).toBe(true);

    const eased = await updateGuardState({
      ...base, sheddingActive: shed.sheddingActive, headroom: 0.21, overshootActionable: false, drawKw: 4.79, capacityBreached: false,
    });
    expect(eased.sheddingActive).toBe(true);

    const again = await updateGuardState({
      ...base, sheddingActive: eased.sheddingActive, headroom: -0.05, overshootActionable: true, drawKw: 5.05, capacityBreached: true,
    });
    expect(again.sheddingActive).toBe(true);
  });

  it('passes the in-flight shed summary to shortfall logging', async () => {
    const capacityGuard = {
      checkShortfall: vi.fn().mockResolvedValue(undefined),
    } as unknown as CapacityGuard;

    await updateGuardState({
      sheddingActive: false,
      hourlyBudgetExhausted: false,
      shortfallThresholdKw: 5,
      capacityGuard,
      headroom: -1,
      overshootActionable: true,
      drawKw: 6, capacityBreached: true,
      // In flight per the executor's command store, not per a field on the
      // device: the plan-input seam does not carry binary command state.
      isBinaryCommandPending: (deviceId) => deviceId === 'shed',
      devices: [
        withBinaryDiscriminant(withFixtureResidualKw({
          available: true,
          id: 'shed',
          expectedPowerKw: 1, expectedPowerSource: 'default',
          name: 'Shed',
          commandableNow: true,
          objectiveSessionInactive: false,
          boostSupported: false,
          boostRequested: false,
          hasStandingDemand: true,
          surplusTracking: false,
          confirmedNotDrawing: false,
          targets: [],
          binaryControl: { on: true },
          currentOn: true,
          controllable: true,
          binaryCapabilityId: 'onoff',
          currentDrawKw: 0,
        })) as PlanInputDevice,
        withBinaryDiscriminant(withFixtureResidualKw({
          available: true,
          currentDrawKw: 1,
          id: 'stale',
          expectedPowerKw: 1, expectedPowerSource: 'default',
          name: 'Stale',
          commandableNow: true,
          objectiveSessionInactive: false,
          boostSupported: false,
          boostRequested: false,
          hasStandingDemand: true,
          surplusTracking: false,
          confirmedNotDrawing: false,
          targets: [],
          binaryControl: { on: true },
          currentOn: true,
          controllable: true,
          binaryCapabilityId: 'onoff',
        })) as PlanInputDevice,
      ],
      shedSet: new Set(['shed']),
      softLimitSource: 'capacity',
    });

    expect(capacityGuard.checkShortfall).toHaveBeenCalledWith(expect.objectContaining({
      hasCandidates: true,
      deficitKw: 1,
      capacityStateSummary: expect.objectContaining({
      controlledDevices: 2,
      plannedShedDevices: 1,
      pendingPlannedShedDevices: 1,
      activePlannedShedDevices: 1,
      // The 'stale' device is trusted-on via its latched binary state, so it counts active.
      activeControlledDevices: 2,
      zeroDrawControlledDevices: 1,
      pendingControlledDevices: 1,
      summarySource: 'plan_input',
      }),
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
        boostActive: false,
      }),
      steppedPlanDevice({
        id: 'stepped',
        name: 'Tank',
        currentState: 'unknown',
        plannedState: 'keep',
        boostActive: false,
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
      currentOn: false,
    }) as PlanInputDevice;

    const planState = createPlanEngineState();
    const [planDevice] = buildInitialPlanDevices({
      context: buildPlanningContext([rawDevice]),
      state: planState,
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      shortfall: { inShortfall: false },
      deps: {
        getInferredSurplusKw: () => 0,
        getShedBehavior: () => ({ action: 'set_step' }),
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
      sumControlledUsage,
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
      binaryCapabilityId: 'onoff',
      canSetControl: true,
      available: true,
      binaryControl: { on: true },
      currentOn: true,
    }]);

    await executor.applyPlanActions({
      meta: buildPlanMeta({
        totalKw: 5,
        softLimitKw: 4,
        headroomKw: -1}),
      devices: [buildPlanDevice({
        id: 'dev-1',
        name: 'Heater',
        currentState: 'off',
        plannedState: 'shed',
        boostActive: false,
        currentTarget: 21,
        currentTemperature: 21,
        plannedTarget: 21,
        binaryCapabilityId: 'onoff',
        reason: fixtureDeviceReason('shed due to capacity'),
      })],
    });

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', false);
  });
});
