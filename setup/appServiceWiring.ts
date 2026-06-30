import type Homey from 'homey';
import CapacityGuard from '../lib/power/capacityGuard';
import { DeviceTransport, type DeviceTransportBinarySettleOps } from '../lib/device/deviceTransport';
import {
  clearAllPendingBinarySettleWindows,
  clearPendingBinarySettleWindow,
  hasPendingBinarySettleWindow,
  notePendingBinarySettleObservation,
  startPendingBinarySettleWindow,
  type BinarySettleState,
} from '../lib/observer/binarySettle';
import {
  ObservedStateEmitter,
  type ObservedStateChangedEvent,
  type PlanReconcileObservedEvent,
} from '../lib/observer/observedStateEvents';
import { ObservedHomePower } from '../lib/observer/observedHomePower';
import { ObservedDeviceStateProjection } from '../lib/observer/observedDeviceStateProjection';
import { SnapshotWarmupGate } from '../lib/plan/snapshotWarmupGate';
import { buildPlanCapacityStateSummary } from '../lib/plan/planLogging';
import type { PlanService } from '../lib/plan/planService';
import { PlanRebuildScheduler } from '../lib/plan/rebuildScheduler/scheduler';
import {
  PowerCalibrationStore,
  createCalibrationSnapshotMutationHook,
} from '../lib/device/devicePowerCalibrationStore';
import { isNumberMap } from '../lib/utils/appTypeGuards';
import { DEVICE_LAST_CONTROLLED_MS } from '../lib/utils/settingsKeys';
import { isStateOfChargeCapabilityId } from '../lib/device/transport/stateOfCharge';
import { incPerfCounters } from '../lib/utils/perfCounters';
import {
  createRootLogger,
  setRootLogger,
  type Logger as PinoLogger,
} from '../lib/logging/logger';
import { createHomeyDestination } from '../lib/logging/homeyDestination';
import { normalizeError } from '../lib/utils/errorUtils';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import type { WeatherCollector } from '../lib/weather/weatherCollector';
import type { PowerTrackerPersistReason } from '../lib/power/sampleIngest';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import type { AppContext, StartupBootstrapConfig } from '../lib/app/appContext';
import {
  createDeferredObjectiveActivePlanRecorder,
  createDeferredObjectiveLifecycleEmitter,
  createDeferredObjectivePlanHistoryRecorder,
  createDailyBudgetService,
  createDeviceDiagnosticsService,
  createPlanEngine,
  createPlanService,
  createPriceCoordinator,
  createPriceFlowTagPublisher,
  evictMissingDeviceCacheEntries,
  persistDeferredObjectiveObservationWatermark,
  toPlanDevice,
} from './appInit';
import { startBackgroundCollectors } from './appInit/startBackgroundCollectors';
import { wireBudgetPrice } from './appInit/wireBudgetPrice';
import type { PvForecastController } from './appInit/createPvForecastService';
import { flushDailyBudgetStateOnUninit, runStartupStep, startAppServices } from './appLifecycleHelpers';
import { initSettingsHandlerForApp } from './appSettingsHelpers';
import { BackgroundTasksController } from './backgroundTasksController';
import type { AppNativeWiring } from './appNativeWiring';
import * as realtimeReconcile from './appRealtimeDeviceReconcile';
import { scheduleAppRealtimeDeviceReconcile } from './appRealtimeDeviceReconcileRuntime';

const STARTUP_RESTORE_STABILIZATION_MS = 60 * 1000;
// Bound the warmup wait so a failed/slow Homey Manager fetch can never deadlock
// startup: if `refreshSnapshot()` does not resolve in this window the gate
// releases with reason `timeout` and the planner proceeds (next snapshot will
// arrive on the periodic refresh and rebuild correctly). Tests use a 0 bound
// to skip the wait entirely. Per `feedback_homey_sdk_unreliable`, a slow SDK
// fetch is treated as a transient gap, not a persisted-state corruption.
const SNAPSHOT_WARMUP_TIMEOUT_MS = process.env.NODE_ENV === 'test' ? 0 : 5_000;
// Cadence for re-running native-wiring flow-conflict detection so Flows added
// after startup (or a degraded-startup empty snapshot) are picked up without a
// restart. No-op unless the verdict changed.
const NATIVE_WIRING_REQUERY_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Dependencies for {@link AppServiceWiring}. Service handles the wider app also
 * reads/writes (`priceCoordinator`, `deviceManager`, `planEngine`, …) live on
 * `PelsApp` and flow through `ctx` (the shared `AppContext`); observer-owned
 * fields and other private `PelsApp` state are reached through the typed
 * getters/setters below. Cluster-internal calls that have a thin `PelsApp`
 * stub (`initPlanEngine`, `runStartupSettingsMigrations`, …) route back through
 * the app so test seams/spies that reassign the instance method are honoured.
 */
