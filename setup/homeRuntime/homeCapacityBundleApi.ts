/**
 * The per-home capacity bundle's public handle (multi-home R7b). Split out of
 * `createHomeCapacityBundle` so that factory stays within the setup-layer
 * per-function/per-file size ceilings. Every handler closes over the passed
 * service handles; the bundle's mutable state (`home`, capacity scalars, sample
 * revision, teardown fence) is reached through getter/setter closures so it
 * stays owned by the factory. Type imports are erased at compile time.
 */
import { normalizeError } from '../../lib/utils/errorUtils';
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

export function buildHomeCapacityBundleApi(params: {
  ctx: AppContext;
  homeId: HomeId;
  logger: () => ReturnType<AppContext['getStructuredLogger']>;
  timerKey: (suffix: string) => string;
  guard: CapacityGuard;
  planEngine: ReturnType<typeof createPlanEngine>;
  planService: PlanService;
  scope: HomeScope;
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
}): HomeCapacityBundle {
  const {
    ctx, homeId, logger, timerKey, guard, planEngine, planService, scope, tracker,
    pipeline, planRebuildScheduler, capacityStore, applyMembershipReadyEdge,
    markPreparedOwnershipGenerationReconciled,
    getHome, setHome, getScalars, setScalars,
    getStableSampleRevision, beginPreparedOwnershipReconcile,
    flushDeferredShortfallSideEffect, isTornDown, markTornDown,
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
  return {
    homeId,
    isTornDown,
    getHomeConfig: () => ({ ...getHome() }),
    getMeterDeviceId: () => getHome().meterDeviceId,
    getDiagnostics: () => ({
      homeId,
      meterDeviceId: getHome().meterDeviceId,
      capacityScalars: { ...getScalars() },
      dryRunEffective: scope.getCapacityDryRun(),
      lastMeterPowerKw: guard.getLastTotalPower(),
      lastDeviceControlledMs: { ...planEngine.state.lastDeviceControlledMs },
    }),
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
      rebuild: (reason) => planService.rebuildPlanFromCache(reason),
      // The scope's EFFECTIVE posture, which also covers not-membership-ready
      // and not-source-authorized — both states where this home is observing
      // without controlling, so an off device is not evidence of a user action.
      isDryRun: () => scope.getCapacityDryRun(),
    }),
    updateHomeConfig: (next) => {
      setHome(next);
    },
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
