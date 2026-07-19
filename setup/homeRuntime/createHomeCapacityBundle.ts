/**
 * One sub-home's self-contained, CAPACITY-ONLY control loop (multi-home R7b):
 * its own capacity settings store, guard, power tracker (with home-suffixed
 * persistence), rebuild scheduler, sample pipeline, plan engine and service.
 * Constructed and torn down by `HomeRuntimeRegistry` as the homes registry
 * changes; the MAIN home never routes through this factory — its wiring in
 * `app.ts`/`setup/appServiceWiring.ts` is untouched and its four unsuffixed
 * persisted keys are never written by bundle code.
 *
 * Strictly capacity-only by construction: the sub-home `HomeScope` binds
 * `getDailyBudgetSnapshot: () => null`, price-optimization/cheap/expensive to
 * `false`, the surplus term to `null`, and omits the smart-task decoration
 * seam — the shared plan factories then collapse to pure capacity control
 * without branching on which home they serve.
 *
 * Boot-window double-control guard: `getCapacityDryRun` reads `true` until
 * membership has resolved from a COMMITTED zone tree
 * (`HomeMembershipService.hasSeenZoneTreeCommit`). Dry-run is the engine's
 * canonical plan-but-don't-actuate switch, so the bundle PLANS from boot but
 * cannot actuate until membership is trustworthy — a pinned device (resolvable
 * before any tree) could otherwise be double-controlled while main still plans
 * it through the fail-safe complement.
 *
 * Persistence: `power_tracker_state:<homeId>` and
 * `device_last_controlled_ms:<homeId>` are rehydrated on (re)creation,
 * junk-tolerant (same guards as the main-home load paths), and persisted
 * through the same debounce/hour-rollover policy as main's tracker — minus
 * main's daily-budget/UI/calibration piggybacks, which are main-only concerns.
 * Teardown stops timers and detaches nothing global; persisted state stays in
 * place for re-creation.
 */