export type AppServiceWiringDeps = {
  ctx: AppContext;
  homeyApp: Homey.App;
  backgroundTasks: BackgroundTasksController;
  timers: TimerRegistry;
  nativeWiring: AppNativeWiring;
  planRebuildScheduler: PlanRebuildScheduler;
  getStructuredLogger: () => PinoLogger | undefined;
  setStructuredLogger: (logger: PinoLogger) => void;
  getPlanService: () => PlanService;
  getPowerCalibrationStore: () => PowerCalibrationStore;
  getObserverBinarySettleState: () => BinarySettleState;
  getObservedStateEmitter: () => ObservedStateEmitter;
  getObservedHomePower: () => ObservedHomePower;
  getObservedDeviceStateProjection: () => ObservedDeviceStateProjection;
  setObservedDeviceStateProjection: (projection: ObservedDeviceStateProjection) => void;
  getRealtimeDeviceReconcileState: () => realtimeReconcile.RealtimeDeviceReconcileState;
  setStopSettingsHandler: (stop: (() => void) | undefined) => void;
  getStopSettingsHandler: () => (() => void) | undefined;
  setWeatherCollector: (collector: WeatherCollector | undefined) => void;
  getPvForecast: () => PvForecastController | undefined;
  setPvForecast: (pvForecast: PvForecastController | undefined) => void;
  setNativeWiringUninitializing: (value: boolean) => void;
  isManagedFilterActive: () => boolean;
  resolveNativeWiringEnabled: (deviceId: string) => boolean;
  runNativeWiringDetectionBestEffort: () => void;
  getDeviceDriverIdOverride: (deviceId: string) => string | undefined;
  getFlowConflict: (deviceId: string) => { conflictingCapabilities: readonly string[]; flowName?: string } | undefined;
  computeShortfallThreshold: () => number;
  getSnapshotDevice: (deviceId: string) => TargetDeviceSnapshot | undefined;
  hasEnabledEvBoostForSnapshot: (device: TargetDeviceSnapshot | undefined) => boolean;
  loadFlowReportedCapabilities: () => void;
  loadPowerCalibrationStore: () => void;
  startPowerTrackerPruning: () => void;
  persistPowerTrackerState: (reason: PowerTrackerPersistReason) => void;
  flushPowerCalibration: () => void;
  runStartupSettingsMigrations: () => void;
  // Routed through the app so test seams that reassign the instance method are
  // honoured (and so the thin PelsApp delegators are runtime-reachable, not just
  // called by the integration boot helper).
  initPlanEngine: () => void;
  initPriceCoordinator: () => Promise<void>;
  initDailyBudgetService: () => void;
  initDeviceManager: () => Promise<void>;
  initCapacityGuard: () => void;
  initDeviceDiagnosticsService: () => void;
  initPlanService: () => void;
  initCapacityGuardProviders: () => void;
  initSettingsHandler: () => void;
};

/**
 * Boot/teardown orchestration and per-service construction extracted from
 * `PelsApp`. `PelsApp` keeps slim `onInit`/`onUninit` lifecycle methods plus
 * thin `init*` delegators (the latter are still called directly by the
 * integration-test boot helper); the bodies live here.
 */
export class AppServiceWiring {
  constructor(private readonly deps: AppServiceWiringDeps) {}

