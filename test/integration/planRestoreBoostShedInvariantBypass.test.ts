/**
 * Regression for the boosted staircase observed in prod (2026-07-05): a
 * boosted water heater climbing low → medium → max was re-blocked by the
 * shed invariant at every rung because the freshly-entered step had no
 * accepted calibration samples yet, costing ~5 minutes per step.
 *
 * Contract under test: an ACTIVE boost bypasses the shed invariant while only
 * LOWER-priority devices are limited: it is the user's priority override over
 * the fairness rule toward devices ranked below it, and this layer asks no
 * further questions about it. A limited device ranked above it holds it at its
 * lowest active step like any other (owner ruling 2026-11-03: a boosted
 * priority-4 charger climbed to 12 A while priority-2 and -3 thermostats were
 * held). The draw evidence that
 * decides whether a boost stays active at all lives one layer up, in
 * `resolveBoostActive` (`test/unit/planBoost.test.ts`), and deliberately keeps
 * boosting while calibration has no confident idle verdict — which is exactly
 * the mid-climb rung this regression is about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { buildPlanCycleObject, cycleArgsFor, type PlanCycle, type PlanCycleSpec } from '../utils/planContextPowerFixture';
import type { PowerTrackerState } from '../../lib/power/tracker';
import {
  buildPlanDevice,
  steppedPlanDevice,
  applyRestorePlanForSpec,
} from '../utils/planTestUtils';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { testLogger } from '../utils/testLogger';

const buildContextFields = (overrides: PlanCycleSpec = {}): PlanCycle => buildPlanCycleObject({
  devices: [],
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
  ...overrides,
});

// Mirror the producer: unless a test pins the axes explicitly, the capacity
// axis tracks the fixture's binding headroom (capacity-bound home, no daily
// budget), so per-axis restore admission sees the same available power the
// binding scalar used to provide.
const buildContext = (overrides: PlanCycleSpec = {}): PlanCycle => buildContextFields(overrides);

describe('boost bypasses the shed invariant over lower-priority devices only', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-05T20:07:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const runScenario = (heaterPriority = 1, thermostatPriority = 5) => {
    const state = createPlanEngineState();
    return applyRestorePlanForSpec({
      planDevices: [
        steppedPlanDevice({
          id: 'water-heater',
          name: 'Connected 300',
          priority: heaterPriority,
          currentState: 'on',
          plannedState: 'keep',
          boostActive: true,
          selectedStepId: 'medium',
          desiredStepId: 'medium',
          // Drawing its rung: a boosted climb is priced from what is flowing.
          currentDrawKw: 2,
        }),
        // A shed device makes countShedDevices > 0, which is exactly the
        // condition that used to re-engage the invariant against boost.
        buildPlanDevice({
          id: 'shed-thermostat',
          name: 'Termostat gang',
          priority: thermostatPriority,
          currentState: 'off',
          plannedState: 'shed',
          boostActive: false,
          controllable: true,
          expectedPowerKw: 1,
        }),
      ],
      ...cycleArgsFor(buildContext()),
      state,
      sheddingActive: false,
      deps: {
        structuredLog: testLogger,
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        temperatureSetpoints: new Map(),
        getShedBehavior: () => ({ action: 'turn_off' as const }),
      },
    });
  };

  it('holds a boosted device at its step while a higher-priority device is limited', () => {
    // Prod 2026-11-02: the boosted charger (priority 4) stepped up past the
    // fairness rule while the priority-2 and -3 thermostats were held.
    const result = runScenario(5, 1);
    const heater = result.planDevices.find((d) => d.id === 'water-heater');
    expect(heater?.desiredStepId).toBe('medium');
    expect(heater?.reason).toMatchObject({ code: PLAN_REASON_CODES.shedInvariant, shedDeviceCount: 1 });
  });

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
    const result = applyRestorePlanForSpec({
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
      ...cycleArgsFor(buildContext()),
      state,
      sheddingActive: false,
      deps: {
        structuredLog: testLogger,
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        temperatureSetpoints: new Map(),
        getShedBehavior: () => ({ action: 'turn_off' as const }),
      },
    });
    const heater = result.planDevices.find((d) => d.id === 'water-heater');
    expect(heater?.reason?.code).toBe(PLAN_REASON_CODES.shedInvariant);
    expect(heater?.desiredStepId).not.toBe('max');
  });

  it('still holds an unboosted device at its step while others are limited', () => {
    const state = createPlanEngineState();
    const result = applyRestorePlanForSpec({
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
      ...cycleArgsFor(buildContext()),
      state,
      sheddingActive: false,
      deps: {
        structuredLog: testLogger,
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        temperatureSetpoints: new Map(),
        getShedBehavior: () => ({ action: 'turn_off' as const }),
      },
    });
    const heater = result.planDevices.find((d) => d.id === 'water-heater');
    expect(heater?.reason?.code).toBe(PLAN_REASON_CODES.shedInvariant);
    expect(heater?.desiredStepId).not.toBe('max');
  });
});
