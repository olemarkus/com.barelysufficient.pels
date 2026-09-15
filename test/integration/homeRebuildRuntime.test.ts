import { afterEach, describe, expect, it, vi } from 'vitest';
import type CapacityGuard from '../../lib/power/capacityGuard';
import type { Logger } from '../../lib/logging/logger';
import { createHomeRebuildRuntime } from '../../lib/plan/rebuildScheduler/homeRebuildRuntime';
import type { PlanService } from '../../lib/plan/planService';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { partialDouble } from '../helpers/partialDouble';
import { unchangedRebuildOutcome } from '../helpers/powerRebuildScheduler';
import type { RebuildOutcome } from '../../lib/plan/rebuildScheduler/policy';

/**
 * The composition, not the components: that the scheduler this factory returns
 * is actually wired to the telemetry observer and to this home's timer key.
 *
 * It is covered here rather than through `PelsApp` because the factory serves
 * both homes off one argument list — an app-level test would pin the main
 * home's wiring and leave a meter area's, which is the half that had none.
 *
 * Integration tier, not unit: a queued rebuild arms a real `setTimeout`
 * through the registry, and reads the scheduler's own clock. Only the logger,
 * guard and plan service — the seams outside this layer — are doubled. Every
 * registry a test builds is cleared below, so no armed timer outlives its spec.
 */
const armedRegistries: TimerRegistry[] = [];

afterEach(() => {
  for (const registry of armedRegistries.splice(0)) registry.clearAll();
});
const buildRuntime = (overrides: { homeId?: 'main' | 'h_annex'; rebuild?: () => Promise<RebuildOutcome> } = {}) => {
  // The throttle reads only the `RebuildOutcome` slice of the service's outcome.
  const rebuildPlanFromCache = (overrides.rebuild ?? (async () => unchangedRebuildOutcome())) as unknown as
    PlanService['rebuildPlanFromCache'];
  const debug = vi.fn();
  const child = vi.fn().mockReturnValue({ debug, error: vi.fn() });
  const timers = new TimerRegistry();
  armedRegistries.push(timers);
  const runtime = createHomeRebuildRuntime(
    overrides.homeId ?? 'main',
    timers,
    (suffix) => (overrides.homeId === 'h_annex' ? `home:h_annex:${suffix}` : suffix),
    () => partialDouble<CapacityGuard>({ isInShortfall: () => false, recordReading: async () => undefined }),
    () => partialDouble<PlanService>({ rebuildPlanFromCache }),
    () => partialDouble<Logger>({ child: child as unknown as Logger['child'] }),
    () => true,
  );
  return { ...runtime, debug, timers };
};

const CALM_POSTURE = { planConvergenceActive: false, unactionable: false, shortfallUnrecoverable: false };

/** A whole-home reading against a 10 kW limit; tight once it passes 9 kW. */
const reading = (currentPowerW: number, shortfallThresholdKw = 20) => ({
  currentPowerW,
  totalKw: currentPowerW / 1000,
  limitKw: 10,
  capacityPaceKw: 9,
  shortfallThresholdKw,
});

describe('createHomeRebuildRuntime', () => {
  it('wires the scheduler to this home telemetry, naming the home on the record', () => {
    // The first rebuild never finishes, so the next two readings queue behind it
    // and the breach replaces the tight signal: the one path that reaches the
    // replacement record.
    const { throttle, debug } = buildRuntime({ homeId: 'h_annex', rebuild: () => new Promise(() => undefined) });

    void throttle.onSample(reading(5_000), CALM_POSTURE);
    void throttle.onSample(reading(9_500), CALM_POSTURE);
    void throttle.onSample(reading(9_600, 9.2), CALM_POSTURE);

    expect(debug).toHaveBeenCalledWith(expect.objectContaining({
      event: 'plan_rebuild_scheduler_intent_replaced',
      homeId: 'h_annex',
      previousKind: 'signal',
      nextKind: 'hardCap',
    }));
  });

  it('arms the scheduler timer under this home key, so its teardown can clear it', async () => {
    const { throttle, timers } = buildRuntime({ homeId: 'h_annex' });

    await throttle.onSample(reading(5_000), CALM_POSTURE);
    // Tight inside the 2 s min interval: queued on a timer.
    void throttle.onSample(reading(9_500), CALM_POSTURE);

    expect(timers.has('home:h_annex:planRebuild')).toBe(true);
    expect(timers.has('planRebuild')).toBe(false);
  });
});
