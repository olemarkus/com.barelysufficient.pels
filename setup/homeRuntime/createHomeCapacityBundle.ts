/**
 * One sub-home's self-contained, CAPACITY-ONLY control loop (multi-home R7b):
 * its own capacity settings store, guard, power tracker (with home-suffixed
 * persistence), rebuild scheduler, sample pipeline, plan engine and service.
 * Constructed and torn down by `HomeRuntimeRegistry` as the homes registry
 * changes; the MAIN home never routes through this factory — its wiring in
 * `app.ts`/`setup/appServiceWiring.ts` is untouched and its four unsuffixed
 * persisted keys are never written by bundle code.
 *
 * Capacity-only by construction: the sub-home `HomeScope` binds
 * `getDailyBudgetSnapshot: () => null`, price-optimization/cheap/expensive to
 * `false`, the surplus term to `null`, and `decorateWithoutDeferredObjectives`
 * for the smart-task seam — the shared plan factories then collapse to pure
 * capacity control without branching on which home they serve.
 *
 * That is a claim about POLICY INPUTS, not about the write surface. The mode
 * target is the RESTORE ANCHOR rather than a policy, so `getOperatingMode` /
 * `getModeDeviceTargets` bind live here, and this bundle will command a member
 * to its mode target with no capacity pressure at all. Neutralizing them left
 * an area temperature device shed indefinitely. The active mode, targets,
 * aliases and priorities come from this area's coherent suffixed catalog,
 * with the legacy Main snapshot used only until marker-last initialization.
 *
 * Boot-window double-control guard: `getCapacityDryRun` reads `true` until
 * membership has resolved from a COMMITTED zone tree
 * (`HomeMembershipService.hasSeenZoneTreeCommit`). Dry-run is the engine's
 * canonical plan-but-don't-actuate switch, so the bundle PLANS from boot but
 * cannot actuate until membership is trustworthy — a pinned device (resolvable
 * before any tree) could otherwise be double-controlled while main still plans
 * it through the fail-safe complement.
 *
 * Persistence: the home's tracker rows in the userdata store and
 * `device_last_controlled_ms:<homeId>` are rehydrated on (re)creation. Tracker
 * hydration is identity-bound before this factory runs: a store that cannot
 * be read fences construction until the owned retry, while an identity
 * mismatch clears freshness but keeps accounting. Last-controlled state uses
 * its typed map guard. Persistence
 * follows main's debounce/hour-rollover policy, minus main-only daily-budget,
 * UI, and calibration piggybacks. Teardown stops timers; persisted state stays.
 */
