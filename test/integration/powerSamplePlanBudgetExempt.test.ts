import { EnergyAccounting } from '../../lib/power/energyAccounting';
import { buildBucketUsageSplit } from '../../lib/dailyBudget/dailyBudgetLearning';
import { buildObservedHourlyStatsFromWindow } from '../../lib/dailyBudget/dailyBudgetObservedStats';
// The task owner supplies effective exemptions directly to measured accounting;
// publication of a planner snapshot is not an accounting precondition.
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
  taskExemptDeviceIds: ReadonlySet<string>,
  controllable = true,
  measuredPowerKw = 2,
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
      getWallClockMs: Date.now,
      rebuildPlanFromCache: async () => ({ actionChanged: false, appliedActions: false, failed: false }),
    },
  );
  const pipeline = new PowerSamplePipeline({
    ingestQueue: createSampleIngestQueue(),
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
    readTaskBudgetExemptDeviceIds: () => taskExemptDeviceIds,
    getDeviceSurfaces: () => deviceSurfacesFixtures([{
      available: true,
      id: 'dev-task',
      expectedPowerKw: 2,
      expectedPowerSource: 'default' as const,
      name: 'Water heater on a smart task',
      targets: [],
      measuredPowerKw,
      controllable,
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

describe('PowerSamplePipeline task budget exemptions', () => {
  it('books the task owner exemption without a published plan', async () => {
    const { pipeline, getTracker } = buildPipeline(null, new Set(['dev-task']));
    await pipeline.recordPowerSample(2_000, T0);
    await pipeline.recordPowerSample(2_000, T0 + HALF_HOUR_MS);

    expect(getTracker().exemptBuckets?.[new Date(T0).toISOString()]).toBeCloseTo(1, 3);
  });

  it('ignores a published exemption that the task owner no longer holds', async () => {
    const { pipeline, getTracker } = buildPipeline(publishedExempting(T0), new Set());
    await pipeline.recordPowerSample(2_000, T0);
    await pipeline.recordPowerSample(2_000, T0 + HALF_HOUR_MS);

    expect(getTracker().exemptBuckets?.[new Date(T0).toISOString()] ?? 0).toBe(0);
  });
});

it('paces a capacity-off charger as exempt and learns it as background', async () => {
  const { pipeline, getTracker } = buildPipeline(null, new Set(['dev-task']), false, 3.06);
  await pipeline.recordPowerSample(4_400, T0);
  await pipeline.recordPowerSample(4_400, T0 + 60 * 60_000);
  const tracker = getTracker();
  const key = new Date(T0).toISOString();
  expect(tracker.controlledBuckets?.[key]).toBe(0);
  expect(tracker.uncontrolledBuckets?.[key]).toBeCloseTo(4.4);
  expect(tracker.exemptBuckets?.[key]).toBeCloseTo(3.06);
  expect(tracker.uncontrolledExemptBuckets?.[key]).toBeCloseTo(3.06);
  expect(new EnergyAccounting(tracker).bucket(key).budgetCountedKwh).toBeCloseTo(1.34);
  const learned = buildBucketUsageSplit({ bucketStartUtcMs: [T0], powerTracker: tracker });
  expect(learned.bucketUsageControlled).toEqual([0]);
  expect(learned.bucketUsageUncontrolled[0]).toBeCloseTo(4.4);
  const { stats } = buildObservedHourlyStatsFromWindow({
    powerTracker: tracker, timeZone: 'UTC', windowStartUtcMs: T0, windowEndUtcMs: T0 + 60 * 60_000,
  });
  expect(stats.profileObservedMaxUncontrolledKWh[10]).toBeCloseTo(4.4);
  expect(stats.profileObservedP50GrossUncontrolledKWh[10]).toBeCloseTo(4.4);
});
