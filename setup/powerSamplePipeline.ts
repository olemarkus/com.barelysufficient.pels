import type CapacityGuard from '../lib/power/capacityGuard';
import type { DeviceTransport } from '../lib/device/deviceTransport';
import type { PlanEngine } from '../lib/plan/planEngine';
import type { PlanService } from '../lib/plan/planService';
import { PlanRebuildScheduler } from '../lib/plan/rebuildScheduler/scheduler';
import { recordPowerSampleForApp } from '../lib/power/sampleIngest';
import { PowerSampleRebuildState } from '../lib/plan/rebuildScheduler/powerDriven';
import { schedulePlanRebuildFromSignal } from '../lib/plan/rebuildScheduler/signalDriven';
import { splitControlledUsageKw, sumBudgetExemptLiveUsageKw } from '../lib/plan/planUsage';
import { withHeadroomCurrentOn } from '../lib/plan/planHeadroomSupport';
import { updateObjectiveProfilesFromSnapshot } from '../lib/objectives/profiles';
import { isPlanActivelyConverging } from '../lib/plan/planStateHelpers';
import { buildPlanCapacityStateSummary, isPlanUnactionable } from '../lib/plan/planLogging';
import { shouldSkipShortfallRebuildFromPlanSummary } from '../lib/plan/rebuildScheduler/shortfallSuppression';
import { addPerfDuration, incPerfCounter } from '../lib/utils/perfCounters';
import type { StructuredDebugEmitter } from '../lib/logging/logger';
import type { PowerTrackerState } from '../packages/contracts/src/powerTrackerTypes';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import type { PowerSampleAdmission } from '../lib/app/appContext';

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
  /** Latest outdoor temperature (hidden weather feature); undefined when unavailable or stale. */
  getOutdoorTemperatureC?: () => number | undefined;
  /** Feed the per-sample gross generation (W) plus the co-sampled SIGNED net home
   *  power (W, import positive) to the learned PV forecast; no-op when absent. */
  recordPvGenerationSample?: (generationW: number | undefined, nowMs: number, netPowerW?: number) => void;
  /** Feed the same co-sampled pair (SIGNED net W + gross generation W, generation
   *  undefined for flow-source samples) to the curtailment-surplus estimator;
   *  no-op when absent. */
  recordCurtailmentSample?: (netW: number, generationW: number | undefined, nowMs: number) => void;
  /**
   * Publish the identity of the meter an INGESTED whole-home sample came from
   * (multi-home: membership's sampled-meter ownership fence). Called only after
   * `recordPowerSampleForApp` completes for a request that carried an identity,
   * with the ingest's own `nowMs` — so the identity, the watts, and their
   * timestamp move as ONE admitted operation. A request superseded by
   * coalescing drops its identity claim together with its watts; flow and
   * sub-home samples never carry the field and never publish. No-op when
   * absent (sub-home pipelines).
   */
  noteResolvedHomeMeter?: (deviceId: string | null, sampleAtMs: number) => void;
};

type PowerSampleOptions = {
  generationW?: number;
  /**
   * Identity of the meter this sample was read from. Present (string or null)
   * only on Homey-Energy whole-home samples; ABSENT on flow-driven and
   * sub-home-meter samples, which carry no identity semantics. `null` = the
   * read produced watts but could not attribute them; never proof of
   * non-collision.
   */
  resolvedHomeMeterDeviceId?: string | null;
};

export type StableSampleRevision =
  | { state: 'stable'; revision: number }
  | { state: 'pending' };

type PowerSampleRequest = {
  currentPowerW: number;
  nowMs: number;
  revision: number;
  generationW?: number;
  resolvedHomeMeterDeviceId?: string | null;
};

