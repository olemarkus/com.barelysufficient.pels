/**
 * Regression for the boosted staircase observed in prod (2026-07-05): a
 * boosted water heater climbing low → medium → max was re-blocked by the
 * shed invariant at every rung because the freshly-entered step had no
 * accepted calibration samples yet, costing ~5 minutes per step.
 *
 * Contract under test: an ACTIVE boost bypasses the shed invariant
 * unconditionally — it is the user's priority override over the fairness rule,
 * and this layer asks no further questions about it. The draw evidence that
 * decides whether a boost stays active at all lives one layer up, in
 * `resolveBoostActive` (`test/unit/planBoost.test.ts`), and deliberately keeps
 * boosting while calibration has no confident idle verdict — which is exactly
 * the mid-climb rung this regression is about.
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
import { PriceLevel } from '../../lib/price/priceLevels';

const buildContextFields = (overrides: Partial<PlanContext> = {}): PlanContext => ({
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
  headroomRaw: 3,
  headroom: 3,
  restoreMarginPlanning: 0.2,
  currentHourPriceLevel: PriceLevel.UNKNOWN,
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

describe('boost bypasses the shed invariant unconditionally', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-05T20:07:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const runScenario = () => {
    const state = createPlanEngineState();
    return applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'water-heater',
          name: 'Connected 300',
          priority: 1,
          currentState: 'on',
          plannedState: 'keep',
          boostActive: true,
          selectedStepId: 'medium',
          desiredStepId: 'medium',
        }),
        // A shed device makes countShedDevices > 0, which is exactly the
        // condition that used to re-engage the invariant against boost.
        buildPlanDevice({
          id: 'shed-thermostat',
          name: 'Termostat gang',
          priority: 5,
          currentState: 'off',
          plannedState: 'shed',
          boostActive: false,
          controllable: true,
          expectedPowerKw: 1,
        }),
      ],
      context: buildContext(),
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

  it('escalates past the invariant while the boost is active (staircase case)', () => {
    const result = runScenario();
    const heater = result.planDevices.find((d) => d.id === 'water-heater');
    expect(heater?.reason?.code).not.toBe(PLAN_REASON_CODES.shedInvariant);
    expect(heater?.desiredStepId).toBe('max');
    expect(heater?.reason?.code).toBe(PLAN_REASON_CODES.restoreNeed);
  });

  it('applies the invariant to a device whose boost was released', () => {
    // The inverted half of the contract, stated rather than dropped. Before the
    // release moved upstream, a device with a CONFIDENT idle verdict still
    // bypassed the invariant here and the old spec asserted exactly that. It no
    // longer does — `resolveBoostActive` releases the boost, and an unboosted
    // device is subject to fairness like any other. Pinning it means a future
    // reader can see the reversal was chosen, not lost in a deletion.
    const state = createPlanEngineState();
    const result = applyRestorePlan({
      planDevices: [
        steppedPlanDevice({
          id: 'water-heater',
          name: 'Connected 300',
          priority: 1,
          currentState: 'on',
          plannedState: 'keep',
          boostActive: false,
          selectedStepId: 'medium',
          desiredStepId: 'medium',
        }),
        buildPlanDevice({
          id: 'shed-thermostat',
          name: 'Termostat gang',
          priority: 5,
          currentState: 'off',
          plannedState: 'shed',
          boostActive: false,
          controllable: true,
          expectedPowerKw: 1,
        }),
      ],
      context: buildContext(),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        normalizedShedFloorCByDevice: new Map(),
        getShedBehavior: () => ({ action: 'turn_off' as const }),
        logDebug: vi.fn(),
      },
    });
    const heater = result.planDevices.find((d) => d.id === 'water-heater');
    expect(heater?.reason?.code).toBe(PLAN_REASON_CODES.shedInvariant);
    expect(heater?.desiredStepId).not.toBe('max');
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
          boostActive: false,
          selectedStepId: 'medium',
          desiredStepId: 'medium',
        }),
        buildPlanDevice({
          id: 'shed-thermostat',
          name: 'Termostat gang',
          priority: 5,
          currentState: 'off',
          plannedState: 'shed',
          boostActive: false,
          controllable: true,
          expectedPowerKw: 1,
        }),
      ],
      context: buildContext(),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        normalizedShedFloorCByDevice: new Map(),
        getShedBehavior: () => ({ action: 'turn_off' as const }),
        logDebug: vi.fn(),
      },
    });
    const heater = result.planDevices.find((d) => d.id === 'water-heater');
    expect(heater?.reason?.code).toBe(PLAN_REASON_CODES.shedInvariant);
    expect(heater?.desiredStepId).not.toBe('max');
  });
});
