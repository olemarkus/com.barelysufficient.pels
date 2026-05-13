/**
 * Regression coverage for the boost-driven stepped-escalation gate.
 *
 * `blockSteppedRestoreForShedInvariant` / `canUseSwapForSteppedRestore` in
 * `lib/plan/planRestoreHelpers.ts` honor `hasRecentObservedDrawAtSelectedStep`
 * on the plan device: when calibration confirms the device is *not* currently
 * drawing at its selected step, boost cannot bypass the shed invariant or
 * trigger a swap to a higher step. When calibration has no opinion
 * (`undefined`), the legacy bypass remains in effect so newly-paired devices
 * are not penalised during warm-up.
 *
 * Closes TODO §"Gate boost-driven stepped escalation on recent observed draw
 * at the current step."
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_REASON_CODES } from '../packages/shared-domain/src/planReasonSemantics';
import { applyRestorePlan } from '../lib/plan/planRestore';
import type { PlanContext } from '../lib/plan/planContext';
import type { PowerTrackerState } from '../lib/core/powerTracker';
import {
  buildPlanDevice,
  steppedPlanDevice,
} from './utils/planTestUtils';
import { createPlanEngineState } from '../lib/plan/planState';

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
  headroomRaw: 1,
  headroom: 1,
  restoreMarginPlanning: 0.2,
  ...overrides,
} as PlanContext);

describe('boost-driven escalation honours hasRecentObservedDrawAtSelectedStep', () => {
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
            ? { hasRecentObservedDrawAtSelectedStep: hasRecentObservedDraw }
            : {}),
        }),
        buildPlanDevice({
          id: 'lower-priority',
          name: 'Lower priority heater',
          priority: 5,
          currentState: 'on',
          plannedState: 'keep',
          controllable: true,
          powerKw: 2,
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

  it('blocks the bypass when calibration says the device is idle at its current step', () => {
    const result = buildScenario(false);
    const steppedDev = result.planDevices.find((d) => d.id === 'dev-step');
    // With the gate engaged, the stepped device falls back to the
    // shed-invariant rejection rather than acquiring a pending swap.
    expect(steppedDev?.reason?.code).not.toBe(PLAN_REASON_CODES.swapPending);
  });
});