  async runInit(): Promise<void> {
    const { ctx } = this.deps;
    const deferStartupBootstrap = process.env.NODE_ENV !== 'test' || process.env.PELS_ASYNC_STARTUP === '1';
    const logStartupStepFailure = (label: string, error: Error): void => {
      this.deps.getStructuredLogger()?.child({ component: 'startup' }).error({
        event: 'startup_step_failed',
        reasonCode: 'startup_step_failed',
        stepLabel: label,
        err: normalizeError(error),
      });
    };
    const structuredLogger = this.installStructuredLogger();
    structuredLogger.child({ component: 'startup' }).info({ event: 'app_initialized' });
    this.deps.backgroundTasks.startResourceWarningListeners();
    this.deps.backgroundTasks.installHeapSnapshotHandler(structuredLogger);
    await runStartupStep('updateDebugLoggingEnabled', () => ctx.updateDebugLoggingEnabled(), logStartupStepFailure);
    this.deps.backgroundTasks.startPerfLogging();
    await runStartupStep('initPriceCoordinator', () => this.deps.initPriceCoordinator(), logStartupStepFailure);
    await runStartupStep(
      'runStartupSettingsMigrations',
      () => this.deps.runStartupSettingsMigrations(),
      logStartupStepFailure,
    );
    await runStartupStep('loadCapacitySettings', () => ctx.loadCapacitySettings(), logStartupStepFailure);
    await runStartupStep('initDailyBudgetService', () => this.deps.initDailyBudgetService(), logStartupStepFailure);
    await runStartupStep(
      'loadFlowReportedCapabilities',
      () => this.deps.loadFlowReportedCapabilities(),
      logStartupStepFailure,
    );
    await runStartupStep(
      'initDeviceDiagnosticsService',
      () => this.deps.initDeviceDiagnosticsService(),
      logStartupStepFailure,
    );
    // Load the calibration store before the device manager so the
    // event-driven `onSnapshotMutated` hook is bound to the persisted store
    // from the first observation. Otherwise any live-feed event arriving
    // between `initDeviceManager` and `loadPowerCalibrationStore` would land
    // on the placeholder store and be discarded when the persisted snapshot
    // replaces it.
    await runStartupStep(
      'loadPowerCalibrationStore',
      () => this.deps.loadPowerCalibrationStore(),
      logStartupStepFailure,
    );
    await runStartupStep('initDeviceManager', () => this.deps.initDeviceManager(), logStartupStepFailure);
    const startupBootstrap: StartupBootstrapConfig = {
      snapshotPlanBootstrapDelayMs: deferStartupBootstrap ? 1200 : 0,
      runSnapshotPlanBootstrapInBackground: deferStartupBootstrap,
      runPriceBootstrapInBackground: deferStartupBootstrap,
      applyPriceOptimizationImmediatelyOnStart: !deferStartupBootstrap,
    };
    ctx.startupBootstrap = startupBootstrap;
    await runStartupStep('initCapacityGuard', () => this.deps.initCapacityGuard(), logStartupStepFailure);
    await runStartupStep('initPlanEngine', () => this.deps.initPlanEngine(), logStartupStepFailure);
    await runStartupStep('initPlanService', () => this.deps.initPlanService(), logStartupStepFailure);
    await runStartupStep(
      'initCapacityGuardProviders',
      () => this.deps.initCapacityGuardProviders(),
      logStartupStepFailure,
    );
    await runStartupStep('initSettingsHandler', () => this.deps.initSettingsHandler(), logStartupStepFailure);
    ctx.lastNotifiedOperatingMode = ctx.operatingMode;
    await runStartupStep('startAppServices', () => startAppServices(ctx), logStartupStepFailure);
    await runStartupStep(
      'startPriceLowestTriggerChecker',
      () => this.deps.backgroundTasks.startPriceLowestTriggerChecker(),
      logStartupStepFailure,
    );
    await runStartupStep(
      'startPostStartupBackgroundTasks',
      () => this.startPostStartupBackgroundTasks(),
      logStartupStepFailure,
    );
  }

