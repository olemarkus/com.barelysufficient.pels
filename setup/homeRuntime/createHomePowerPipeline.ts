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
 * same factory. The capacity closures (`getPowerTracker`/`getCapacitySettings`
 * /`getCapacityGuard`/`getPowerSampleRebuildState`) default to the ctx (main
 * home) reads when omitted and are overridden with per-bundle state for
 * sub-homes. The weather/PV/curtailment taps are caller-supplied and simply
 * NOT passed for sub-home pipelines: a sub-home meter's net W is not the
 * home's grid power, so feeding it to the PV forecast or the
 * curtailment-surplus estimator would corrupt them.
 */
import type CapacityGuard from '../../lib/power/capacityGuard';
import type { AppContext } from '../../lib/app/appContext';
import type { PlanEngine } from '../../lib/plan/planEngine';
import type { PlanService } from '../../lib/plan/planService';
import type { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import type { PowerSampleRebuildState } from '../../lib/plan/rebuildScheduler/powerDriven';
import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';
import { MAIN_HOME_ID, type HomeId } from '../../lib/utils/settingsKeys';
import { filterDevicesForHome } from '../homeMembership';
import { PowerSamplePipeline } from '../powerSamplePipeline';

export type HomePowerPipelineDeps = {
  ctx: AppContext;
  /** The home this pipeline samples for; scopes the snapshot view below. */
  homeId: HomeId;
  planRebuildScheduler: PlanRebuildScheduler;
  // `AppContext` types `planEngine`/`planService` as optional (they are wired
  // during startup); the pipeline contract requires the definite getters the
  // app's own fields carry, so the caller supplies them.
  getPlanEngine: () => PlanEngine;
  getPlanService: () => PlanService;
  getPlanRebuildNowMs: () => number;
  savePowerTracker: (state: PowerTrackerState) => void;
  // Caller-supplied so the ctx mutation stays at the class site (the
  // `functional/immutable-data` rule exempts class contexts).
  setPowerSampleRebuildState: (state: PowerSampleRebuildState) => void;
  // Per-home capacity closures (R7b). Omitted = the ctx (main home) reads,
  // preserving the pre-R7b wiring byte-for-byte; sub-home bundles supply their
  // own tracker/settings/guard/rebuild-state so two homes never share
  // capacity state.
  getPowerTracker?: () => PowerTrackerState;
  getCapacitySettings?: () => { limitKw: number; marginKw: number };
  getCapacityGuard?: () => CapacityGuard | undefined;
  getPowerSampleRebuildState?: () => PowerSampleRebuildState;
  /** Latest outdoor temperature (hidden weather feature); undefined when unavailable or stale. */
  getOutdoorTemperatureC?: () => number | undefined;
  /** Feed the per-sample gross generation (W) plus the co-sampled SIGNED net home
   *  power (W, import positive) to the learned PV forecast; no-op when absent. */
  recordPvGenerationSample?: (generationW: number | undefined, nowMs: number, netPowerW?: number) => void;
  /** Feed the same co-sampled pair to the curtailment-surplus estimator; no-op
   *  when absent (sub-home pipelines — see the module doc). */
  recordCurtailmentSample?: (netW: number, generationW: number | undefined, nowMs: number) => void;
};

export function createHomePowerPipeline(deps: HomePowerPipelineDeps): PowerSamplePipeline {
  const { ctx } = deps;
  return new PowerSamplePipeline({
    getPowerTracker: deps.getPowerTracker ?? (() => ctx.powerTracker),
    getCapacitySettings: deps.getCapacitySettings ?? (() => ctx.capacitySettings),
    getCapacityGuard: deps.getCapacityGuard ?? (() => ctx.capacityGuard),
    getPlanEngine: deps.getPlanEngine,
    getPlanService: deps.getPlanService,
    getDeviceManager: () => ctx.deviceManager,
    planRebuildScheduler: deps.planRebuildScheduler,
    getPowerSampleRebuildState: deps.getPowerSampleRebuildState ?? (() => ctx.powerSampleRebuildState),
    setPowerSampleRebuildState: deps.setPowerSampleRebuildState,
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
    getPlanRebuildNowMs: deps.getPlanRebuildNowMs,
    savePowerTracker: deps.savePowerTracker,
    getStructuredDebugEmitter: (component, topic) => ctx.getStructuredDebugEmitter(component, topic),
    getOutdoorTemperatureC: deps.getOutdoorTemperatureC,
    recordPvGenerationSample: deps.recordPvGenerationSample,
    recordCurtailmentSample: deps.recordCurtailmentSample,
    // Main home only: the sampled whole-home meter identity feeds membership's
    // ownership fence, and only Main's samples carry one. Sub-home pipelines
    // never receive identity-carrying options (their `recordMeterSample` route
    // passes bare watts), so this is defence in depth on top of that. Lazy over
    // ctx: membership is wired after the pipeline.
    ...(deps.homeId === MAIN_HOME_ID
      ? {
        noteResolvedHomeMeter: (deviceId: string | null, sampleAtMs: number) => (
          ctx.homeMembership?.noteResolvedHomeMeter(deviceId, sampleAtMs)
        ),
      }
      : {}),
  });
}
