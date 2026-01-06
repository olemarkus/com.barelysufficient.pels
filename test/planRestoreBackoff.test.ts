import type { PowerTrackerState } from '../lib/core/powerTracker';
import type { PlanContext } from '../lib/plan/planContext';
import { createPlanEngineState } from '../lib/plan/planState';
import { applyRestorePlan } from '../lib/plan/planRestore';

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
});

describe('restore cooldown backoff', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('backs off restore cooldown from 60 to 120, 240, then caps at 300 seconds', () => {
    const state = createPlanEngineState();
    let now = Date.UTC(2024, 0, 1, 0, 0, 0);

    const deps = {
      powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
      getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null }),
      log: jest.fn(),
      logDebug: jest.fn(),
    };

    const step = (advanceMs: number): number => {
      now += advanceMs;
      jest.setSystemTime(now);
      state.lastRestoreMs = now - 2 * 60 * 1000;
      state.lastOvershootMs = now - 1000;

      const result = applyRestorePlan({
        planDevices: [],
        context: buildContext(),
        state,
        sheddingActive: false,
        deps,
      });

      state.restoreCooldownMs = result.restoreCooldownMs;
      state.lastRestoreCooldownBumpMs = result.lastRestoreCooldownBumpMs;
      return result.restoreCooldownMs;
    };

    expect(step(0)).toBe(120000);
    expect(step(60000)).toBe(240000);
    expect(step(60000)).toBe(300000);
    expect(step(60000)).toBe(300000);
  });

  it('resets restore cooldown to base after sustained stability', () => {
    const state = createPlanEngineState();
    let now = Date.UTC(2024, 0, 1, 0, 0, 0);

    const deps = {
      powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
      getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null }),
      log: jest.fn(),
      logDebug: jest.fn(),
    };

    const triggerInstability = (): void => {
      state.lastRestoreMs = now - 2 * 60 * 1000;
      state.lastOvershootMs = now - 1000;
    };

    triggerInstability();
    jest.setSystemTime(now);
    let result = applyRestorePlan({
      planDevices: [],
      context: buildContext(),
      state,
      sheddingActive: false,
      deps,
    });

    state.restoreCooldownMs = result.restoreCooldownMs;
    state.lastRestoreCooldownBumpMs = result.lastRestoreCooldownBumpMs;
    expect(result.restoreCooldownMs).toBe(120000);

    now += 6 * 60 * 1000;
    state.lastOvershootMs = now - 6 * 60 * 1000;
    jest.setSystemTime(now);
    result = applyRestorePlan({
      planDevices: [],
      context: buildContext(),
      state,
      sheddingActive: false,
      deps,
    });

    expect(result.restoreCooldownMs).toBe(60000);
  });
});