  startPostStartupBackgroundTasks(): void {
    const { ctx } = this.deps;
    this.deps.startPowerTrackerPruning();
    const collectors = startBackgroundCollectors(ctx, (c) => this.deps.backgroundTasks.startWeatherCollector(c));
    this.deps.setWeatherCollector(collectors.weatherCollector);
    this.deps.setPvForecast(collectors.pvForecast);
    // Join the PV forecast + daily-budget background into the planning price, now
    // that the forecast exists (the boot price bootstrap ran before it).
    wireBudgetPrice(ctx, (ms) => this.deps.getPvForecast()?.service.forecast([ms])?.[0]?.generationKwh);
    // Clock-driven smart-task lifecycle emission (status/hours-remaining/ended +
    // history). PlanService exists by now, so the emitter's getDevices reads the
    // live plan-device source. Runs off the power path — fixes the flow-mode lag.
    this.deps.backgroundTasks.startDeferredObjectiveLifecycleClock(
      createDeferredObjectiveLifecycleEmitter(ctx),
    );
    // Fire-and-forget native-wiring flow-conflict detection. Best-effort: must
    // never block or fail startup, and reads fail closed. See
    // setup/flowConflictProbe.ts.
    this.deps.runNativeWiringDetectionBestEffort();
    // Re-run periodically so a conflicting Flow added after startup is
    // reflected without a restart, and a degraded startup (empty snapshot at
    // warm-up) recovers once the snapshot populates. The no-change guard makes
    // each run a no-op unless the verdict actually changed; the in-flight guard
    // and a dedicated timer (not the refresh path) keep it from looping.
    this.deps.timers.registerInterval('nativeWiringRequery', setInterval(
      () => this.deps.runNativeWiringDetectionBestEffort(),
      NATIVE_WIRING_REQUERY_INTERVAL_MS,
    ));
  }

  async initPriceCoordinator(): Promise<void> {
    const { ctx } = this.deps;
    ctx.priceCoordinator = createPriceCoordinator(ctx);
    const publisher = createPriceFlowTagPublisher(ctx);
    ctx.priceFlowTagPublisher = publisher;
    await publisher.init();
    // Publish whatever the persisted price store already holds, so HomeyScript
    // reads at startup see real data (and the right `unit`) instead of the
    // placeholder default — without waiting for the first price refresh.
    await publisher.publish('startup');
  }

  initDailyBudgetService(): void {
    const { ctx } = this.deps;
    const service = createDailyBudgetService(ctx);
    ctx.dailyBudgetService = service;
    service.loadSettings();
    service.loadState();
  }

  installStructuredLogger(): PinoLogger {
    const { ctx } = this.deps;
    const logger = createRootLogger(
      createHomeyDestination({ log: (...a) => ctx.log(...a), error: (...a) => ctx.error(...a) }),
    );
    setRootLogger(logger);
    this.deps.setStructuredLogger(logger);
    return logger;
  }

  /**
   * Build the observer-owned binarySettle operation bag passed into
   * `DeviceTransport`. Binds each observer function so transport can
   * invoke them through the bag without statically referencing
   * `lib/observer/binarySettle.ts` (cruiser rule
   * `no-device-to-peer-except-power`). PR #4 of the observer/transport
   * split — `notes/state-management/observer-transport-split.md`.
   */
  private buildObserverBinarySettleOps(): DeviceTransportBinarySettleOps {
    return {
      start: startPendingBinarySettleWindow,
      note: notePendingBinarySettleObservation,
      hasWindow: hasPendingBinarySettleWindow,
      clear: clearPendingBinarySettleWindow,
      clearAll: clearAllPendingBinarySettleWindows,
    };
  }

