import type CapacityGuard from '../lib/power/capacityGuard';
import type { DeviceTransport } from '../lib/device/deviceTransport';
import type { PlanEngine } from '../lib/plan/planEngine';
import type { PlanService } from '../lib/plan/planService';
import { PlanRebuildScheduler } from '../lib/plan/rebuildScheduler/scheduler';
import { recordPowerSampleForApp } from '../lib/power/sampleIngest';
import { PowerSampleRebuildState } from '../lib/plan/rebuildScheduler/powerDriven';
import { schedulePlanRebuildFromSignal } from '../lib/plan/rebuildScheduler/signalDriven';
import { splitControlledUsageKw, sumBudgetExemptLiveUsageKw } from '../lib/plan/planUsage';
import { updateObjectiveProfilesFromSnapshot } from '../lib/objectives/profiles';
import { isPlanActivelyConverging } from '../lib/plan/planStateHelpers';
import { buildPlanCapacityStateSummary } from '../lib/plan/planLogging';
import { shouldSkipShortfallRebuildFromPlanSummary } from '../lib/plan/rebuildScheduler/shortfallSuppression';
import { addPerfDuration, incPerfCounter } from '../lib/utils/perfCounters';
import type { StructuredDebugEmitter } from '../lib/logging/logger';
import type { PowerTrackerState } from '../packages/contracts/src/powerTrackerTypes';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';

// Tightened to zero in tests so coalesced rebuild requests don't block on
// the throttle while a test is awaiting the resulting plan revision; prod
// values preserve the 2s/15s/30s envelope that gates `signal` intent
// scheduling. Mirrors the constants previously inlined on `PelsApp`.
const POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 2000;
const POWER_SAMPLE_REBUILD_STABLE_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 15000;
const POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 100 : 30 * 1000;

export type PowerSamplePipelineDeps = {
  getPowerTracker: () => PowerTrackerState;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityGuard: () => CapacityGuard | undefined;
  getPlanEngine: () => PlanEngine;
  getPlanService: () => PlanService;
  getDeviceManager: () => DeviceTransport | undefined;
  planRebuildScheduler: PlanRebuildScheduler;
  getPowerSampleRebuildState: () => PowerSampleRebuildState;
  setPowerSampleRebuildState: (state: PowerSampleRebuildState) => void;
  getLatestTargetSnapshot: () => TargetDeviceSnapshot[];
  getPlanRebuildNowMs: () => number;
  savePowerTracker: (state: PowerTrackerState) => void;
  getStructuredDebugEmitter: (component: string, debugTopic: 'objective_profiles') => StructuredDebugEmitter;
};

/**
 * Lives in `setup/` because the only state it owns is the coalescing
 * bookkeeping for `recordPowerSample` (`powerSampleLoop`,
 * `powerSampleRerunRequested`, `pendingPowerSampleRequest`). No other
 * module queries those — they exist solely so back-to-back
 * `recordPowerSample` calls debounce into one in-flight loop with a
 * single pending rerun. The orchestration itself just smuggles
 * sibling-domain concerns (`plan*`, `capacityGuard`, `device manager`,
 * `powerTracker`) into one call into `recordPowerSampleForApp`
 * (which IS the lib-side power-sample primitive in
 * `lib/power/sampleIngest.ts`).
 *
 * `recordPowerSample(currentPowerW, nowMs)` is the public entry point.
 * The Homey-Energy poll source and the flow-card power-sample reporter
 * (both wired in `PelsApp.onInit`) call it; the app's
 * `appPowerSampleIngest.recordPowerSample` AppContext member also
 * routes here.
 */
export class PowerSamplePipeline {
  private powerSampleLoop?: Promise<void>;
  private powerSampleRerunRequested = false;
  private pendingPowerSampleRequest?: { currentPowerW: number; nowMs: number };

  constructor(private readonly deps: PowerSamplePipelineDeps) {}

