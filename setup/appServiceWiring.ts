import type { TeardownRegistry } from '../lib/utils/teardownRegistry';
import type Homey from 'homey';
import type { ObservedStateEmitter } from '../lib/observer/observedStateEvents';
import type { ObservedHomePower } from '../lib/observer/observedHomePower';
import type { ObservedDeviceStateProjection } from '../lib/observer/observedDeviceStateProjection';
import { SnapshotWarmupGate } from '../lib/plan/snapshotWarmupGate';
import type { PlanService } from '../lib/plan/planService';
import type { PlanRebuildScheduler } from '../lib/plan/rebuildScheduler/scheduler';
import type { PowerCalibrationStore } from '../lib/device/devicePowerCalibrationStore';
import { isNumberMap } from '../lib/utils/appTypeGuards';
import { DEVICE_LAST_CONTROLLED_MS } from '../lib/utils/settingsKeys';
import {
  createRootLogger,
  setRootLogger,
  type Logger as PinoLogger,
} from '../lib/logging/logger';
import { createHomeyDestination } from '../lib/logging/homeyDestination';
import { normalizeError } from '../lib/utils/errorUtils';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import type { WeatherCollector } from '../lib/weather/weatherCollector';
import {
  requireInitializedAppContext,
  type AppContext,
  type StartupBootstrapConfig,
} from '../lib/app/appContext';
import {
  createDeferredObjectiveActivePlanRecorder,
  createDeferredObjectivePlanHistoryRecorder,
  createDailyBudgetService,
  createDeviceDiagnosticsService,
  createPlanEngineComposition,
  createPlanService,
  createPriceCoordinator,
  createPriceFlowTagPublisher,
  persistDeferredObjectiveObservationWatermark,
  resolvePlanService,
  subscribePlanObservedState,
} from './appInit';
import { buildMainHomeScope, type HomeScope } from './homeRuntime/homeScope';
import type { HomeRuntimeRegistry } from './homeRuntime/homeRuntimeRegistry';
import { buildHomeRuntimeReadPort, createHomeRuntimeRegistryForApp } from './appInit/wireHomeRuntimeRegistry';
import { wireDeviceTransport } from './appInit/wireDeviceTransport';
import type { HomeMembershipService } from './homeMembership';
import type { PvForecastController } from './appInit/createPvForecastService';
import type {
  HomeySolarForecastController,
  HomeySolarForecastLifecycle,
} from '../lib/solar/homeySolarForecastController';
import { flushDailyBudgetStateOnUninit, runStartupStep, startAppServices } from './appLifecycleHelpers';
import { wireHomeMembership } from './appInit/wireHomeMembership';
import {
  buildAppHomeMembershipOptions,
  createPreparedMainReconcileFence,
  type StableSampleRevisionReader,
} from './appInit/appHomeMembershipOptions';
import { registerSettingsHandler } from './appInit/registerSettingsHandler';
import { createMainCapacityGuard } from './appInit/createMainCapacityGuard';
import { startPostStartupBackgroundTasks } from './appInit/startPostStartupBackgroundTasks';
import { BackgroundTasksController } from './backgroundTasksController';
import type { AppNativeWiring } from './appNativeWiring';
import {
  invalidateOwningHomeRebuildSuppression,
  syncExternalOffHoldForObservation,
} from './appObservedControlStateRuntime';
import type { ObservedControlStateChangedEvent } from '../lib/observer/observedStateEvents';
import type { PlanRebuildTrigger } from '../lib/plan/planRebuildTrigger';
import { installMainFreshnessEscalation } from './appMainFreshnessEscalation';

const STARTUP_RESTORE_STABILIZATION_MS = 60 * 1000;
// Bound the warmup wait so a failed/slow Homey Manager fetch can never deadlock
// startup: if `refreshSnapshot()` does not resolve in this window the gate
// releases with reason `timeout` and the planner proceeds (next snapshot will
// arrive on the periodic refresh and rebuild correctly). Tests use a 0 bound
// to skip the wait entirely. Per `feedback_homey_sdk_unreliable`, a slow SDK
// fetch is treated as a transient gap, not a persisted-state corruption.
const SNAPSHOT_WARMUP_TIMEOUT_MS = process.env.NODE_ENV === 'test' ? 0 : 5_000;

