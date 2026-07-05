/**
 * Regression for the boosted staircase observed in prod (2026-07-05): a
 * boosted water heater climbing low → medium → max was re-blocked by the
 * shed invariant at every rung because the freshly-entered step had no
 * accepted calibration samples yet, costing ~5 minutes per step.
 *
 * Contract under test: boost bypasses the shed invariant UNCONDITIONALLY —
 * it is the user's priority override over the fairness rule, and must not
 * be gated on draw evidence (`hasRecentObservedDraw`). Even a confident
 * "idle" verdict only blocks the swap path (see
 * `planRestoreBoostObservedDrawGate.test.ts`); per-rung headroom admission,
 * the stepped attempt-hold, and per-device restore timing bound a
 * wrongly-escalated idle device.
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

const buildContext = (overrides: Partial<PlanContext> = {}): PlanContext => ({
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
  headroomRaw: 3,
  headroom: 3,
  restoreMarginPlanning: 0.2,
  ...overrides,
} as PlanContext);

describe('boost bypasses the shed invariant unconditionally', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-05T20:07:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const runScenario = (hasRecentObservedDraw: boolean | undefined) => {
    const state = createPlanEngineState();
    return applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'water-heater',
          name: 'Connected 300',
          priority: 1,
          currentState: 'on',
          plannedState: 'keep',
          selectedStepId: 'medium',
          desiredStepId: 'medium',
          temperatureBoostActive: true,
          ...(hasRecentObservedDraw !== undefined
            ? { hasRecentObservedDraw }
            : {}),
        }),
        // A shed device makes countShedDevices > 0, which is exactly the
        // condition that used to re-engage the invariant against boost.
        buildPlanDevice({
          id: 'shed-thermostat',
          name: 'Termostat gang',
          priority: 5,
          currentState: 'off',
          plannedState: 'shed',
          controllable: true,
          powerKw: 1,
        }),
      ],
      context: buildContext(),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        logDebug: vi.fn(),
      },
    });
  };

  it('escalates past the invariant even when draw evidence at the new step is missing (staircase case)', () => {
    const result = runScenario(false);
    const heater = result.planDevices.find((d) => d.id === 'water-heater');
    expect(heater?.reason?.code).not.toBe(PLAN_REASON_CODES.shedInvariant);
    expect(heater?.desiredStepId).toBe('max');
    expect(heater?.reason?.code).toBe(PLAN_REASON_CODES.restoreNeed);
  });

  it('escalates past the invariant when calibration has no opinion', () => {
    const result = runScenario(undefined);
    const heater = result.planDevices.find((d) => d.id === 'water-heater');
    expect(heater?.reason?.code).not.toBe(PLAN_REASON_CODES.shedInvariant);
    expect(heater?.desiredStepId).toBe('max');
  });

  it('still holds an unboosted device at its step while others are limited', () => {
    const state = createPlanEngineState();
    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'water-heater',
          name: 'Connected 300',
          priority: 1,
          currentState: 'on',
          plannedState: 'keep',
          selectedStepId: 'medium',
          desiredStepId: 'medium',
        }),
        buildPlanDevice({
          id: 'shed-thermostat',
          name: 'Termostat gang',
          priority: 5,
          currentState: 'off',
          plannedState: 'shed',
          controllable: true,
          powerKw: 1,
        }),
      ],
      context: buildContext(),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
        logDebug: vi.fn(),
      },
    });
    const heater = result.planDevices.find((d) => d.id === 'water-heater');
    expect(heater?.reason?.code).toBe(PLAN_REASON_CODES.shedInvariant);
    expect(heater?.desiredStepId).not.toBe('max');
  });
});