const buildPowerSampleRequest = (
  currentPowerW: number,
  nowMs: number,
  options: PowerSampleOptions,
  revision: number,
): PowerSampleRequest => ({
  currentPowerW,
  nowMs,
  revision,
  ...(typeof options.generationW === 'number' && Number.isFinite(options.generationW)
    ? { generationW: Math.max(0, options.generationW) }
    : {}),
  ...(options.resolvedHomeMeterDeviceId !== undefined
    ? { resolvedHomeMeterDeviceId: options.resolvedHomeMeterDeviceId }
    : {}),
});

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
  private pendingPowerSampleRequest?: PowerSampleRequest;
  // Bumped at the synchronous request edge, before a coalesced sample can wait
  // on plan work. Ownership-generation recovery uses it to abort a prepared
  // reconcile when a fresher capacity decision arrives mid-build.
  private sampleRevision = 0;
  private completedSampleRevision = 0;

  constructor(private readonly deps: PowerSamplePipelineDeps) {}

  async recordPowerSample(
    currentPowerW: number,
    nowMs: number = Date.now(),
    options: PowerSampleOptions = {},
  ): Promise<PowerSampleAdmission> {
    this.sampleRevision += 1;
    incPerfCounter('power_sample_requested_total');
    const request = buildPowerSampleRequest(currentPowerW, nowMs, options, this.sampleRevision);

    if (this.powerSampleLoop) {
      if (this.powerSampleRerunRequested) {
        incPerfCounter('power_sample_rerun_coalesced_total');
      } else {
        incPerfCounter('power_sample_rerun_requested_total');
      }
      this.powerSampleRerunRequested = true;
      this.pendingPowerSampleRequest = request;
      await this.powerSampleLoop;
      return this.resolveAdmission(request.revision);
    }

    const loopPromise = this.runCoalescedPowerSamples(request);
    this.powerSampleLoop = loopPromise;
    await loopPromise;
    return this.resolveAdmission(request.revision);
  }

  private resolveAdmission(revision: number): PowerSampleAdmission {
    const stable = this.getStableSampleRevision();
    return stable.state === 'stable' && stable.revision === revision
      ? { state: 'admitted', revision }
      : {
        state: 'superseded',
        revision,
        latestRevision: this.sampleRevision,
      };
  }

  getStableSampleRevision(): StableSampleRevision {
    return this.completedSampleRevision === this.sampleRevision
      ? { state: 'stable', revision: this.sampleRevision }
      : { state: 'pending' };
  }

  private async runCoalescedPowerSamples(initialRequest: PowerSampleRequest): Promise<void> {
    let request = initialRequest;
    try {
      while (true) {
        this.powerSampleRerunRequested = false;
        this.pendingPowerSampleRequest = undefined;
        await this.runPowerSample(request);
        this.completedSampleRevision = request.revision;
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

  /**
   * The ingest-side half of the sampled-meter ownership fence: fires at the
   * persisted-watts point of the request's ingest - after `saveState` has made
   * the admitted watts what the tracker serves (so the identity's expiry
   * anchor equals the tracker's stamp for those watts), and BEFORE the plan
   * rebuild the ingest awaits (so no control consumer can plan from these
   * watts under the previous meter's membership). Contained: membership
   * recompute work must never break the sample loop.
   */
  private publishResolvedHomeMeter(request: PowerSampleRequest): void {
    if (request.resolvedHomeMeterDeviceId === undefined) return;
    try {
      this.deps.noteResolvedHomeMeter?.(request.resolvedHomeMeterDeviceId, request.nowMs);
    } catch {
      incPerfCounter('power_sample_identity_publish_failed_total');
    }
  }

  private async runPowerSample(request: PowerSampleRequest): Promise<void> {
    const { currentPowerW, nowMs, generationW } = request;
    const sampleStart = Date.now();
    // Record gross generation for the learned PV forecast, independent of the
    // capacity/plan path below (a pure data tap — never affects shed decisions).
    // `currentPowerW` is the SIGNED net home power co-sampled with generation
    // (Homey-Energy mode); flow-driven samples carry no generationW, so this
    // stays a no-op for flow homes.
    this.deps.recordPvGenerationSample?.(generationW, nowMs, currentPowerW);
    // Same co-sampled pair to the curtailment-surplus estimator (another pure
    // data tap — the estimator only ever feeds the surplus pool, never sheds).
    this.deps.recordCurtailmentSample?.(currentPowerW, generationW, nowMs);
    const powerTracker = this.deps.getPowerTracker();
    const previousSampleTs = powerTracker.lastTimestamp;
    try {
      const planEngine = this.deps.getPlanEngine();
      const planService = this.deps.getPlanService();
      const planState = planEngine?.state;
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
      // Unwinnable state: a full rebuild cannot change any action, so the
      // scheduler throttles it to the max-interval cadence rather than burning
      // ~1.4s of CPU on every power sample (which trips Homey's cpuwarn watchdog).
      const planUnactionable = isPlanUnactionable(latestPlanSummary);
      // An unwinnable overshoot must not count as "converging": convergence bypasses
      // the scheduler's anti-storm guards, and that bypass is what let a persistent
      // 0-allowance shortfall rebuild ~1.6s of plan on every power sample until the
      // cpuwarn watchdog killed the app. In-flight commands still win inside the helper.
      const planConvergenceActive = isPlanActivelyConverging(planState, { unactionable: planUnactionable });
      const capacitySettings = this.deps.getCapacitySettings();
      const capacityGuard = this.deps.getCapacityGuard();
      await recordPowerSampleForApp({
        currentPowerW,
        generationW,
        nowMs,
        capacitySettings,
        getLatestTargetSnapshot: () => this.deps.getLatestTargetSnapshot(),
        powerTracker,
        capacityGuard,
        // Stamp the producer-resolved `currentOn` onto the raw snapshots before the
        // plan-layer usage math: these devices come straight from the transport and
        // carry `binaryControl` but no `currentOn`, so the usage on/off reads would
        // otherwise treat an idle-but-on binary device as off and charge expected kW.
        splitControlledUsage: (params) => splitControlledUsageKw({
          ...params,
          devices: params.devices.map(withHeadroomCurrentOn),
        }),
        sumBudgetExemptUsage: (devices) => sumBudgetExemptLiveUsageKw(devices.map(withHeadroomCurrentOn)),
        updateObjectiveProfiles: (params) => updateObjectiveProfilesFromSnapshot({
          ...params,
          debugStructured: this.deps.getStructuredDebugEmitter('objective_profiles', 'objective_profiles'),
          outdoorTemperatureC: this.deps.getOutdoorTemperatureC?.(),
        }),
        schedulePlanRebuild: async () => {
          // Fence ordering: the tracker core invokes this callback after
          // `saveState` persisted the admitted watts and BEFORE the plan
          // rebuild it awaits. Publishing here means the first rebuild this
          // sample triggers already plans under the membership its identity
          // implies; the previous post-ingest publication let that rebuild
          // reach the actuator while membership still held the prior meter's
          // identity - Main commanding from an area's watts. Publication is
          // contained, so a membership failure can never break the rebuild.
          this.publishResolvedHomeMeter(request);
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
            unactionable: planUnactionable,
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
