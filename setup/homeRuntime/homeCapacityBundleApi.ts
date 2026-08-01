/**
 * The per-home capacity bundle's public handle (multi-home R7b). Split out of
 * `createHomeCapacityBundle` so that factory stays within the setup-layer
 * per-function/per-file size ceilings. Every handler closes over the passed
 * service handles; the bundle's mutable state (`home`, capacity scalars, sample
 * revision, teardown fence) is reached through getter/setter closures so it
 * stays owned by the factory. Type imports are erased at compile time.
 */
import { normalizeError } from '../../lib/utils/errorUtils';
// Re-exported, not re-implemented: the blank-name rule belongs in shared-domain
// next to the home names so the settings UI answers it identically (it cannot
// import `setup/**`). It travels through this module only because
// `createHomeCapacityBundle.ts` sits at its 20/20 `import-x/max-dependencies`
// ceiling and already depends on this one.
export { resolveHomeAreaDisplayName } from '../../packages/shared-domain/src/homeNames';
import type { AppContext } from '../../lib/app/appContext';
import type { SubHomeConfig } from '../../lib/home/homeConfig';
import type { HomeId } from '../../lib/utils/settingsKeys';
import type { CapacityScalarSettings } from '../../lib/power/capacitySettingsStore';
import type { PlanService } from '../../lib/plan/planService';
import type CapacityGuard from '../../lib/power/capacityGuard';
import type { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import type { createPlanEngine } from '../appInit/createPlanEngine';
import type { createCapacitySettingsStore } from '../capacitySettingsStoreAdapter';
import type { createHomePowerPipeline } from './createHomePowerPipeline';
import type { HomeScope } from './homeScope';
import type {
  HomeCapacityBundle,
  HomeCapacityBundleDeps,
  HomeCapacityBundleDiagnostics,
} from './createHomeCapacityBundle';
import type { SuffixedTrackerPersistence } from './suffixedTrackerPersistence';
import type { StableSampleRevision } from '../powerSamplePipeline';

export type PreparedBundleSampleFence = {
  bindReader: (reader: () => StableSampleRevision) => void;
  begin: (sampleRevision: number) => () => void;
  isActive: () => boolean;
  isSuperseded: () => boolean;
};

/**
 * Reference-counted final-actuator fence for prepared sub-home plan work.
 * Handles are identity-keyed so ending one overlapping reconcile cannot remove
 * another reconcile's protection, even when both use the same sample revision.
 */
export const createPreparedBundleSampleFence = (): PreparedBundleSampleFence => {
  const activeRevisions = new Map<symbol, number>();
  let readStableRevision = (): StableSampleRevision => ({ state: 'stable', revision: 0 });
  return {
    bindReader: (reader) => { readStableRevision = reader; },
    begin: (sampleRevision) => {
      const handle = Symbol('preparedBundleReconcile');
      activeRevisions.set(handle, sampleRevision);
      return () => { activeRevisions.delete(handle); };
    },
    isActive: () => activeRevisions.size > 0,
    isSuperseded: () => {
      if (activeRevisions.size === 0) return false;
      const current = readStableRevision();
      return current.state !== 'stable'
        || [...activeRevisions.values()].some((revision) => revision !== current.revision);
    },
  };
};

export const startHomeCapacityBundle = (
  planService: PlanService,
  logger: () => ReturnType<AppContext['getStructuredLogger']>,
  home: SubHomeConfig,
  capacityScalars: CapacityScalarSettings,
): void => {
  void planService.rebuildPlanFromCache('home_bundle_created').catch((error: unknown) => {
    logger()?.error({
      event: 'home_bundle_initial_rebuild_failed',
      homeId: home.homeId,
      err: normalizeError(error),
    });
  });
  logger()?.info({
    event: 'home_capacity_bundle_created',
    homeId: home.homeId,
    meterDeviceId: home.meterDeviceId,
    limitKw: capacityScalars.limitKw,
    dryRun: capacityScalars.dryRun,
  });
};

const isStableRevision = (sample: StableSampleRevision, revision: number): boolean => (
  sample.state === 'stable' && sample.revision === revision
);

const buildOwnershipGenerationOperations = (params: {
  homeId: HomeId;
  logger: () => ReturnType<AppContext['getStructuredLogger']>;
  planService: PlanService;
  isTornDown: () => boolean;
  getStableSampleRevision: () => StableSampleRevision;
  beginPreparedOwnershipReconcile: (sampleRevision: number) => () => void;
  markPreparedOwnershipGenerationReconciled: () => void;
  flushDeferredShortfallSideEffect: () => Promise<boolean>;
}): Pick<
  HomeCapacityBundle,
  'rebuildForMembershipChange'
  | 'prepareOwnershipGeneration'
  | 'isPreparedOwnershipGenerationCurrent'
  | 'reconcilePreparedOwnershipGeneration'
> => {
  const {
    homeId,
    logger,
    planService,
    isTornDown,
    getStableSampleRevision,
    beginPreparedOwnershipReconcile,
    markPreparedOwnershipGenerationReconciled,
    flushDeferredShortfallSideEffect,
  } = params;
  const rebuildMembershipPlan = async (): Promise<boolean> => {
    if (isTornDown()) return false;
    try {
      const outcome = await planService.rebuildPlanFromCache('home_membership_changed');
      return !outcome.failed && !isTornDown();
    } catch (error: unknown) {
      logger()?.error({
        event: 'home_membership_bundle_rebuild_failed',
        homeId,
        err: normalizeError(error),
      });
      return false;
    }
  };
  return {
    rebuildForMembershipChange: rebuildMembershipPlan,
    prepareOwnershipGeneration: async () => {
      const sample = getStableSampleRevision();
      if (sample.state === 'pending') return sample;
      const rebuilt = await rebuildMembershipPlan();
      const current = getStableSampleRevision();
      return rebuilt
        && current.state === 'stable'
        && current.revision === sample.revision
        ? sample
        : { state: 'pending' };
    },
    isPreparedOwnershipGenerationCurrent: (sampleRevision) => (
      !isTornDown() && isStableRevision(getStableSampleRevision(), sampleRevision)
    ),
    reconcilePreparedOwnershipGeneration: async (sampleRevision) => {
      let aborted = false;
      const endPreparedReconcile = beginPreparedOwnershipReconcile(sampleRevision);
      try {
        await planService.reconcileLatestPlanState(
          () => {
            const current = getStableSampleRevision();
            return isTornDown()
              || current.state !== 'stable'
              || current.revision !== sampleRevision;
          },
          () => { aborted = true; },
        );
      } finally {
        endPreparedReconcile();
      }
      const stable = getStableSampleRevision();
      const current = !aborted
        && !isTornDown()
        && stable.state === 'stable'
        && stable.revision === sampleRevision;
      const sideEffectFlushed = current && await flushDeferredShortfallSideEffect();
      if (sideEffectFlushed) markPreparedOwnershipGenerationReconciled();
      return sideEffectFlushed;
    },
  };
};

/**
 * Rebuild after this area's coherent catalog snapshot reloads. The explicit
 * trigger matters for a silent-meter area, which may receive no power-driven
 * rebuild after a mode change. Also serves legacy Main-following areas until
 * marker-last migration completes.
 */
const buildSettingsRebuild = (params: {
  homeId: HomeId;
  logger: () => ReturnType<AppContext['getStructuredLogger']>;
  planService: PlanService;
  isTornDown: () => boolean;
  reason: string;
  failureEvent: string;
}): (() => void) => () => {
  if (params.isTornDown()) return;
  // `rebuildPlanFromCache` CONTAINS planner errors and resolves `failed: true`
  // (the catch below only sees non-contained throws), so the resolved outcome
  // must be inspected too — the `home_membership_bundle_rebuild_failed` site
  // above is the precedent. No retry here: the next mode/settings write or
  // power-sample rebuild re-runs the closures, and the log makes the miss
  // visible instead of silent.
  void params.planService.rebuildPlanFromCache(params.reason).then((outcome) => {
    if (!outcome.failed || params.isTornDown()) return;
    params.logger()?.error({
      event: params.failureEvent,
      homeId: params.homeId,
    });
  }).catch((error: unknown) => {
    params.logger()?.error({
      event: params.failureEvent,
      homeId: params.homeId,
      err: normalizeError(error),
    });
  });
};

/**
 * The canonical effective no-actuation switch: both external trust boundaries
 * fold into the persisted per-home toggle — membership must be committed and
 * this meter-bearing source epoch must be authorized before writes are enabled.
 *
 * Parameterized by the source predicate ON PURPOSE. The bundle's EXECUTION
 * predicate arms a source-recovery retry (rebuild + reconcile) as a side effect
 * of being asked, so only the control path may pass it; the READ seam passes
 * the registry's raw predicate and gets the same value with no side effect.
 * Lives here rather than in a new file because `createHomeCapacityBundle.ts`
 * already value-imports this module and is at its `import-x/max-dependencies`
 * ceiling.
 */
export const resolveEffectiveDryRun = (params: {
  isTornDown: () => boolean;
  isMembershipReady: () => boolean;
  isMeterSourceAuthorized: () => boolean;
  getScalars: () => CapacityScalarSettings;
}): boolean => (
  params.isTornDown()
  || !params.isMembershipReady()
  || !params.isMeterSourceAuthorized()
  || params.getScalars().dryRun
);

/**
 * The bundle's READ surface: the diagnostics block plus the already-committed
 * view the per-home settings-UI read seam serves (`lib/home/homeRuntimeRead.ts`).
 * Both are pure reads — no rebuild, no snapshot refresh/decorate, no actuation,
 * and no timer armed. That is why the dry-run value arrives as
 * `readEffectiveDryRun` instead of through the scope: `scope.getCapacityDryRun`
 * routes the source check through the execution predicate, which schedules a
 * recovery rebuild+reconcile when the source is unauthorized — a UI poll
 * landing in a transient `power_source` read failure would otherwise start
 * background actuation work.
 *
 * Deliberately NO device list either: `scope.getPlanDevices()` seeds observed
 * state, evicts caches and decorates the whole snapshot, so serving it here
 * would turn a UI poll into a snapshot rebuild.
 */
const buildHomeCapacityBundleReads = (params: {
  homeId: HomeId;
  guard: CapacityGuard;
  planEngine: ReturnType<typeof createPlanEngine>;
  planService: PlanService;
  readEffectiveDryRun: () => boolean;
  /** THIS home's effective mode (scope accessor — pure resolution, no recovery arming). */
  getOperatingMode: () => string;
  tracker: SuffixedTrackerPersistence;
  getHome: () => SubHomeConfig;
  getScalars: () => CapacityScalarSettings;
}): Pick<HomeCapacityBundle, 'getDiagnostics' | 'getReadModel'> => {
  const {
    homeId, guard, planEngine, planService, readEffectiveDryRun, getOperatingMode, tracker, getHome, getScalars,
  } = params;
  const readDiagnostics = (): HomeCapacityBundleDiagnostics => ({
    homeId,
    meterDeviceId: getHome().meterDeviceId,
    operatingMode: getOperatingMode(),
    capacityScalars: { ...getScalars() },
    dryRunEffective: readEffectiveDryRun(),
    lastMeterPowerKw: guard.getLastTotalPower(),
    lastDeviceControlledMs: { ...planEngine.state.lastDeviceControlledMs },
  });
  return {
    getDiagnostics: readDiagnostics,
    getReadModel: () => ({
      homeId,
      // Re-serializes the STORED snapshot; it does not plan.
      plan: planService.getLatestPlanSnapshotForUi(),
      planUpdatedAtMs: planService.getLatestPlanSnapshotUpdatedAtMs(),
      powerTracker: tracker.getState(),
      diagnostics: readDiagnostics(),
    }),
  };
};

/**
 * Composes the read surface for one bundle: the RAW registry gates resolved
 * into `readEffectiveDryRun` here, in one place, so the call site cannot pass
 * the scope's recovery-arming execution predicate by mistake. Named, not
 * spread: `isTornDown` is bundle-local and must never be shadowed by a
 * same-named key arriving from the registry side.
 */
const buildScopedBundleReads = (params: {
  homeId: HomeId;
  guard: CapacityGuard;
  planEngine: ReturnType<typeof createPlanEngine>;
  planService: PlanService;
  tracker: SuffixedTrackerPersistence;
  getHome: () => SubHomeConfig;
  getScalars: () => CapacityScalarSettings;
  getOperatingMode: () => string;
  isTornDown: () => boolean;
  readDryRunGates: { isMembershipReady: () => boolean; isMeterSourceAuthorized: () => boolean };
}): Pick<HomeCapacityBundle, 'getDiagnostics' | 'getReadModel'> => {
  const { isTornDown, readDryRunGates, getScalars } = params;
  return buildHomeCapacityBundleReads({
    homeId: params.homeId,
    guard: params.guard,
    planEngine: params.planEngine,
    planService: params.planService,
    getOperatingMode: params.getOperatingMode,
    tracker: params.tracker,
    getHome: params.getHome,
    getScalars,
    readEffectiveDryRun: () => resolveEffectiveDryRun({
      isTornDown,
      isMembershipReady: readDryRunGates.isMembershipReady,
      isMeterSourceAuthorized: readDryRunGates.isMeterSourceAuthorized,
      getScalars,
    }),
  });
};

type HomeCapacityBundleApiParams = {
  ctx: AppContext;
  homeId: HomeId;
  logger: () => ReturnType<AppContext['getStructuredLogger']>;
  timerKey: (suffix: string) => string;
  guard: CapacityGuard;
  planEngine: ReturnType<typeof createPlanEngine>;
  planService: PlanService;
  scope: HomeScope;
  /**
   * The registry's RAW membership/source predicates. The scope's execution
   * predicate arms a source-recovery rebuild+reconcile as a side effect of
   * being asked, so the READ surface resolves its dry-run through these.
   */
  readDryRunGates: Pick<HomeCapacityBundleDeps, 'isMembershipReady' | 'isMeterSourceAuthorized'>;
  tracker: SuffixedTrackerPersistence;
  pipeline: ReturnType<typeof createHomePowerPipeline>;
  planRebuildScheduler: PlanRebuildScheduler;
  capacityStore: ReturnType<typeof createCapacitySettingsStore>;
  applyMembershipReadyEdge: () => void;
  markPreparedOwnershipGenerationReconciled: () => void;
  getHome: () => SubHomeConfig;
  setHome: (home: SubHomeConfig) => void;
  getScalars: () => CapacityScalarSettings;
  setScalars: (scalars: CapacityScalarSettings) => void;
  getStableSampleRevision: () => StableSampleRevision;
  beginPreparedOwnershipReconcile: (sampleRevision: number) => () => void;
  flushDeferredShortfallSideEffect: () => Promise<boolean>;
  isTornDown: () => boolean;
  markTornDown: () => void;
  reloadModeCatalog: (allowPendingOwnershipGeneration?: boolean) => void;
  isModeCatalogInitialized: () => boolean;
};

export function buildHomeCapacityBundleApi(params: HomeCapacityBundleApiParams): HomeCapacityBundle {
  const {
    ctx, homeId, logger, timerKey, guard, planEngine, planService, scope, tracker,
    readDryRunGates,
    pipeline, planRebuildScheduler, capacityStore, applyMembershipReadyEdge,
    markPreparedOwnershipGenerationReconciled,
    getHome, setHome, getScalars, setScalars,
    getStableSampleRevision, beginPreparedOwnershipReconcile,
    flushDeferredShortfallSideEffect, isTornDown, markTornDown,
    reloadModeCatalog, isModeCatalogInitialized,
  } = params;
  const ownershipGenerationOperations = buildOwnershipGenerationOperations({
    homeId,
    logger,
    planService,
    isTornDown,
    getStableSampleRevision,
    beginPreparedOwnershipReconcile,
    markPreparedOwnershipGenerationReconciled,
    flushDeferredShortfallSideEffect,
  });
  const readOperations = buildScopedBundleReads({
    homeId, guard, planEngine, planService, tracker, getHome, getScalars, isTornDown, readDryRunGates,
    // The scope's mode accessor: pure resolution + edge-triggered transition
    // log, no recovery arming — safe on the read surface (unlike its dry-run).
    getOperatingMode: scope.getOperatingMode,
  });
  return {
    homeId,
    isTornDown,
    getHomeConfig: () => ({ ...getHome() }),
    getMeterDeviceId: () => getHome().meterDeviceId,
    ...readOperations,
    // Realtime-reconcile routing (P1#1): the wrapper binds these when a drifting
    // device resolves to THIS home. `getLiveDevices` reuses the scope's own
    // membership-filtered, own-engine pending-binary plan view (NOT main's
    // `toPlanDevice`), so the drift check reads this bundle's device set exactly.
    getReconcileHooks: () => ({
      getLatestPlanSnapshot: () => planService.getLatestReconcilePlanSnapshot(),
      getLiveDevices: () => scope.getPlanDevices(),
      reconcile: () => planService.reconcileLatestPlanState(),
      // External-off hold: both must come from THIS bundle. Main's pending store
      // never saw this device's commands, so it would report PELS's own write as
      // an outside action; main's plan does not contain the device at all.
      hasPendingBinaryCommand: (deviceId, capabilityId) => (
        planEngine.hasPendingBinaryCommandForCapability(deviceId, capabilityId)
      ),
      clearRecentBinaryOffCommand: (deviceId, capabilityId) => (
        planEngine.clearRecentBinaryOffCommandForCapability(deviceId, capabilityId)),
      rebuild: (reason) => planService.rebuildPlanFromCache(reason),
    }),
    updateHomeConfig: (next) => {
      setHome(next);
    },
    rebuildForModeSettingsChange: buildSettingsRebuild({
      homeId,
      logger,
      planService,
      isTornDown,
      reason: 'settings:mode_targets',
      failureEvent: 'home_mode_targets_rebuild_failed',
    }),
    rebuildForDeviceControlSettingsChange: buildSettingsRebuild({
      homeId,
      logger,
      planService,
      isTornDown,
      reason: 'settings:temperature_control_disabled_devices',
      failureEvent: 'home_device_control_settings_rebuild_failed',
    }),
    reloadModeCatalog,
    isModeCatalogInitialized,
    applyMembershipReadyEdge,
    ...ownershipGenerationOperations,
    flushDeferredShortfallSideEffect,
    recordMeterSample: (powerW, sampleNowMs) => {
      if (isTornDown()) return;
      // The ready-edge is DECOUPLED from sample arrival (also fired by the
      // registry from the tree-commit transition, so it works in flow mode). We
      // ALSO retry it after each ingest: a ready-edge that failed or was
      // superseded re-armed its latch, and the next settled sample re-applies the
      // fresh committed decision (a no-op once latched).
      void pipeline.recordPowerSample(powerW, sampleNowMs)
        .then(() => { applyMembershipReadyEdge(); })
        .catch((error: unknown) => {
          logger()?.error({ event: 'home_meter_sample_failed', homeId, err: normalizeError(error) });
        });
    },
    reloadCapacityScalars: () => {
      if (isTornDown()) return;
      const wasDryRun = getScalars().dryRun;
      const next = capacityStore.read();
      setScalars(next);
      guard.setLimit(next.limitKw);
      guard.setSoftMargin(next.marginKw);
      // Sub-homes DEFAULT dry_run=true, so flipping it false is the normal
      // ACTIVATION path (P2#2). A plain rebuild after that transition can produce
      // the SAME action signature as the never-applied dry-run shed plan, and
      // `maybeApplyPlanChanges` skips unchanged planned sheds (stable actuation
      // does not cover shed actions) — so the home would stay over cap without
      // ever issuing the already-planned command. Force the committed intent to
      // actuate via reconcile (drift = device still ON while the plan sheds),
      // exactly as the membership-ready edge does. Reconcile self-guards on the
      // EFFECTIVE dry-run, so it no-ops if the boot-window membership gate still
      // holds (the ready-edge applies it later).
      const activatedActuation = wasDryRun && !next.dryRun;
      // Direct rebuild, mirroring the main home's settings path
      // (`handleCapacityLimitChange` also bypasses the sample scheduler).
      void planService.rebuildPlanFromCache('settings:home_capacity_scalars')
        .then((outcome) => (activatedActuation && !outcome.failed
          ? planService.reconcileLatestPlanState()
          : undefined))
        .catch((error: unknown) => {
          logger()?.error({ event: 'home_capacity_reload_rebuild_failed', homeId, err: normalizeError(error) });
        });
    },
    reloadPowerTracker: () => {
      if (isTornDown()) return;
      tracker.reloadFromSettings();
    },
    teardown: (options) => {
      // A failed durable reset leaves this runtime fenced but retained by the
      // registry as a tombstone. Repeated teardown(reset) calls are therefore
      // the retry seam: the in-memory tracker is already cleared, and only its
      // safety write is attempted again.
      if (isTornDown()) {
        return options?.resetMeterFreshness !== true || tracker.resetFreshness();
      }
      // Setting the fence FIRST nulls the actuator seam and gates the suffixed
      // writers/tracker-save, so any in-flight rebuild/reconcile/heartbeat/sample
      // continuation dispatched before this point can neither actuate nor persist.
      markTornDown();
      planRebuildScheduler.cancelAll('home_bundle_teardown');
      ctx.timers.clear(timerKey('planRebuild'));
      ctx.timers.clear(timerKey('noTreeWarn'));
      ctx.timers.clear(timerKey('freshnessHeartbeat'));
      ctx.timers.clear(timerKey('membershipReadyApplyRetry'));
      ctx.timers.clear(timerKey('shortfallSideEffectRetry'));
      // One key per alert lane, named here and in `createHomeCapacityBundle`.
      ctx.timers.clear(timerKey('shortfallAlertImmediate'));
      ctx.timers.clear(timerKey('shortfallAlertSustained'));
      ctx.timers.clear(timerKey('sourceActuationRetry'));
      tracker.stopAndFlush();
      // Flush the final accepted old-identity sample first, then overwrite only
      // its freshness latch. A late old pipeline save is fenced by `markTornDown`.
      const resetSucceeded = options?.resetMeterFreshness !== true || tracker.resetFreshness();
      logger()?.info({ event: 'home_capacity_bundle_torn_down', homeId });
      return resetSucceeded;
    },
  };
}