import type { AppContext } from '../../lib/app/appContext';
import type { SubHomeConfig } from '../../lib/home/homeConfig';
import type { HomeId } from '../../lib/utils/settingsKeys';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { CapacityScalarSettings } from '../../lib/power/capacitySettingsStore';
import type { PlanService } from '../../lib/plan/planService';
import type { DevicePlan, PlanInputDevice } from '../../lib/plan/planTypes';
import type { PowerSampleRebuildState } from '../../lib/plan/rebuildScheduler/powerDriven';
import type { RebuildIntent, SchedulerState } from '../../lib/plan/rebuildScheduler/scheduler';
import CapacityGuard from '../../lib/power/capacityGuard';
import { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import { executePendingPowerRebuild } from '../../lib/plan/rebuildScheduler/powerDriven';
import { TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS } from '../../lib/plan/rebuildScheduler/policy';
import { buildPlanCapacityStateSummary } from '../../lib/plan/planLogging';
import { prunePowerTrackerHistoryForApp, type PowerTrackerPersistReason } from '../../lib/power/sampleIngest';
import { isNumberMap, isPowerTrackerState, sanitizePowerTrackerSolarFields } from '../../lib/utils/appTypeGuards';
import { getHourBucketKey } from '../../lib/utils/dateUtils';
import { VOLATILE_WRITE_THROTTLE_MS } from '../../lib/utils/timingConstants';
import { normalizeError } from '../../lib/utils/errorUtils';
import {
  CAPACITY_IN_SHORTFALL,
  DEVICE_LAST_CONTROLLED_MS,
  PELS_STATUS,
  POWER_TRACKER_STATE,
  homeScopedSettingsKey,
} from '../../lib/utils/settingsKeys';
import { createCapacitySettingsStore } from '../capacitySettingsStoreAdapter';
// Direct file imports (not the `setup/appInit.ts` barrel) to mirror
// `homeScope.ts` and avoid the factory↔scope module cycle via the barrel.
import { createPlanEngine } from '../appInit/createPlanEngine';
import { createPlanService } from '../appInit/createPlanService';
import { evictMissingDeviceCacheEntries, toPlanDevice } from '../appInit/toPlanDevice';
import { isRuntimePlannedDevice } from '../appDeviceSupport';
import { filterDevicesForHome } from '../homeMembership';
import { createHomePowerPipeline } from './createHomePowerPipeline';
import { buildHomeCapacityBundleApi } from './homeCapacityBundleApi';
import { installBundleReadinessAndFreshness } from './homeCapacityBundleReadiness';
import type { HomeScope } from './homeScope';

// A sub-home's OWN fallback seed for its capacity store. Mirrors the app-boot
// defaults (`PelsApp.capacitySettings` / `capacityDryRun`) but is deliberately
// a per-home constant — NEVER main's live snapshot: seeding a sub-home from
// main's configured hard cap would silently run a second controller against
// main's contract limit. Dry-run defaults TRUE (the safe boot default): an
// unconfigured sub-home plans but never actuates.
const SUB_HOME_CAPACITY_DEFAULTS: CapacityScalarSettings = {
  limitKw: 10,
  marginKw: 0.2,
  dryRun: true,
};

// A neutral operating mode for the capacity-only sub-home scope. The mode value
// is only ever used to index `getModeDeviceTargets()`, which a sub-home binds to
// `{}` — so no member is ever driven to a mode target regardless of this value.
// A non-real sentinel makes the "no mode targets" intent explicit.
const SUB_HOME_NEUTRAL_OPERATING_MODE = '';

// Mirrors `STARTUP_RESTORE_STABILIZATION_MS` in `setup/appServiceWiring.ts`:
// a freshly (re)created bundle holds restores until its meter proves live
// (the first fresh sample clears the window via the pipeline).
const BUNDLE_RESTORE_STABILIZATION_MS = 60 * 1000;
const TRACKER_PRUNE_INITIAL_DELAY_MS = 10 * 1000;
const TRACKER_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export type HomeCapacityBundleDeps = {
  ctx: AppContext;
  home: SubHomeConfig;
  /** Membership-readiness signal (a committed zone tree has been joined). */
  isMembershipReady: () => boolean;
};

/** Read-only per-bundle diagnostics (test observability + future `ui_homes`). */
export type HomeCapacityBundleDiagnostics = {
  homeId: HomeId;
  meterDeviceId: string | null;
  capacityScalars: CapacityScalarSettings;
  /** The engine's effective no-actuation switch (persisted flag OR the boot-window membership gate). */
  dryRunEffective: boolean;
  /** Last meter reading this bundle's guard saw (kW), or null before the first sample. */
  lastMeterPowerKw: number | null;
  lastDeviceControlledMs: Record<string, number>;
};

/**
 * The realtime-reconcile routing seam for a device THIS home owns (multi-home
 * R7b P1#1). The app's realtime-device-reconcile wrapper binds these closures
 * when a drifting device resolves to a sub-home, so an external on/off change to
 * a sub-home load is drift-checked and reconciled against THAT home's plan —
 * main's plan filters sub-home members out, so it would never see the drift.
 * Shapes mirror the main-home closures the wrapper otherwise uses.
 */
export type RealtimeReconcileHooks = {
  getLatestPlanSnapshot: () => DevicePlan | null;
  getLiveDevices: () => PlanInputDevice[];
  reconcile: () => Promise<boolean>;
};

export type HomeCapacityBundle = {
  homeId: HomeId;
  /** This home's meter device id (fresh from the last reconciled config). */
  getMeterDeviceId: () => string | null;
  getDiagnostics: () => HomeCapacityBundleDiagnostics;
  /**
   * Realtime-reconcile routing hooks (see {@link RealtimeReconcileHooks}): the
   * reconcile wrapper binds these for a device this home owns so the drift is
   * reconciled through THIS bundle's plan, not main's.
   */
  getReconcileHooks: () => RealtimeReconcileHooks;
  /** Adopt a changed sub-home config (meter/root-zone/name) without teardown. */
  updateHomeConfig: (home: SubHomeConfig) => void;
  /**
   * Apply the once-only membership-ready edge (rebuild → reconcile). Idempotent
   * and latched; a no-op until the execution gate opens. Driven by the registry
   * from the membership tree-commit transition (decoupled from sample arrival).
   */
  applyMembershipReadyEdge: () => void;
  /** Feed one meter reading (W) into this home's sample pipeline. */
  recordMeterSample: (powerW: number, nowMs: number) => void;
  /** Suffix-hook: reload the capacity scalars into the guard + request a rebuild. */
  reloadCapacityScalars: () => void;
  /** Suffix-hook: adopt an externally written tracker state (own-write echoes suppressed). */
  reloadPowerTracker: () => void;
  /** Stop timers/scheduler; leaves all suffixed persisted state in place. */
  teardown: () => void;
};

// Mirrors `shouldForcePersistPowerTracker` in `setup/appPowerTracker.ts`
// (module-private there): an hour-bucket rollover bypasses the persist
// debounce so a restart never loses the closed hour's totals.
const crossesHourBoundary = (previous: PowerTrackerState, next: PowerTrackerState): boolean => {
  const previousTs = previous.lastTimestamp;
  const nextTs = next.lastTimestamp;
  if (
    typeof previousTs !== 'number' || typeof nextTs !== 'number'
    || !Number.isFinite(previousTs) || !Number.isFinite(nextTs)
  ) return false;
  return getHourBucketKey(previousTs) !== getHourBucketKey(nextTs);
};

export type SuffixedTrackerPersistence = {
  getState: () => PowerTrackerState;
  /** Pipeline save path: adopt + debounce-persist (hour rollovers force). */
  save: (next: PowerTrackerState) => void;
  /** Suffix-hook reload with own-write echo suppression (see the hook contract). */
  reloadFromSettings: () => void;
  /** Meter swap: drop the freshness stamp so the next new-meter sample re-primes it. */
  resetFreshness: () => void;
  startPruning: () => void;
  /** Flush a pending debounced persist, then stop the tracker timers. */
  stopAndFlush: () => void;
};

// Per-home tracker state + suffixed persistence. Hydration is junk-tolerant:
// the same field-level solar sanitize + whole-shape guard as the main home's
// `SettingsRepository.loadPowerTrackerState`; junk resolves to a fresh empty
// state, never a crash and never a destructive overwrite of the persisted blob.
function createSuffixedTrackerPersistence(params: {
  ctx: AppContext;
  homeId: HomeId;
  timerKey: (suffix: string) => string;
  /** Teardown fence: drop a post-teardown sample-pipeline save so it can't re-arm a persist. */
  isTornDown: () => boolean;
}): SuffixedTrackerPersistence {
  const { ctx, homeId, timerKey, isTornDown } = params;
  const trackerKey = homeScopedSettingsKey(POWER_TRACKER_STATE, homeId);
  const hydrated = sanitizePowerTrackerSolarFields(ctx.homey.settings.get(trackerKey) as unknown);
  let state: PowerTrackerState = isPowerTrackerState(hydrated) ? hydrated : {};
  // Own-write echo fingerprint: the suffixed persist below re-enters the
  // settings handler as an (un-deduped) suffix-hook call at sample cadence;
  // `reloadFromSettings` compares against this to skip self-echoes.
  let lastPersistedJson: string | null = null;
  const persist = (reason: PowerTrackerPersistReason): void => {
    ctx.timers.clear(timerKey('powerTrackerSave'));
    try {
      const serialized = JSON.stringify(state);
      ctx.homey.settings.set(trackerKey, state);
      // Fingerprint recorded only after a successful write, so a failed set
      // can never suppress the adoption of a later external write.
      lastPersistedJson = serialized;
    } catch (error) {
      ctx.getStructuredLogger('homes')?.error({
        event: 'home_power_tracker_persist_failed', homeId, reason, err: normalizeError(error),
      });
    }
  };
  const prune = (): void => {
    state = prunePowerTrackerHistoryForApp({
      powerTracker: state,
      debugStructured: ctx.getStructuredDebugEmitter('perf', 'perf'),
      error: (msg, err) => ctx.error(msg, err),
      timeZone: ctx.getTimeZone(),
    });
    persist('prune');
  };
  return {
    getState: () => state,
    save: (next) => {
      // Fenced on teardown: a sample-pipeline continuation resolving after
      // `stopAndFlush` must NOT re-schedule a persist (it would fire post-teardown
      // and clobber a same-`homeId` bundle re-created after this one). The final
      // pre-teardown state is flushed by `stopAndFlush` via `persist` directly.
      if (isTornDown()) return;
      const previous = state;
      state = next;
      if (crossesHourBoundary(previous, next)) {
        persist('hour_rollover');
        return;
      }
      if (!ctx.timers.has(timerKey('powerTrackerSave'))) {
        ctx.timers.registerTimeout(
          timerKey('powerTrackerSave'),
          setTimeout(() => persist('scheduled'), VOLATILE_WRITE_THROTTLE_MS),
        );
      }
    },
    reloadFromSettings: () => {
      const raw = ctx.homey.settings.get(trackerKey) as unknown;
      // Own-write echo suppression: adopting our own echo would discard
      // in-memory samples accrued since the last persist.
      try {
        if (JSON.stringify(raw) === lastPersistedJson) return;
      } catch {
        // Unserializable junk cannot be our own write; fall through to the guard.
      }
      const sanitized = sanitizePowerTrackerSolarFields(raw);
      if (isPowerTrackerState(sanitized)) state = sanitized;
    },
    resetFreshness: () => {
      // Meter swap (R7b P2#3): drop the PREVIOUS meter's freshness stamp so
      // `resolvePowerSampleFreshness` resolves to "never sampled" (stale_hold)
      // rather than aging the old timestamp into a fail-closed shed before the
      // new meter reports. Accumulated totals are a separate accounting concern
      // and are intentionally left intact; the next new-meter sample re-primes
      // `lastTimestamp`/`lastPowerW`.
      state = { ...state, lastTimestamp: undefined, lastPowerW: undefined };
    },
    startPruning: () => {
      ctx.timers.registerTimeout(timerKey('trackerPruneInitial'), setTimeout(() => {
        ctx.timers.clear(timerKey('trackerPruneInitial'));
        prune();
      }, TRACKER_PRUNE_INITIAL_DELAY_MS));
      ctx.timers.registerInterval(timerKey('trackerPruneInterval'), setInterval(
        prune,
        TRACKER_PRUNE_INTERVAL_MS,
      ));
    },
    stopAndFlush: () => {
      // Flush BEFORE clearing timers so the last accepted samples survive for
      // re-creation; suffixed persisted state is deliberately left in place.
      if (ctx.timers.has(timerKey('powerTrackerSave'))) persist('uninit');
      for (const suffix of ['powerTrackerSave', 'trackerPruneInitial', 'trackerPruneInterval']) {
        ctx.timers.clear(timerKey(suffix));
      }
    },
  };
}

// Per-bundle rebuild scheduler over the bundle's own rebuild state; every
// timer rides the shared TimerRegistry under this home's key. Bundle clock:
// `Date.now()` unconditionally — self-consistent within the bundle (state,
// due times and the pipeline's `getPlanRebuildNowMs` all read the same
// clock); the main home keeps its monotonic-clock variant.
function createBundleRebuildScheduler(params: {
  ctx: AppContext;
  timerKey: (suffix: string) => string;
  getRebuildState: () => PowerSampleRebuildState;
  setRebuildState: (state: PowerSampleRebuildState) => void;
  getPlanService: () => PlanService;
}): PlanRebuildScheduler {
  const { ctx, timerKey, getRebuildState, setRebuildState, getPlanService } = params;
  const nowMs = () => Date.now();
  // Mirrors `PelsApp.resolvePlanRebuildDueAtMs` for the two intent kinds a
  // bundle emits; `flow` intents do not exist for sub-homes.
  const resolveDueAtMs = (intent: RebuildIntent, state: SchedulerState): number => {
    const rebuildState = getRebuildState();
    const floorMs = rebuildState.tightUnactionable === true && rebuildState.lastMs > 0
      ? rebuildState.lastMs + TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS
      : Number.NEGATIVE_INFINITY;
    if (intent.kind === 'hardCap') return Math.max(state.nowMs, floorMs);
    if (intent.kind === 'signal') return Math.max(rebuildState.pendingDueMs ?? state.nowMs, floorMs);
    return Number.POSITIVE_INFINITY;
  };
  return new PlanRebuildScheduler({
    getNowMs: nowMs,
    resolveDueAtMs,
    executeIntent: (intent) => {
      if (intent.kind === 'signal' || intent.kind === 'hardCap') {
        return executePendingPowerRebuild({
          getState: getRebuildState,
          setState: setRebuildState,
          getNowMs: nowMs,
          rebuildPlanFromCache: (reason?: string) => getPlanService().rebuildPlanFromCache(reason),
        });
      }
      return getPlanService().rebuildPlanFromCache(intent.reason).then(() => undefined);
    },
    shouldExecuteImmediately: (intent) => intent.kind !== 'flow',
    setTimeoutFn: (callback, delayMs) => (
      ctx.timers.registerTimeout(timerKey('planRebuild'), setTimeout(callback, delayMs))
    ),
    clearTimeoutFn: () => { ctx.timers.clear(timerKey('planRebuild')); },
  });
}

// The sub-home `HomeScope`: capacity-only policy block, suffixed persisted-
// signal writers, membership-partitioned plan input (fail-closed for sub-home
// scopes — see `filterDevicesForHome`).
function buildSubHomeScope(params: {
  ctx: AppContext;
  homeId: HomeId;
  isMembershipReady: () => boolean;
  /** Teardown fence: gate the suffixed-key writers so a post-teardown continuation cannot persist. */
  isTornDown: () => boolean;
  getScalars: () => CapacityScalarSettings;
  getGuard: () => CapacityGuard | undefined;
  getTracker: () => PowerTrackerState;
  /** Late-bound: the bundle's own service (created after the engine). */
  getServiceForSync: () => PlanService | undefined;
  /** Late-bound: the bundle's OWN engine, for the sub-home pending-binary read. */
  getPlanEngineForPending: () => ReturnType<typeof createPlanEngine> | undefined;
  /** This home's configured meter device id (fresh per read); excluded from the plan input. */
  getMeterDeviceId: () => string | null;
}): HomeScope {
  const {
    ctx, homeId, isMembershipReady, isTornDown, getScalars, getGuard, getTracker,
    getServiceForSync, getPlanEngineForPending, getMeterDeviceId,
  } = params;
  // Suffixed persisted-signal write, fenced on teardown: an in-flight
  // rebuild/reconcile continuation that resolves AFTER teardown must not
  // re-create this home's suffixed keys (nor clobber a same-`homeId` bundle
  // re-created after this one). Actuation is fenced separately at the actuator
  // seam (see `createPlanEngine` `isActuationFenced`).
  const writeSuffixed = (baseKey: string, value: unknown): void => {
    if (isTornDown()) return;
    ctx.homey.settings.set(homeScopedSettingsKey(baseKey, homeId), value);
  };
  return {
    homeId,
    getCapacitySettings: () => ({ limitKw: getScalars().limitKw, marginKw: getScalars().marginKw }),
    // Boot-window double-control guard folded into the engine's canonical
    // no-actuation switch: forced dry-run until membership has resolved from a
    // committed zone tree, then the persisted per-home flag governs.
    getCapacityDryRun: () => !isMembershipReady() || getScalars().dryRun,
    getCapacityGuard: getGuard,
    getPowerTracker: getTracker,
    getDailyBudgetSnapshot: () => null,
    getPlanDevices: () => {
      // Same seed + evict pre-passes as the main scope (both idempotent and
      // full-snapshot-based); see `buildMainHomeScope.getPlanDevices`.
      ctx.seedObservedStateFromSnapshot();
      const snapshot = ctx.latestTargetSnapshot;
      evictMissingDeviceCacheEntries(ctx, snapshot);
      const meterDeviceId = getMeterDeviceId();
      return filterDevicesForHome(ctx.homeMembership, snapshot, homeId)
        // Own-meter carve-out: a home's configured meter device is its power
        // SOURCE, not a managed load. If that metering plug were also
        // managed+controllable it would be shed on overshoot — either an
        // oscillation (off plug reads ~0 W → "under cap" → restore → spike) or a
        // freeze-off (plug goes unavailable → the bundle stops sampling). Drop it
        // from the plan input entirely (RUNTIME guard; the homes UI should also
        // warn — see TODO.md).
        .filter((device) => meterDeviceId === null || device.id !== meterDeviceId)
        // Capacity-only overrides: NO surplus posture (a sub-home has no
        // price/surplus signal, so a surplusWilling device would be held OFF
        // forever), and the pending-binary read routed to THIS bundle's engine
        // (not MAIN's via `ctx.planEngine`).
        .map((device) => toPlanDevice(ctx, device, {
          surplusPostureEnabled: false,
          getPendingBinaryCommand: (id, model) => (
            getPlanEngineForPending()?.getPendingBinaryCommandForDevice(id, model) ?? null
          ),
        }))
        .filter(isRuntimePlannedDevice);
    },
    setCapacityInShortfall: (inShortfall) => writeSuffixed(CAPACITY_IN_SHORTFALL, inShortfall),
    persistLastControlledMs: (lastControlledMs) => writeSuffixed(DEVICE_LAST_CONTROLLED_MS, lastControlledMs),
    writePelsStatus: (status) => writeSuffixed(PELS_STATUS, status),
    // Capacity-only policy: no price optimization, no cheap/expensive hours,
    // no surplus term, no smart-task decoration (absent = identity), no
    // mode-target driving, no dynamic-soft-limit override.
    getPriceOptimizationEnabled: () => false,
    isCurrentHourCheap: () => false,
    isCurrentHourExpensive: () => false,
    getInferredSurplusKw: () => null,
    getPriceOptimizationSettings: () => ({}),
    getDynamicSoftLimitOverride: () => null,
    getOperatingMode: () => SUB_HOME_NEUTRAL_OPERATING_MODE,
    getModeDeviceTargets: () => ({}),
    // Capacity-only UI/side-effect posture: no combined prices (→ price level
    // UNKNOWN, `price_level_changed` never fires), no shared `plan_updated`
    // emit (the settings UI reads only MAIN's plan stream), and no shared
    // diagnostics recorder (a sub-home plan pollutes main's per-boot epoch).
    getCombinedPrices: () => null,
    emitsUiRealtime: false,
    getDeviceDiagnostics: () => undefined,
    // THIS home's post-actuation live-state sync — syncing main's service
    // (the ctx delegator) would touch the wrong plan.
    syncLivePlanStateAfterTargetActuation: (source) => (
      getServiceForSync()?.syncLivePlanStateInline(source) ?? false
    ),
  };
}

// Same provider wiring as main's `initCapacityGuard` + `initCapacityGuardProviders`;
// with the capacity-only scope (null budget, price-opt off) both providers
// collapse to the pure capacity math.
function createBundleGuard(params: {
  ctx: AppContext;
  scalars: CapacityScalarSettings;
  planEngine: ReturnType<typeof createPlanEngine>;
  planService: PlanService;
  /** Teardown fence: the shortfall/clear callbacks fire the GLOBAL capacity_shortfall Flow. */
  isTornDown: () => boolean;
}): CapacityGuard {
  const { ctx, scalars, planEngine, planService, isTornDown } = params;
  const guard = new CapacityGuard({
    limitKw: scalars.limitKw,
    softMarginKw: scalars.marginKw,
    // Fenced on teardown: `handleShortfall`/`handleShortfallCleared` fire the app's
    // SINGLE global `capacity_shortfall` Flow card (not a per-home signal). An
    // in-flight rebuild resolving AFTER teardown must not raise/clear that card —
    // it would be a stale external control event for a home no longer managed (R7b P1).
    onShortfall: async (deficitKw) => { if (isTornDown()) return; await planService.handleShortfall(deficitKw); },
    onShortfallCleared: async () => { if (isTornDown()) return; await planService.handleShortfallCleared(); },
    structuredLog: ctx.getStructuredLogger('capacity'),
    capacityStateSummaryProvider: () => buildPlanCapacityStateSummary(
      planService.getLatestPlanSnapshot(),
      {
        summarySource: 'plan_snapshot',
        summarySourceAtMs: planService.getLatestPlanSnapshotUpdatedAtMs() ?? null,
      },
    ),
  });
  guard.setSoftLimitProvider(() => planEngine.computeDynamicSoftLimit());
  guard.setShortfallThresholdProvider(() => planService.computeShortfallThreshold());
  return guard;
}

// Assembles the bundle's sample-ingest runtime: the per-bundle rebuild
// scheduler and the sample pipeline wired over it. Returns both so `teardown`
// can cancel the scheduler. Extracted to keep `createHomeCapacityBundle` within
// the setup-layer size ceilings.
function createBundleSamplePipeline(params: {
  ctx: AppContext;
  homeId: HomeId;
  timerKey: (suffix: string) => string;
  getRebuildState: () => PowerSampleRebuildState;
  setRebuildState: (state: PowerSampleRebuildState) => void;
  getPlanEngine: () => ReturnType<typeof createPlanEngine>;
  getPlanService: () => PlanService;
  getCapacityGuard: () => CapacityGuard;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getMeterDeviceId: () => string | null;
  savePowerTracker: (state: PowerTrackerState) => void;
  getPowerTracker: () => PowerTrackerState;
}): { pipeline: ReturnType<typeof createHomePowerPipeline>; scheduler: PlanRebuildScheduler } {
  const scheduler = createBundleRebuildScheduler({
    ctx: params.ctx,
    timerKey: params.timerKey,
    getRebuildState: params.getRebuildState,
    setRebuildState: params.setRebuildState,
    getPlanService: params.getPlanService,
  });
  const pipeline = createHomePowerPipeline({
    ctx: params.ctx,
    homeId: params.homeId,
    planRebuildScheduler: scheduler,
    getPlanEngine: params.getPlanEngine,
    getPlanService: params.getPlanService,
    getMeterDeviceId: params.getMeterDeviceId,
    getPlanRebuildNowMs: () => Date.now(),
    savePowerTracker: params.savePowerTracker,
    setPowerSampleRebuildState: params.setRebuildState,
    getPowerTracker: params.getPowerTracker,
    getCapacitySettings: params.getCapacitySettings,
    getCapacityGuard: params.getCapacityGuard,
    getPowerSampleRebuildState: params.getRebuildState,
    // No weather/PV/curtailment taps for sub-homes: a sub-home meter's net W is
    // not the home's grid power — feeding it to those estimators would corrupt them.
  });
  return { pipeline, scheduler };
}

export function createHomeCapacityBundle(deps: HomeCapacityBundleDeps): HomeCapacityBundle {
  const { ctx } = deps;
  const { homeId } = deps.home;
  const logger = () => ctx.getStructuredLogger('homes');
  const timerKey = (suffix: string) => `home:${homeId}:${suffix}`;

  let home = deps.home;
  let tornDown = false;
  const isTornDown = (): boolean => tornDown;
  // Monotonic meter-sample counter: bumped synchronously on each arriving sample
  // so the readiness apply-edge can detect a NEWER sample landing between its
  // rebuild capture and its reconcile boundary (and abort a now-stale decision —
  // R7b P1-5). Actuation and suffixed writes past teardown are fenced separately
  // (the actuator seam + the suffixed-write / tracker-save `isTornDown` gates), so
  // a same-`homeId` bundle re-created after this one is never clobbered.
  let sampleRevision = 0;
  // Last-good capacity scalars, seeded from the home's OWN defaults (never
  // main's live snapshot — see SUB_HOME_CAPACITY_DEFAULTS). The store is
  // constructed ONCE per bundle and is the ONLY capacity source for this scope.
  let capacityScalars: CapacityScalarSettings = SUB_HOME_CAPACITY_DEFAULTS;
  const capacityStore = createCapacitySettingsStore(ctx.homey.settings, homeId, () => capacityScalars);
  capacityScalars = capacityStore.read();
  let rebuildState: PowerSampleRebuildState = { lastMs: 0 };

  const tracker = createSuffixedTrackerPersistence({ ctx, homeId, timerKey, isTornDown });
  const scope = buildSubHomeScope({
    ctx,
    homeId,
    isMembershipReady: deps.isMembershipReady,
    isTornDown,
    getScalars: () => capacityScalars,
    // Lazy closures over consts assigned after the engine/service exist (the
    // guard's shortfall callbacks need the service; nothing invokes either
    // closure during factory construction).
    getGuard: () => guard,
    getTracker: tracker.getState,
    getServiceForSync: () => planService,
    getPlanEngineForPending: () => planEngine,
    getMeterDeviceId: () => home.meterDeviceId,
  });
  // `isActuationFenced` nulls this bundle's actuator seam once torn down: ANY
  // in-flight rebuild/reconcile/heartbeat/sample continuation resolving after
  // teardown no-ops at the write boundary, so a removed home can never actuate
  // into main's just-adopted complement (double-control — R7b P0-2).
  const planEngine = createPlanEngine(ctx, scope, { isActuationFenced: isTornDown });
  // Suffixed mirror of `AppServiceWiring.hydratePlanEngineControlState`: the
  // per-home restore backoff survives an app restart / bundle re-creation.
  const storedLastControlled = ctx.homey.settings.get(
    homeScopedSettingsKey(DEVICE_LAST_CONTROLLED_MS, homeId),
  ) as unknown;
  // eslint-disable-next-line functional/immutable-data -- same engine-state hydration write as the main-home wiring
  planEngine.state.lastDeviceControlledMs = isNumberMap(storedLastControlled) ? { ...storedLastControlled } : {};
  planEngine.beginStartupRestoreStabilization(BUNDLE_RESTORE_STABILIZATION_MS);
  // The bundle's OWN engine is passed explicitly — omitting it would fall
  // through to `ctx.planEngine` (the MAIN home's engine).
  const planService = createPlanService(ctx, scope, planEngine);
  const guard = createBundleGuard({ ctx, scalars: capacityScalars, planEngine, planService, isTornDown });

  const { pipeline, scheduler: planRebuildScheduler } = createBundleSamplePipeline({
    ctx,
    homeId,
    timerKey,
    getRebuildState: () => rebuildState,
    setRebuildState: (state) => { rebuildState = state; },
    getPlanEngine: () => planEngine,
    getPlanService: () => planService,
    getCapacityGuard: () => guard,
    getCapacitySettings: scope.getCapacitySettings,
    getMeterDeviceId: () => home.meterDeviceId,
    savePowerTracker: tracker.save,
    getPowerTracker: tracker.getState,
  });
  tracker.startPruning();

  // Readiness apply-edge (decoupled from sample arrival; fired by the registry
  // from the membership tree-commit transition or the trust-fallback timer) plus
  // the trust-fallback and freshness-heartbeat timers.
  const { applyMembershipReadyEdge } = installBundleReadinessAndFreshness({
    ctx,
    homeId,
    timerKey,
    logger,
    planService,
    getTrackerState: tracker.getState,
    isTornDown,
    getSampleRevision: () => sampleRevision,
    isMembershipReady: deps.isMembershipReady,
  });

  // Initial plan build so the suffixed status signals exist without waiting
  // for the first meter sample. Awaits the shared snapshot warmup gate inside
  // `rebuildPlanFromCache` during boot; contained (never fails construction).
  void planService.rebuildPlanFromCache('home_bundle_created').catch((error: unknown) => {
    logger()?.error({ event: 'home_bundle_initial_rebuild_failed', homeId, err: normalizeError(error) });
  });
  logger()?.info({
    event: 'home_capacity_bundle_created',
    homeId,
    meterDeviceId: home.meterDeviceId,
    limitKw: capacityScalars.limitKw,
    dryRun: capacityScalars.dryRun,
  });

  return buildHomeCapacityBundleApi({
    ctx,
    homeId,
    logger,
    timerKey,
    guard,
    planEngine,
    planService,
    scope,
    tracker,
    pipeline,
    planRebuildScheduler,
    capacityStore,
    applyMembershipReadyEdge,
    getHome: () => home,
    setHome: (next) => { home = next; },
    getScalars: () => capacityScalars,
    setScalars: (next) => { capacityScalars = next; },
    bumpSampleRevision: () => { sampleRevision += 1; },
    isTornDown,
    markTornDown: () => { tornDown = true; },
  });
}
