import {
  describe, expect, it, vi,
} from 'vitest';
import { ObservedStateEmitter } from '../../lib/observer/observedStateEvents';
import type { PlanService } from '../../lib/plan/planService';
import { subscribePlanObservedState } from '../../setup/appInit/planObservedStateSubscription';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { cleanupApps, createApp } from '../utils/appTestUtils';

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
    syncExternalOffHold: vi.fn(),
    invalidateRebuildSuppression: vi.fn(),
  };
};

describe('subscribePlanObservedState', () => {
  afterEach(async () => {
    await cleanupApps();
  });

  it('registers the production subscription only after the plan stack exists', async () => {
    const app = createApp();
    const callOrder: string[] = [];
    const runtime = app as unknown as {
      initPlanEngine: () => void;
      initPlanService: () => void;
      subscribePlanObservedState: () => void;
      serviceWiring: {
        runPlanStackStartupSteps: (onFailure: (label: string, error: Error) => void) => Promise<void>;
      };
    };
    runtime.initPlanEngine = () => { callOrder.push('engine'); };
    runtime.initPlanService = () => { callOrder.push('service'); };
    runtime.subscribePlanObservedState = () => { callOrder.push('subscription'); };

    await runtime.serviceWiring.runPlanStackStartupSteps(() => undefined);

    expect(callOrder).toEqual(['engine', 'service', 'subscription']);
  });

  it('syncs live plan state for an observation once the plan service is wired', () => {
    const syncLivePlanState = vi.fn().mockResolvedValue(true);
    const deps = buildDeps({ syncLivePlanState } as unknown as PlanService);
    subscribePlanObservedState({ ...deps, getObservedStateEmitter: () => deps.emitter });

    deps.emitter.emitObservedStateChanged({ deviceId: 'heater-1', source: 'realtime_capability' });

    expect(syncLivePlanState).toHaveBeenCalledWith('realtime_capability');
  });

  // The decisive pin for P0 #2: a control-state observation reaches the
  // external-off hold and the suppression latch, and NOTHING asks for a rebuild.
  // A capacity decision taken here would run against a whole-home reading that
  // never saw the device move.
  it('gives a control-state observation to the external-off hold, not to a rebuild', () => {
    const deps = buildDeps({ syncLivePlanState: vi.fn() } as unknown as PlanService);
    const rebuildPlanFromCache = vi.fn();
    deps.ctx.planService = { rebuildPlanFromCache } as unknown as PlanService;
    subscribePlanObservedState({ ...deps, getObservedStateEmitter: () => deps.emitter });

    deps.emitter.emitObservedControlStateChanged({ deviceId: 'heater-1' });

    expect(deps.syncExternalOffHold).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  // Named per DEVICE, not applied to a shared field: the invalidation has to
  // reach the home that owns the device, and only the caller knows which that
  // is. Routing is asserted in `owningHomeRouting.test.ts`.
  it('asks for the suppressions of the moved device\'s home to be cleared', () => {
    const deps = buildDeps({ syncLivePlanState: vi.fn() } as unknown as PlanService);
    deps.ctx.isCapacityControlEnabled = () => true;
    subscribePlanObservedState({ ...deps, getObservedStateEmitter: () => deps.emitter });

    deps.emitter.emitObservedControlStateChanged({ deviceId: 'heater-1' });

    expect(deps.invalidateRebuildSuppression).toHaveBeenCalledWith('heater-1');
  });

  it('leaves the suppressions alone for a device PELS does not control', () => {
    const deps = buildDeps({ syncLivePlanState: vi.fn() } as unknown as PlanService);
    deps.ctx.isCapacityControlEnabled = () => false;
    subscribePlanObservedState({ ...deps, getObservedStateEmitter: () => deps.emitter });

    deps.emitter.emitObservedControlStateChanged({ deviceId: 'heater-1' });

    expect(deps.invalidateRebuildSuppression).not.toHaveBeenCalled();
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
