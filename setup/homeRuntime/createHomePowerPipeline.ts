/**
 * Factory for one home's `PowerSamplePipeline`. Extracted from the `PelsApp`
 * field initializer so the construction site is a per-home deps bag instead of
 * `this`-bound closures hardwired in `app.ts`: the ctx-derivable closures are
 * built here, and `app.ts` supplies only the members that live on private
 * `PelsApp` state (scheduler, plan engine/service getters, tracker persistence,
 * weather/PV taps). The multi-home follow-up constructs additional pipelines
 * with per-home deps; the main home's bag reproduces the exact pre-refactor
 * closures.
 */
import type { AppContext } from '../../lib/app/appContext';
import type { PlanEngine } from '../../lib/plan/planEngine';
import type { PlanService } from '../../lib/plan/planService';
import type { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import type { PowerSampleRebuildState } from '../../lib/plan/rebuildScheduler/powerDriven';
import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';
import type { HomeId } from '../../lib/utils/settingsKeys';
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
  /** Latest outdoor temperature (hidden weather feature); undefined when unavailable or stale. */
  getOutdoorTemperatureC?: () => number | undefined;
  /** Feed the per-sample gross generation (W) plus the co-sampled SIGNED net home
   *  power (W, import positive) to the learned PV forecast; no-op when absent. */
  recordPvGenerationSample?: (generationW: number | undefined, nowMs: number, netPowerW?: number) => void;
};

export function createHomePowerPipeline(deps: HomePowerPipelineDeps): PowerSamplePipeline {
  const { ctx } = deps;
  return new PowerSamplePipeline({
    getPowerTracker: () => ctx.powerTracker,
    getCapacitySettings: () => ctx.capacitySettings,
    getCapacityGuard: () => ctx.capacityGuard,
    getPlanEngine: deps.getPlanEngine,
    getPlanService: deps.getPlanService,
    getDeviceManager: () => ctx.deviceManager,
    planRebuildScheduler: deps.planRebuildScheduler,
    getPowerSampleRebuildState: () => ctx.powerSampleRebuildState,
    setPowerSampleRebuildState: deps.setPowerSampleRebuildState,
    // Membership complement (same single seam as the plan input in
    // `homeScope.ts`): with sub-homes configured, this home's controlled/
    // background usage split and per-device sample accounting stop counting
    // sub-home members — their draw lands in background usage. Identity (same
    // array) when `hasSubHomes()` is false.
    getLatestTargetSnapshot: () => filterDevicesForHome(ctx.homeMembership, ctx.latestTargetSnapshot, deps.homeId),
    getPlanRebuildNowMs: deps.getPlanRebuildNowMs,
    savePowerTracker: deps.savePowerTracker,
    getStructuredDebugEmitter: (component, topic) => ctx.getStructuredDebugEmitter(component, topic),
    getOutdoorTemperatureC: deps.getOutdoorTemperatureC,
    recordPvGenerationSample: deps.recordPvGenerationSample,
    // Optional AppContext member assigned by wireCurtailmentSurplus post-startup.
    recordCurtailmentSample: (netW, genW, nowMs) => ctx.recordCurtailmentSample?.(netW, genW, nowMs),
  });
}