/**
 * Dependencies for {@link AppServiceWiring}. Service handles the wider app also
 * reads/writes (`priceCoordinator`, `deviceManager`, `planEngine`, …) live on
 * `PelsApp` and flow through `ctx` (the shared `AppContext`); observer-owned
 * fields and other private `PelsApp` state are reached through the typed
 * getters/setters below. Cluster-internal calls that have a thin `PelsApp`
 * stub (`initPlanEngine`, `runStartupSettingsMigrations`, …) route back through
 * the app so test seams/spies that reassign the instance method are honoured.
 */
// Re-exported so `app.ts` can construct the fence it owns without taking a
// second module dependency — its `import-x/max-dependencies` ceiling of 31 is a
// ratchet, and this wiring already imports the factory.
export { createPreparedMainReconcileFence };

/** The Main-home shortfall gate, as this wiring hands it over and reads it back. */
export type MainShortfallSideEffectGate = ReturnType<
  typeof createMainCapacityGuard
>['shortfallSideEffectGate'];

/** Ask Main to re-establish meter authority, now or on the next scheduled pass. */
export type MainAuthorityRecoveryRequest = (timing?: 'scheduled' | 'immediate') => void;

/** Detaches the membership recompute triggers: refresh subscription + zone-tree-commit callback. */
const MEMBERSHIP_TEARDOWN_KEY = 'homeMembership';

export type AppServiceWiringDeps = {
  ctx: AppContext;
  /**
   * Handles to the services ordered startup constructs, held by `PelsApp` — the
   * composition root — and reached here through accessors. This class builds
   * them and hands them over; it does not remember them. The shape is
   * `AppNativeWiring`'s, for the same reason: the wiring layer holds nothing,
   * and a handle to a constructed service belongs to whoever composed the app.
   */
  getHomeMembershipService: () => HomeMembershipService | undefined;
  setHomeMembershipService: (service: HomeMembershipService | undefined) => void;
  getHomeRuntimeRegistry: () => HomeRuntimeRegistry | undefined;
  setHomeRuntimeRegistry: (registry: HomeRuntimeRegistry | undefined) => void;
  getMainShortfallSideEffectGate: () => MainShortfallSideEffectGate | undefined;
  setMainShortfallSideEffectGate: (gate: MainShortfallSideEffectGate | undefined) => void;
  getRequestMainAuthorityRecovery: () => MainAuthorityRecoveryRequest | undefined;
  setRequestMainAuthorityRecovery: (request: MainAuthorityRecoveryRequest | undefined) => void;
  /**
   * Set before teardown starts and read at the final Main actuator seam: an
   * already-running recovery reconcile can otherwise resume after membership is
   * detached and issue a late SDK command. One-way — nothing un-stops it.
   */
  isMainActuationStopped: () => boolean;
  stopMainActuation: () => void;
  /** Where this wiring's own stop callbacks live. See `lib/utils/teardownRegistry.ts`. */
  teardown: TeardownRegistry;
  preparedMainReconcileFence: ReturnType<typeof createPreparedMainReconcileFence>;
  homeyApp: Homey.App;
  backgroundTasks: BackgroundTasksController;
  timers: TimerRegistry;
  nativeWiring: AppNativeWiring;
  planRebuildScheduler: PlanRebuildScheduler;
  getStructuredLogger: () => PinoLogger | undefined;
  setStructuredLogger: (logger: PinoLogger) => void;
  getPlanService: () => PlanService;
  getStablePowerSampleRevision: StableSampleRevisionReader;
  getPowerCalibrationStore: () => PowerCalibrationStore;
  getObservedStateEmitter: () => ObservedStateEmitter;
  getObservedHomePower: () => ObservedHomePower;
  getObservedDeviceStateProjection: () => ObservedDeviceStateProjection;
  setObservedDeviceStateProjection: (projection: ObservedDeviceStateProjection) => void;
  setStopSettingsHandler: (stop: (() => void) | undefined) => void;
  getStopSettingsHandler: () => (() => void) | undefined;
  setWeatherCollector: (collector: WeatherCollector | undefined) => void;
  getPvForecast: () => PvForecastController | undefined;
  setPvForecast: (pvForecast: PvForecastController | undefined) => void;
  getHomeySolarForecast: () => HomeySolarForecastLifecycle;
  setHomeySolarForecast: (controller: HomeySolarForecastController) => void;
  setNativeWiringUninitializing: (value: boolean) => void;
  isManagedFilterActive: () => boolean;
  resolveNativeWiringEnabled: (deviceId: string) => boolean;
  runNativeWiringDetectionBestEffort: () => void;
  getDeviceDriverIdOverride: (deviceId: string) => string | undefined;
  getFlowConflict: (deviceId: string) => { conflictingCapabilities: readonly string[]; flowName?: string } | undefined;
  computeShortfallThreshold: () => number;
  retryDeferredOvershootSeed: (
    membership: HomeMembershipService,
    allowPendingOwnershipGeneration: boolean,
  ) => void;
  loadPersistedState: () => void;
  persistLearnedPowerPeaks: () => void;
  flushLearnedPowerPeaks: () => void;
  loadPowerCalibrationStore: () => void;
  startPowerTrackerPruning: () => void;
  stopPowerTracker: () => void;
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
  subscribePlanObservedState: () => void;
  captureDefaultDynamicSoftLimit: () => void;
  initSettingsHandler: () => void;
};

