import type CapacityGuard from '../lib/power/capacityGuard';
import type { DeviceTransport } from '../lib/device/deviceTransport';
import type { PlanEngine } from '../lib/plan/planEngine';
import type { PlanService } from '../lib/plan/planService';
import { PlanRebuildScheduler } from '../lib/plan/rebuildScheduler/scheduler';
import {
  recordPowerSampleForApp,
  type SplitControlledUsage,
  type SumBudgetExemptUsage,
  type UpdateObjectiveProfiles,
} from '../lib/power/sampleIngest';
import { PowerSampleRebuildState } from '../lib/plan/rebuildScheduler/powerDriven';
import { schedulePlanRebuildFromSignal } from '../lib/plan/rebuildScheduler/signalDriven';
import { resolveLastTotalPowerKw } from '../lib/power/lastTotalPower';
import { computeShortfallThreshold } from '../lib/plan/planBudget';
import { splitControlledUsageKw, sumBudgetExemptProjectedUsageKw } from '../lib/plan/planUsage';
import { withHeadroomCurrentOn } from '../lib/plan/planHeadroomSupport';
import { updateObjectiveProfilesFromSnapshot } from '../lib/objectives/profiles';
import { isPlanActivelyConverging } from '../lib/plan/planStateHelpers';
import { buildPlanCapacityStateSummary, isPlanUnactionable } from '../lib/plan/planLogging';
import { shouldSkipShortfallRebuildFromPlanSummary } from '../lib/plan/rebuildScheduler/shortfallSuppression';
import { addPerfDuration, incPerfCounter } from '../lib/utils/perfCounters';
import { createSingleFlightLoop } from '../lib/utils/singleFlightLoop';
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
  /**
   * Late-bound by necessity: main's pipeline is a `PelsApp` field
   * initializer, constructed before `initCapacityGuard` runs. The type is
   * non-optional, so this defers the read without modelling an absent guard.
   */
  getCapacityGuard: () => CapacityGuard;
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
  /**
   * Production (W) for a sample that does not carry its own, or `undefined` when
   * there is no fresh reading. The `homey_energy` poll always supplies
   * generation from the same report it read net from, so this resolves only for
   * a Flow-reported sample — where the companion generation poll
   * (`GenerationPollSource`) left it in observer state. The FRESHNESS bound is
   * the caller's (`resolveFreshGenerationW`); absent means "not known", never a
   * stale value inherited into the accrual. Omitted by sub-home pipelines, which
   * are capacity-only and must not adopt the main home's production.
   */
  getCoSampledGenerationW?: (nowMs: number) => number | undefined;
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
  noteResolvedHomeMeter?: (deviceId: string, sampleAtMs: number) => void;
  /**
   * Admitted-sample push for the home's meter-silence monitor
   * (`lib/power/meterSilence.ts`): fires for EVERY admitted sample of this
   * home's pipeline — flow-driven, polled, or sub-meter — at the same
   * persisted-watts point as the identity publication, so "silence" clears on
   * exactly the ingest that moved the tracker latch. No-op when absent.
   */
  noteSampleAdmitted: () => void;
};

type PowerSampleOptions = {
  generationW?: number;
  /**
   * Identity of the meter this sample was read from. Present only on
   * Homey-Energy whole-home samples — and then always a named meter (there is
   * no Automatic and no unattributed reading); ABSENT on flow-driven and
   * sub-home-meter samples, which carry no identity semantics.
   */
  meterDeviceId?: string;
};

export type StableSampleRevision =
  | { state: 'stable'; revision: number }
  | { state: 'pending' };

type PowerSampleRequest = {
  currentPowerW: number;
  nowMs: number;
  revision: number;
  generationW?: number;
  /**
   * Generation for consumers that REQUIRE co-temporality with `currentPowerW` —
   * i.e. the curtailment-surplus estimator, whose freshness guarantee is stamped
   * from the net clock. Resolved here, at the producer: present only when the
   * sample carried its own reading, absent when it was co-sampled from the
   * observer's held value. Consumers read the flat field and branch on nothing.
   */
  coTemporalGenerationW?: number;
  meterDeviceId?: string;
};

const buildPowerSampleRequest = (
  currentPowerW: number,
  nowMs: number,
  options: PowerSampleOptions,
  revision: number,
  coSampledGenerationW?: number,
): PowerSampleRequest => {
  // The sample's OWN generation wins: it was read from the same report as this
  // net, so it is co-temporal by construction. The fallback exists for sources
  // that carry net only, and is resolved (and freshness-bounded) by the caller.
  //
  // Validity gates the SELECTION, not just the write. A junk own-reading must
  // fall THROUGH to the co-sampled value rather than block it — and a negative
  // one must be rejected outright rather than floored to 0, which would both
  // fabricate a zero-production observation and suppress a good fallback.
  // Production is `+`-only at every producer, so a negative here is malformed.
  const ownGenerationW = typeof options.generationW === 'number'
    && Number.isFinite(options.generationW)
    && options.generationW >= 0
    ? options.generationW
    : undefined;
  const generationW = ownGenerationW ?? coSampledGenerationW;
  return {
    currentPowerW,
    nowMs,
    revision,
    ...(generationW !== undefined ? { generationW } : {}),
    ...(ownGenerationW !== undefined ? { coTemporalGenerationW: ownGenerationW } : {}),
    ...(options.meterDeviceId !== undefined
      ? { meterDeviceId: options.meterDeviceId }
      : {}),
  };
};

