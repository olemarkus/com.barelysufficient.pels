/**
 * Main's silent-meter escalation.
 *
 * Sub-homes have had this since R7b P1#4; main never did, and it did not show
 * because device chatter used to drive a rebuild often enough that a dead meter
 * still escalated. Now that a whole-home reading is the primary rebuild trigger
 * (`lib/plan/planRebuildTrigger.ts`), the meter dying takes the trigger with it —
 * so without this clock main would hold its last "under cap" decision forever.
 *
 * The rule it pins: **nothing at all until the shed timeout, then exactly once.**
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMainFreshnessEscalation } from '../../setup/appMainFreshnessEscalation';
import { POWER_SAMPLE_STALE_SHED_TIMEOUT_MS } from '../../lib/power/sampleFreshness';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { drainPending } from '../utils/asyncDrain';
import type { AppContext } from '../../lib/app/appContext';
import type { PlanService } from '../../lib/plan/planService';

const okOutcome = { failed: false, isDryRun: false, gated: false, appliedActions: true };

const buildCtx = (params: { lastTimestamp?: number; powerSource?: string } = {}) => {
  const rebuildPlanFromCache = vi.fn().mockResolvedValue(okOutcome);
  const ctx = createAppContextMock({
    planService: { rebuildPlanFromCache } as unknown as PlanService,
  });
  // The mock's `set` does not feed its `get`, and `requireConfiguredPowerSource`
  // classifies an empty key list as a SUSPECT read (not a default), so both halves
  // have to be stubbed or the source reads as unreadable and nothing escalates.
  const powerSource = params.powerSource ?? 'homey_energy';
  ctx.homey.settings.get = vi.fn((key: string) => (key === 'power_source' ? powerSource : null));
  ctx.homey.settings.getKeys = vi.fn(() => ['power_source']);
  ctx.powerTracker = {
    ...ctx.powerTracker,
    lastTimestamp: params.lastTimestamp ?? Date.now(),
  } as AppContext['powerTracker'];
  return { ctx, rebuildPlanFromCache };
};

describe('main silent-meter escalation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('asks for nothing while the meter is merely quiet', async () => {
    const { ctx, rebuildPlanFromCache } = buildCtx();
    installMainFreshnessEscalation(ctx, () => false);

    // Well past the freshness threshold, well short of the shed timeout.
    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS - 60_000);
    await drainPending();

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('escalates exactly once at the shed timeout, not on every tick', async () => {
    const { ctx, rebuildPlanFromCache } = buildCtx();
    installMainFreshnessEscalation(ctx, () => false);

    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 30_000);
    await drainPending();
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('freshness_heartbeat');

    // Many more ticks inside the same stale period must add nothing.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await drainPending();
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('suspends under power_source = flow, where the Flow clock owns the escalation', async () => {
    const { ctx, rebuildPlanFromCache } = buildCtx({ powerSource: 'flow' });
    installMainFreshnessEscalation(ctx, () => false);

    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 60_000);
    await drainPending();

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('skips a home that has never sampled — there is no reading to have lost', async () => {
    const { ctx, rebuildPlanFromCache } = buildCtx();
    ctx.powerTracker = { ...ctx.powerTracker, lastTimestamp: undefined } as AppContext['powerTracker'];
    installMainFreshnessEscalation(ctx, () => false);

    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 60_000);
    await drainPending();

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('does not escalate after teardown', async () => {
    const { ctx, rebuildPlanFromCache } = buildCtx();
    installMainFreshnessEscalation(ctx, () => true);

    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 60_000);
    await drainPending();

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });
});
