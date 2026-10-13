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
import type { AppContext } from '../../lib/app/appContext';
import { MAIN_HOME_ID, type HomeId } from '../../lib/utils/settingsKeys';
import { resolveFreshGenerationW, resolveGenerationSegments } from '../../lib/observer/generationFreshness';
import { ObservedHomePower } from '../../lib/observer/observedHomePower';
import { PowerSamplePipeline, type PowerSamplePipelineDeps } from '../powerSamplePipeline';
import { MeterSilenceMonitor, type MeterSilenceMonitorDeps } from '../../lib/power/meterSilence';

export type HomePowerPipelineDeps = Pick<PowerSamplePipelineDeps,
  | 'getPlanEngine'
  | 'getPlanService'
  | 'savePowerTracker'
  | 'planRebuildThrottle'
  | 'getPowerTracker'
  | 'getCapacitySettings'
  | 'getCapacityGuard'
  | 'getOutdoorTemperatureC'
  | 'recordPvGenerationSample'
  | 'recordCurtailmentSample'
  | 'noteResolvedHomeMeter'
> & {
  ctx: AppContext;
  /** The home this pipeline samples for; scopes the snapshot view below. */
  homeId: HomeId;
  /**
   * Observer's whole-home production holder. The MAIN home passes the one the
   * production readers write; a sub-home passes {@link createUnobservedHomeProduction},
   * which no reader writes, so it co-samples and accrues no production.
   * Sub-homes are capacity-only and must never adopt the main home's production.
   */
  observedHomePower: ObservedHomePower;
};

/**
 * The production holder for a home that has no production reader (a meter
 * area): nothing writes it, so it answers "no reading" and "no stretches" by
 * being empty. Constructed here because this factory is the wiring that owns
 * the observer edge for a home's pipeline.
 */
export function createUnobservedHomeProduction(): ObservedHomePower {
  return new ObservedHomePower();
}

export function createHomePowerPipeline(deps: HomePowerPipelineDeps): PowerSamplePipeline {
  const { ctx, observedHomePower } = deps;
  return new PowerSamplePipeline({
    createIngestQueue: (queueDeps) => createSampleIngestQueue(queueDeps),
    getPowerTracker: deps.getPowerTracker,
    getCapacitySettings: deps.getCapacitySettings,
    getTimeZone: ctx.getTimeZone,
    getCapacityGuard: deps.getCapacityGuard,
    getPlanEngine: deps.getPlanEngine,
    getPlanService: deps.getPlanService,
    planRebuildThrottle: deps.planRebuildThrottle,
    getThermalDirection: (deviceId) => ctx.observer.getThermalDirection(deviceId),
    // Power attribution needs inventory class and Observer measurements. Use
    // the explicit joined read here; planner input intentionally carries
    // neither class nor zone.
    // The membership complement removes sub-home loads from this home's
    // controlled/background split and every configured meter from each home's
    // attribution.
    getDeviceSurfaces: () => {
      const devices = ctx.getDeviceSurfaces();
      const membership = ctx.homeMembership;
      if (membership) return membership.filterDevicesForHome(devices, deps.homeId);
      return deps.homeId === MAIN_HOME_ID ? devices : [];
    },
    savePowerTracker: deps.savePowerTracker,
    getOutdoorTemperatureC: deps.getOutdoorTemperatureC,
    getCoSampledGenerationW: (nowMs) => resolveFreshGenerationW({
      generationW: observedHomePower.getGenerationW(),
      observedAtMs: observedHomePower.getGenerationObservedAtMs(),
      nowMs,
    }),
    getObservedGenerationSegments: (nowMs) => (
      resolveGenerationSegments(observedHomePower.getGenerationReadings(), nowMs)
    ),
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
