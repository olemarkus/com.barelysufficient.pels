/**
 * Regression coverage for the boost-driven stepped-escalation gate.
 *
 * `canUseSwapForSteppedRestore` in `lib/plan/restore/steppedRestoreAdmission.ts`
 * honors `hasRecentObservedDraw` on the plan device: when calibration
 * confirms the device has not been drawing at any step recently, boost
 * cannot trigger a swap to a higher step — pausing a running lower-priority
 * device for a boosted device that isn't accepting load is pure loss. When
 * calibration has no opinion (`undefined`), the legacy bypass remains in
 * effect so newly-paired devices are not penalised during warm-up.
 *
 * The shed-invariant bypass is deliberately NOT gated on draw evidence —
 * boost overrides the fairness invariant unconditionally (see the staircase
 * regression in `planRestoreBoostShedInvariantBypass.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { applyRestorePlan } from '../../lib/plan/restore';
import type { PlanContext } from '../../lib/plan/planContext';
import type { PowerTrackerState } from '../../lib/power/tracker';
import {
  buildPlanDevice,
  steppedPlanDevice,
} from '../utils/planTestUtils';
import { createPlanEngineState } from '../../lib/plan/planState';

const buildContextFields = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  devices: [],
  desiredForMode: {},
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
  currentHourPriceLevel: { cheap: false, expensive: false },
  ...overrides,
} as PlanContext);

// Mirror the producer: unless a test pins the axes explicitly, the capacity
// axis tracks the fixture's binding headroom (capacity-bound home, no daily
// budget), so per-axis restore admission sees the same available power the
// binding scalar used to provide.
const buildContext = (overrides: Partial<PlanContext> = {}): PlanContext => {
  const base = buildContextFields(overrides);
  return {
    ...base,
    capacityHeadroomKw: overrides.capacityHeadroomKw ?? base.headroom,
    budgetHeadroomKw: overrides.budgetHeadroomKw ?? null,
  };
};

describe('boost-driven escalation honours hasRecentObservedDraw', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const buildScenario = (hasRecentObservedDraw: boolean | undefined) => {
    const state = createPlanEngineState();
    return applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'dev-step',
          name: 'Priority tank',
          priority: 1,
          currentState: 'on',
          plannedState: 'keep',
          selectedStepId: 'medium',
          desiredStepId: 'medium',
          temperatureBoostActive: true,
          ...(hasRecentObservedDraw !== undefined
            ? { hasRecentObservedDraw: hasRecentObservedDraw }
            : {}),
        }),
        buildPlanDevice({
          id: 'lower-priority',
          name: 'Lower priority heater',
          priority: 5,
          currentState: 'on',
          plannedState: 'keep',
          controllable: true,
          // `estimatePower` sets both for a declared load; only its
          // knows-nothing `default` arm leaves `expectedPowerKw` unset.
          measuredPowerKw: 2, expectedPowerKw: 2,
        }),
      ],
      context: buildContext({ headroomRaw: 0.8, headroom: 0.8 }),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        logDebug: vi.fn(),
      },
    });
  };

  it('keeps the legacy bypass when calibration has no opinion (undefined)', () => {
    const result = buildScenario(undefined);
    const steppedDev = result.planDevices.find((d) => d.id === 'dev-step');
    expect(steppedDev?.reason?.code).toBe(PLAN_REASON_CODES.swapPending);
  });

  it('keeps the bypass when calibration confirms recent draw at the current step', () => {
    const result = buildScenario(true);
    const steppedDev = result.planDevices.find((d) => d.id === 'dev-step');
    expect(steppedDev?.reason?.code).toBe(PLAN_REASON_CODES.swapPending);
  });

  it('blocks the swap when calibration says the device has not been drawing at any step', () => {
    const result = buildScenario(false);
    const steppedDev = result.planDevices.find((d) => d.id === 'dev-step');
    // With the gate engaged, the stepped device falls back to a plain
    // headroom rejection rather than acquiring a pending swap.
    expect(steppedDev?.reason?.code).not.toBe(PLAN_REASON_CODES.swapPending);
  });
});
