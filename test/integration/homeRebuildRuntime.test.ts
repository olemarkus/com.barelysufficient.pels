import { afterEach, describe, expect, it, vi } from 'vitest';
import type CapacityGuard from '../../lib/power/capacityGuard';
import type { Logger } from '../../lib/logging/logger';
import { createHomeRebuildRuntime } from '../../lib/plan/rebuildScheduler/homeRebuildRuntime';
import type { PlanService } from '../../lib/plan/planService';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { partialDouble } from '../helpers/partialDouble';

/**
 * The composition, not the components: that the scheduler this factory returns
 * is actually wired to the telemetry observer and to this home's timer key.
 *
 * It is covered here rather than through `PelsApp` because the factory serves
 * both homes off one argument list — an app-level test would pin the main
 * home's wiring and leave a meter area's, which is the half that had none.
 *
 * Integration tier, not unit: requesting an intent arms a real `setTimeout`
 * through the registry, and reads the scheduler's own clock. Only the logger,
 * guard and plan service — the seams outside this layer — are doubled. Every
 * registry a test builds is cleared below, so no armed timer outlives its spec.
 */
const armedRegistries: TimerRegistry[] = [];

afterEach(() => {
  for (const registry of armedRegistries.splice(0)) registry.clearAll();
});
const buildRuntime = (overrides: { timers?: TimerRegistry; homeId?: 'main' | 'h_annex' } = {}) => {
  const debug = vi.fn();
  const child = vi.fn().mockReturnValue({ debug, error: vi.fn() });
  const timers = overrides.timers ?? new TimerRegistry();
  armedRegistries.push(timers);
  const runtime = createHomeRebuildRuntime(
    overrides.homeId ?? 'main',
    timers,
    (suffix) => (overrides.homeId === 'h_annex' ? `home:h_annex:${suffix}` : suffix),
    () => partialDouble<CapacityGuard>({}),
    () => partialDouble<PlanService>({
      rebuildPlanFromCache: vi.fn().mockResolvedValue(undefined),
    }),
    () => partialDouble<Logger>({ child: child as unknown as Logger['child'] }),
    () => true,
  );
  return { ...runtime, debug, timers };
};

describe('createHomeRebuildRuntime', () => {
  it('wires the scheduler to this home telemetry, naming the home on the record', () => {
    const { scheduler, debug } = buildRuntime({ homeId: 'h_annex' });

    // A second flow intent replaces the pending first — the one path that
    // reaches the observer without needing a real capacity guard.
    scheduler.request({ kind: 'flow', reason: 'flow_card' });
    scheduler.request({ kind: 'flow', reason: 'settings' });

    expect(debug).toHaveBeenCalledWith(expect.objectContaining({
      event: 'plan_rebuild_scheduler_intent_replaced',
      homeId: 'h_annex',
    }));
  });

  it('arms the scheduler timer under this home key, so its teardown can clear it', () => {
    const { scheduler, timers } = buildRuntime({ homeId: 'h_annex' });

    scheduler.request({ kind: 'flow', reason: 'flow_card' });

    expect(timers.has('home:h_annex:planRebuild')).toBe(true);
    expect(timers.has('planRebuild')).toBe(false);
  });

  it('gives a flow intent a due time, which the throttle alone never would', () => {
    const { scheduler } = buildRuntime();

    scheduler.request({ kind: 'flow', reason: 'flow_card' });

    // `throttle.dueAtMs` answers +Infinity for a flow intent; the runtime's
    // policy answers a finite coalesce window, so the intent is schedulable.
    expect(scheduler.now().pendingDueMs).toBeLessThan(Number.POSITIVE_INFINITY);
  });
});
