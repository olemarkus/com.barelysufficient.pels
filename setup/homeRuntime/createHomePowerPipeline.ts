/**
 * Factory for one home's `PowerSamplePipeline`. Extracted from the `PelsApp`
 * field initializer so the construction site is a per-home deps bag instead of
 * `this`-bound closures hardwired in `app.ts`: the ctx-derivable closures are
 * built here, and `app.ts` supplies only the members that live on private
 * `PelsApp` state (scheduler, plan engine/service getters, tracker persistence,
 * weather/PV taps). The main home's bag reproduces the exact pre-refactor
 * closures.
 *
 * R7b: sub-home capacity bundles construct additional pipelines through the
 * same factory. Every home names its own capacity state — tracker, capacity
 * scalars, guard and rebuild throttle are required deps. The tracker and the
 * scalars used to be optional, falling back to the `ctx` reads when omitted,
 * which meant "omitted" silently spelled "the main home": the one home whose
 * capacity state is ambient on the context got its wiring for free, and the
 * shape of a home's pipeline depended on which home it was. The weather/PV/
 * curtailment taps are caller-supplied and simply NOT passed for sub-home
 * pipelines: a sub-home meter's net W is not the home's grid power, so feeding
 * it to the PV forecast or the curtailment-surplus estimator would corrupt them.
 */
import { createSampleIngestQueue } from '../../lib/power/sampleIngestQueue';
import type CapacityGuard from '../../lib/power/capacityGuard';
import type { AppContext } from '../../lib/app/appContext';
import type { PlanEngine } from '../../lib/plan/planEngine';
import type { PlanService } from '../../lib/plan/planService';
import type { PlanRebuildThrottle } from '../../lib/plan/rebuildScheduler/throttle';
import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';
import type { HomeId } from '../../lib/utils/settingsKeys';
import { filterDevicesForHome } from '../homeMembership';
import { resolveFreshGenerationW } from '../../lib/observer/generationFreshness';
import type { ObservedHomePower } from '../../lib/observer/observedHomePower';
import { PowerSamplePipeline } from '../powerSamplePipeline';
import { MeterSilenceMonitor, type MeterSilenceMonitorDeps } from '../../lib/power/meterSilence';

export type HomePowerPipelineDeps = {
  ctx: AppContext;
  /** The home this pipeline samples for; scopes the snapshot view below. */
  homeId: HomeId;
  // `AppContext` types `planEngine`/`planService` as optional (they are wired
  // during startup); the pipeline contract requires the definite getters the
  // app's own fields carry, so the caller supplies them.
  getPlanEngine: () => PlanEngine;
  getPlanService: () => PlanService;
  savePowerTracker: (state: PowerTrackerState) => void;
  /** This home's rebuild throttle — the sample's one exit into the planner. */
  planRebuildThrottle: PlanRebuildThrottle;
  // Per-home capacity state. Required for every home, main included: two homes
  // never share a tracker, capacity scalars or a guard, so there is no home for
  // which one of these is the obvious default.
  getPowerTracker: () => PowerTrackerState;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityGuard: () => CapacityGuard;
  /** Latest outdoor temperature (hidden weather feature); undefined when unavailable or stale. */
  getOutdoorTemperatureC?: () => number | undefined;
  /** Feed the per-sample gross generation (W) plus the co-sampled SIGNED net home
   *  power (W, import positive) to the learned PV forecast; no-op when absent. */
  recordPvGenerationSample?: (generationW: number | undefined, nowMs: number, netPowerW?: number) => void;
  /** Feed the same co-sampled pair to the curtailment-surplus estimator; no-op
   *  when absent (sub-home pipelines — see the module doc). */
  recordCurtailmentSample?: (netW: number, generationW: number | undefined, nowMs: number) => void;
  /**
   * Observer's whole-home holder, supplied by the MAIN home only. Its held
   * production is co-sampled onto samples that carry none of their own — i.e.
   * Flow-reported ones, since the `homey_energy` poll always supplies its own
   * from the report it read net from. A sub-home pipeline omits it: those are
   * capacity-only and must never adopt the main home's production.
   */
  observedHomePower?: ObservedHomePower;
  /**
   * Publish the identity of the meter an ingested sample came from, into
   * membership's sampled-meter ownership fence. Only the home whose meter IS
   * the whole-home meter has anything to publish, and it is the home that says
   * so: Main binds the membership note, a meter area binds nothing to do. This
   * factory used to decide that itself, from `homeId === MAIN_HOME_ID`.
   */
  noteResolvedHomeMeter: (deviceId: string, sampleAtMs: number) => void;
};

export function createHomePowerPipeline(deps: HomePowerPipelineDeps): PowerSamplePipeline {
  const { ctx } = deps;
  return new PowerSamplePipeline({
    createIngestQueue: (queueDeps) => createSampleIngestQueue(queueDeps),
    getPowerTracker: deps.getPowerTracker,
    getCapacitySettings: deps.getCapacitySettings,
    getCapacityGuard: deps.getCapacityGuard,
    getPlanEngine: deps.getPlanEngine,
    getPlanService: deps.getPlanService,
    getDeviceManager: () => ctx.deviceManager,
    planRebuildThrottle: deps.planRebuildThrottle,
    // Membership complement (same single seam as the plan input in
    // `homeScope.ts`): with sub-homes configured, this home's controlled/
    // background usage split and per-device sample accounting stop counting
    // sub-home members — their draw lands in background usage. Identity (same
    // array) for the main home when `hasSubHomes()` is false; EMPTY for a
    // sub-home under those conditions (fail-closed dual). The shared filter
    // also removes every configured meter from every home's controlled/
    // background split, regardless of where that source device is zoned.
    getLatestTargetSnapshot: () => (
      filterDevicesForHome(ctx.homeMembership, ctx.latestTargetSnapshot, deps.homeId)
    ),
    savePowerTracker: deps.savePowerTracker,
    getStructuredDebugEmitter: (component, topic) => ctx.getStructuredDebugEmitter(component, topic),
    getOutdoorTemperatureC: deps.getOutdoorTemperatureC,
    getCoSampledGenerationW: deps.observedHomePower
      ? (nowMs) => resolveFreshGenerationW({
        generationW: deps.observedHomePower?.getGenerationW() ?? null,
        observedAtMs: deps.observedHomePower?.getGenerationObservedAtMs() ?? null,
        nowMs,
      })
      : undefined,
    recordPvGenerationSample: deps.recordPvGenerationSample,
    recordCurtailmentSample: deps.recordCurtailmentSample,
    noteResolvedHomeMeter: deps.noteResolvedHomeMeter,
  });
}

/**
 * Construction seam for a home's `MeterSilenceMonitor`, co-located with the
 * pipeline factory because the two read the same tracker latch (the ingest
 * that moves it is what clears the block). The composition root holds the
 * instance; this module only constructs.
 */
export function createMeterSilenceMonitor(deps: MeterSilenceMonitorDeps): MeterSilenceMonitor {
  return new MeterSilenceMonitor(deps);
}