  async initDeviceManager(): Promise<void> {
    const { ctx } = this.deps;
    const structuredLogger = this.deps.getStructuredLogger() ?? this.installStructuredLogger();
    const structuredLog = structuredLogger.child({ component: 'devices' });
    // Co-create the observed-state projection with the transport so their
    // lifecycles are coupled. The projection's sequence guard is keyed on the
    // transport's per-device `observationSeq`; a new DeviceTransport resets those
    // counters, so a long-lived projection would drop a fresh transport's early
    // deltas (seq <= the previous transport's higher seqs). `initDeviceManager`
    // runs once today (no in-process restart path), so this is currently
    // equivalent to the field initializer — but it documents and enforces the
    // transport/projection epoch coupling for any future restart. The persistent
    // emitter subscription reads the projection getter at event time, so
    // reassigning the field is sufficient.
    this.deps.setObservedDeviceStateProjection(new ObservedDeviceStateProjection());
    const deviceManager = new DeviceTransport(this.deps.homeyApp, {
      log: ctx.log.bind(ctx),
      debug: (...args: unknown[]) => ctx.logDebug('devices', ...args),
      error: ctx.error.bind(ctx),
      structuredLog,
    }, {
      getPriority: (id) => ctx.getPriorityForDevice(id),
      getControllable: (id) => ctx.isCapacityControlEnabled(id),
      getManaged: (id) => ctx.resolveManagedState(id),
      isManagedFilterActive: () => this.deps.isManagedFilterActive(),
      getBudgetExempt: (id) => ctx.isBudgetExempt(id),
      getCommunicationModel: (id) => ctx.getCommunicationModel(id),
      getNativeEvWiringEnabled: (id) => this.deps.resolveNativeWiringEnabled(id),
      getFlowConflict: (id) => this.deps.getFlowConflict(id),
      getDeviceDriverIdOverride: (id) => this.deps.getDeviceDriverIdOverride(id),
      getDeviceControlProfile: (id) => ctx.deviceControlProfiles[id],
      getDeviceTargetPowerConfig: (id) => ctx.deviceTargetPowerConfigs[id],
      getFlowReportedCapabilities: (deviceId) => ctx.getFlowReportedCapabilitiesForDevice(deviceId),
    }, {
      expectedPowerKwOverrides: ctx.expectedPowerKwOverrides,
      lastKnownPowerKw: ctx.lastKnownPowerKw,
      lastPositiveMeasuredPowerKw: ctx.lastPositiveMeasuredPowerKw,
    }, {
      debugStructured: ctx.getStructuredDebugEmitter('devices', 'devices'),
      getFlowTriggerCard: (cardId) => ctx.homey.flow?.getTriggerCard?.(cardId),
      onSnapshotMutated: createCalibrationSnapshotMutationHook({
        getStore: () => this.deps.getPowerCalibrationStore(),
        debugStructured: ctx.getStructuredDebugEmitter('power_calibration', 'power_calibration'),
      }),
      binarySettleState: this.deps.getObserverBinarySettleState(),
      binarySettleOps: this.buildObserverBinarySettleOps(),
      pendingPredicate: (deviceId, capabilityId) => (
        hasPendingBinarySettleWindow(this.deps.getObserverBinarySettleState(), deviceId, capabilityId)
      ),
      observedStateDispatcher: this.deps.getObservedStateEmitter().asDispatcher(this.deps.getObservedHomePower()),
    });
    ctx.deviceManager = deviceManager;
    await deviceManager.init();
    const emitter = this.deps.getObservedStateEmitter();
    // Wiring subscribes to the observer-owned emitter rather than the
    // transport-side EventEmitter. Transport's dispatcher (above) routes
    // every post-translation event through `observedStateEmitter`, which
    // is the single source of truth for realtime fan-out post-PR #5. See
    // notes/state-management/observer-transport-split.md.
    emitter.onPlanReconcile((event: PlanReconcileObservedEvent) => {
      this.scheduleRealtimeDeviceReconcile(event);
    });
    // Feed the projection FIRST, before any listener that reads it. Listeners
    // fire in registration order, and `syncLivePlanState` below reads the
    // projection (via `toPlanDevice`'s `currentOn`/`currentState`); applying the
    // event here first ensures that pass sees the freshly-merged observed value for
    // the same event instead of the previous one (stage 4b).
    emitter.onObservedStateChanged((e) => this.deps.getObservedDeviceStateProjection().applyDelta(e));
    emitter.onObservedStateRefresh((e) => this.deps.getObservedDeviceStateProjection().applyRefresh(e));
    // NB: the projection is seeded lazily on the first plan build
    // (`createPlanService.getPlanDevices` → `ctx.seedObservedStateFromSnapshot`),
    // not here: right after `initDeviceManager` the transport's `getSnapshot()`
    // is still empty (transport `init()` only attaches the live feed; the first
    // snapshot arrives with the bootstrap refresh, which dispatches its own
    // refresh into the projection). Seeding here would be a guaranteed no-op.
    emitter.onObservedStateChanged((event: ObservedStateChangedEvent) => {
      if (this.shouldRebuildPlanForRealtimeEvSocObservation(event)) {
        incPerfCounters([
          'plan_rebuild_requested_total',
          'plan_rebuild_requested.flow_total',
          'plan_rebuild_requested.flow.realtime_ev_soc_total',
        ]);
        this.deps.planRebuildScheduler.request({
          kind: 'flow',
          reason: 'realtime_ev_soc',
        });
      }
      if (
        event.measurePowerBecameSignificantlyPositive === true
        && ctx.isCapacityControlEnabled(event.deviceId)
      ) {
        ctx.powerSampleRebuildState = {
          ...ctx.powerSampleRebuildState,
          shortfallSuppressionInvalidated: true,
        };
      }
      void ctx.planService?.syncLivePlanState(event.source);
    });
  }

