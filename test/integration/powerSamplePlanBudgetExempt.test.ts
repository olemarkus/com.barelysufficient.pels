// The plan cycle's budget exemptions reach the exempt kWh integral
// (`PowerSamplePipeline` → `recordPowerSampleForApp`). A smart task's "may go
// over daily budget" exempts its device on the plan only, and the daily
// threshold already treats it so; its measured energy must book as exempt too,
// or the task's kWh counts as used and squeezes the rest of the day.
import { createSampleIngestQueue } from '../../lib/power/sampleIngestQueue';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { describe, expect, it, vi } from 'vitest';
import { PowerSamplePipeline } from '../../setup/powerSamplePipeline';
import type { PlanEngine } from '../../lib/plan/planEngine';
import type { PlanService } from '../../lib/plan/planService';
import type { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import { PlanRebuildThrottle } from '../../lib/plan/rebuildScheduler/throttle';
import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';
import { OvershootIncident } from '../../lib/plan/overshootIncident';
import type { PublishedPlan } from '../../lib/plan/publishedPlan';
import { buildPlan } from '../utils/planConvergenceFixtures';
import { buildPlanDevice } from '../utils/planTestUtils';
import { deviceSurfacesFixtures } from '../utils/deviceSnapshotFixture';

const T0 = Date.parse('2026-07-27T10:00:00Z');
const HALF_HOUR_MS = 30 * 60_000;

const publishedExempting = (publishedAtMs: number): PublishedPlan => ({
  plan: buildPlan([buildPlanDevice({ id: 'dev-task', budgetExempt: true })]),
  publishedAtMs,
});

const buildPipeline = (
  published: PublishedPlan | null,
): { pipeline: PowerSamplePipeline; getTracker: () => PowerTrackerState } => {
  let powerTracker: PowerTrackerState = {};
  // The scheduler stub executes every accepted intent at once by calling back
  // into the throttle, so the ingest path settles like production.
  const scheduler = {
    request: vi.fn(() => {
      void throttle.execute();
      return 'queued' as const;
    }),
  } as unknown as PlanRebuildScheduler;
  const throttle: PlanRebuildThrottle = new PlanRebuildThrottle(
    {
      getScheduler: () => scheduler,
      getCapacityGuard: () => createTestCapacityGuard({ homeId: 'main' }),
      getNowMs: Date.now,
      rebuildPlanFromCache: async () => ({ actionChanged: false, appliedActions: false, failed: false }),
    },
  );
  const pipeline = new PowerSamplePipeline({
    createIngestQueue: (queueDeps) => createSampleIngestQueue(queueDeps),
    // Never called here: these samples carry no meter identity.
    noteResolvedHomeMeter: () => {},
    getPowerTracker: () => powerTracker,
    getCapacityGuard: () => createTestCapacityGuard({ homeId: 'main' }),
    getCapacitySettings: () => ({ capacityEnabled: true, gridImportLimitKw: null, limitKw: 12, marginKw: 0.5, periodMinutes: 60 }),
    getTimeZone: () => 'UTC',
    getPlanEngine: () => ({
      computeShortfallThreshold: () => 10,
      state: {
        actuation: { hasInFlight: () => false },
        pendingTargetCommands: {},
        pendingBinaryCommands: {},
        overshoot: new OvershootIncident(),
      },
      clearStartupRestoreStabilization: vi.fn(),
    } as unknown as PlanEngine),
    getPlanService: () => ({
      getLatestPlanSnapshot: () => null,
      getLatestPublishedPlan: () => published,
      rebuildPlanFromCache: vi.fn(async () => ({ failed: false })),
      computePhysicalPowerLimit: () => 9.5,
    } as unknown as PlanService),
    planRebuildThrottle: throttle,
    getDeviceSurfaces: () => deviceSurfacesFixtures([{
      available: true,
      id: 'dev-task',
      expectedPowerKw: 2,
      expectedPowerSource: 'default' as const,
      name: 'Water heater on a smart task',
      targets: [],
      measuredPowerKw: 2,
      budgetExempt: false,
    }]),
    getThermalDirection: () => 'heating',
    // Production's `savePowerTracker` calls `setPowerTracker`, so the next
    // `getPowerTracker()` sees the admitted sample. Discarding the write leaves
    // the tracker permanently unlatched — a state no admitted sample produces.
    savePowerTracker: (state) => { powerTracker = state; },
    getCoSampledGenerationW: () => undefined,
    getObservedGenerationSegments: () => [],
  });
  return { pipeline, getTracker: () => powerTracker };
};

describe('PowerSamplePipeline plan budget exemptions', () => {
  it('books a device the published plan exempts as exempt energy', async () => {
    const { pipeline, getTracker } = buildPipeline(publishedExempting(T0));
    await pipeline.recordPowerSample(2_000, T0);
    await pipeline.recordPowerSample(2_000, T0 + HALF_HOUR_MS);

    expect(getTracker().exemptBuckets?.[new Date(T0).toISOString()]).toBeCloseTo(1, 3);
  });

  it('books nothing as exempt from a plan published in an earlier hour', async () => {
    const { pipeline, getTracker } = buildPipeline(publishedExempting(T0 - 2 * HALF_HOUR_MS));
    await pipeline.recordPowerSample(2_000, T0);
    await pipeline.recordPowerSample(2_000, T0 + HALF_HOUR_MS);

    expect(getTracker().exemptBuckets?.[new Date(T0).toISOString()] ?? 0).toBe(0);
  });
});