/**
 * Boot/teardown orchestration and per-service construction extracted from
 * `PelsApp`. `PelsApp` keeps slim `onInit`/`onUninit` lifecycle methods plus
 * thin `init*` delegators (the latter are still called directly by the
 * integration-test boot helper); the bodies live here.
 */
export class AppServiceWiring {
  // The main home's closure bundle for the plan factories. Built once (the
  // capacity-settings store port inside it is constructed a single time at
  // this wiring site) and shared by `initPlanEngine`/`initPlanService`.
  private readonly mainHomeScope: HomeScope;

  constructor(private readonly deps: AppServiceWiringDeps) {
    const { ctx } = deps;
    this.mainHomeScope = buildMainHomeScope(deps.ctx);
    ctx.rebuildOwningHomePlanForDevice = (deviceId, trigger) => (
      this.rebuildOwningHomePlanForDevice(deviceId, trigger)
    );
  }

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
      'loadPersistedState',
      () => this.deps.loadPersistedState(),
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
    await runStartupStep('initHomeMembership', () => this.initHomeMembership(), logStartupStepFailure);
    const startupBootstrap: StartupBootstrapConfig = {
      snapshotPlanBootstrapDelayMs: deferStartupBootstrap ? 1200 : 0,
      runSnapshotPlanBootstrapInBackground: deferStartupBootstrap,
      runPriceBootstrapInBackground: deferStartupBootstrap,
      applyPriceOptimizationImmediatelyOnStart: !deferStartupBootstrap,
    };
    ctx.startupBootstrap = startupBootstrap;
    await runStartupStep('initCapacityGuard', () => this.deps.initCapacityGuard(), logStartupStepFailure);
    await this.runPlanStackStartupSteps(logStartupStepFailure);
    await runStartupStep(
      'captureDefaultDynamicSoftLimit',
      () => this.deps.captureDefaultDynamicSoftLimit(),
      logStartupStepFailure,
    );
    await runStartupStep('initSettingsHandler', () => this.deps.initSettingsHandler(), logStartupStepFailure);
    await runStartupStep('initHomeRuntimeRegistry', () => this.initHomeRuntimeRegistry(), logStartupStepFailure);
    ctx.lastNotifiedOperatingMode = ctx.operatingMode;
    await runStartupStep('startAppServices', () => {
      requireInitializedAppContext(ctx);
      return startAppServices(ctx);
    }, logStartupStepFailure);
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
    requireInitializedAppContext(ctx);
    startPostStartupBackgroundTasks({ ...this.deps, ctx });
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

  // Body in `setup/appInit/wireDeviceTransport.ts`; kept as a method so the
  // thin `PelsApp.initDeviceManager` delegator and the integration boot
  // helper keep their call site.
  async initDeviceManager(): Promise<void> {
    await wireDeviceTransport({
      ...this.deps,
      installStructuredLogger: () => this.installStructuredLogger(),
      getHomeRuntimeRegistry: () => this.deps.getHomeRuntimeRegistry(),
      getHomeMembershipService: () => this.deps.getHomeMembershipService(),
    });
  }

