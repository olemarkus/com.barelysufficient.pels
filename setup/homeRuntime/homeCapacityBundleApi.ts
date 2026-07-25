/**
 * The per-home capacity bundle's public handle (multi-home R7b). Split out of
 * `createHomeCapacityBundle` so that factory stays within the setup-layer
 * per-function/per-file size ceilings. Every handler closes over the passed
 * service handles; the bundle's mutable state (`home`, capacity scalars, sample
 * revision, teardown fence) is reached through getter/setter closures so it
 * stays owned by the factory. The type imports from `createHomeCapacityBundle`
 * are erased at compile time (no runtime cycle).
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
  SuffixedTrackerPersistence,
} from './createHomeCapacityBundle';

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
  getHome: () => SubHomeConfig;
  setHome: (home: SubHomeConfig) => void;
  getScalars: () => CapacityScalarSettings;
  setScalars: (scalars: CapacityScalarSettings) => void;
  bumpSampleRevision: () => void;
  isTornDown: () => boolean;
  markTornDown: () => void;
}): HomeCapacityBundle {
  const {
    ctx, homeId, logger, timerKey, guard, planEngine, planService, scope, tracker,
    pipeline, planRebuildScheduler, capacityStore, applyMembershipReadyEdge,
    getHome, setHome, getScalars, setScalars, bumpSampleRevision, isTornDown, markTornDown,
  } = params;
  return {
    homeId,
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
      const meterChanged = getHome().meterDeviceId !== next.meterDeviceId;
      setHome(next);
      // In-place meter swap (same homeId — P2#3): the guard + tracker still hold
      // the OLD meter's last total and freshness stamp. Clear both so a rebuild
      // before the new meter's first reading cannot shed/restore on the stale
      // load, and the freshness heartbeat cannot age that stale stamp into a
      // fail-closed shed. The new meter's first sample re-primes both.
      if (meterChanged) {
        guard.resetLastTotalPower();
        tracker.resetFreshness();
      }
    },
    applyMembershipReadyEdge,
    recordMeterSample: (powerW, sampleNowMs) => {
      if (isTornDown()) return;
      // Stamp the sample BEFORE the async ingest so a ready-edge rebuild already
      // in flight sees the revision move and aborts its now-stale decision (P1-5).
      bumpSampleRevision();
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
    teardown: () => {
      // Setting the fence FIRST nulls the actuator seam and gates the suffixed
      // writers/tracker-save, so any in-flight rebuild/reconcile/heartbeat/sample
      // continuation dispatched before this point can neither actuate nor persist.
      markTornDown();
      planRebuildScheduler.cancelAll('home_bundle_teardown');
      ctx.timers.clear(timerKey('planRebuild'));
      ctx.timers.clear(timerKey('noTreeWarn'));
      ctx.timers.clear(timerKey('freshnessHeartbeat'));
      tracker.stopAndFlush();
      logger()?.info({ event: 'home_capacity_bundle_torn_down', homeId });
    },
  };
}
