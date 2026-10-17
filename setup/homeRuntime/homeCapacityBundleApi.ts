/**
 * The per-home capacity bundle's public handle (multi-home R7b). Split out of
 * `createHomeCapacityBundle` so that factory stays within the setup-layer
 * per-function/per-file size ceilings. Every handler closes over the passed
 * service handles; the bundle's mutable state (config, capacity scalars,
 * teardown latch) lives in its `SubHomeRuntime` (`lib/home/subHomeRuntime.ts`).
 * Type imports are erased at compile time.
 */
import { normalizeError } from '../../lib/utils/errorUtils';
import type { AppContext } from '../../lib/app/appContext';
import type { SubHomeRuntime } from '../../lib/home/subHomeRuntime';
import type { SubHomeMembershipReadyEdge } from '../../lib/home/subHomeMembershipReadyEdge';
import type { SubHomeOwnershipGeneration } from '../../lib/home/subHomeOwnershipGeneration';
import type { HomeRuntimeDiagnostics } from '../../lib/home/homeRuntimeRead';
import type { PlanService } from '../../lib/plan/planService';
import { resolveLastTotalPowerKw } from '../../lib/power/lastTotalPower';
import { resolveCurrentMonthQuarterPeakKw } from '../../lib/power/capacityPeak';
import type { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import type { PlanEngine } from '../../lib/plan/planEngine';
import {
  createCapacitySettingsReloader,
  resolveInstalledCapacityScalars,
  type createCapacitySettingsStore,
} from '../../lib/power/capacitySettingsStore';
import type { createHomePowerPipeline } from './createHomePowerPipeline';
import type { HomeScope } from './homeScope';
import type { HomeCapacityBundle } from './createHomeCapacityBundle';
import type { HomeTrackerPersistence } from '../../lib/power/homeTrackerPersistence';
import type { PlanRebuildThrottle } from '../../lib/plan/rebuildScheduler/throttle';
export const startHomeCapacityBundle = (
  planService: PlanService,
  logger: () => ReturnType<AppContext['getStructuredLogger']>,
  runtime: SubHomeRuntime,
): void => {
  void planService.rebuildPlanFromCache('home_bundle_created').catch((error: unknown) => {
    logger()?.error({
      event: 'home_bundle_initial_rebuild_failed',
      homeId: runtime.homeId,
      err: normalizeError(error),
    });
  });
  const { meterDeviceId } = runtime.getHomeConfig();
  const { limitKw, dryRun } = runtime.getCapacityScalars();
  logger()?.info({
    event: 'home_capacity_bundle_created',
    homeId: runtime.homeId,
    meterDeviceId,
    limitKw,
    dryRun,
  });
};

/**
 * Rebuild after this area's coherent catalog snapshot reloads. The explicit
 * trigger matters for a silent-meter area, which may receive no power-driven
 * rebuild after a mode change. Also serves legacy Main-following areas until
 * marker-last migration completes.
 */
/** A contained rebuild lane: identity, logging, the plan service, the fence. */
type HomeRebuildLaneDeps = Pick<HomeCapacityBundleApiParams, 'runtime' | 'logger' | 'planService'>;

const buildSettingsRebuild = (
  params: HomeRebuildLaneDeps,
  settingsSource: string,
  failureEvent: string,
): (() => void) => () => {
  if (params.runtime.isTornDown()) return;
  // `rebuildPlanFromCache` CONTAINS planner errors and resolves `failed: true`
  // (the catch below only sees non-contained throws), so the resolved outcome
  // must be inspected too — the `home_membership_bundle_rebuild_failed` site
  // in `lib/home/subHomeOwnershipGeneration.ts` is the precedent. No retry
  // here: the next mode/settings write or power-sample rebuild re-runs the
  // closures, and the log makes the miss visible instead of silent.
  void params.planService.rebuildPlanFromCache('settings', { detail: settingsSource })
    .then((outcome) => {
      if (!outcome.failed || params.runtime.isTornDown()) return;
      params.logger()?.error({
        event: failureEvent,
        homeId: params.runtime.homeId,
      });
    }).catch((error: unknown) => {
      params.logger()?.error({
        event: failureEvent,
        homeId: params.runtime.homeId,
        err: normalizeError(error),
      });
    });
};

/**
 * What the read surface may touch. `getOperatingMode` is the scope's mode
 * accessor — pure resolution plus an edge-triggered transition log, no recovery
 * arming — lifted out at the call site so the scope itself stays out of reach.
 */
type HomeCapacityBundleReadDeps = Pick<
  HomeCapacityBundleApiParams,
  'ctx' | 'runtime' | 'planEngine' | 'planService' | 'tracker'
> & { getOperatingMode: () => string };

/**
 * The bundle's READ surface: the diagnostics block plus the already-committed
 * view the per-home settings-UI read seam serves (`lib/home/homeRuntimeRead.ts`).
 * Both are pure reads — no rebuild, no snapshot refresh/decorate, no actuation,
 * and no timer armed. `HomeCapacityBundleReadDeps` carries no `scope`, which is
 * what keeps that true structurally rather than by convention:
 * `scope.getCapacityDryRun` routes the source check through the execution
 * predicate, which schedules a recovery rebuild+reconcile when the source is
 * unauthorized — a UI poll landing in a transient `power_source` read failure
 * would otherwise start background actuation work. The read surface therefore
 * resolves its dry-run from the RAW registry gates (`readEffectiveDryRun`).
 *
 * Deliberately NO device list either: `scope.getPlanDevices()` seeds observed
 * state, evicts caches and decorates the whole snapshot, so serving it here
 * would turn a UI poll into a snapshot rebuild.
 */
const buildHomeCapacityBundleReads = (
  deps: HomeCapacityBundleReadDeps,
): Pick<HomeCapacityBundle, 'getDiagnostics' | 'getReadModel'> => {
  const {
    ctx, runtime, planEngine, planService, tracker, getOperatingMode,
  } = deps;
  const { homeId } = runtime;
  const readDiagnostics = (): HomeRuntimeDiagnostics => ({
    homeId,
    meterDeviceId: runtime.getHomeConfig().meterDeviceId,
    operatingMode: getOperatingMode(),
    capacityScalars: { ...runtime.getCapacityScalars() },
    dryRunEffective: runtime.readEffectiveDryRun(),
    lastMeterPowerKw: resolveLastTotalPowerKw(tracker.getState()),
    lastDeviceControlledMs: { ...planEngine.state.actuation.lastDeviceControlledMs },
  });
  return {
    getDiagnostics: readDiagnostics,
    getReadModel: () => ({
      homeId,
      // Re-serializes the STORED snapshot; it does not plan.
      plan: planService.getLatestPlanSnapshotForUi(),
      planUpdatedAtMs: planService.getLatestPlanSnapshotUpdatedAtMs(),
      powerTracker: tracker.getState(),
      currentMonthCapacityPeakKw: resolveCurrentMonthQuarterPeakKw(tracker.getState(), ctx.getTimeZone(), Date.now()),
      diagnostics: readDiagnostics(),
    }),
  };
};

type HomeCapacityBundleApiParams = {
  ctx: AppContext;
  /** The area's config, capacity scalars, teardown latch and dry-run gates. */
  runtime: SubHomeRuntime;
  logger: () => ReturnType<AppContext['getStructuredLogger']>;
  timerKey: (suffix: string) => string;
  planEngine: PlanEngine;
  planService: PlanService;
  scope: HomeScope;
  tracker: HomeTrackerPersistence;
  pipeline: ReturnType<typeof createHomePowerPipeline>;
  planRebuildScheduler: PlanRebuildScheduler;
  capacityStore: ReturnType<typeof createCapacitySettingsStore>;
  /** The area's membership-ready apply-edge (`lib/home/subHomeMembershipReadyEdge.ts`). */
  membershipReadyEdge: SubHomeMembershipReadyEdge;
  /** The area's side of the ownership-generation protocol (`lib/home/subHomeOwnershipGeneration.ts`). */
  ownershipGeneration: SubHomeOwnershipGeneration;
  reloadModeCatalog: (allowPendingOwnershipGeneration?: boolean) => void;
  isModeCatalogInitialized: () => boolean;
  /** THIS bundle's own rebuild throttle (never main's) — see `OwningHomeHooks`. */
  planRebuildThrottle: PlanRebuildThrottle;
};

export function buildHomeCapacityBundleApi(params: HomeCapacityBundleApiParams): HomeCapacityBundle {
  const {
    ctx, runtime, logger, timerKey, planEngine, planService, scope, tracker,
    pipeline, planRebuildScheduler, capacityStore, membershipReadyEdge,
    ownershipGeneration, reloadModeCatalog, isModeCatalogInitialized,
  } = params;
  const { homeId, isTornDown } = runtime;
  const readOperations = buildHomeCapacityBundleReads({ ...params, getOperatingMode: scope.getOperatingMode });
  // When this home re-reads its capacity block, and whether the read rebuilds,
  // is the capacity owner's (`createCapacitySettingsReloader`); the wiring only
  // installs a read and runs the rebuild it is told to.
  const capacitySettingsRetryTimer = timerKey('capacitySettingsLoadRetry');
  const capacitySettingsReloader = createCapacitySettingsReloader({
    store: capacityStore,
    timers: ctx.timers,
    timerKey: capacitySettingsRetryTimer,
    isStopped: isTornDown,
    // The capacity scalars live in their own store; nothing mirrors them now.
    install: (read) => runtime.setCapacityScalars(resolveInstalledCapacityScalars(read, runtime.getCapacityScalars())),
    rebuildOnChange: true,
    rebuild: () => {
      // Sub-homes DEFAULT dry_run=true, so flipping it false is the normal
      // ACTIVATION path (P2#2). The rebuild after that transition can produce the
      // SAME action signature as the never-applied dry-run shed plan, which used
      // to skip the apply entirely (stable actuation does not cover shed actions)
      // and leave the home over cap with its command never issued — so this path
      // chased the rebuild with a reconcile to force the write. It no longer needs
      // to for a `turn_off` shed: the plan wants the device off, it is observed on,
      // and that IS execution work outstanding, so the rebuild applies it itself.
      //
      // CAVEAT, because the coverage is not total: a `set_step` shed to a non-off
      // step is NOT caught. `hasSteppedStepDrift` compares the observed step
      // against `planDevice.selectedStepId`, which on a rebuild is the observed
      // step (same read) — structurally equal, so step drift is always false
      // there, and the binary axis reads `on` as expected. Such a plan still
      // depends on `changes.actionChanged`. That hole predates this change (the
      // deleted reconcile lane used the same predicate), and closing it means
      // comparing against `desiredStepId` for an unexecuted shed.
      //
      // Direct rebuild, mirroring the main home's settings path
      // (`handleCapacityLimitChange` also bypasses the sample scheduler).
      void planService.rebuildPlanFromCache('settings', { detail: 'home_capacity_scalars' })
        .catch((error: unknown) => {
          logger()?.error({ event: 'home_capacity_reload_rebuild_failed', homeId, err: normalizeError(error) });
        });
    },
  });
  const reloadCapacityScalars = (): void => capacitySettingsReloader.reload();
  return {
    homeId,
    isTornDown,
    getHomeConfig: () => ({ ...runtime.getHomeConfig() }),
    getMeterDeviceId: () => runtime.getHomeConfig().meterDeviceId,
    ...readOperations,
    // Owning-home routing (P1#1): bound when an observed device resolves to THIS
    // home. Every member must come from THIS bundle — main's pending store never
    // saw this device's commands (so it would report PELS's own write as an
    // outside action), main's plan does not contain the device, and main's
    // rebuild state describes a different house.
    getOwningHomeHooks: () => ({
      syncLivePlanState: planService.syncLivePlanState.bind(planService),
      hasPendingBinaryCommand: (deviceId) => (
        planEngine.hasAttributablePendingBinaryCommand(deviceId)
      ),
      clearRecentBinaryOffCommand: (deviceId) => (
        planEngine.clearRecentBinaryOffCommand(deviceId)),
      rebuildPlan: (trigger) => planService.rebuildPlanFromCache(trigger),
      invalidateRebuildSuppression: () => {
        params.planRebuildThrottle.onObservation();
      },
      canDeviceChangeActionableLoad: (deviceId) => planService.canDeviceChangeActionableLoad(deviceId),
      isDeviceLimited: (deviceId) => planService.isDeviceLimitedInLatestPlan(deviceId),
    }),
    updateHomeConfig: (next) => {
      runtime.updateHomeConfig(next);
    },
    rebuildForModeSettingsChange: buildSettingsRebuild(
      params, 'mode_targets', 'home_mode_targets_rebuild_failed',
    ),
    rebuildForDeviceControlSettingsChange: buildSettingsRebuild(
      params, 'temperature_control_disabled_devices', 'home_device_control_settings_rebuild_failed',
    ),
    reloadModeCatalog,
    isModeCatalogInitialized,
    applyMembershipReadyEdge: membershipReadyEdge.apply,
    rebuildForMembershipChange: ownershipGeneration.rebuildForMembershipChange,
    prepareOwnershipGeneration: ownershipGeneration.prepare,
    isPreparedOwnershipGenerationCurrent: ownershipGeneration.isPreparedCurrent,
    reconcilePreparedOwnershipGeneration: ownershipGeneration.reconcilePrepared,
    recordMeterSample: (powerW, sampleNowMs) => {
      if (isTornDown()) return;
      // The ready-edge is DECOUPLED from sample arrival (also fired by the
      // registry from the tree-commit transition, so it works in flow mode). We
      // ALSO retry it after each ingest: a ready-edge that failed or was
      // superseded re-armed its latch, and the next settled sample re-applies the
      // fresh committed decision (a no-op once latched).
      void pipeline.recordPowerSample(powerW, sampleNowMs)
        .then(() => { membershipReadyEdge.apply(); })
        .catch((error: unknown) => {
          logger()?.error({ event: 'home_meter_sample_failed', homeId, err: normalizeError(error) });
        });
    },
    reloadCapacityScalars,
    onScopedSettingWritten: (baseKey) => capacitySettingsReloader.reloadAfterWrite(baseKey),
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
      runtime.markTornDown();
      // A torn-down home has no status: the registry serves `absent` for it
      // from here on, and the fenced writer cannot publish one again.
      ctx.planStatuses.retire(homeId);
      scope.disposeBinaryCommandReachability();
      planRebuildScheduler.cancelAll('home_bundle_teardown');
      ctx.timers.clear(timerKey('planRebuild'));
      ctx.timers.clear(timerKey('noTreeWarn'));
      ctx.timers.clear(timerKey('freshnessHeartbeat'));
      ctx.timers.clear(timerKey('membershipReadyApplyRetry'));
      ctx.timers.clear(timerKey('shortfallSideEffectRetry'));
      // One key per alert lane. The three suffixes above and below are named
      // in `createHomeCapacityGuard`, which arms them through this same
      // `timerKey` namer — a rename there must land here too, because a
      // discarded lane deliberately declines to clear its own key (see
      // `lib/power/capacityShortfallAlertDispatch.ts`), so an unmatched suffix leaves
      // the sustained ticker armed for a torn-down area.
      ctx.timers.clear(timerKey('shortfallAlertImmediate'));
      ctx.timers.clear(timerKey('shortfallAlertSustained'));
      ctx.timers.clear(timerKey('sourceActuationRetry'));
      ctx.timers.clear(capacitySettingsRetryTimer);
      tracker.stopAndFlush();
      // Flush the final accepted old-identity sample first, then overwrite only
      // its freshness latch. A late old pipeline save is fenced by `markTornDown`.
      // The order is load-bearing: the store diffs against what it holds, and
      // the homes-config commit may already have reset the latch there, so the
      // flush re-upserts the in-memory latch and this reset is what clears it.
      const resetSucceeded = options?.resetMeterFreshness !== true || tracker.resetFreshness();
      logger()?.info({ event: 'home_capacity_bundle_torn_down', homeId });
      return resetSucceeded;
    },
  };
}