  // Body in `setup/appInit/wireHomeMembership.ts`; the trigger-teardown handle
  // is invoked in `runUninit`.
  initHomeMembership(): void {
    // The zone-tree-commit readiness edge fires each capacity bundle's
    // membership-ready apply (decoupled from meter-sample arrival). Lazy over
    // `this.deps.getHomeRuntimeRegistry()`, which is wired later by
    // `initHomeRuntimeRegistry` — inert (registry undefined) until then.
    const wiring = wireHomeMembership(
      this.deps.ctx,
      this.deps.getObservedStateEmitter(),
      buildAppHomeMembershipOptions({
        getRegistry: () => this.deps.getHomeRuntimeRegistry(),
        getMembership: () => this.deps.getHomeMembershipService(),
        getMainStableSampleRevision: this.deps.getStablePowerSampleRevision,
        beginMainPreparedReconcile: (sampleRevision) => {
          this.deps.getMainShortfallSideEffectGate()?.holdDeferredUntilPreparedApply();
          return this.deps.preparedMainReconcileFence.begin(sampleRevision);
        },
        flushMainShortfallSideEffect: async () => (
          this.deps.getMainShortfallSideEffectGate()?.flushAfterPreparedApply() ?? true
        ),
        retryDeferredOvershootSeed: this.deps.retryDeferredOvershootSeed,
      }),
    );
    this.deps.ctx.homeMembership = wiring.service;
    this.deps.setHomeMembershipService(wiring.service);
    // Refuses rather than silently replacing, which the field assignment this
    // came from did not: a second `initHomeMembership` without an intervening
    // `runUninit` used to leak the predecessor's detach callback. There is one
    // call site and it sits inside the ordered startup sequence, so this is a
    // louder failure for a path that should not exist rather than a new one.
    this.deps.teardown.register(MEMBERSHIP_TEARDOWN_KEY, wiring.teardown);
    this.deps.setRequestMainAuthorityRecovery(wiring.requestMainAuthorityRecovery);
  }

  /**
   * Build the per-home capacity-bundle registry (R7b). Its runtime seams are
   * already wired lazily over `this.deps.getHomeRuntimeRegistry()` (the transport's
   * per-meter provider pair and the suffixed settings-change hooks). Runs
   * AFTER membership wiring so a bundle's first plan input and its
   * execution-readiness gate (fail-closed: false until a committed zone tree
   * has been joined, and false again after teardown) read real membership
   * state. With zero sub-homes the reconcile is a no-op and nothing else runs.
   */
  initHomeRuntimeRegistry(): void {
    this.deps.setHomeRuntimeRegistry(createHomeRuntimeRegistryForApp(
      this.deps.ctx,
      () => this.deps.getHomeMembershipService()?.isSubHomeExecutionReady() === true,
      () => this.deps.getHomeMembershipService()?.isRuntimeActive() === true,
    ));
    // Publish the per-home read seam. The registry stays private: `ctx` gets a
    // closure over the app's registry handle exposing only `readHome`, so it
    // reports `unavailable` before this step and again once `runUninit` clears it.
    this.deps.ctx.homeRuntimeRead = buildHomeRuntimeReadPort(() => this.deps.getHomeRuntimeRegistry());
  }

  initCapacityGuard(): void {
    const { ctx } = this.deps;
    const runtime = createMainCapacityGuard({
      ctx,
      isDiscarded: () => this.deps.isMainActuationStopped(),
      isTemporarilyFenced: () => (
        this.deps.preparedMainReconcileFence.isActive()
        || this.deps.getHomeMembershipService()?.isMainHomeActuationFenced() === true
      ),
      isPreparedReconcileActive: this.deps.preparedMainReconcileFence.isActive,
    });
    ctx.capacityGuard = runtime.guard;
    this.deps.setMainShortfallSideEffectGate(runtime.shortfallSideEffectGate);
  }

  initPlanEngine(): void {
    const { ctx } = this.deps;
    if (!ctx.deferredObjectivePlanHistoryRecorder) {
      ctx.deferredObjectivePlanHistoryRecorder = createDeferredObjectivePlanHistoryRecorder(ctx);
    }
    if (!ctx.deferredObjectiveActivePlanRecorder) {
      ctx.deferredObjectiveActivePlanRecorder = createDeferredObjectiveActivePlanRecorder(ctx);
    }
    const { planEngine, lifecycleFallbackPort } = createPlanEngineComposition(ctx, this.mainHomeScope, {
      capacityGuard: ctx.capacityGuard,
      isActuationFenced: () => this.isMainActuationFenced(),
    });
    ctx.planEngine = planEngine;
    ctx.lifecycleFallback = lifecycleFallbackPort;
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
    ctx.planService = createPlanService(ctx, this.mainHomeScope);
    installMainFreshnessEscalation(
      ctx,
      () => this.deps.isMainActuationStopped(),
      () => this.isMainActuationFenced(),
    );
  }

