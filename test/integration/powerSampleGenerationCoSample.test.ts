// The co-sampled-generation contract of the admitted ingest seam
// (`PowerSamplePipeline`).
//
// A sample's OWN generation was read from the same energy report as its net, so
// the two are co-temporal by construction. A CO-SAMPLED one was not: it comes
// from the observer's held reading, which on the flow source is refreshed by a
// separate poll and can be up to `POWER_SAMPLE_STALE_THRESHOLD_MS` older than
// the net beside it.
//
// Accounting consumers (the generation buckets, the gross-consumption split, the
// PV forecast trainer) accept either. The curtailment-surplus estimator does
// NOT: its `CURTAIL_SAMPLE_FRESH_MS` (45 s) guarantee is timestamped from the
// net clock, which is only sound while the pair travels together — a co-sampled
// reading would silently stretch it to ~105 s, and a stale-LOW generation value
// inflates the inferred surplus into real grid import. So it stays dormant on
// sources that cannot deliver the pair together, and arming it there needs the
// generation's own clock carried into `recordSample` first.
import { createSampleIngestQueue } from '../../lib/power/sampleIngestQueue';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { describe, expect, it, vi } from 'vitest';
import { PowerSamplePipeline } from '../../setup/powerSamplePipeline';
import type { PlanEngine } from '../../lib/plan/planEngine';
import type { PlanService } from '../../lib/plan/planService';
import type { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';

const T0 = Date.parse('2026-07-27T10:00:00Z');

type Taps = {
  curtailment: ReturnType<typeof vi.fn<(netW: number, generationW: number | undefined, nowMs: number) => void>>;
  pvForecast: ReturnType<typeof vi.fn<(generationW: number | undefined, nowMs: number, netW?: number) => void>>;
};

const buildPipeline = (coSampledGenerationW?: number): { pipeline: PowerSamplePipeline; taps: Taps } => {
  const powerTracker: PowerTrackerState = {};
  let rebuildState: { lastMs: number; lastRebuildPowerW: number; pendingResolve?: (r?: string) => void } = {
    lastMs: 0,
    lastRebuildPowerW: 0,
  };
  const taps: Taps = {
    curtailment: vi.fn<(netW: number, generationW: number | undefined, nowMs: number) => void>(),
    pvForecast: vi.fn<(generationW: number | undefined, nowMs: number, netW?: number) => void>(),
  };
  const pipeline = new PowerSamplePipeline({
    createIngestQueue: (queueDeps) => createSampleIngestQueue(queueDeps),
    getPowerTracker: () => powerTracker,
    getCapacityGuard: () => createTestCapacityGuard({ homeId: 'main' }),
    getCapacitySettings: () => ({ limitKw: 12, marginKw: 0.5 }),
    getPlanEngine: () => ({
      state: {
        pendingSheds: new Set<string>(),
        pendingRestores: new Set<string>(),
        pendingTargetCommands: {},
        pendingBinaryCommands: {},
        wasOvershoot: false,
      },
      clearStartupRestoreStabilization: vi.fn(),
    } as unknown as PlanEngine),
    getPlanService: () => ({
      getLatestPlanSnapshot: () => null,
      getLatestPlanSnapshotUpdatedAtMs: () => null,
      rebuildPlanFromCache: vi.fn(async () => ({ failed: false })),
      computeDynamicSoftLimit: () => 9.5,
    } as unknown as PlanService),
    getDeviceManager: () => undefined,
    planRebuildScheduler: {
      request: vi.fn(() => {
        rebuildState.pendingResolve?.('executed');
        return { status: 'accepted' };
      }),
    } as unknown as PlanRebuildScheduler,
    getPowerSampleRebuildState: () => rebuildState,
    setPowerSampleRebuildState: (state) => { rebuildState = state as typeof rebuildState; },
    getLatestTargetSnapshot: () => [],
    getPlanRebuildNowMs: () => Date.now(),
    savePowerTracker: () => undefined,
    getStructuredDebugEmitter: () => vi.fn(),
    recordCurtailmentSample: taps.curtailment,
    recordPvGenerationSample: taps.pvForecast,
    ...(coSampledGenerationW === undefined ? {} : { getCoSampledGenerationW: () => coSampledGenerationW }),
  });
  return { pipeline, taps };
};

describe('PowerSamplePipeline generation co-sampling', () => {
  it("passes a sample's OWN generation to the curtailment estimator", async () => {
    // Read from the same report as the net, so the estimator's net-clock
    // freshness stamp is sound.
    const { pipeline, taps } = buildPipeline();
    await pipeline.recordPowerSample(-1_500, T0, { generationW: 7_000 });

    expect(taps.curtailment).toHaveBeenCalledWith(-1_500, 7_000, T0);
    expect(taps.pvForecast).toHaveBeenCalledWith(7_000, T0, -1_500);
  });

  it('withholds a CO-SAMPLED generation from the curtailment estimator, but not from accounting', async () => {
    // The Flow-source shape: net from the card, generation from the observer's
    // held reading. Accounting gets it (the Solar card's Produced figure and the
    // gross-consumption split depend on it); the estimator does not, so it stays
    // dormant rather than running its 45 s contract on a value that may be 60 s
    // old.
    const { pipeline, taps } = buildPipeline(7_000);
    await pipeline.recordPowerSample(-1_500, T0);

    expect(taps.curtailment).toHaveBeenCalledWith(-1_500, undefined, T0);
    expect(taps.pvForecast).toHaveBeenCalledWith(7_000, T0, -1_500);
  });

  it('reports no generation at all when nothing fresh is held', async () => {
    const { pipeline, taps } = buildPipeline();
    await pipeline.recordPowerSample(-1_500, T0);

    expect(taps.curtailment).toHaveBeenCalledWith(-1_500, undefined, T0);
    expect(taps.pvForecast).toHaveBeenCalledWith(undefined, T0, -1_500);
  });

  it("prefers a sample's own generation over the held reading", async () => {
    // Both present: the co-temporal one wins, and it is NOT treated as
    // co-sampled, so the estimator still receives it.
    const { pipeline, taps } = buildPipeline(1_000);
    await pipeline.recordPowerSample(-1_500, T0, { generationW: 7_000 });

    expect(taps.curtailment).toHaveBeenCalledWith(-1_500, 7_000, T0);
  });

  it('falls back to the held reading when the sample carries a NEGATIVE one', async () => {
    // Production is `+`-only at every producer, so a negative own-reading is
    // malformed, not "exporting". Flooring it to 0 would fabricate a
    // zero-production observation AND suppress a perfectly good fallback.
    const { pipeline, taps } = buildPipeline(7_000);
    await pipeline.recordPowerSample(-1_500, T0, { generationW: -250 });

    expect(taps.curtailment).toHaveBeenCalledWith(-1_500, undefined, T0);
    expect(taps.pvForecast).toHaveBeenCalledWith(7_000, T0, -1_500);
  });

  it('falls back to the held reading when the sample carries a non-finite one', async () => {
    // Finiteness gates the SELECTION: junk must not block the fallback and leave
    // the sample with no generation at all. The fallback is still co-sampled, so
    // the estimator declines it.
    const { pipeline, taps } = buildPipeline(7_000);
    await pipeline.recordPowerSample(-1_500, T0, { generationW: Number.NaN });

    expect(taps.curtailment).toHaveBeenCalledWith(-1_500, undefined, T0);
    expect(taps.pvForecast).toHaveBeenCalledWith(7_000, T0, -1_500);
  });
});