  private shouldRebuildPlanForRealtimeEvSocObservation(event: ObservedStateChangedEvent): boolean {
    const capabilityIds = [
      ...(event.capabilityId ? [event.capabilityId] : []),
      ...(event.observedCapabilityIds ?? []),
    ];
    if (!capabilityIds.some((capabilityId) => isStateOfChargeCapabilityId(capabilityId))) return false;
    return this.deps.hasEnabledEvBoostForSnapshot(this.deps.getSnapshotDevice(event.deviceId));
  }

  initCapacityGuard(): void {
    const { ctx } = this.deps;
    ctx.capacityGuard = new CapacityGuard({
      limitKw: ctx.capacitySettings.limitKw,
      softMarginKw: ctx.capacitySettings.marginKw,
      onShortfall: async (deficitKw) => this.deps.getPlanService().handleShortfall(deficitKw),
      onShortfallCleared: async () => this.deps.getPlanService().handleShortfallCleared(),
      structuredLog: ctx.getStructuredLogger('capacity'),
      capacityStateSummaryProvider: () => buildPlanCapacityStateSummary(
        ctx.planService?.getLatestPlanSnapshot(),
        {
          summarySource: 'plan_snapshot',
          summarySourceAtMs: ctx.planService?.getLatestPlanSnapshotUpdatedAtMs() ?? null,
        },
      ),
    });
  }

  initPlanEngine(): void {
    const { ctx } = this.deps;
    if (!ctx.deferredObjectivePlanHistoryRecorder) {
      ctx.deferredObjectivePlanHistoryRecorder = createDeferredObjectivePlanHistoryRecorder(ctx);
    }
    if (!ctx.deferredObjectiveActivePlanRecorder) {
      ctx.deferredObjectiveActivePlanRecorder = createDeferredObjectiveActivePlanRecorder(ctx);
    }
    const planEngine = createPlanEngine(ctx);
    ctx.planEngine = planEngine;
    this.hydratePlanEngineControlState();
    planEngine.beginStartupRestoreStabilization(STARTUP_RESTORE_STABILIZATION_MS);
    // Create the warmup gate before `initPlanService` reads it via `ctx`.
    // The gate holds the first `rebuildPlanFromCache` (any source) until the
    // bootstrap's first `refreshSnapshot()` resolves, so the planner never
    // runs against an empty snapshot. Without it, a price-refresh or
    // settings-change-triggered rebuild between `initDeviceManager` and the
    // first snapshot publishes `deferred_objective_unknown` for every
    // objective whose device hasn't landed yet, which fires a spurious
    // `waiting → unachievable` flow trigger on every restart.
    this.initSnapshotWarmupGate();
  }

  private hydratePlanEngineControlState(): void {
    const { ctx } = this.deps;
    if (!ctx.planEngine) return;
    const stored = ctx.homey.settings.get(DEVICE_LAST_CONTROLLED_MS) as unknown;
    ctx.planEngine.state.lastDeviceControlledMs = isNumberMap(stored) ? { ...stored } : {};
  }

  initDeviceDiagnosticsService(): void {
    const { ctx } = this.deps;
    ctx.deviceDiagnosticsService = createDeviceDiagnosticsService(ctx);
  }

  private initSnapshotWarmupGate(): void {
    const { ctx } = this.deps;
    const warmupLogger = ctx.getStructuredLogger('startup');
    ctx.snapshotWarmupGate = new SnapshotWarmupGate({
      timeoutMs: SNAPSHOT_WARMUP_TIMEOUT_MS,
      onRelease: (reason) => {
        // Emit at warn for timeout (operationally interesting; means the
        // first device snapshot did not land within the bound) and info for
        // the normal snapshot-ready release. Both go through the structured
        // logger so log audits can attribute spurious-event suppression.
        const payload = {
          event: 'snapshot_warmup_gate_released',
          reason,
          timeoutMs: SNAPSHOT_WARMUP_TIMEOUT_MS,
        };
        if (reason === 'timeout') {
          warmupLogger?.warn(payload);
        } else {
          warmupLogger?.info(payload);
        }
      },
    });
  }

  initPlanService(): void {
    const { ctx } = this.deps;
    ctx.planService = createPlanService(ctx);
  }

