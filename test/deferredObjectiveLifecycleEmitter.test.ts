import { describe, it, expect, vi } from 'vitest';
import {
  DeferredObjectiveLifecycleEmitter,
  type DeferredObjectiveLifecycleEmitterDeps,
} from '../lib/objectives/deferredObjectives/lifecycleEmitter';
import type { PowerTrackerState } from '../lib/power/tracker';
import type { DeferredObjectiveSettingsV1 } from '../lib/objectives/deferredObjectives/settings';

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

  it('no-ops when no settings provider returns settings', () => {
    const observeDeferredObjectivePlanHistory = vi.fn();
    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      getDeferredObjectiveSettings: () => undefined,
      observeDeferredObjectivePlanHistory,
    }));

    emitter.tick(Date.now());

    expect(observeDeferredObjectivePlanHistory).not.toHaveBeenCalled();
  });
});
