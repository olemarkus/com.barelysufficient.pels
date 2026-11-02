// A smart task's budget exemptions reach the exempt kWh integral
// (`PowerSamplePipeline` → `recordPowerSampleForApp`), read from the claims'
// owner (`readTaskBudgetExemptDeviceIds`). A smart task's "may go over daily
// budget" exempts its device for the hour, and the daily threshold already
// treats it so; its measured energy must book as exempt too, or the task's kWh
// counts as used and squeezes the rest of the hour.
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
import { deviceSurfacesFixtures } from '../utils/deviceSnapshotFixture';

const T0 = Date.parse('2026-07-27T10:00:00Z');
const HALF_HOUR_MS = 30 * 60_000;

const buildPipeline = (
  claims: ReadonlySet<string>,
  /** The device's Power-limit control: off books its draw as background usage. */
  controllable: boolean,
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
      getLatestPublishedPlan: () => null,
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
      controllable,
      budgetExempt: false,
    }]),
    readTaskBudgetExemptDeviceIds: () => claims,
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

describe('PowerSamplePipeline smart-task budget exemptions', () => {
  const hourKey = new Date(T0).toISOString();

  it('books a device a smart task exempts as exempt energy beside its managed draw', async () => {
    const { pipeline, getTracker } = buildPipeline(new Set(['dev-task']), true);
    await pipeline.recordPowerSample(2_000, T0);
    await pipeline.recordPowerSample(2_000, T0 + HALF_HOUR_MS);

    expect(getTracker().exemptBuckets?.[hourKey]).toBeCloseTo(1, 3);
    expect(getTracker().uncontrolledExemptBuckets?.[hourKey] ?? 0).toBe(0);
  });

  it('books a capacity-off device a smart task exempts as exempt background energy', async () => {
    // Prod 2026-11-02: a charger with Power-limit control off ran on a task that may
    // go over the daily budget. Its draw is background usage, and it is exempt: it
    // books beside the background side, never on the managed one.
    const { pipeline, getTracker } = buildPipeline(new Set(['dev-task']), false);
    await pipeline.recordPowerSample(2_000, T0);
    await pipeline.recordPowerSample(2_000, T0 + HALF_HOUR_MS);

    expect(getTracker().uncontrolledExemptBuckets?.[hourKey]).toBeCloseTo(1, 3);
    expect(getTracker().uncontrolledBuckets?.[hourKey]).toBeCloseTo(1, 3);
    expect(getTracker().exemptBuckets?.[hourKey] ?? 0).toBe(0);
    expect(getTracker().controlledBuckets?.[hourKey] ?? 0).toBe(0);
  });

  it('books nothing as exempt without a claim, and the background share never appears', async () => {
    const { pipeline, getTracker } = buildPipeline(new Set(), false);
    await pipeline.recordPowerSample(2_000, T0);
    await pipeline.recordPowerSample(2_000, T0 + HALF_HOUR_MS);

    expect(getTracker().exemptBuckets?.[hourKey] ?? 0).toBe(0);
    // Sparse: a home whose exempt background share never draws gains neither the
    // persisted family nor its latch.
    expect(getTracker()).not.toHaveProperty('uncontrolledExemptBuckets');
    expect(getTracker()).not.toHaveProperty('lastUncontrolledExemptPowerW');
  });
});