  /**
   * Main's home-wide write fence, read by the actuator wrapper AND the
   * silent-meter escalation (which refuses to spend its one shed pass while
   * every write would answer `requested: false`). Active sub-home zone
   * membership is provisional until the first real zone tree commits; Main's
   * plan may still contain those fallback-Main devices, so the final write
   * seam stays closed until ownership is trustworthy.
   */
  private isMainActuationFenced(): boolean {
    return this.deps.isMainActuationStopped()
      || this.deps.preparedMainReconcileFence.isSuperseded()
      || this.deps.ctx.homeMembership?.isMainHomeActuationFenced() === true;
  }

  /**
   * The plan stack, in the one order that works: the engine, then the service,
   * then the observed-state listeners that reach it.
   *
   * The last step is ORDERING, not a guard. Registering those listeners with the
   * transport (inside `initDeviceManager`, three awaited steps earlier) left a
   * window in which a device event either lost its `syncLivePlanState` or queued
   * a rebuild intent that would dereference an unwired service. Keep the three
   * together and in this order; do not hoist the subscription.
   */
  private async runPlanStackStartupSteps(
    logStartupStepFailure: (label: string, error: Error) => void,
  ): Promise<void> {
    await runStartupStep('initPlanEngine', () => this.deps.initPlanEngine(), logStartupStepFailure);
    await runStartupStep('initPlanService', () => this.deps.initPlanService(), logStartupStepFailure);
    await runStartupStep(
      'subscribePlanObservedState',
      () => this.deps.subscribePlanObservedState(),
      logStartupStepFailure,
    );
  }

  // Body in `setup/appInit/planObservedStateSubscription.ts`. Deliberately NOT folded into
  // `initDeviceManager`: these listeners reach the plan service, so they may not
  // be live before `initPlanService`.
  subscribePlanObservedState(): void {
    subscribePlanObservedState({
      ...this.deps,
      syncExternalOffHold: (event) => this.syncExternalOffHold(event),
      invalidateRebuildSuppression: (deviceId) => this.invalidateRebuildSuppression(deviceId),
    });
  }

  // Body in `setup/appObservedControlStateRuntime.ts`, beside the external-off
  // hold it is routed alongside.
  invalidateRebuildSuppression(deviceId: string): void {
    invalidateOwningHomeRebuildSuppression({
      ctx: this.deps.ctx,
      deviceId,
      getHomeRuntimeRegistry: () => this.deps.getHomeRuntimeRegistry(),
    });
  }

  captureDefaultDynamicSoftLimit(): void {
    const { ctx } = this.deps;
    ctx.defaultComputeDynamicSoftLimit = ctx.computeDynamicSoftLimit;
  }

  initSettingsHandler(): void {
    // Home-runtime hooks are lazy over the app's registry handle:
    // `initHomeRuntimeRegistry` runs after this step; until then a suffixed
    // write is dropped here and absorbed by the registry's boot-time reconcile.
    this.deps.setStopSettingsHandler(registerSettingsHandler({
      ctx: this.deps.ctx,
      getHomeRuntimeRegistry: () => this.deps.getHomeRuntimeRegistry(),
      requestMainAuthorityRecovery: (timing) => this.deps.getRequestMainAuthorityRecovery()?.(timing),
      observeOwnershipConfigurationChanged: () => {
        this.deps.getHomeMembershipService()?.observeOwnershipConfigurationChanged();
      },
      // Lazy over the app field: the controller starts in a later step
      // (startPostStartupBackgroundTasks); until then a write is a no-op and
      // the controller's own start() probe covers it.
      // The ONLY way `pv_forecast_source` changes. Re-resolve the held setting
      // FIRST so the probe gate and both forecast consumers see the new choice,
      // then kick the probe — the handler recomputes prices straight after.
      onPvForecastSourceObserved: () => {
        const forecast = this.deps.getHomeySolarForecast();
        if (forecast.kind !== 'started') return;
        forecast.controller.refreshSourceSetting();
        void forecast.controller.refresh();
      },
    }));
  }