  initCapacityGuardProviders(): void {
    const { ctx } = this.deps;
    if (!ctx.capacityGuard) return;
    ctx.defaultComputeDynamicSoftLimit = ctx.computeDynamicSoftLimit;
    ctx.capacityGuard.setSoftLimitProvider(() => ctx.computeDynamicSoftLimit());
    ctx.capacityGuard.setShortfallThresholdProvider(() => this.deps.computeShortfallThreshold());
  }

  initSettingsHandler(): void {
    const settingsHandler = initSettingsHandlerForApp(this.deps.ctx);
    this.deps.setStopSettingsHandler(settingsHandler.stop);
  }

  scheduleRealtimeDeviceReconcile(event: realtimeReconcile.RealtimeDeviceReconcileEvent): void {
    const { ctx } = this.deps;
    const structuredLog = ctx.getStructuredLogger('reconcile');
    const debugStructured = ctx.getStructuredDebugEmitter('reconcile', 'devices');
    const timer = scheduleAppRealtimeDeviceReconcile({
      event,
      state: this.deps.getRealtimeDeviceReconcileState(),
      hasPendingTimer: this.deps.timers.has('realtimeDeviceReconcile'),
      getLatestPlanSnapshot: () => ctx.planService?.getLatestReconcilePlanSnapshot() ?? null,
      getLiveDevices: () => {
        const snapshot = ctx.latestTargetSnapshot;
        evictMissingDeviceCacheEntries(ctx, snapshot);
        return snapshot.map((device) => toPlanDevice(ctx, device));
      },
      structuredLog,
      debugStructured,
      reconcile: () => ctx.planService?.reconcileLatestPlanState() ?? Promise.resolve(false),
      onTimerFired: () => {
        this.deps.timers.clear('realtimeDeviceReconcile');
      },
      onError: (error) => {
        const normalizedError = normalizeError(error);
        structuredLog?.error({
          event: 'realtime_reconcile_failed',
          err: normalizedError,
        });
      },
    });
    if (timer) {
      this.deps.timers.registerTimeout('realtimeDeviceReconcile', timer);
    }
  }

  async runUninit(): Promise<void> {
    const { ctx } = this.deps;
    // Signal the fire-and-forget native-wiring probe to drop its side effects
    // before anything else tears down. We deliberately do NOT await it: it can
    // be parked on a slow flow read, and blocking teardown on that read would
    // stall shutdown. Suppressing its continuation is enough.
    this.deps.setNativeWiringUninitializing(true);
    this.clearUninitTimers();
    realtimeReconcile.clearRealtimeDeviceReconcileState(this.deps.getRealtimeDeviceReconcileState());
    this.stopUninitServices();
    this.deps.getPvForecast()?.stop();
    // Release the warmup gate so any rebuild awaiting it during a partial
    // startup unblocks (cancelAll below then drops the intent), instead of
    // dangling on a promise the gate would otherwise resolve via its
    // bounded timeout.
    ctx.snapshotWarmupGate?.release('timeout');
    this.deps.planRebuildScheduler.cancelAll('app_uninit');
    ctx.deviceDiagnosticsService?.destroy();
    // Persist any unflushed deferred-objective plan-history entries before shutting down.
    ctx.deferredObjectivePlanHistoryRecorder?.flushIfDirty();
    ctx.deferredObjectiveActivePlanRecorder?.flushIfDirty();
    flushDailyBudgetStateOnUninit(ctx);
    // Flush bypasses the debounce window so any samples accepted since the
    // last persist tick reach settings before shutdown. Without this, samples
    // recorded inside the persist-debounce window are lost on restart.
    this.deps.flushPowerCalibration();
    // Mark how far we've observed; back-fill on next startup picks up from here. Skipped if
    // the recorder is still dirty (save failed), so the next start re-scans the missed window.
    persistDeferredObjectiveObservationWatermark(ctx, ctx.deferredObjectivePlanHistoryRecorder);
    ctx.priceCoordinator?.stop();
    ctx.deviceManager?.destroy();
  }

  private clearUninitTimers(): void {
    const { ctx } = this.deps;
    if (this.deps.timers.has('powerTrackerSave')) {
      this.deps.persistPowerTrackerState('uninit');
    }
    this.deps.timers.clearAll();
    ctx.snapshotHelpers.stop();
    ctx.homeyEnergyHelpers.stop();
  }

  private stopUninitServices(): void {
    this.deps.backgroundTasks.stopAll();
    this.deps.getStopSettingsHandler()?.();
  }
}