  async recordPowerSample(currentPowerW: number, nowMs: number = Date.now()): Promise<void> {
    incPerfCounter('power_sample_requested_total');
    const request = { currentPowerW, nowMs };

    if (this.powerSampleLoop) {
      if (this.powerSampleRerunRequested) {
        incPerfCounter('power_sample_rerun_coalesced_total');
      } else {
        incPerfCounter('power_sample_rerun_requested_total');
      }
      this.powerSampleRerunRequested = true;
      this.pendingPowerSampleRequest = request;
      return this.powerSampleLoop;
    }

    const loopPromise = this.runCoalescedPowerSamples(request);
    this.powerSampleLoop = loopPromise;
    return loopPromise;
  }

  private async runCoalescedPowerSamples(initialRequest: { currentPowerW: number; nowMs: number }): Promise<void> {
    let request = initialRequest;
    try {
      while (true) {
        this.powerSampleRerunRequested = false;
        this.pendingPowerSampleRequest = undefined;
        await this.runPowerSample(request.currentPowerW, request.nowMs);
        if (!this.powerSampleRerunRequested) return;
        incPerfCounter('power_sample_rerun_executed_total');
        request = this.pendingPowerSampleRequest ?? request;
      }
    } finally {
      if (this.powerSampleLoop) {
        this.powerSampleLoop = undefined;
      }
      this.powerSampleRerunRequested = false;
      this.pendingPowerSampleRequest = undefined;
    }
  }

  private async runPowerSample(currentPowerW: number, nowMs: number = Date.now()): Promise<void> {
    const sampleStart = Date.now();
    const powerTracker = this.deps.getPowerTracker();
    const previousSampleTs = powerTracker.lastTimestamp;
    try {
      const planEngine = this.deps.getPlanEngine();
      const planService = this.deps.getPlanService();
      const planState = planEngine?.state;
      const planConvergenceActive = isPlanActivelyConverging(planState);
      const latestPlanSummary = buildPlanCapacityStateSummary(
        planService?.getLatestPlanSnapshot(),
        {
          summarySource: 'plan_snapshot',
          summarySourceAtMs: planService?.getLatestPlanSnapshotUpdatedAtMs() ?? null,
        },
      );
      const skipWhileShortfallUnrecoverable = shouldSkipShortfallRebuildFromPlanSummary({
        summary: latestPlanSummary,
        state: this.deps.getPowerSampleRebuildState(),
      });
      const capacitySettings = this.deps.getCapacitySettings();
      const capacityGuard = this.deps.getCapacityGuard();
      await recordPowerSampleForApp({
        currentPowerW,
        nowMs,
        capacitySettings,
        getLatestTargetSnapshot: () => this.deps.getLatestTargetSnapshot(),
        powerTracker,
        capacityGuard,
        splitControlledUsage: (params) => splitControlledUsageKw(params),
        sumBudgetExemptUsage: (devices) => sumBudgetExemptLiveUsageKw(devices),
        updateObjectiveProfiles: (params) => updateObjectiveProfilesFromSnapshot({
          ...params,
          debugStructured: this.deps.getStructuredDebugEmitter('objective_profiles', 'objective_profiles'),
        }),
        schedulePlanRebuild: async () => {
          await schedulePlanRebuildFromSignal({
            scheduler: this.deps.planRebuildScheduler,
            getState: () => this.deps.getPowerSampleRebuildState(),
            setState: (state) => this.deps.setPowerSampleRebuildState(state),
            getNowMs: () => this.deps.getPlanRebuildNowMs(),
            minIntervalMs: POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS,
            stableMinIntervalMs: POWER_SAMPLE_REBUILD_STABLE_INTERVAL_MS,
            maxIntervalMs: POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS,
            rebuildPlanFromCache: (reason?: string) => planService.rebuildPlanFromCache(reason),
            currentPowerW,
            capacitySettings,
            capacityGuard,
            planConvergenceActive,
            skipWhileShortfallUnrecoverable,
          });
        },
        saveState: (state) => this.deps.savePowerTracker(state),
      });
      if (previousSampleTs === undefined || nowMs > previousSampleTs) {
        planEngine.clearStartupRestoreStabilization(nowMs);
      }
    } finally {
      addPerfDuration('power_sample_ms', Date.now() - sampleStart);
      incPerfCounter('power_sample_total');
    }
  }
}
