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
import type { SubHomeBundle } from '../../lib/home/homeRuntimeRegistry';
import type {
  PowerTrackerMeterIdentity,
  PowerTrackerState,
} from '../../lib/power/trackerTypes';
import type { PlanService } from '../../lib/plan/planService';
import { decorateWithoutDeferredObjectives } from '../../lib/plan/planBuilderDecoration';
import type CapacityGuard from '../../lib/power/capacityGuard';
import { createHomeRebuildRuntime } from '../../lib/plan/rebuildScheduler/homeRebuildRuntime';
import { createCapacitySettingsStore } from '../../lib/power/capacitySettingsStore';
import type { PlanEngine } from '../../lib/plan/planEngine';
import { buildHomePlanDevices } from './planDevicePrePass';
import { createHomePowerPipeline, createUnobservedHomeProduction } from './createHomePowerPipeline';
import { MeterSilenceMonitor } from '../../lib/power/meterSilence';
import { buildHomeCapacityBundleApi, startHomeCapacityBundle } from './homeCapacityBundleApi';
import { resolveHomeAreaDisplayName } from '../../packages/shared-domain/src/homeNames';
import { MeterSilenceEscalation } from '../../lib/power/meterSilenceEscalation';
import { requireDeviceManager } from '../appInit/contextGuards';
import {
  createHomeModeCatalog,
  type HomeModeCatalog,
} from '../../lib/home/homeModeCatalog';
import type { SubHomeRecoveryDeps } from '../../lib/home/subHomeRecovery';
import { SubHomeMembershipReadyEdge } from '../../lib/home/subHomeMembershipReadyEdge';
import { SubHomeSourceRecovery } from '../../lib/home/subHomeSourceRecovery';
import { SubHomeOwnershipGeneration } from '../../lib/home/subHomeOwnershipGeneration';
import type { HomeScope } from './homeScope';
import { createHomePlanRuntime } from './createHomePlanRuntime';
import { createHomeCommandReachability } from './createHomeCommandReachability';
import { createHomeSignalWriters } from './homeSignalWriters';
import {
  createHomeTrackerPersistence,
  type HomeTrackerPersistence,
  type HomeTrackerPersistenceDeps,
} from '../../lib/power/homeTrackerPersistence';
import type { SubHomeRuntime } from '../../lib/home/subHomeRuntime';
import { createHomeCapacityGuard } from './createHomeCapacityGuard';
import type { PlanRebuildTrigger } from '../../lib/plan/planRebuildTrigger';
import { PriceLevel } from '../../lib/price/priceLevels';

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
  syncLivePlanState: PlanService['syncLivePlanState'];
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
  /**
   * Whether the device's move can change the load THIS home's latest plan
   * found actionable, which decides whether its observation may clear the
   * suppressions above. Main's plan does not contain this device, so main
   * would say "no".
   */
  canDeviceChangeActionableLoad: (deviceId: string) => boolean;
  /**
   * Whether THIS home's latest plan has the device limited by setpoint. Asked by
   * the mode-target adoption path, which must not save an owner's reaction to a
   * limit; main's plan does not contain this device, so main would say "no".
   */
  isDeviceLimited: (deviceId: string) => boolean;
};

/** One sub-home's bundle: lib/home's contract, routing through this area's plan seams. */
export type HomeCapacityBundle = SubHomeBundle<OwningHomeHooks> & {
  /**
   * Reload the capacity scalars into the guard + request a rebuild. The
   * factory below asks it once, when the area's first read was unavailable.
   */
  reloadCapacityScalars: () => void;
};