import type { AppContext } from '../../lib/app/appContext';
import type { SubHomeConfig } from '../../lib/home/homeConfig';
import type { HomeRuntimeDiagnostics, HomeRuntimeReading } from '../../lib/home/homeRuntimeRead';
import type { HomeId } from '../../lib/utils/settingsKeys';
import type {
  PowerTrackerMeterIdentity,
  PowerTrackerState,
} from '../../lib/power/trackerTypes';
import type { CapacityScalarSettings } from '../../lib/power/capacitySettingsStore';
import type { PlanService } from '../../lib/plan/planService';
import { decorateWithoutDeferredObjectives } from '../../lib/plan/planBuilderDecoration';
import type CapacityGuard from '../../lib/power/capacityGuard';
import { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import type { PlanRebuildThrottle } from '../../lib/plan/rebuildScheduler/throttle';
import { createHomePlanRebuildThrottle } from '../planRebuildIntentPolicy';
import {
} from '../../lib/utils/appTypeGuards';
import {
  DEVICE_LAST_CONTROLLED_MS,
  homeScopedSettingsKey,
} from '../../lib/utils/settingsKeys';
import { createCapacitySettingsStore } from '../capacitySettingsStoreAdapter';
// Direct file imports (not the `setup/appInit.ts` barrel) to mirror
// `homeScope.ts` and avoid the factory↔scope module cycle via the barrel.
import { createPlanEngine } from '../appInit/createPlanEngine';
import { createPlanService } from '../appInit/createPlanService';
import { buildHomePlanDevices } from './planDevicePrePass';
import { createHomePowerPipeline } from './createHomePowerPipeline';
import { MeterSilenceMonitor } from '../../lib/power/meterSilence';
import {
  buildHomeCapacityBundleApi,
  createPreparedBundleSampleFence,
  resolveEffectiveDryRun,
  resolveHomeAreaDisplayName,
  startHomeCapacityBundle,
} from './homeCapacityBundleApi';
import { installBundleReadinessAndFreshness } from './homeCapacityBundleReadiness';
import {
  createHomeModeCatalog,
  getConfiguredPriorityFromHomeModeCatalog,
  type HomeModeCatalog,
} from './homeModeCatalog';
import { installHomeCapacityBundleSourceRecovery } from './homeCapacityBundleSourceRecovery';
import type { HomeScope } from './homeScope';
import { createHomeCommandReachability } from './createHomeCommandReachability';
import { createHomeSignalWriters } from './homeSignalWriters';
import {
  createHomeTrackerPersistence,
} from '../../lib/power/homeTrackerPersistence';
import type { StableSampleRevision } from '../powerSamplePipeline';
import { createBundleCapacityGuard } from './createBundleCapacityGuard';
import type { PlanRebuildTrigger } from '../../lib/plan/planRebuildTrigger';
import { PriceLevel } from '../../lib/price/priceLevels';

// A sub-home's OWN fallback seed for its capacity store. Mirrors the app-boot
// defaults (`PelsApp.capacitySettings` / `capacityDryRun`) but is deliberately
// a per-home constant — NEVER main's live snapshot: seeding a sub-home from
// main's configured hard cap would silently run a second controller against
// main's contract limit. Dry-run defaults TRUE (the safe boot default): an
// unconfigured sub-home plans but never actuates.
const SUB_HOME_CAPACITY_DEFAULTS: CapacityScalarSettings = { limitKw: 10, marginKw: 0.2, dryRun: true };

// Mirrors `STARTUP_RESTORE_STABILIZATION_MS` in `setup/appServiceWiring.ts`:
export type HomeCapacityBundleDeps = {
  ctx: AppContext;
  home: SubHomeConfig;
  /** Already safety-resolved against persisted state by the owning registry. */
  initialPowerTrackerState: PowerTrackerState;
  /** Identity every tracker persist from this runtime must carry. */
  powerTrackerMeterIdentity: PowerTrackerMeterIdentity;
  /** Membership-readiness signal (a committed zone tree has been joined). */
  isMembershipReady: () => boolean;
  /**
   * Source-epoch gate resolved by the registry. True only while the current
   * global source and the last fully handled source epoch are Homey Energy.
   */
  isMeterSourceAuthorized: () => boolean;
  /**
   * Permanent source-epoch invalidation for this runtime. Unlike a transient
   * settings-read failure, this means a deferred global Flow transition belongs
   * to a superseded meter epoch and must be discarded.
   */
  isMeterSourceEpochDiscarded: () => boolean;
};

/**
 * Read-only per-bundle diagnostics. ONE declaration, owned by the read port's
 * contract in `lib/home` — the legal direction is `setup → lib`, so there is no
 * boundary reason to keep a second copy here (the field docs live there).
 */
export type HomeCapacityBundleDiagnostics = HomeRuntimeDiagnostics;

/**
 * Every seam that must be answered by the home that OWNS a device rather than by
 * main (multi-home R7b P1#1). Main filters sub-home members out of its plan and
 * never saw their commands, so main's answer to any of these is wrong in a way
 * that looks plausible: a fabricated external-off hold (PELS's own write reads
 * as an outside action), a rebuild of a plan that does not contain the device,
 * or a suppression cleared on a house that did not change.
 *
 * It used to be named for the reconcile lane and carried that lane's
 * `requestRebuild` and plan snapshot. Both are gone — a device event is not what
 * a capacity decision is about (root `AGENTS.md` § Control Flow) — and what is
 * left serves three different callers, so it is named for the routing rather
 * than for any one of them.
 */
export type OwningHomeHooks = {
  hasPendingBinaryCommand: (deviceId: string) => boolean;
  clearRecentBinaryOffCommand: (deviceId: string) => void;
  /**
   * Re-plan THIS home. Used by the reachability lane, which learns that a device
   * PELS thought it could command has become uncommandable (or the reverse) —
   * a change to what the planner may DO, not an observation of what a device is
   * doing, so it is a trigger in its own right.
   */
  rebuildPlan: (trigger: PlanRebuildTrigger) => Promise<unknown>;
  /**
   * Clear THIS home's rebuild suppressions after one of its devices moved.
   * Each bundle owns a separate rebuild throttle, so clearing main's
   * would leave the owning home holding a "nothing is actionable" verdict about
   * a house that has since changed — for up to the 120 s tight-noop backoff.
   */
  invalidateRebuildSuppression: () => void;
};

export type HomeCapacityBundle = {
  homeId: HomeId;
  /** True after teardown has closed every writer/actuator seam. */
  isTornDown: () => boolean;
  /** Current reconciled config, used when a source transition replaces the runtime. */
  getHomeConfig: () => SubHomeConfig;
  /** This home's meter device id (fresh from the last reconciled config). */
  getMeterDeviceId: () => string | null;
  getDiagnostics: () => HomeCapacityBundleDiagnostics;
  /**
   * This home's already-committed state for the per-home UI read seam
   * (`lib/home/homeRuntimeRead.ts`): the last committed plan snapshot, this
   * home's tracker state, and the diagnostics above. Pure reads — no rebuild,
   * no snapshot refresh/decorate, no actuation.
   */
  getReadModel: () => HomeRuntimeReading;
  /**
   * Owning-home routing hooks (see {@link OwningHomeHooks}): the observed-control-state
   * wiring binds these for a device this home owns, so the hold, the suppressions
   * and any rebuild are answered by THIS bundle rather than main's.
   */
  getOwningHomeHooks: () => OwningHomeHooks;
  /** Adopt a same-meter config change (root-zone/name) without teardown. */
  updateHomeConfig: (home: SubHomeConfig) => void;
  /** Rebuild the plan after this area's mode catalog changes. */
  rebuildForModeSettingsChange: () => void;
  /** Rebuild after a global per-device command-authority policy change. */
  rebuildForDeviceControlSettingsChange: () => void;
  /** Re-read this area's coherent suffixed mode catalog. */
  reloadModeCatalog: (allowPendingOwnershipGeneration?: boolean) => void;
  isModeCatalogInitialized: () => boolean;
  /**
   * Apply the once-only membership-ready edge (rebuild → reconcile). Idempotent
   * and latched; a no-op until the execution gate opens. Driven by the registry
   * from the membership tree-commit transition (decoupled from sample arrival).
   */
  applyMembershipReadyEdge: () => void;
  /**
   * Rebuild this home's committed plan after a pin/zone/config ownership
   * change so the new complement is adopted promptly. Point-of-use ownership
   * fencing remains the immediate safety boundary for any older continuation.
   */
  rebuildForMembershipChange: () => Promise<boolean>;
  /** Commit a fresh plan behind the ownership fence; token is its sample revision. */
  prepareOwnershipGeneration: () => Promise<StableSampleRevision>;
  isPreparedOwnershipGenerationCurrent: (sampleRevision: number) => boolean;
  /** Reconcile with the same point-of-use sample-revision abort as the ready edge. */
  reconcilePreparedOwnershipGeneration: (sampleRevision: number) => Promise<boolean>;
  flushDeferredShortfallSideEffect: () => Promise<boolean>;
  /** Feed one meter reading (W) into this home's sample pipeline. */
  recordMeterSample: (powerW: number, nowMs: number) => void;
  /** Suffix-hook: reload the capacity scalars into the guard + request a rebuild. */
  reloadCapacityScalars: () => void;
  /**
   * Stop timers/scheduler. Identity changes additionally clear and durably
   * persist meter freshness after the final pending-state flush.
   *
   * Returns false only when the requested durable freshness reset failed. The
   * runtime is already fenced in that case; callers must retain it as a
   * tombstone and retry the reset before constructing a replacement.
   */
  teardown: (options?: { resetMeterFreshness?: boolean }) => boolean;
};

// Per-bundle rebuild throttle and the scheduler it queues into; every timer
// rides the shared TimerRegistry under this home's key. Bundle clock:
// `Date.now()` unconditionally — self-consistent within the bundle (the
// throttle's memory and the scheduler's due times read the same clock); the
// main home keeps its monotonic-clock variant. `flow` intents do not exist for
// sub-homes, so every intent here is the throttle's.
function createBundleRebuildRuntime(params: {
  ctx: AppContext;
  timerKey: (suffix: string) => string;
  getPlanService: () => PlanService;
  getCapacityGuard: () => CapacityGuard;
}): { scheduler: PlanRebuildScheduler; throttle: PlanRebuildThrottle } {
  const { ctx, timerKey, getPlanService, getCapacityGuard } = params;
  const nowMs = () => Date.now();
  const throttle: PlanRebuildThrottle = createHomePlanRebuildThrottle({
    getScheduler: () => scheduler,
    getCapacityGuard,
    getNowMs: nowMs,
    rebuildPlanFromCache: (trigger) => getPlanService().rebuildPlanFromCache(trigger),
  });
  const scheduler: PlanRebuildScheduler = new PlanRebuildScheduler({
    getNowMs: nowMs,
    resolveDueAtMs: (intent, state) => throttle.dueAtMs(intent, state.nowMs),
    executeIntent: (intent) => {
      if (intent.kind === 'signal' || intent.kind === 'hardCap') return throttle.execute();
      return getPlanService()
        .rebuildPlanFromCache(intent.reason, { detail: intent.detail })
        .then(() => undefined);
    },
    shouldExecuteImmediately: (intent) => intent.kind !== 'flow',
    // A cancelled intent releases the rebuild queued for it, so a sample
    // awaiting one learns the reason instead of hanging past teardown.
    onIntentCancelled: (intent, reason) => {
      if (intent.kind === 'signal' || intent.kind === 'hardCap') throttle.cancel(reason);
    },
    setTimeoutFn: (callback, delayMs) => (
      ctx.timers.registerTimeout(timerKey('planRebuild'), setTimeout(callback, delayMs))
    ),
    clearTimeoutFn: () => { ctx.timers.clear(timerKey('planRebuild')); },
  });
  return { scheduler, throttle };
}

// The sub-home `HomeScope`: capacity-only policy block, suffixed persisted-
// signal writers, membership-partitioned plan input (fail-closed for sub-home
// scopes — see `filterDevicesForHome`).
function buildSubHomeScope(params: {
  ctx: AppContext;
  homeId: HomeId;
  /** Live read: a rename lands via `updateHomeConfig` without a teardown. */
  getHome: () => SubHomeConfig;
  isMembershipReady: () => boolean;
  isMeterSourceAuthorized: () => boolean;
  /** Teardown fence: gate the suffixed-key writers so a post-teardown continuation cannot persist. */
  isTornDown: () => boolean;
  getScalars: () => CapacityScalarSettings;
  getTracker: () => PowerTrackerState;
  /** Late-bound: the bundle's own service (created after the engine). */
  getServiceForSync: () => PlanService | undefined;
  /** Late-bound: the bundle's OWN engine, for the sub-home PELS-OFF provenance cleanup. */
  getPlanEngineForCommandProvenance: () => ReturnType<typeof createPlanEngine> | undefined;
  modeCatalog: HomeModeCatalog;
  meterSilenceMonitor: MeterSilenceMonitor;
}): HomeScope {
  const {
    ctx, homeId, getHome, isMembershipReady, isMeterSourceAuthorized, isTornDown, getScalars,
    getTracker, getServiceForSync, getPlanEngineForCommandProvenance, modeCatalog,
    meterSilenceMonitor,
  } = params;
  // Same lane the main home wires, with this area's own way of reaching its
  // plan service: a torn-down bundle drops the rebuild rather than driving a
  // service it no longer owns. The scheduled timer key is cleared either way,
  // so teardown leaves nothing behind in the shared registry.
  const binaryCommandReachability = createHomeCommandReachability(ctx, homeId, (trigger) => {
    if (!isTornDown()) void getServiceForSync()?.rebuildPlanFromCache(trigger);
  });
  return {
    homeId,
    // Names THIS area on the global hard-cap Flow triggers, which every home
    // shares — without it an area's alert reads as the Main home's.
    getHomeDisplayName: () => resolveHomeAreaDisplayName(getHome().name),
    getCapacitySettings: () => ({ limitKw: getScalars().limitKw, marginKw: getScalars().marginKw }),
    // The canonical no-actuation switch (see `resolveEffectiveDryRun`). This is
    // the CONTROL path, so it passes the execution source predicate — the one
    // that also arms source recovery.
    getCapacityDryRun: () => resolveEffectiveDryRun({
      isTornDown, isMembershipReady, isMeterSourceAuthorized, getScalars,
    }),
    getPowerTracker: getTracker,
    getMeterSilenceMonitor: () => meterSilenceMonitor,
    getDailyBudgetSnapshot: () => null,
    getPlanDevices: () => {
      // Capacity-only overrides: NO surplus posture (a sub-home has no
      // price/surplus signal, so a surplusWilling device would be held OFF
      // forever), and the PELS-OFF provenance cleanup routed to THIS bundle's
      // engine (not MAIN's via `ctx.planEngine`).
      return buildHomePlanDevices(ctx, homeId, {
        surplusPostureEnabled: false,
        getBasePriorityForDevice: (id) => (
          getConfiguredPriorityFromHomeModeCatalog(modeCatalog.getSnapshot(), id)
        ),
        clearRecentBinaryOffCommand: (id, observedOnAtMs) => getPlanEngineForCommandProvenance()
          ?.clearRecentBinaryOffCommand(id, observedOnAtMs),
        projectCommandability: binaryCommandReachability.project,
        pruneCommandability: binaryCommandReachability.prune,
      });
    },
    binaryCommandLifecycle: binaryCommandReachability.lifecycle,
    disposeBinaryCommandReachability: binaryCommandReachability.dispose,
    ...createHomeSignalWriters(ctx, homeId, isTornDown),
    // Capacity-only policy: no price optimization, no price level (so its status
    // reads UNKNOWN and `price_level_changed` never fires against MAIN's level),
    // no surplus term, no dynamic-soft-limit override. The smart-task seam is
    // bound to the identity decoration further down, not left off.
    getPriceOptimizationEnabled: () => false,
    getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
    getInferredSurplusKw: () => 0,
    getPriceOptimizationSettings: () => ({}),
    getDynamicSoftLimitOverride: () => null,
    // Mode targets are the RESTORE ANCHOR, not a price/budget policy, so they
    // bind live for every home. Binding them to `{}` made `modeTargetCFor`
    // fall back to the device's live setpoint (`lib/plan/planBuilder.ts`); while
    // shed that reading IS the shed setpoint, so on release `plannedTarget`
    // equalled `currentTarget`, the executor dropped the write, and an area
    // temperature device stayed cold indefinitely. Price-opt and surplus stay
    // gated separately above: both need a per-device config entry, and the
    // empty map bound there has none.
    //
    // Mode names, targets and priorities are independent per meter area. The
    // catalog adapter exposes one coherent last-good snapshot, and retains the
    // legacy Main snapshot only until the area's marker-last initialization
    // succeeds.
    getOperatingMode: () => modeCatalog.getSnapshot().operatingMode,
    getModeDeviceTargets: () => modeCatalog.getSnapshot().targets,
    // No smart tasks in a meter area (multi-home v1 defers them per home), so
    // the decoration seam is the identity one, named rather than omitted.
    decorateDeferredObjectives: decorateWithoutDeferredObjectives,
    // Capacity-only UI/side-effect posture: no shared `plan_updated` emit (the
    // settings UI reads only MAIN's plan stream), and no shared diagnostics
    // recorder (a sub-home plan pollutes main's per-boot epoch).
    emitsUiRealtime: false,
    getDeviceDiagnostics: () => undefined,
    // THIS home's post-actuation live-state sync — syncing main's service
    // (the ctx delegator) would touch the wrong plan.
    syncLivePlanStateAfterTargetActuation: (source) => (
      getServiceForSync()?.syncLivePlanStateInline(source) ?? false
    ),
  };
}

// Assembles the bundle's sample-ingest runtime: the per-bundle rebuild
// scheduler and the sample pipeline wired over it. Returns both so `teardown`
// can cancel the scheduler. Extracted to keep `createHomeCapacityBundle` within
// the setup-layer size ceilings.
function createBundleSamplePipeline(params: {
  ctx: AppContext;
  homeId: HomeId;
  timerKey: (suffix: string) => string;
  getPlanEngine: () => ReturnType<typeof createPlanEngine>;
  getPlanService: () => PlanService;
  getCapacityGuard: () => CapacityGuard;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  savePowerTracker: (state: PowerTrackerState) => void;
  getPowerTracker: () => PowerTrackerState;
}): {
  pipeline: ReturnType<typeof createHomePowerPipeline>;
  scheduler: PlanRebuildScheduler;
  throttle: PlanRebuildThrottle;
} {
  const { scheduler, throttle } = createBundleRebuildRuntime({
    ctx: params.ctx,
    timerKey: params.timerKey,
    getPlanService: params.getPlanService,
    getCapacityGuard: params.getCapacityGuard,
  });
  const pipeline = createHomePowerPipeline({
    ctx: params.ctx,
    homeId: params.homeId,
    planRebuildThrottle: throttle,
    getPlanEngine: params.getPlanEngine,
    getPlanService: params.getPlanService,
    savePowerTracker: params.savePowerTracker,
    getPowerTracker: params.getPowerTracker,
    getCapacitySettings: params.getCapacitySettings,
    getCapacityGuard: params.getCapacityGuard,
    // A meter area's meter is not the whole-home meter, so this area has no
    // identity to publish into membership's sampled-meter ownership fence —
    // adopting one would settle or latch MAIN's write fence from a meter Main
    // does not own. Its samples also carry no identity to publish
    // (`recordMeterSample` ingests bare watts), so this is the second of two
    // independent guards rather than the only one.
    noteResolvedHomeMeter: () => {},
    // No weather/PV/curtailment taps for sub-homes: a sub-home meter's net W is
    // not the home's grid power — feeding it to those estimators would corrupt them.
  });
  return { pipeline, scheduler, throttle };
}

function createBundlePlanningRuntime(params: {
  ctx: AppContext;
  homeId: HomeId;
  timerKey: (suffix: string) => string;
  isTornDown: () => boolean;
  isMembershipReady: () => boolean;
  isMeterSourceAuthorized: () => boolean;
  isMeterSourceEpochDiscarded: () => boolean;
  isMeterSourceAuthorizedForExecution: () => boolean;
  preparedSampleFence: ReturnType<typeof createPreparedBundleSampleFence>;
  tracker: ReturnType<typeof createHomeTrackerPersistence>;
  getHome: () => SubHomeConfig;
  getCapacityScalars: () => CapacityScalarSettings;
  modeCatalog: HomeModeCatalog;
}) {
  // This home's meter-silence policy: shared by the composed plan-build gate
  // (via the scope), the pipeline's admitted-sample push, and the freshness
  // escalation's shed-pass protocol.
  const meterSilenceMonitor = new MeterSilenceMonitor({
    getLastSampleAtMs: () => params.tracker.getState().lastTimestamp,
    nowMs: () => Date.now(),
    structuredLog: () => params.ctx.getStructuredLogger('power'),
  });
  const scope = buildSubHomeScope({
    ctx: params.ctx,
    homeId: params.homeId,
    getHome: params.getHome,
    isMembershipReady: params.isMembershipReady,
    isMeterSourceAuthorized: params.isMeterSourceAuthorizedForExecution,
    isTornDown: params.isTornDown,
    getScalars: params.getCapacityScalars,
    getTracker: params.tracker.getState,
    getServiceForSync: () => planService,
    getPlanEngineForCommandProvenance: () => planEngine,
    modeCatalog: params.modeCatalog,
    meterSilenceMonitor,
  });
  const isActuationFenced = (): boolean => {
    if (
      params.isTornDown()
      || !params.isMembershipReady()
      || params.preparedSampleFence.isSuperseded()
    ) return true;
    return !params.isMeterSourceAuthorizedForExecution();
  };
  const {
    guard,
    flushDeferredShortfallSideEffect,
    holdDeferredShortfallSideEffect,
  } = createBundleCapacityGuard({
    ctx: params.ctx,
    homeId: params.homeId,
    getCapacityScalars: params.getCapacityScalars,
    getPlanService: () => planService,
    getHomeDisplayName: scope.getHomeDisplayName,
    getPowerTracker: params.tracker.getState,
    isTornDown: params.isTornDown,
    isMembershipReady: params.isMembershipReady,
    isMeterSourceAuthorized: params.isMeterSourceAuthorized,
    isMeterSourceEpochDiscarded: params.isMeterSourceEpochDiscarded,
    isPreparedReconcileActive: params.preparedSampleFence.isActive,
    shortfallRetryTimerKey: params.timerKey('shortfallSideEffectRetry'),
    shortfallAlertImmediateTimerKey: params.timerKey('shortfallAlertImmediate'),
    shortfallAlertSustainedTimerKey: params.timerKey('shortfallAlertSustained'),
  });
  const planEngine = createPlanEngine(params.ctx, scope, { capacityGuard: guard, isActuationFenced });
  const storedLastControlled = params.ctx.homey.settings.get(
    homeScopedSettingsKey(DEVICE_LAST_CONTROLLED_MS, params.homeId),
  ) as unknown;
  planEngine.state.actuation.loadLastControlled(storedLastControlled);
  // A freshly (re)created bundle holds restores until its meter proves live;
  // the first fresh sample clears the window via the pipeline.
  planEngine.beginStartupRestoreStabilization(Date.now());
  const planService = createPlanService(params.ctx, scope, planEngine);
  const { pipeline, scheduler: planRebuildScheduler, throttle: planRebuildThrottle } = createBundleSamplePipeline({
    ctx: params.ctx,
    homeId: params.homeId,
    timerKey: params.timerKey,
    getPlanEngine: () => planEngine,
    getPlanService: () => planService,
    getCapacityGuard: () => guard,
    getCapacitySettings: scope.getCapacitySettings,
    savePowerTracker: params.tracker.save,
    getPowerTracker: params.tracker.getState,
  });
  return {
    scope,
    planEngine,
    planService,
    guard,
    meterSilenceMonitor,
    flushDeferredShortfallSideEffect,
    holdDeferredShortfallSideEffect,
    pipeline,
    planRebuildScheduler,
    planRebuildThrottle,
    isActuationFenced,
  };
}

export function createHomeCapacityBundle(deps: HomeCapacityBundleDeps): HomeCapacityBundle {
  const { ctx } = deps;
  const { homeId } = deps.home;
  const logger = () => ctx.getStructuredLogger('homes');
  const timerKey = (suffix: string) => `home:${homeId}:${suffix}`;

  let home = deps.home;
  let tornDown = false;
  const preparedSampleFence = createPreparedBundleSampleFence();
  const isTornDown = (): boolean => tornDown;
  // Last-good capacity scalars, seeded from the home's OWN defaults (never
  // main's live snapshot — see SUB_HOME_CAPACITY_DEFAULTS). The store is
  // constructed ONCE per bundle and is the ONLY capacity source for this scope.
  let capacityScalars: CapacityScalarSettings = SUB_HOME_CAPACITY_DEFAULTS;
  const capacityStore = createCapacitySettingsStore(ctx.homey.settings, homeId, () => capacityScalars);
  capacityScalars = capacityStore.read();

  const tracker = createHomeTrackerPersistence({
    deps: {
      getStore: () => ctx.getTrackerStore(),
      timers: ctx.timers,
      getLogger: () => ctx.getStructuredLogger('homes'),
      getPruneDebugEmitter: () => ctx.getStructuredDebugEmitter('perf', 'perf'),
      reportError: (message, error) => ctx.error(message, error),
      getTimeZone: () => ctx.getTimeZone(),
      isTornDown,
      onPersisted: () => ctx.emitPowerTrackerPersisted(homeId),
    },
    homeId,
    initialState: deps.initialPowerTrackerState,
    meterBinding: { kind: 'bound', identity: deps.powerTrackerMeterIdentity },
    timerKey,
  });
  const modeCatalog = createHomeModeCatalog(ctx, homeId);
  let scheduleSourceActuationRetry = (): void => undefined;
  const isMeterSourceAuthorizedForExecution = (): boolean => {
    const authorized = deps.isMeterSourceAuthorized();
    if (!authorized && !deps.isMeterSourceEpochDiscarded()) scheduleSourceActuationRetry();
    return authorized;
  };
  const {
    scope,
    planEngine,
    isActuationFenced,
    planService,
    guard,
    flushDeferredShortfallSideEffect,
    holdDeferredShortfallSideEffect,
    pipeline,
    planRebuildScheduler,
    planRebuildThrottle,
    meterSilenceMonitor,
  } = createBundlePlanningRuntime({
    ctx, homeId,
    isMembershipReady: deps.isMembershipReady,
    isMeterSourceAuthorized: deps.isMeterSourceAuthorized,
    isMeterSourceEpochDiscarded: deps.isMeterSourceEpochDiscarded,
    isMeterSourceAuthorizedForExecution,
    isTornDown,
    timerKey, preparedSampleFence, tracker,
    getHome: () => home,
    getCapacityScalars: () => capacityScalars,
    modeCatalog,
  });
  preparedSampleFence.bindReader(() => pipeline.getStableSampleRevision());
  const beginPreparedOwnershipReconcile = (sampleRevision: number): (() => void) => {
    holdDeferredShortfallSideEffect();
    return preparedSampleFence.begin(sampleRevision);
  };
  scheduleSourceActuationRetry = installHomeCapacityBundleSourceRecovery({
    ctx,
    homeId,
    timerKey: timerKey('sourceActuationRetry'),
    planService,
    isTornDown,
    isMembershipReady: deps.isMembershipReady,
    isMeterSourceAuthorized: deps.isMeterSourceAuthorized,
    isMeterSourceEpochDiscarded: deps.isMeterSourceEpochDiscarded,
    getStableSampleRevision: () => pipeline.getStableSampleRevision(),
    beginPreparedReconcile: beginPreparedOwnershipReconcile,
    flushDeferredShortfallSideEffect,
  }).schedule;
  tracker.startPruning();

  // Readiness apply-edge (decoupled from sample arrival; fired by the registry
  // from the membership tree-commit transition or the trust-fallback timer) plus
  // the trust-fallback and freshness-heartbeat timers.
  const {
    applyMembershipReadyEdge,
    markPreparedOwnershipGenerationReconciled,
  } = installBundleReadinessAndFreshness({
    ctx, homeId, timerKey, logger, planService,
    getTrackerState: tracker.getState,
    meterSilence: meterSilenceMonitor,
    getStableSampleRevision: () => pipeline.getStableSampleRevision(),
    beginPreparedOwnershipReconcile,
    isMembershipReady: deps.isMembershipReady,
    isMeterSourceAuthorized: deps.isMeterSourceAuthorized,
    isTornDown, isActuationFenced, flushDeferredShortfallSideEffect,
  });

  // Initial signals build awaits the shared snapshot warmup gate; contained.
  startHomeCapacityBundle(planService, logger, home, capacityScalars);

  return buildHomeCapacityBundleApi({
    ctx, homeId, logger, timerKey,
    guard, planEngine, planService, scope,
    // The registry's RAW predicates: unlike the scope's execution predicate they
    // arm no source recovery, so the read surface stays inert. Listed
    // explicitly rather than passed as `deps`, so the declared two-key shape and
    // the runtime object cannot disagree (the consumer spreads this).
    readDryRunGates: {
      isMembershipReady: deps.isMembershipReady,
      isMeterSourceAuthorized: deps.isMeterSourceAuthorized,
    },
    tracker, pipeline, planRebuildScheduler, planRebuildThrottle, capacityStore,
    applyMembershipReadyEdge, markPreparedOwnershipGenerationReconciled,
    getHome: () => home,
    setHome: (next) => { home = next; },
    getScalars: () => capacityScalars,
    setScalars: (next) => { capacityScalars = next; },
    getStableSampleRevision: () => pipeline.getStableSampleRevision(),
    beginPreparedOwnershipReconcile, flushDeferredShortfallSideEffect, isTornDown,
    markTornDown: () => { tornDown = true; },
    reloadModeCatalog: modeCatalog.reload,
    isModeCatalogInitialized: modeCatalog.isInitialized,
  });
}