/**
 * Lives in `setup/` because it is an orchestrator, not a domain component: it
 * fans ONE reading out across plan, objectives, solar and home membership. It
 * value-imports BOTH `lib/plan` and `lib/objectives`, and no peer module is
 * allowed to import both: `arch:grep` bars `lib/plan -> lib/objectives`, and
 * `no-objectives-to-peer-except-power` bars the reverse. `lib/power` and
 * `lib/device` are barred from `lib/plan` in turn. So there is no domain module
 * this can live in — see the orchestration entry in `TODO.md`. The domain work
 * itself is one call into `recordPowerSampleForApp` (`lib/power/sampleIngest.ts`).
 *
 * The state it retains is the sample-revision ledger: `sampleRevision` is
 * bumped at the synchronous request edge and `completedSampleRevision` records
 * the last request the loop finished, which together answer whether a caller's
 * sample was admitted or superseded. The coalescing that used to live beside it
 * is `lib/utils/singleFlightLoop.ts` now — one ingest at a time, newest queued
 * request wins, and a synchronously re-entrant caller can no longer start a
 * second concurrent loop.
 *
 * `recordPowerSample(currentPowerW, nowMs)` is the public entry point.
 * The Homey-Energy poll source and the flow-card power-sample reporter
 * (both wired in `PelsApp.onInit`) call it; the `AppContext.recordPowerSample`
 * member (implemented by `AppRuntimeApi.recordPowerSample`) also routes here.
 */
export class PowerSamplePipeline {
  // Bumped at the synchronous request edge, before a coalesced sample can wait
  // on plan work. Ownership-generation recovery uses it to abort a prepared
  // reconcile when a fresher capacity decision arrives mid-build.
  private sampleRevision = 0;
  private completedSampleRevision = 0;

  /**
   * One ingest at a time, newest queued request wins. The coalescing itself is
   * `lib/utils/singleFlightLoop.ts`; what stays here is the revision ledger,
   * which is the sample-specific half — the loop knows nothing about admission.
   */
  private readonly loop = createSingleFlightLoop<PowerSampleRequest>({
    run: (request) => this.runPowerSample(request).then(() => {
      this.completedSampleRevision = request.revision;
    }),
    nextRequest: (queued) => queued,
    mayContinue: () => true,
    onRequest: ({ join, replacedQueued }) => {
      if (join === 'started') return;
      incPerfCounter(replacedQueued
        ? 'power_sample_rerun_coalesced_total'
        : 'power_sample_rerun_requested_total');
    },
    onRerun: () => incPerfCounter('power_sample_rerun_executed_total'),
  });

  /**
   * The three snapshot seams `recordPowerSampleForApp` reaches back through,
   * bound ONCE rather than rebuilt on every sample. Each is a pure wrapper: it
   * takes everything sample-specific as an argument, and the two getters inside
   * the profiling one are still called per invocation — resolving the debug
   * emitter at boot would freeze whether that topic is enabled, and debug
   * logging is live in production.
   *
   * All three exist because `lib/power` sits UNDER the modules that own the
   * arithmetic: `lib/plan` reads power, so power may not read plan. They are the
   * points where an ordering `lib/power` owns has to reach outside it.
   */
  private readonly splitControlledUsage: SplitControlledUsage = (params) => splitControlledUsageKw({
    ...params,
    // Stamp the producer-resolved `currentOn` onto the raw snapshots before the
    // plan-layer usage math: these devices come straight from the transport and
    // carry `binaryControl` but no `currentOn`, so the usage on/off reads would
    // otherwise treat an idle-but-on binary device as off and charge expected kW.
    devices: params.devices.map(withHeadroomCurrentOn),
  });

  private readonly sumBudgetExemptUsage: SumBudgetExemptUsage = (devices) => (
    sumBudgetExemptProjectedUsageKw(devices.map(withHeadroomCurrentOn))
  );

  // Same producer boundary as the two usage seams above, for the same reason:
  // rate learning reads the device's DRAW, and the raw `measuredPowerKw` does
  // not travel past the producer. Resolving here means `lib/objectives` never
  // sees a raw reading — and because `ObjectiveSampleDevice.currentDrawKw` is
  // required, dropping this map is a compile error rather than a fleet learning
  // at 0 W.
  private readonly updateObjectiveProfiles: UpdateObjectiveProfiles = (params) => (
    updateObjectiveProfilesFromSnapshot({
      ...params,
      devices: params.devices.map(withHeadroomCurrentOn),
      debugStructured: this.deps.getStructuredDebugEmitter('objective_profiles', 'objective_profiles'),
      outdoorTemperatureC: this.deps.getOutdoorTemperatureC?.(),
    })
  );