// The sub-home `HomeScope`: capacity-only policy block, suffixed persisted-
// signal writers, membership-partitioned plan input (fail-closed for sub-home
// scopes — see `filterDevicesForHome`). `getServiceForSync` and
// `getPlanEngineForCommandProvenance` are late-bound: the bundle's OWN service
// and engine are created after the scope (the engine is read for the sub-home
// PELS-OFF provenance cleanup).
function buildSubHomeScope(
  ctx: AppContext,
  runtime: SubHomeRuntime,
  getPowerTracker: () => PowerTrackerState,
  getServiceForSync: () => PlanService | undefined,
  getPlanEngineForCommandProvenance: () => PlanEngine | undefined,
  modeCatalog: HomeModeCatalog,
  meterSilenceMonitor: MeterSilenceMonitor,
): HomeScope {
  const { homeId, isTornDown } = runtime;
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
    // Live read: a rename lands via `updateHomeConfig` without a teardown.
    getHomeDisplayName: () => resolveHomeAreaDisplayName(runtime.getHomeConfig().name),
    getCapacitySettings: () => {
      const { dryRun: _dryRun, ...capacitySettings } = runtime.getCapacityScalars();
      return capacitySettings;
    },
    // The canonical no-actuation switch. This is the CONTROL path, so it asks
    // the execution form — the one that also arms source recovery.
    getCapacityDryRun: runtime.isEffectiveDryRunForExecution,
    readSimulationSetting: () => runtime.getCapacityScalars().dryRun,
    getPowerTracker,
    getMeterSilenceMonitor: () => meterSilenceMonitor,
    getDailyBudgetSnapshot: () => null,
    getPlanDevices: () => {
      // Capacity-only overrides: NO surplus posture (a sub-home has no
      // price/surplus signal, so a surplusWilling device would be held OFF
      // forever), and the PELS-OFF provenance cleanup routed to THIS bundle's
      // engine (not MAIN's via `ctx.planEngine`).
      return buildHomePlanDevices(ctx, homeId, {
        surplusPostureEnabled: false,
        // Home-battery control is Main only (v1).
        storage: { kind: 'none' },
        getPrioritiesForDevices: modeCatalog.getPrioritiesForDevices,
        clearRecentBinaryOffCommand: (id, observedOnAtMs) => getPlanEngineForCommandProvenance()
          ?.clearRecentBinaryOffCommand(id, observedOnAtMs),
        projectCommandability: binaryCommandReachability.project,
        pruneCommandability: binaryCommandReachability.prune,
      });
    },
    // Home-battery control is Main only (v1): no battery here is watched for control.
    isBatteryWatchOnly: () => false,
    binaryCommandLifecycle: binaryCommandReachability.lifecycle,
    disposeBinaryCommandReachability: binaryCommandReachability.dispose,
    // Teardown fence: a post-teardown continuation cannot persist a suffixed key.
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
    // bind live for every home. Binding them to `{}` made the kept setpoint
    // fall back to the device's live setpoint (`lib/thermostat/temperatureSetpoints.ts`); while
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
    getOperatingMode: modeCatalog.getOperatingMode,
    getModeDeviceTargets: modeCatalog.getModeDeviceTargets,
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
function createBundleSamplePipeline(
  ctx: AppContext,
  scope: HomeScope,
  timerKey: (suffix: string) => string,
  planEngine: PlanEngine,
  planService: PlanService,
  guard: CapacityGuard,
  tracker: HomeTrackerPersistence,
) {
  const { scheduler, throttle } = createHomeRebuildRuntime(
    scope.homeId,
    ctx.timers,
    timerKey,
    () => guard,
    () => planService,
    () => ctx.getStructuredLogger('plan'),
    (topic) => ctx.debugLoggingTopics.has(topic),
  );
  const pipeline = createHomePowerPipeline({
    ctx,
    homeId: scope.homeId,
    planRebuildThrottle: throttle,
    getPlanEngine: () => planEngine,
    getPlanService: () => planService,
    savePowerTracker: tracker.save,
    getPowerTracker: tracker.getState,
    getCapacitySettings: scope.getCapacitySettings,
    getCapacityGuard: () => guard,
    // A meter area's meter is not the whole-home meter, so this area has no
    // identity to publish into membership's sampled-meter ownership fence —
    // adopting one would settle or latch MAIN's write fence from a meter Main
    // does not own. Its samples also carry no identity to publish
    // (`recordMeterSample` ingests bare watts), so this is the second of two
    // independent guards rather than the only one.
    noteResolvedHomeMeter: () => {},
    // No weather/PV/curtailment taps for sub-homes: a sub-home meter's net W is
    // not the home's grid power — feeding it to those estimators would corrupt them.
    // Nor the main home's production: this home reads none of its own.
    observedHomePower: createUnobservedHomeProduction(),
  });
  return { pipeline, scheduler, throttle };
}

function createBundlePlanningRuntime(
  ctx: AppContext,
  runtime: SubHomeRuntime,
  timerKey: (suffix: string) => string,
  tracker: HomeTrackerPersistence,
  modeCatalog: HomeModeCatalog,
) {
  // This home's meter-silence policy: shared by the composed plan-build gate
  // (via the scope), the pipeline's admitted-sample push, and the freshness
  // escalation's shed-pass protocol.
  const meterSilenceMonitor = new MeterSilenceMonitor({
    homeId: runtime.homeId,
    getPowerTracker: tracker.getState,
    nowMs: () => Date.now(),
    structuredLog: () => ctx.getStructuredLogger('power'),
  });
  const scope = buildSubHomeScope(
    ctx, runtime, tracker.getState, () => planService, () => planEngine, modeCatalog, meterSilenceMonitor,
  );
  // The pipeline is built below; its prepared-reconcile fence is asked only at
  // actuation, which needs the finished bundle.
  const isActuationFenced = (): boolean => runtime.isActuationFenced(
    () => pipeline.preparedReconcileFence.isSuperseded(),
  );
  // Lifecycle/source authority, composed here for the same reason the main home
  // composes its own at its boot step: an area has two inputs Main does not
  // (membership, meter-source authority), and they are this bundle's signals,
  // not the guard's business. The epoch-discard arm is on the DISCARDED
  // predicate and not on the closed-authority one because an invalidated source
  // epoch never reopens for this runtime — the bundle is torn down before the
  // epoch can commit again — so a transition observed behind it is dropped
  // rather than held for a reopening that will not come.
  const { guard, shortfallSideEffectGate } = createHomeCapacityGuard(
    ctx,
    scope,
    timerKey,
    () => planService,
    runtime.isDiscarded,
    runtime.isAuthorityClosed,
    () => pipeline.preparedReconcileFence.isActive(),
  );
  const { planEngine, planService } = createHomePlanRuntime(
    ctx,
    scope,
    // Home-battery control is Main only (v1): a meter area builds no storage lane.
    { capacityGuard: guard, isActuationFenced, storageLane: { kind: 'none' } },
  );
  const { pipeline, scheduler: planRebuildScheduler, throttle: planRebuildThrottle } = createBundleSamplePipeline(
    ctx, scope, timerKey, planEngine, planService, guard, tracker,
  );
  return {
    scope,
    planEngine,
    planService,
    meterSilenceMonitor,
    flushDeferredShortfallSideEffect: shortfallSideEffectGate.flushAfterPreparedApply,
    holdDeferredShortfallSideEffect: shortfallSideEffectGate.holdDeferredUntilPreparedApply,
    pipeline,
    planRebuildScheduler,
    planRebuildThrottle,
    isActuationFenced,
  };
}

/** A meter area's tracker collaborators, on the app context and this area's runtime. */
function createAreaTrackerDeps(ctx: AppContext, runtime: SubHomeRuntime): HomeTrackerPersistenceDeps {
  const { homeId, isTornDown } = runtime;
  return {
    getStore: () => ctx.getTrackerStore(),
    timers: ctx.timers,
    getLogger: () => ctx.getStructuredLogger('homes'),
    reportError: (message, error) => ctx.error(message, error),
    getTimeZone: () => ctx.getTimeZone(),
    isTornDown,
    onPersisted: () => ctx.emitPowerTrackerPersisted(homeId),
    // A meter area's meter is not the whole-home feed: its export must not
    // arm the Main feed's latch.
    observeExportEvidence: () => {},
  };
}

export function createHomeCapacityBundle(
  ctx: AppContext,
  mainModeCatalog: HomeModeCatalog,
  /** The area's state and the registry's membership and meter-source gates. */
  runtime: SubHomeRuntime,
  /** Already resolved against this meter identity (`requireTrackerForMeter`). */
  initialPowerTrackerState: PowerTrackerState,
  /** Identity every tracker persist from this runtime must carry. */
  powerTrackerMeterIdentity: PowerTrackerMeterIdentity,
): HomeCapacityBundle {
  const { homeId } = runtime;
  const logger = () => ctx.getStructuredLogger('homes');
  const timerKey = (suffix: string) => `home:${homeId}:${suffix}`;

  // The store is constructed ONCE per bundle and is the ONLY capacity source
  // for this scope; its last-good fallback is the runtime's own seed (never
  // Main's live snapshot).
  const capacityStore = createCapacitySettingsStore(ctx.homey.settings, homeId, runtime.getCapacityScalars);
  const initialCapacityRead = capacityStore.read();
  if (initialCapacityRead.state !== 'unavailable') runtime.setCapacityScalars(initialCapacityRead.value);

  const tracker = createHomeTrackerPersistence({
    deps: createAreaTrackerDeps(ctx, runtime),
    homeId,
    initialState: initialPowerTrackerState,
    meterBinding: { kind: 'bound', identity: powerTrackerMeterIdentity },
    timerKey,
  });
  const modeCatalog = createHomeModeCatalog(
    homeId,
    ctx.homey.settings,
    () => mainModeCatalog.getSnapshot(),
    () => ctx.deviceControlSettings.managedDevices,
    () => ctx.homeMembership,
    () => ctx.getStructuredLogger('homes'),
    () => ctx.readHomeBatteryDevices(),
  );
  const {
    scope,
    planEngine,
    isActuationFenced,
    planService,
    flushDeferredShortfallSideEffect,
    holdDeferredShortfallSideEffect,
    pipeline,
    planRebuildScheduler,
    planRebuildThrottle,
    meterSilenceMonitor,
  } = createBundlePlanningRuntime(ctx, runtime, timerKey, tracker, modeCatalog);
  const beginPreparedReconcile = (sampleRevision: number): (() => void) => {
    holdDeferredShortfallSideEffect();
    return pipeline.preparedReconcileFence.begin(sampleRevision);
  };
  const recoveryDeps: SubHomeRecoveryDeps = {
    runtime,
    timers: ctx.timers,
    timerKey,
    getLogger: logger,
    planService,
    pipeline,
    beginPreparedReconcile,
    flushDeferredShortfallSideEffect,
  };
  runtime.bindSourceActuationRetry(new SubHomeSourceRecovery(recoveryDeps).schedule);
  tracker.startPruning();

  // Readiness apply-edge (decoupled from sample arrival; fired by the registry
  // from the membership tree-commit transition) and its no-tree warn timer.
  const membershipReadyEdge = new SubHomeMembershipReadyEdge(recoveryDeps);
  const ownershipGeneration = new SubHomeOwnershipGeneration(recoveryDeps, membershipReadyEdge);
  // This home's one silent-meter clock. Shared with main
  // (`lib/power/meterSilenceEscalation.ts`) so both escalate on the same rule.
  new MeterSilenceEscalation({
    homeId,
    timers: ctx.timers,
    timerKey: timerKey('freshnessHeartbeat'),
    logger,
    rebuild: () => planService.rebuildPlanFromCache('freshness_heartbeat'),
    meterSilence: meterSilenceMonitor,
    isTornDown: runtime.isTornDown,
    // Sub-home meters are fanned out ONLY by the Homey Energy poll
    // (`routeMeterReadings` drops readings under flow), so a bundle whose source
    // has been switched to flow has an orphaned timestamp that will never refresh.
    isMeterSampled: runtime.isMeterSourceAuthorized,
    isSnapshotWarm: () => requireDeviceManager(ctx).hasWarmSnapshot(),
    isActuationFenced,
  }).start();

  // Initial signals build awaits the shared snapshot warmup gate; contained.
  startHomeCapacityBundle(planService, logger, runtime);

  const bundle = buildHomeCapacityBundleApi({
    ctx, runtime, logger, timerKey,
    planEngine, planService, scope,
    tracker, pipeline, planRebuildScheduler, planRebuildThrottle, capacityStore,
    membershipReadyEdge, ownershipGeneration,
    reloadModeCatalog: modeCatalog.reload,
    isModeCatalogInitialized: modeCatalog.isInitialized,
  });
  // The dry-run defaults above are the safe boot posture. Let the API's owned
  // retry lane recover the real scalars before allowing them to drive plans.
  if (initialCapacityRead.state === 'unavailable') bundle.reloadCapacityScalars();
  return bundle;
}
