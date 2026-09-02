/**
 * Regression coverage for the boost-driven stepped-escalation swap.
 *
 * `canUseSwapForSteppedRestore` in `lib/plan/restore/steppedRestoreAdmission.ts`
 * reads `boostActive` and nothing else. Pausing a running lower-priority device
 * to feed a boosted device that is not accepting load would be pure loss, and
 * that used to be a second, swap-only draw-evidence gate here
 * (`hasRecentObservedDraw`). It is now the release inside `resolveBoostActive`
 * (`lib/plan/planBoost.ts`, pinned by `test/unit/planBoost.test.ts`): a device
 * confidently drawing nothing arrives with no boost at all, so the question is
 * answered once, upstream, for every consumer of the decision.
 *
 * What this file still guards is the restore layer's half — the swap happens
 * for a boosted device and not for an unboosted one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { applyRestorePlan } from '../../lib/plan/restore';
import { buildPlanCycleObject, cycleArgsFor, type PlanCycle, type PlanCycleSpec } from '../utils/planContextPowerFixture';
import type { PowerTrackerState } from '../../lib/power/tracker';
import {
  buildPlanDevice,
  steppedPlanDevice,
} from '../utils/planTestUtils';
import { createPlanEngineState } from '../../lib/plan/planState';
import { PriceLevel } from '../../lib/price/priceLevels';

const buildContextFields = (overrides: PlanCycleSpec = {}): PlanCycle => buildPlanCycleObject({
  devices: [],
  modeTargetCFor: (d) => d.currentTarget,
  total: 0,
  softLimit: 0,
  capacitySoftLimit: 0,
  dailySoftLimit: null,
  softLimitSource: 'capacity',
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  headroomRaw: 1,
  headroom: 1,
  restoreMarginPlanning: 0.2,
  currentHourPriceLevel: PriceLevel.UNKNOWN,
  ...overrides,
});

// Mirror the producer: unless a test pins the axes explicitly, the capacity
// axis tracks the fixture's binding headroom (capacity-bound home, no daily
// budget), so per-axis restore admission sees the same available power the
// binding scalar used to provide.
const buildContext = (overrides: PlanCycleSpec = {}): PlanCycle => buildContextFields(overrides);

describe('boost-driven escalation swaps on the boost decision alone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const buildScenario = (boostActive: boolean) => {
    const state = createPlanEngineState();
    return applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Priority tank',
          priority: 1,
          currentState: 'on',
          plannedState: 'keep',
          boostActive,
          selectedStepId: 'medium',
          desiredStepId: 'medium',
        }),
        buildPlanDevice({
          id: 'lower-priority',
          name: 'Lower priority heater',
          priority: 5,
          currentState: 'on',
          plannedState: 'keep',
          boostActive: false,
          controllable: true,
          // `estimatePower` sets both for a declared load; only its
          // knows-nothing `default` arm leaves `expectedPowerKw` unset.
          measuredPowerKw: 2, expectedPowerKw: 2,
        }),
      ],
      ...cycleArgsFor(buildContext({ headroomRaw: 0.8, headroom: 0.8 })),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        normalizedShedFloorCByDevice: new Map(),
        getShedBehavior: () => ({ action: 'turn_off' as const }),
        logDebug: vi.fn(),
      },
    });
  };

  it('swaps a lower-priority device out for a boosted climb', () => {
    const result = buildScenario(true);
    const steppedDev = result.planDevices.find((d) => d.id === 'dev-step');
    expect(steppedDev?.reason?.code).toBe(PLAN_REASON_CODES.swapPending);
  });

  it('does not swap for a device whose boost was released or never engaged', () => {
    // Released by `resolveBoostActive` — the idle-at-setpoint device that used
    // to be caught by this layer's own gate now simply arrives unboosted, and
    // falls back to a plain headroom rejection rather than acquiring a swap.
    const result = buildScenario(false);
    const steppedDev = result.planDevices.find((d) => d.id === 'dev-step');
    expect(steppedDev?.reason?.code).not.toBe(PLAN_REASON_CODES.swapPending);
  });
});