  constructor(private readonly deps: PowerSamplePipelineDeps) {}

  async recordPowerSample(
    currentPowerW: number,
    nowMs: number = Date.now(),
    options: PowerSampleOptions = {},
  ): Promise<PowerSampleAdmission> {
    this.sampleRevision += 1;
    incPerfCounter('power_sample_requested_total');
    const request = buildPowerSampleRequest(
      currentPowerW, nowMs, options, this.sampleRevision, this.deps.getCoSampledGenerationW?.(nowMs),
    );

    await this.loop.request(request);
    return this.resolveAdmission(request.revision);
  }

  /**
   * Whether the caller's own sample is the one the tracker now serves.
   *
   * A synchronously re-entrant caller — which the loop answers immediately with
   * `queued` rather than letting it start a second pass — reads its verdict
   * before its request has run, so it sees `superseded` with
   * `revision === latestRevision`: superseded by itself. That shape is unique to
   * this window and no current caller reaches it (`recordPowerSample` is driven
   * by poll sources and flow cards, neither re-entrant). Every consumer treats
   * anything but `admitted` as "do not claim meter authority", so the answer is
   * the conservative one either way.
   */
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
    if (request.meterDeviceId === undefined) return;
    try {
      this.deps.noteResolvedHomeMeter?.(request.meterDeviceId, request.nowMs);
    } catch {
      incPerfCounter('power_sample_identity_publish_failed_total');
    }
  }

  private async runPowerSample(request: PowerSampleRequest): Promise<void> {
    const { currentPowerW, nowMs, generationW } = request;
    const sampleStart = Date.now();
    // Record gross generation for the learned PV forecast, independent of the
    // capacity/plan path below. `currentPowerW` is the SIGNED net home power
    // co-sampled with generation. Live on BOTH power sources now: a flow sample
    // carries generation once the companion poll has a fresh reading, so this is
    // no longer a no-op for flow homes. Still not a shed decision itself — but
    // note that supplying generation does move `resolveGrossConsumptionW`, and
    // through it the managed/background split and daily-budget attribution.
    this.deps.recordPvGenerationSample?.(generationW, nowMs, currentPowerW);
    // The curtailment-surplus estimator takes a sample's OWN generation only.
    // Its `CURTAIL_SAMPLE_FRESH_MS` (45 s) guarantee is timestamped from the NET
    // clock, which is only sound while the two are read from one report. A
    // co-sampled reading can be up to `POWER_SAMPLE_STALE_THRESHOLD_MS` older
    // than the net beside it, which would silently stretch that 45 s to ~105 s —
    // and a stale-LOW generation reading inflates the inferred surplus, engaging
    // a lift on production that is already self-consumed and pushing into real
    // grid import. So the estimator stays dormant on sources that do not deliver
    // the pair together; arming it there needs the generation's own clock
    // carried into `recordSample` first. The PV forecast tap above has no such
    // contract (it trains on hourly buckets) and takes the merged value.
    this.deps.recordCurtailmentSample?.(currentPowerW, request.coTemporalGenerationW, nowMs);
    const powerTracker = this.deps.getPowerTracker();
    const previousSampleTs = powerTracker.lastTimestamp;
    try {
      const planEngine = this.deps.getPlanEngine();
      const planService = this.deps.getPlanService();
      const planState = planEngine?.state;
      const latestPlanSummary = buildPlanCapacityStateSummary(
        planService.getLatestPlanSnapshot(),
        {
          summarySource: 'plan_snapshot',
          summarySourceAtMs: planService.getLatestPlanSnapshotUpdatedAtMs(),
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
        splitControlledUsage: this.splitControlledUsage,
        sumBudgetExemptUsage: this.sumBudgetExemptUsage,
        updateObjectiveProfiles: this.updateObjectiveProfiles,
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
          try {
            this.deps.noteSampleAdmitted();
          } catch {
            incPerfCounter('power_sample_silence_note_failed_total');
          }
          await schedulePlanRebuildFromSignal({
            scheduler: this.deps.planRebuildScheduler,
            getState: () => this.deps.getPowerSampleRebuildState(),
            setState: (state) => this.deps.setPowerSampleRebuildState(state),
            getNowMs: () => this.deps.getPlanRebuildNowMs(),
            minIntervalMs: POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS,
            stableMinIntervalMs: POWER_SAMPLE_REBUILD_STABLE_INTERVAL_MS,
            maxIntervalMs: POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS,
            currentPowerW,
            capacitySettings,
            capacityGuard,
            latchedTotalKw: resolveLastTotalPowerKw(this.deps.getPowerTracker()),
            capacityPaceKw: planService.computeDynamicSoftLimit(),
            shortfallThresholdKw: computeShortfallThreshold({
              capacitySettings,
              powerTracker: this.deps.getPowerTracker(),
            }),
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
