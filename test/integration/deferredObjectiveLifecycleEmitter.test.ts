import { describe, it, expect, vi } from 'vitest';
import {
  DeferredObjectiveLifecycleEmitter,
  type DeferredObjectiveLifecycleEmitterDeps,
} from '../../lib/objectives/deferredObjectives/lifecycleEmitter';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { DeferredObjectiveSettingsV1 } from '../../lib/objectives/deferredObjectives/settings';
import type { DeferredObjectiveActivePlansV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';

const buildDeps = (
  overrides: Partial<DeferredObjectiveLifecycleEmitterDeps> = {},
): DeferredObjectiveLifecycleEmitterDeps => ({
  getDeferredObjectiveSettings: () => ({ version: 1, objectivesByDeviceId: {} } as DeferredObjectiveSettingsV1),
  getTimeZone: () => 'UTC',
  getDevices: () => [],
  getPowerTracker: () => ({ lastTimestamp: Date.now() } as PowerTrackerState),
  getDailyBudgetSnapshot: () => null,
  getPriceOptimizationEnabled: () => false,
  getDeferredObjectiveActivePlans: () => null,
  getHardCapKw: () => 10,
  ...overrides,
});

describe('DeferredObjectiveLifecycleEmitter', () => {
  it('evaluates and forwards each tick to the plan-history recorder', () => {
    const observeDeferredObjectivePlanHistory = vi.fn();
    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      observeDeferredObjectivePlanHistory,
    }));

    emitter.tick(1_000_000_000_000);

    expect(observeDeferredObjectivePlanHistory).toHaveBeenCalledTimes(1);
    const [diagnostics, nowMs] = observeDeferredObjectivePlanHistory.mock.calls[0]!;
    expect(Array.isArray(diagnostics)).toBe(true);
    expect(nowMs).toBe(1_000_000_000_000);
  });

  it('reads the active-plan snapshot once per tick and forwards that same instance to observe', () => {
    const activePlans: DeferredObjectiveActivePlansV1 = { version: 1, plansByDeviceId: {} };
    const getDeferredObjectiveActivePlans = vi.fn(() => activePlans);
    const observeDeferredObjectivePlanHistory = vi.fn();
    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      getDeferredObjectiveActivePlans,
      observeDeferredObjectivePlanHistory,
    }));

    emitter.tick(1_000_000_000_000);

    // Exactly one recorder read per tick (shared by the diagnostics build and observe).
    expect(getDeferredObjectiveActivePlans).toHaveBeenCalledTimes(1);
    // The same snapshot instance reaches the observe callback (third positional arg).
    const observedActivePlans = observeDeferredObjectivePlanHistory.mock.calls[0]![2];
    expect(observedActivePlans).toBe(activePlans);
  });

  it('no-ops when no settings provider returns settings', () => {
    const observeDeferredObjectivePlanHistory = vi.fn();
    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      getDeferredObjectiveSettings: () => undefined,
      observeDeferredObjectivePlanHistory,
    }));

    emitter.tick(Date.now());

    expect(observeDeferredObjectivePlanHistory).not.toHaveBeenCalled();
  });

  it('forwards each tick to the active-plan recorder (the write rides the clock)', () => {
    const observeDeferredObjectiveActivePlans = vi.fn();
    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      observeDeferredObjectiveActivePlans,
    }));

    emitter.tick(1_000_000_000_000);

    expect(observeDeferredObjectiveActivePlans).toHaveBeenCalledTimes(1);
    const [diagnostics, nowMs] = observeDeferredObjectiveActivePlans.mock.calls[0]!;
    expect(Array.isArray(diagnostics)).toBe(true);
    expect(nowMs).toBe(1_000_000_000_000);
  });

  it('does not write active plans when no settings are returned', () => {
    const observeDeferredObjectiveActivePlans = vi.fn();
    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      getDeferredObjectiveSettings: () => undefined,
      observeDeferredObjectiveActivePlans,
    }));

    emitter.tick(Date.now());

    expect(observeDeferredObjectiveActivePlans).not.toHaveBeenCalled();
  });

  it('observes plan history before writing the active-plan commitment', () => {
    // The emitter reads the active-plan snapshot ONCE per tick and forwards it to
    // plan-history; the active-plan WRITE then mutates the recorder afterwards.
    // So history runs first and intentionally correlates against the pre-write
    // (previous-tick) commitment — a ≤30 s lag, immaterial for the history record.
    const order: string[] = [];
    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      observeDeferredObjectiveActivePlans: () => { order.push('active-plan'); },
      observeDeferredObjectivePlanHistory: () => { order.push('history'); },
    }));

    emitter.tick(1_000_000_000_000);

    expect(order).toEqual(['history', 'active-plan']);
  });
});
