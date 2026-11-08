import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeferredObjectiveRoster } from '../../packages/contracts/src/deferredObjectiveSettings';
import { createEmptyActivePlans } from '../../lib/objectives/deferredObjectives/activePlanSettings';
import { DeferredObjectiveDecorationController } from '../../lib/objectives/deferredObjectives';
import { TaskAllocationRoster } from '../../lib/objectives/deferredObjectives/taskAllocationRoster';
import type { PlanEngine } from '../../lib/plan/planEngine';
import type { PlanService } from '../../lib/plan/planService';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import type { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import { PlanRebuildThrottle } from '../../lib/plan/rebuildScheduler/throttle';
import { EnergyAccounting } from '../../lib/power/energyAccounting';
import { createSampleIngestQueue } from '../../lib/power/sampleIngestQueue';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { PowerSamplePipeline } from '../../setup/powerSamplePipeline';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import {
  noDeviceExclusion, noDeliveredEnergy, noReservationSuppression, noStallEvidence,
} from '../helpers/deferredObjectiveWiringFixtures';
import { createFixturePriorityQuery } from '../helpers/modePriorityFixtures';
import { partialDouble } from '../helpers/partialDouble';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';
import { deviceSurfacesFixtures } from '../utils/deviceSnapshotFixture';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { fixtureControlPosture, withFixtureResidualKw } from '../utils/planTestUtils';

const START_MS = Date.UTC(2026, 9, 2, 0);
const QUARTER_MS = 15 * 60_000;
const HOUR_KEY = new Date(START_MS).toISOString();

const buildTaskDevice = (controllable: boolean): PlanInputDevice => withBinaryDiscriminant(withFixtureResidualKw({
  id: 'task', name: 'Task load', available: true, currentDrawKw: 3,
  expectedPowerKw: 3, expectedPowerSource: 'default',
  commandableNow: true, objectiveSessionInactive: false, waitingForCarAssociation: false,
  boostSupported: false, boostRequested: false, hasStandingDemand: true,
  surplusTracking: false, confirmedNotDrawing: false, isEvCharger: false,
  isBatteryOrSolar: false, starvationSupported: false,
  deviceType: 'onoff', controlModel: 'binary_power', targets: [],
  binaryCapabilityId: 'onoff', binaryControl: { on: true },
  control: fixtureControlPosture({ controllable }),
})) as PlanInputDevice;

const buildHarness = (controllable: boolean, decisionDelayMs = 0) => {
  let tracker: PowerTrackerState = {};
  let observedPowerKw = 3;
  let dropPowerOnDecision = false;
  let failDecision = false;
  const settings: DeferredObjectiveRoster = {
    objectivesByDeviceId: {
      task: {
        enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 6,
        deadlineAtMs: START_MS + 4 * QUARTER_MS, rescue: { exemptFromBudget: 'always' },
      },
    },
  };
  const device = buildTaskDevice(controllable);
  const controller = new DeferredObjectiveDecorationController({
    allocationRoster: new TaskAllocationRoster(() => new Date()),
    hasSolarProduction: () => false,
    getThermalDirection: () => 'heating',
    getPrioritiesForDevices: createFixturePriorityQuery(),
    getTimeZone: () => 'UTC',
    getPowerTracker: () => tracker,
    getPriceOptimizationEnabled: () => true,
    buildPriceHorizon: () => Array.from({ length: 4 }, (_, index) => ({
      startMs: START_MS + index * QUARTER_MS,
      endMs: START_MS + (index + 1) * QUARTER_MS,
      price: 1, moneyPrice: 1,
    })),
    getCapacitySettings: () => capacityOnlyPowerLimits(10),
    getDeferredObjectiveActivePlans: createEmptyActivePlans,
    resolveDeviceExclusion: noDeviceExclusion,
    getStallClassification: noStallEvidence,
    hasObservedTask: () => false,
    isReservationSuppressed: noReservationSuppression,
    getDeliveredEnergyKWh: noDeliveredEnergy,
  }, () => settings);
  const guard = createTestCapacityGuard({ homeId: 'main' });
  const scheduler = partialDouble<PlanRebuildScheduler>({
    request: () => {
      void throttle.execute();
      return 'queued';
    },
  });
  const throttle = new PlanRebuildThrottle({
    getScheduler: () => scheduler,
    getCapacityGuard: () => guard,
    getNowMs: Date.now,
    getWallClockMs: Date.now,
    rebuildPlanFromCache: async () => {
      if (failDecision) {
        failDecision = false;
        return { actionChanged: false, appliedActions: false, failed: true };
      }
      vi.setSystemTime(Date.now() + decisionDelayMs);
      controller.decorate({ devices: [device], dailyBudgetSnapshot: null, nowTs: Date.now() });
      if (dropPowerOnDecision) observedPowerKw = 0;
      // The budget owner can update tracker state while deciding. Accounting
      // must patch the latest state, not overwrite that update with its old copy.
      tracker = { ...tracker, hourlyBudgets: { [HOUR_KEY]: 9.5 } };
      return { actionChanged: false, appliedActions: false, failed: false };
    },
  });
  const pipeline = new PowerSamplePipeline({
    ingestQueue: createSampleIngestQueue(),
    noteResolvedHomeMeter: () => {},
    getPowerTracker: () => tracker,
    getCapacityGuard: () => guard,
    getCapacitySettings: () => capacityOnlyPowerLimits(10),
    getTimeZone: () => 'UTC',
    getPlanEngine: () => partialDouble<PlanEngine>({
      computeShortfallThreshold: () => 10,
      computePhaseDeficitKw: () => 0,
      state: createPlanEngineState(),
      clearStartupRestoreStabilization: () => false,
    }),
    getPlanService: () => partialDouble<PlanService>({
      getLatestPublishedPlan: () => null,
      computePhysicalPowerLimit: () => 10,
    }),
    planRebuildThrottle: throttle,
    readTaskBudgetExemptDeviceIds: (nowMs) => controller.readBudgetExemptDeviceIds(nowMs),
    getDeviceSurfaces: () => deviceSurfacesFixtures([{
      id: 'task', name: 'Task load', available: true, targets: [],
      expectedPowerKw: 3, expectedPowerSource: 'default', measuredPowerKw: observedPowerKw,
      controllable, budgetExempt: false,
    }]),
    getThermalDirection: () => 'heating',
    savePowerTracker: (next) => { tracker = next; },
    getCoSampledGenerationW: () => undefined,
    getObservedGenerationSegments: () => [],
  });
  return {
    settings,
    dropPowerDuringDecision: () => { dropPowerOnDecision = true; },
    failNextDecision: () => { failDecision = true; },
    getTracker: () => tracker,
    sample: async (quarter: number) => {
      const nowMs = START_MS + quarter * QUARTER_MS;
      vi.setSystemTime(nowMs);
      await pipeline.recordPowerSample(3_000, nowMs);
    },
  };
};

afterEach(() => vi.useRealTimers());

describe('meter-driven task exemption renewal', () => {
  it.each([true, false])('counts consecutive exempt quarters with controllable=%s', async (controllable) => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const { sample, getTracker } = buildHarness(controllable, 2_000);
    for (const quarter of [0, 1, 2, 3, 4]) await sample(quarter);
    const tracker = getTracker();
    expect(tracker.buckets?.[HOUR_KEY]).toBeCloseTo(3);
    expect(tracker.exemptBuckets?.[HOUR_KEY]).toBeCloseTo(3);
    expect(tracker.uncontrolledExemptBuckets?.[HOUR_KEY] ?? 0).toBeCloseTo(controllable ? 0 : 3);
    expect(new EnergyAccounting(tracker).bucket(HOUR_KEY).budgetCountedKwh).toBeCloseTo(0);
    expect(tracker.hourlyBudgets?.[HOUR_KEY]).toBe(9.5);
  });

  it.each(['disable', 'clear', 'permission'] as const)('ends exemption after task %s', async (change) => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const { sample, getTracker, settings } = buildHarness(false);
    await sample(0);
    await sample(1);
    if (change === 'disable') settings.objectivesByDeviceId.task.enabled = false;
    if (change === 'clear') delete settings.objectivesByDeviceId.task;
    if (change === 'permission') settings.objectivesByDeviceId.task.rescue = {};
    await sample(2);
    await sample(3);
    expect(getTracker().buckets?.[HOUR_KEY]).toBeCloseTo(2.25);
    expect(getTracker().exemptBuckets?.[HOUR_KEY]).toBeCloseTo(1.5);
    expect(getTracker().lastExemptPowerW).toBe(0);
  });

  it('retains the sample watts when observations change during its decision', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const { sample, getTracker, dropPowerDuringDecision } = buildHarness(false);
    dropPowerDuringDecision();
    await sample(0);
    expect(getTracker().lastExemptPowerW).toBe(3_000);
    expect(getTracker().lastUncontrolledExemptPowerW).toBe(3_000);
    await sample(1);
    expect(getTracker().exemptBuckets?.[HOUR_KEY]).toBeCloseTo(0.75);
    expect(getTracker().lastExemptPowerW).toBe(0);
  });

  it('does not extend an expired claim when the new decision fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const { sample, getTracker, failNextDecision } = buildHarness(false);
    await sample(0);
    await sample(1);
    failNextDecision();
    await sample(2);
    expect(getTracker().lastExemptPowerW).toBe(0);
    await sample(3);
    expect(getTracker().exemptBuckets?.[HOUR_KEY]).toBeCloseTo(1.5);
    expect(getTracker().buckets?.[HOUR_KEY]).toBeCloseTo(2.25);
  });

  it('does not renew the held exemption beyond the task deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const { sample, getTracker } = buildHarness(false);
    for (const quarter of [0, 1, 2, 3, 4, 5]) await sample(quarter);
    const nextHour = new Date(START_MS + 4 * QUARTER_MS).toISOString();
    expect(getTracker().exemptBuckets?.[HOUR_KEY]).toBeCloseTo(3);
    expect(getTracker().buckets?.[nextHour]).toBeCloseTo(0.75);
    expect(getTracker().exemptBuckets?.[nextHour] ?? 0).toBe(0);
    expect(getTracker().lastExemptPowerW).toBe(0);
  });
});