  // Body in `setup/appObservedControlStateRuntime.ts`; kept as a method so the
  // emitter subscription and test seams keep their call site.
  syncExternalOffHold(event: ObservedControlStateChangedEvent): void {
    syncExternalOffHoldForObservation({
      ctx: this.deps.ctx,
      event,
      // Route a sub-home device through its own bundle (R7b P1#1); lazy over the
      // app's registry handle so it stays byte-identical (undefined → main closures)
      // before `initHomeRuntimeRegistry` and with no sub-homes.
      getHomeRuntimeRegistry: () => this.deps.getHomeRuntimeRegistry(),
    });
  }

  /**
   * Rebuild the plan of whichever home owns this device.
   *
   * Resolved, not asserted: the target-power reachability lane calls this as a
   * fire-and-forget `void` from a snapshot-mutation hook that is bound during
   * `initDeviceManager`. A synchronous throw there escapes the `.catch` chained
   * at the call site and the `void` around it, so a pre-`initPlanService`
   * mutation would crash boot rather than log. Before the service exists there
   * is no plan to rebuild and nothing to record — the first plan build reads the
   * freshly written reachability anyway.
   */
  rebuildOwningHomePlanForDevice(deviceId: string, trigger: PlanRebuildTrigger): Promise<unknown> {
    const subHomeRoute = this.deps.getHomeRuntimeRegistry()?.getOwningHomeRouteForDevice(deviceId);
    if (subHomeRoute) return subHomeRoute.hooks.rebuildPlan(trigger);
    const resolved = resolvePlanService(this.deps.ctx);
    if (resolved.state !== 'ready') return Promise.resolve();
    return resolved.planService.rebuildPlanFromCache(trigger);
  }

  async runUninit(): Promise<void> {
    const { ctx } = this.deps;
    // First teardown edge: close the final Main write seam before any awaited
    // or synchronous cleanup can detach the membership authority it also reads.
    this.deps.stopMainActuation();
    this.mainHomeScope.disposeBinaryCommandReachability();
    // Signal the fire-and-forget native-wiring probe to drop its side effects
    // before anything else tears down. We deliberately do NOT await it: it can
    // be parked on a slow flow read, and blocking teardown on that read would
    // stall shutdown. Suppressing its continuation is enough.
    this.deps.setNativeWiringUninitializing(true);
    // Tear down the per-home bundles BEFORE the global timer sweep so each
    // bundle can flush a pending suffixed tracker persist while its debounce
    // timer is still observable. Clearing the field also disconnects the lazy
    // per-meter fan-out: an in-flight poll resolving after this routes nowhere.
    this.deps.getHomeRuntimeRegistry()?.teardownAll();
    this.deps.setHomeRuntimeRegistry(undefined);
    ctx.homeRuntimeRead = undefined;
    this.clearUninitTimers();
    this.stopUninitServices();
    // Detach the membership recompute triggers BEFORE the transport teardown
    // so a still-in-flight refresh dispatch or detached zone-tree commit can
    // no longer recompute; clearing `ctx.homeMembership` also kills the lazy
    // settings-change trigger.
    this.deps.teardown.clear(MEMBERSHIP_TEARDOWN_KEY);
    this.deps.setRequestMainAuthorityRecovery(undefined);
    this.deps.setHomeMembershipService(undefined);
    ctx.homeMembership = undefined;
    this.deps.getPvForecast()?.stop();
    const homeySolarForecast = this.deps.getHomeySolarForecast();
    if (homeySolarForecast.kind === 'started') homeySolarForecast.controller.stop();
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
    // Same reason for the learned peaks, which are rate-limited to one write a
    // minute: the peak observed in the last minute of a run is precisely the one
    // a restart would drop, and the trailing flush timer is already gone by now.
    this.deps.flushLearnedPowerPeaks();
    // Mark how far we've observed; back-fill on next startup picks up from here. Skipped if
    // the recorder is still dirty (save failed), so the next start re-scans the missed window.
    persistDeferredObjectiveObservationWatermark(ctx, ctx.deferredObjectivePlanHistoryRecorder);
    ctx.priceCoordinator?.stop();
    ctx.deviceManager?.destroy();
  }

  private clearUninitTimers(): void {
    const { ctx } = this.deps;
    this.deps.stopPowerTracker();
    this.deps.timers.clearAll();
    ctx.snapshotHelpers.stop();
    ctx.homeyEnergyHelpers.stop();
    ctx.generationPollSource.stop();
  }

  private stopUninitServices(): void {
    this.deps.backgroundTasks.stopAll();
    this.deps.getStopSettingsHandler()?.();
  }
}
