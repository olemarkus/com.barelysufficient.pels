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
import { partialDouble } from '../helpers/partialDouble';
import type { DeviceTransport } from '../../lib/device/deviceTransport';
import { drainPending } from '../utils/asyncDrain';
import type { AppContext } from '../../lib/app/appContext';
import type { PlanService } from '../../lib/plan/planService';

const okOutcome = {
  failed: false, isDryRun: false, gated: false, appliedActions: true, deviceApplyFailureCount: 0,
};

const buildCtx = (params: { lastTimestamp?: number; powerSource?: string } = {}) => {
  const rebuildPlanFromCache = vi.fn().mockResolvedValue(okOutcome);
  // The escalation spends its pass only on a warm snapshot and an open write
  // seam; the default scenario has both, so the pass lands.
  const gates = { snapshotWarm: true, actuationFenced: false };
  const ctx = createAppContextMock({
    planService: { rebuildPlanFromCache } as unknown as PlanService,
    deviceManager: partialDouble<DeviceTransport>({
      hasWarmSnapshot: () => gates.snapshotWarm,
    }),
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
  const install = (isTornDown: () => boolean = () => false): void => {
    installMainFreshnessEscalation(ctx, isTornDown, () => gates.actuationFenced);
  };
  return { ctx, rebuildPlanFromCache, gates, install };
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
    const { rebuildPlanFromCache, install } = buildCtx();
    install();

    // Well past the freshness threshold, well short of the shed timeout.
    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS - 60_000);
    await drainPending();

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('escalates exactly once at the shed timeout, not on every tick', async () => {
    const { rebuildPlanFromCache, install } = buildCtx();
    install();

    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 30_000);
    await drainPending();
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('freshness_heartbeat');

    // Many more ticks inside the same stale period must add nothing.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await drainPending();
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('keeps the pass owed while device writes fail — the block must not engage unshed', async () => {
    const { ctx, rebuildPlanFromCache, install } = buildCtx();
    // Every write throws (caught per-device by the executor): the build
    // "succeeds" but the fail-closed shed took no effect.
    rebuildPlanFromCache.mockResolvedValue({ ...okOutcome, deviceApplyFailureCount: 2 });
    install();

    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 90_000);
    await drainPending();
    // The pass is NOT latched: every tick retries (unlike the escalate-once
    // case above) and the block stays disengaged while load may still run.
    expect(rebuildPlanFromCache.mock.calls.length).toBeGreaterThan(1);
    expect(ctx.meterSilenceMonitor.isBlocked()).toBe(false);

    // Writes recover: the pass lands, latches, and the block engages.
    rebuildPlanFromCache.mockResolvedValue(okOutcome);
    await vi.advanceTimersByTimeAsync(60_000);
    await drainPending();
    expect(ctx.meterSilenceMonitor.isBlocked()).toBe(true);
  });

  it('escalates under power_source = flow too — the silence policy is source-agnostic', async () => {
    // Owner ruling 2026-08-31: a silent Flow and a dead meter are the same
    // absence. The Flow clock no longer owns any escalation.
    const { rebuildPlanFromCache, install } = buildCtx({ powerSource: 'flow' });
    install();

    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 60_000);
    await drainPending();

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('sheds once at the first tick for silence restored across a restart, then blocks', async () => {
    // Owner ruling 2026-09-02: the outage clock is the stamp, and a restart
    // does not reset it. A stamp already past the timeout at boot is owed its
    // pass exactly as a live silence is — no process-uptime grace.
    const { ctx, rebuildPlanFromCache, install } = buildCtx({
      lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS - 60_000,
    });
    install();

    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS);
    await drainPending();

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(ctx.meterSilenceMonitor.isBlocked()).toBe(true);
  });

  it('keeps the pass owed while no full device read has committed, then spends it once one has', async () => {
    // The boot fetch failed: the warmup gate released on `timeout` with an
    // empty snapshot. A pass run now would govern nothing, latch, and block
    // the devices the 5-minute poll then lands out of ever being shed.
    const { ctx, rebuildPlanFromCache, gates, install } = buildCtx({
      lastTimestamp: Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS - 60_000,
    });
    gates.snapshotWarm = false;
    install();

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await drainPending();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(ctx.meterSilenceMonitor.shouldRunShedPass()).toBe(true);
    expect(ctx.meterSilenceMonitor.isBlocked()).toBe(false);

    // The poll commits a full read: the next tick spends the pass.
    gates.snapshotWarm = true;
    await vi.advanceTimersByTimeAsync(60_000);
    await drainPending();
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(ctx.meterSilenceMonitor.isBlocked()).toBe(true);
  });

  it('keeps the pass owed while the write seam is fenced — a fenced write is not a shed', async () => {
    const { ctx, rebuildPlanFromCache, gates, install } = buildCtx();
    gates.actuationFenced = true;
    install();

    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 60_000);
    await drainPending();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(ctx.meterSilenceMonitor.shouldRunShedPass()).toBe(true);

    gates.actuationFenced = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await drainPending();
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(ctx.meterSilenceMonitor.isBlocked()).toBe(true);
  });

  it('does not latch a pass whose write seam closed during the rebuild', async () => {
    // The fence is open when the tick starts and closes while the rebuild is
    // in flight: every write answered `requested: false`, which the outcome
    // reports as neither a write nor a failure. Latching would engage the
    // block with load still running, so the pass stays owed.
    const { ctx, rebuildPlanFromCache, gates, install } = buildCtx();
    rebuildPlanFromCache.mockImplementation(async () => {
      gates.actuationFenced = true;
      return okOutcome;
    });
    install();

    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 60_000);
    await drainPending();
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(ctx.meterSilenceMonitor.shouldRunShedPass()).toBe(true);
    expect(ctx.meterSilenceMonitor.isBlocked()).toBe(false);

    // Seam reopens: the next tick spends the pass for real.
    gates.actuationFenced = false;
    rebuildPlanFromCache.mockResolvedValue(okOutcome);
    await vi.advanceTimersByTimeAsync(60_000);
    await drainPending();
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
    expect(ctx.meterSilenceMonitor.isBlocked()).toBe(true);
  });

  it('skips a home that has never sampled — there is no reading to have lost', async () => {
    const { ctx, rebuildPlanFromCache, install } = buildCtx();
    ctx.powerTracker = { ...ctx.powerTracker, lastTimestamp: undefined } as AppContext['powerTracker'];
    install();

    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 60_000);
    await drainPending();

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('does not escalate after teardown', async () => {
    const { rebuildPlanFromCache, install } = buildCtx();
    install(() => true);

    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 60_000);
    await drainPending();

    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });
});
