import {
  describe, expect, it, vi,
} from 'vitest';
import { ObservedStateEmitter } from '../../lib/observer/observedStateEvents';
import type { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import type { PlanService } from '../../lib/plan/planService';
import { subscribePlanObservedState } from '../../setup/appInit/planObservedStateSubscription';
import { createAppContextMock } from '../helpers/appContextTestHelpers';

/**
 * Ordering pin. The plan-dependent observed-state listeners are registered by
 * their own startup step, AFTER `initPlanService`, precisely so a device event
 * can never reach an unwired plan service. Folding them back into
 * `initDeviceManager` reopens a window in which `syncLivePlanState` was dropped
 * and an EV-SoC rebuild intent would dereference `undefined`.
 */
const buildDeps = (planService: PlanService | undefined) => {
  const ctx = createAppContextMock({ planService });
  return {
    ctx,
    emitter: new ObservedStateEmitter(),
    planRebuildScheduler: { request: vi.fn() } as unknown as PlanRebuildScheduler,
    getSnapshotDevice: () => undefined,
    hasEnabledEvBoostForSnapshot: () => false,
    scheduleRealtimeDeviceReconcile: vi.fn(),
  };
};

describe('subscribePlanObservedState', () => {
  it('syncs live plan state for an observation once the plan service is wired', () => {
    const syncLivePlanState = vi.fn().mockResolvedValue(true);
    const deps = buildDeps({ syncLivePlanState } as unknown as PlanService);
    subscribePlanObservedState({ ...deps, getObservedStateEmitter: () => deps.emitter });

    deps.emitter.emitObservedStateChanged({ deviceId: 'heater-1', source: 'realtime_capability' });

    expect(syncLivePlanState).toHaveBeenCalledWith('realtime_capability');
  });

  it('routes a plan-reconcile observation to the reconcile scheduler', () => {
    const deps = buildDeps({ syncLivePlanState: vi.fn() } as unknown as PlanService);
    subscribePlanObservedState({ ...deps, getObservedStateEmitter: () => deps.emitter });

    deps.emitter.emitPlanReconcile({ deviceId: 'heater-1' });

    expect(deps.scheduleRealtimeDeviceReconcile).toHaveBeenCalledTimes(1);
  });

  // If this step is ever moved back before `initPlanService`, boot-time
  // observations fail loudly here instead of silently losing their sync.
  it('asserts when an observation arrives before the plan service is wired', () => {
    const deps = buildDeps(undefined);
    subscribePlanObservedState({ ...deps, getObservedStateEmitter: () => deps.emitter });

    expect(() => deps.emitter.emitObservedStateChanged({ deviceId: 'heater-1', source: 'realtime_capability' }))
      .toThrow('PlanService must be initialized before use.');
  });
});
