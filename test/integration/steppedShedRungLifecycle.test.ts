/**
 * A `turn_off` stepped device left running at an intermediate rung, end to end.
 *
 * The state is new. Until the planner's chosen rung crossed into
 * materialization, a `turn_off` shed always ended with the device off, so
 * "shed AND still drawing" could not happen; the shed behaviour is a FLOOR now,
 * and the planner reaches it only when the deficit requires it. This spec walks
 * the two halves that state has to survive: the shed decision reaching the
 * device as a step, and the device climbing back out afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { buildSheddingPlan } from '../../lib/plan/shedding';
import { buildInitialPlanDevices } from '../../lib/plan/planDevices';
import { applyRestorePlan } from '../../lib/plan/restore';
import { resolvePlannedShedTargetKind } from '../../lib/plan/planActionMaterialization';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { planContextPower } from '../utils/planContextPowerFixture';
import { steppedInputDevice, steppedPlanDevice } from '../utils/planTestUtils';
import type CapacityGuard from '../../lib/power/capacityGuard';
import type { PlanContext } from '../../lib/plan/planContext';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { PriceLevel } from '../../lib/price/priceLevels';

const chargerProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: '6a', planningPowerW: 1380 },
    { id: '10a', planningPowerW: 2300 },
    { id: '16a', planningPowerW: 3680 },
    { id: '20a', planningPowerW: 4600 },
    { id: '24a', planningPowerW: 5520 },
    { id: '28a', planningPowerW: 6440 },
  ],
};

const buildContext = (overrides: Partial<PlanContext> & { total?: number | null } = {}): PlanContext => {
  const total = overrides.total ?? null;
  return {
    devices: [],
    modeTargetCFor: (d) => d.currentTarget,
    softLimit: 0,
    capacitySoftLimit: 0,
    dailySoftLimit: null,
    budgetPaceKw: null,
    projectedExemptKw: null,
    softLimitSource: 'capacity',
    budgetReleasableHeadroomHold: false,
    capacityHeadroomKw: 1,
    budgetHeadroomKw: null,
    hourBucketKey: '2026-08-17T12',
    budgetKWh: 0,
    usedKWh: 0,
    minutesRemaining: 60,
    headroomRaw: 0,
    headroom: 0,
    restoreMarginPlanning: 0.2,
    currentHourPriceLevel: PriceLevel.UNKNOWN,
    ...planContextPower(total),
    ...overrides,
  } as PlanContext;
};

describe('a turn_off stepped shed parked at an intermediate rung', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reaches the device as the rung the deficit was priced against, not as an off', async () => {
    // 3.77 kW open against a charger at 28a. `28a -> 24a` frees 0.92 kW and
    // cannot close it; `10a` frees 4.14 kW and does. Before the chosen rung
    // crossed the boundary, materialization answered the off step here — the
    // whole 6.44 kW cut for a 3.77 kW breach, and the credited rung inert.
    const state = createPlanEngineState();
    const charger = steppedInputDevice({
      id: 'charger',
      name: 'EV charger',
      steppedLoadProfile: chargerProfile,
      selectedStepId: '28a',
      currentDrawKw: 6.44,
      binaryControl: { on: true },
      controllable: true,
    });
    const context = buildContext({
      devices: [charger],
      total: 8.77,
      softLimit: 5,
      capacitySoftLimit: 5,
      headroomRaw: -3.77,
      headroom: -3.77,
    });
    const capacityGuard = {
      checkShortfall: vi.fn().mockResolvedValue(undefined),
      isInShortfall: vi.fn().mockReturnValue(false),
    } as unknown as CapacityGuard;
    const getShedBehavior = () => ({ action: 'turn_off' as const });

    const sheddingPlan = await buildSheddingPlan(context, state, {
      capacityGuard,
      shortfallThresholdKw: 10,
      powerTracker: { lastTimestamp: 900 } as PowerTrackerState,
      pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      getShedBehavior,
      log: vi.fn(),
    });

    expect(sheddingPlan.shedStepTargets.get('charger')).toBe('10a');

    const [planDevice] = buildInitialPlanDevices({
      context,
      state,
      shedSet: sheddingPlan.shedSet,
      shedReasons: sheddingPlan.shedReasons,
      shedStepTargets: sheddingPlan.shedStepTargets,
      guardInShortfall: false,
      deps: {
        getInferredSurplusKw: () => 0,
        getShedBehavior,
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      },
    });

    expect(planDevice.plannedState).toBe('shed');
    expect(planDevice.desiredStepId).toBe('10a');
    expect(planDevice.plannedShedStepId).toBe('10a');
    // And the end state the executor reads is a STEP, so nothing on the binary
    // axis is demanded: `turn_off` was the floor, not this cycle's decision.
    expect(resolvePlannedShedTargetKind(planDevice)).toBe('step');
  });

  it('climbs back up through the active-stepped lane once power is available', () => {
    // The device is running, just lower — so it never becomes an off device
    // waiting to be switched back on. It reaches restore through the ACTIVE
    // stepped lane (`isActiveSteppedRestoreCandidate`, which reads the step axis
    // rather than the binary one) and climbs a rung at a time.
    const state = createPlanEngineState();

    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'charger',
          name: 'EV charger',
          priority: 1,
          steppedLoadProfile: chargerProfile,
          currentState: 'on',
          plannedState: 'keep',
          boostActive: false,
          selectedStepId: '10a',
          desiredStepId: '10a',
          currentDrawKw: 2.3,
          expectedPowerKw: 2.3,
          binaryControl: { on: true },
          controllable: true,
        }),
      ],
      context: buildContext({
        total: 2.3,
        softLimit: 8,
        capacitySoftLimit: 8,
        headroomRaw: 5.7,
        headroom: 5.7,
        capacityHeadroomKw: 5.7,
      }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 900 } as PowerTrackerState,
        normalizedShedFloorCByDevice: new Map(),
        getShedBehavior: () => ({ action: 'turn_off' as const }),
        logDebug: vi.fn(),
      },
    });

    const charger = result.planDevices.find((device) => device.id === 'charger');
    expect(charger?.desiredStepId).toBe('16a');
    expect(charger?.reason?.code).toBe(PLAN_REASON_CODES.restoreNeed);
  });
});
