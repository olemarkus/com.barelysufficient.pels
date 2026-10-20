import { createObservedTemperatureModeUpdates } from './appInit/createObservedTemperatureModeUpdates';
import type { TeardownRegistry } from '../lib/utils/teardownRegistry';
import type Homey from 'homey';
import type { ObservedStateEmitter } from '../lib/observer/observedStateEvents';
import type { ObservedControlStateChangedEvent } from '../lib/ports/observedStateEvents';
import type { ObservedHomePower } from '../lib/observer/observedHomePower';
import type { ObservedDeviceStateProjection } from '../lib/observer/observedDeviceStateProjection';
import { SnapshotWarmupGate } from '../lib/plan/snapshotWarmupGate';
import type { PlanRebuildScheduler } from '../lib/plan/rebuildScheduler/scheduler';
import { createRootLogger, setRootLogger, type Logger as PinoLogger } from '../lib/logging/logger';
import { createHomeyDestination } from '../lib/logging/homeyDestination';
import { normalizeError } from '../lib/utils/errorUtils';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import {
  requireInitializedAppContext,
  type AppContext,
  type StartupBootstrapConfig,
} from '../lib/app/appContext';
import type { ModePriorityOrder } from '../packages/shared-domain/src/settings/modePriorities';
import { buildTaskEvaluationSource } from './appInit/taskEvaluationSource';
import {
  createDeferredObjectiveActivePlanRecorder,
  createDeferredObjectiveEnergyDelivery,
  createDeferredObjectivePlanHistoryRecorder,
  flushDeferredObjectiveRecorders,
  createDailyBudgetService,
  createDeviceDiagnosticsService,
  BATTERY_CONTROL_TEARDOWN_KEY,
  initMainBatteryControl,
  createPriceCoordinator,
  createPriceFlowTagPublisher,
  persistDeferredObjectiveObservationWatermark,
  mainStorageLane,
  requireHomeMembership,
  requirePlanService,
  resolvePlanService,
  subscribePlanObservedState,
} from './appInit';
import { buildMainHomeScope, type HomeScope } from './homeRuntime/homeScope';
import { createHomePlanRuntime } from './homeRuntime/createHomePlanRuntime';
import { createHomeCapacityGuard } from './homeRuntime/createHomeCapacityGuard';
import type { HomeRuntimeRegistry } from './homeRuntime/homeRuntimeRegistry';
import type { PowerSamplePipeline } from './powerSamplePipeline';
import {
  buildHomeRuntimeReadPort, createHomeRuntimeRegistryForApp, wirePlanStatusRealtime,
} from './appInit/wireHomeRuntimeRegistry';
import {
  buildDeviceTransport, startDeviceTransport, subscribeObservedStateProjection,
} from './appInit/wireDeviceTransport';
import type { HomeMembershipWiring } from './homeMembershipWiring';
import type { AppRuntimeHandles } from './appRuntimeHandles';
import type { ShutdownLatch } from '../lib/utils/shutdownLatch';
import {
  flushDailyBudgetStateOnUninit, runStartupSettingsMigrations, runStartupStep, startAppServices,
} from './appLifecycleHelpers';
import { wireHomeMembership } from './appInit/wireHomeMembership';
import {
  buildAppHomeMembershipOptions,
} from './appInit/appHomeMembershipOptions';
import { registerSettingsHandler } from './appInit/registerSettingsHandler';
import { startPostStartupBackgroundTasks } from './appInit/startPostStartupBackgroundTasks';
import type { BackgroundTasksController } from './backgroundTasksController';
import type { AppPowerTracker } from './appPowerTracker';

import type { PlanRebuildTrigger } from '../lib/plan/planRebuildTrigger';
import { installMainFreshnessEscalation } from './appMainFreshnessEscalation';
import {
  invalidateOwningHomeRebuildSuppression, syncOwningHomeLivePlanState, syncExternalOffHoldForObservation,
} from './appObservedControlStateRuntime';
export { createHomeRuntimeRegistryForApp };

type HomeMembershipService = HomeMembershipWiring['service'];

// Bound the warmup wait so a failed/slow Homey Manager fetch can never deadlock
// startup: if `refreshSnapshot()` does not resolve in this window the gate
// releases with reason `timeout` and the planner proceeds (next snapshot will
// arrive on the periodic refresh and rebuild correctly). Per
// `feedback_homey_sdk_unreliable`, a slow SDK fetch is treated as a transient
// gap, not a persisted-state corruption.
const SNAPSHOT_WARMUP_TIMEOUT_MS = 5_000;

/**
 * Production boot order: the snapshot/plan bootstrap deferred and the price
 * bootstrap in the background, with the warmup gate holding planning until the
 * first snapshot lands. The test suite boots synchronously with an open gate,
 * because specs that run the boot steps by hand never reach the bootstrap that
 * would release it; a spec opts into the production order with
 * `PELS_ASYNC_STARTUP=1`. Read per boot, not at import, so a spec can set it.
 */
const usesProductionStartupOrder = (): boolean => (
  process.env.NODE_ENV !== 'test' || process.env.PELS_ASYNC_STARTUP === '1'
);

// Re-exported so `app.ts` can build the per-home read port over the registry
// handle it owns without taking a second module dependency — its
// `import-x/max-dependencies` ceiling is a ratchet, and this wiring already
// imports the factory.
export { buildHomeRuntimeReadPort };
export type { HomeRuntimeRegistry };

/** Detaches the membership recompute triggers: refresh subscription + zone-tree-commit callback. */
const MEMBERSHIP_TEARDOWN_KEY = 'homeMembership';
/** Detaches the settings `set`/`unset` listeners and stops the handler's debounced sync. */
const SETTINGS_HANDLER_TEARDOWN_KEY = 'settingsHandler';

export type AppServiceWiringDeps = {
  ctx: AppContext;
  getHomeOperatingMode: () => string;
  getPrioritiesForDevices: (deviceIds: readonly string[]) => ModePriorityOrder;
  getModeDeviceTargets: () => Record<string, Record<string, number>>;
  resolveOperatingModeForDevice: Parameters<typeof createObservedTemperatureModeUpdates>[1];
  createHomeRuntimeRegistry: (
    membership: Pick<HomeMembershipService, 'isSubHomeExecutionReady' | 'isRuntimeActive'>,
  ) => HomeRuntimeRegistry;
  handles: AppRuntimeHandles;
  /** The app's one-way teardown signal: tripped as the first edge of uninit. */
  shutdown: ShutdownLatch;
  /** Where this wiring's own stop callbacks live. See `lib/utils/teardownRegistry.ts`. */
  teardown: TeardownRegistry;
  /** Main's sample pipeline: its stable revision and the prepared-reconcile fence over it. */
  mainPowerSamplePipeline: PowerSamplePipeline;
  homeyApp: Homey.App;
  backgroundTasks: BackgroundTasksController;
  timers: TimerRegistry;
  powerTrackerHelpers: AppPowerTracker;
  planRebuildScheduler: PlanRebuildScheduler;
  observedStateEmitter: ObservedStateEmitter;
  observedHomePower: ObservedHomePower;
  observedDeviceStateProjection: ObservedDeviceStateProjection;
  /** First: every repository is open before any step can reach for one. */
  openUserdataStores: () => void;
  /** Last: every tracker has flushed by now, and nothing reads the file after this. */
  closeUserdataDatabase: () => void;
  /** Reload Main's mode catalog (`HomeModeCatalog.reload`). */
  reloadMainModeCatalog: () => void;
};

/**
 * Boot/teardown orchestration and per-service construction extracted from
 * `PelsApp`, which keeps slim `onInit`/`onUninit` lifecycle methods. The
 * integration-test boot helper calls the ordered `init*` steps on this instance
 * directly.
 */
export class AppServiceWiring {
  /**
   * The main home's smart-task evaluation source, built once: the plan
   * engine's decoration lane, the lifecycle clock and the app's create-task
   * preview all read the household through this instance. The wiring only
   * hands it on, so it holds it as whatever the builder builds.
   */
  readonly taskEvaluationSource: ReturnType<typeof buildTaskEvaluationSource>;
  // The main home's closure bundle for the plan factories. Built once (the
  // capacity-settings store port inside it is constructed a single time at
  // this wiring site) and shared by `initPlanRuntime`.
  private readonly mainHomeScope: HomeScope;

  constructor(private readonly deps: AppServiceWiringDeps) {
    const { ctx } = deps;
    this.taskEvaluationSource = buildTaskEvaluationSource(ctx, deps.getPrioritiesForDevices);
    this.mainHomeScope = buildMainHomeScope(
      deps.ctx, this.taskEvaluationSource, deps.getPrioritiesForDevices, deps.getHomeOperatingMode,
      deps.getModeDeviceTargets, deps.shutdown,
      () => this.isMainHomeWideFenced());
    ctx.rebuildOwningHomePlanForDevice = (deviceId, trigger) => (
      this.rebuildOwningHomePlanForDevice(deviceId, trigger)
    );
  }

  createObservedTemperatureModeUpdates() {
    return createObservedTemperatureModeUpdates(
      this.deps.ctx,
      this.deps.resolveOperatingModeForDevice,
      () => this.deps.handles.homeRuntimeRegistry?.getLiveBundles() ?? [],
      (deviceId) => this.isDeviceLimitedInOwningHome(deviceId),
    );
  }

  async runInit(): Promise<void> {
    const { ctx } = this.deps;
    const deferStartupBootstrap = usesProductionStartupOrder();
    const logStartupStepFailure = (label: string, error: Error): void => {
      this.deps.handles.structuredLogger?.child({ component: 'startup' }).error({
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
    // The store opens here, named and first, so a database that cannot be
    // opened is attributed to the store rather than to whichever step first
    // reached for it — and no step runs without it.
    await runStartupStep('openUserdataStores', () => this.deps.openUserdataStores(), logStartupStepFailure);
    await runStartupStep('initPriceCoordinator', () => this.initPriceCoordinator(), logStartupStepFailure);
    await runStartupStep(
      'runStartupSettingsMigrations',
      () => runStartupSettingsMigrations(ctx.homey),
      logStartupStepFailure,
    );
    await runStartupStep('loadCapacitySettings', () => ctx.loadCapacitySettings(), logStartupStepFailure);
    await runStartupStep('initDailyBudgetService', () => this.initDailyBudgetService(), logStartupStepFailure);
    await runStartupStep(
      'loadPersistedState',
      () => ctx.flowBacked.loadPersistedState(),
      logStartupStepFailure,
    );
    await runStartupStep(
      'initDeviceDiagnosticsService',
      () => this.initDeviceDiagnosticsService(),
      logStartupStepFailure,
    );
    await this.runDeviceStartupSteps(logStartupStepFailure);
    const startupBootstrap: StartupBootstrapConfig = {
      snapshotPlanBootstrapDelayMs: deferStartupBootstrap ? 1200 : 0,
      runSnapshotPlanBootstrapInBackground: deferStartupBootstrap,
      runPriceBootstrapInBackground: deferStartupBootstrap,
    };
    ctx.startupBootstrap = startupBootstrap;
    await runStartupStep('initCapacityGuard', () => this.initCapacityGuard(), logStartupStepFailure);
    await this.runPlanStackStartupSteps(logStartupStepFailure);
    await runStartupStep(
      'captureDefaultDynamicSoftLimit',
      () => this.captureDefaultDynamicSoftLimit(),
      logStartupStepFailure,
    );
    await runStartupStep('initSettingsHandler', () => this.initSettingsHandler(), logStartupStepFailure);
    await runStartupStep('initHomeRuntimeRegistry', () => this.initHomeRuntimeRegistry(), logStartupStepFailure);
    ctx.lastNotifiedOperatingMode = this.deps.getHomeOperatingMode();
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
    this.deps.powerTrackerHelpers.startPowerTrackerPruning();
    startPostStartupBackgroundTasks(
      ctx,
      this.taskEvaluationSource,
      this.deps.backgroundTasks,
      this.deps.timers,
      this.deps.handles,
      (listener) => { this.deps.observedStateEmitter.onObservedStateRefresh(listener); },
    );
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
    this.deps.handles.structuredLogger = logger;
    return logger;
  }

  // Bodies in `setup/appInit/wireDeviceTransport.ts`; the order is load-bearing.
  async initDeviceManager(): Promise<void> {
    const { ctx, handles, observedStateEmitter } = this.deps;
    const deviceManager = buildDeviceTransport(
      ctx,
      this.deps.homeyApp,
      handles.structuredLogger ?? this.installStructuredLogger(),
      observedStateEmitter.asDispatcher(this.deps.observedHomePower),
    );
    subscribeObservedStateProjection(observedStateEmitter, this.deps.observedDeviceStateProjection);
    // Areas not built yet reload their own catalogs when they are.
    await startDeviceTransport(ctx, deviceManager, () => {
      this.deps.reloadMainModeCatalog();
      handles.homeRuntimeRegistry?.reloadModeCatalogs();
    });
  }

  // Body in `setup/appInit/wireHomeMembership.ts`; the trigger-teardown handle
  // is invoked in `runUninit`.
  initHomeMembership(): void {
    // The zone-tree-commit edge applies each bundle independently of samples.
    // Registry lookup stays lazy because its setup step runs afterward.
    const { handles } = this.deps;
    const wiring = wireHomeMembership(this.deps.ctx,
      (listener) => this.deps.observedStateEmitter.onObservedStateRefresh(listener),
      buildAppHomeMembershipOptions(
        () => handles.homeRuntimeRegistry,
        () => handles.homeMembershipService,
        () => this.deps.mainPowerSamplePipeline.getStableSampleRevision(),
        (sampleRevision) => {
          handles.mainShortfallSideEffectGate?.holdDeferredUntilPreparedApply();
          return this.deps.mainPowerSamplePipeline.preparedReconcileFence.begin(sampleRevision);
        },
        async () => handles.mainShortfallSideEffectGate?.flushAfterPreparedApply() ?? true,
      ),
    );
    this.deps.ctx.homeMembership = wiring.service;
    handles.homeMembershipService = wiring.service;
    // Main's mode catalog persists missing ranks only once it can read
    // settled ownership, which it could not when it first loaded.
    this.deps.ctx.loadCapacitySettings();
    // Refuses rather than silently replacing, which the field assignment this
    // came from did not: a second `initHomeMembership` without an intervening
    // `runUninit` used to leak the predecessor's detach callback. There is one
    // call site and it sits inside the ordered startup sequence, so this is a
    // louder failure for a path that should not exist rather than a new one.
    this.deps.teardown.register(MEMBERSHIP_TEARDOWN_KEY, wiring.teardown);
    handles.requestMainAuthorityRecovery = wiring.requestMainAuthorityRecovery;
  }

  /**
   * Build the per-home capacity-bundle registry (R7b). Its runtime seams are
   * already wired lazily over `this.deps.handles.homeRuntimeRegistry` (the transport's
   * per-meter provider pair and the suffixed settings-change hooks). Runs
   * AFTER membership wiring so a bundle's first plan input and its
   * execution-readiness gate (fail-closed: false until a committed zone tree
   * has been joined, and false again after teardown) read real membership
   * state. With zero sub-homes the reconcile is a no-op and nothing else runs.
   */
  initHomeRuntimeRegistry(): void {
    const { handles } = this.deps;
    // Lazy over the handle, so both answers fail closed once uninit clears it.
    handles.homeRuntimeRegistry = this.deps.createHomeRuntimeRegistry({
      isSubHomeExecutionReady: () => handles.homeMembershipService?.isSubHomeExecutionReady() === true,
      isRuntimeActive: () => handles.homeMembershipService?.isRuntimeActive() === true,
    });
    wirePlanStatusRealtime(this.deps.ctx);
  }

  /**
   * Main's capacity guard, built by the factory every meter area builds its own
   * with. Main's scalars, tracker and display name reach it through the same
   * scope its plan runtime already takes, and its timer keys through the
   * identity namer its tracker persistence already uses — so what stays here is
   * only what is genuinely Main's: which lifecycle signals close its authority.
   */
  initCapacityGuard(): void {
    const { ctx } = this.deps;
    const runtime = createHomeCapacityGuard(
      ctx,
      this.mainHomeScope,
      // Main's timer namespace is the bare suffix, the same identity naming
      // `appPowerTracker.ts` binds for its tracker persistence.
      (suffix) => suffix,
      () => requirePlanService(ctx),
      // Discarded, authority closed, prepared reconcile active — see the
      // factory for what each one licenses.
      () => this.deps.shutdown.isStopped(),
      () => this.isMainHomeWideFenced(),
      () => this.deps.mainPowerSamplePipeline.preparedReconcileFence.isActive(),
    );
    ctx.capacityGuard = runtime.guard;
    this.deps.handles.mainShortfallSideEffectGate = runtime.shortfallSideEffectGate;
  }

  /**
   * Main's plan runtime, built by the factory every meter area builds its own
   * with. Main's half used to be spread over two boot steps and a private
   * hydration helper, which is the only reason the two assemblies were ever
   * separate code: the sequence itself — engine, resume the persisted
   * last-controlled map, open the restore window, then the service over that
   * engine — was already identical, down to the arguments.
   *
   * What stays here is what is genuinely Main's: the smart-task recorders it
   * alone runs, the ambient `AppContext` handles the rest of the app reads it
   * through, and the freshness escalation over its own meter.
   */
  initPlanRuntime(): void {
    const { ctx } = this.deps;
    ctx.deferredObjectivePlanHistoryRecorder ??= createDeferredObjectivePlanHistoryRecorder(ctx);
    ctx.deferredObjectiveActivePlanRecorder ??= createDeferredObjectiveActivePlanRecorder(ctx);
    ctx.deferredObjectiveEnergyDelivery ??= createDeferredObjectiveEnergyDelivery(ctx);
    // The warmup gate leads: the plan service reads it off `ctx` at
    // construction, and it holds the first `rebuildPlanFromCache` (any source)
    // until the bootstrap's first `refreshSnapshot()` resolves, so the planner
    // never runs against an empty snapshot. Without it a price-refresh or
    // settings-change rebuild between `initDeviceManager` and the first
    // snapshot publishes `deferred_objective_unknown` for every objective whose
    // device has not landed yet, firing a spurious `waiting → unachievable`
    // flow trigger on every restart. It depends on nothing the runtime builds.
    this.initSnapshotWarmupGate();
    const { planEngine, planService, lifecycleFallbackPort } = createHomePlanRuntime(ctx, this.mainHomeScope, {
      capacityGuard: ctx.capacityGuard, isActuationFenced: () => this.isMainActuationFenced(),
      storageLane: mainStorageLane(ctx),
    });
    ctx.planEngine = planEngine;
    ctx.planService = planService;
    ctx.lifecycleFallback = lifecycleFallbackPort;
    installMainFreshnessEscalation(
      ctx,
      () => this.deps.shutdown.isStopped(),
      () => this.isMainActuationFenced(),
    );
  }

  initDeviceDiagnosticsService(): void {
    const { ctx } = this.deps;
    ctx.deviceDiagnosticsService = createDeviceDiagnosticsService(ctx);
  }

  private initSnapshotWarmupGate(): void {
    const { ctx } = this.deps;
    const warmupLogger = ctx.getStructuredLogger('startup');
    const timeoutMs = usesProductionStartupOrder() ? SNAPSHOT_WARMUP_TIMEOUT_MS : 0;
    ctx.snapshotWarmupGate = new SnapshotWarmupGate({
      timeoutMs,
      onRelease: (reason) => {
        // Emit at warn for timeout (operationally interesting; means the
        // first device snapshot did not land within the bound) and info for
        // the normal snapshot-ready release and for a teardown inside the
        // startup window (`shutdown`, not a startup problem). All go through
        // the structured logger so log audits can attribute spurious-event
        // suppression.
        const payload = { event: 'snapshot_warmup_gate_released', reason, timeoutMs };
        if (reason === 'timeout') {
          warmupLogger?.warn(payload);
        } else {
          warmupLogger?.info(payload);
        }
      },
    });
  }


  /**
   * The part of Main's fence that holds for a whole plan cycle: the app torn
   * down, or ownership not yet trustworthy. Active sub-home zone membership is
   * provisional until the first real zone tree commits; Main's plan may still
   * contain those fallback-Main devices, so nothing may be written until
   * ownership settles.
   *
   * Being cycle-stable is what lets it be a DRY-RUN gate rather than only a
   * write fence — Main's scope folds it into `getCapacityDryRun`, exactly as a
   * meter area folds its membership and source-epoch gates into
   * `SubHomeRuntime.isEffectiveDryRunForExecution`. The planner still builds; the executor simply
   * does not dispatch writes it already knows cannot land.
   */
  private isMainHomeWideFenced(): boolean {
    // Every reader is built after `initHomeMembership`, and after `runUninit`
    // the stop flag answers before membership is read.
    return this.deps.shutdown.isStopped()
      || requireHomeMembership(this.deps.ctx).isMainHomeActuationFenced();
  }

  /**
   * Main's write fence, read by the actuator wrapper AND the silent-meter
   * escalation (which refuses to spend its one shed pass while every write
   * would answer `requested: false`).
   *
   * The home-wide part above, plus the one condition that can change DURING an
   * apply: a prepared reconcile superseded between the first SDK write and the
   * tenth. That one cannot be a dry-run gate, because dry-run is resolved once
   * when the executor decides to dispatch — which is the same split a meter
   * area makes with its prepared-sample fence.
   */
  private isMainActuationFenced(): boolean {
    return this.isMainHomeWideFenced()
      || this.deps.mainPowerSamplePipeline.preparedReconcileFence.isSuperseded();
  }

  /**
   * The device transport and what is built directly over it, in order: home
   * membership joins its snapshots, and battery control writes through it and
   * reads the membership to keep claims to Main.
   */
  private async runDeviceStartupSteps(logStartupStepFailure: (label: string, error: Error) => void): Promise<void> {
    await runStartupStep('initDeviceManager', () => this.initDeviceManager(), logStartupStepFailure);
    await runStartupStep('initHomeMembership', () => this.initHomeMembership(), logStartupStepFailure);
    await runStartupStep('initBatteryControl', () => this.initBatteryControl(), logStartupStepFailure);
  }

  // Body in `setup/appInit/createBatteryControl.ts`; a method so the integration boot helper reaches it.
  initBatteryControl(): void {
    initMainBatteryControl(this.deps.ctx, this.deps.teardown, this.deps.observedStateEmitter,
      () => this.isMainActuationFenced());
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
    await runStartupStep('initPlanRuntime', () => this.initPlanRuntime(), logStartupStepFailure);
    await runStartupStep(
      'subscribePlanObservedState',
      () => this.subscribePlanObservedState(),
      logStartupStepFailure,
    );
  }

  // Body in `setup/appInit/planObservedStateSubscription.ts`. Deliberately NOT folded into
  // `initDeviceManager`: these listeners reach the plan service, so they may not
  // be live before `initPlanRuntime`.
  subscribePlanObservedState(): void {
    const { ctx, handles, observedStateEmitter } = this.deps;
    observedStateEmitter.onExternalTemperatureAdjusted(
      ctx.observedTemperatureModeUpdates.accept.bind(ctx.observedTemperatureModeUpdates),
    );
    subscribePlanObservedState({
      ctx,
      observedStateEmitter,
      getHomeRuntimeRegistry: () => handles.homeRuntimeRegistry,
      syncExternalOffHold: (event) => this.syncExternalOffHold(event),
      syncLivePlanState: (event) => syncOwningHomeLivePlanState(ctx, event, handles.homeRuntimeRegistry),
      invalidateRebuildSuppression: (deviceId) => this.invalidateRebuildSuppression(deviceId),
    });
  }

  // Body in `setup/appObservedControlStateRuntime.ts`, beside the external-off
  // hold it is routed alongside.
  invalidateRebuildSuppression(deviceId: string): void {
    invalidateOwningHomeRebuildSuppression(this.deps.ctx, deviceId, this.deps.handles.homeRuntimeRegistry);
  }

  captureDefaultDynamicSoftLimit(): void {
    const { ctx } = this.deps;
    ctx.defaultComputeDynamicSoftLimit = ctx.computeDynamicSoftLimit;
  }

  initSettingsHandler(): void {
    // Home-runtime hooks are lazy over the app's registry handle:
    // `initHomeRuntimeRegistry` runs after this step; until then a suffixed
    // write is dropped here and absorbed by the registry's boot-time reconcile.
    const { handles } = this.deps;
    this.deps.teardown.register(SETTINGS_HANDLER_TEARDOWN_KEY, registerSettingsHandler(
      this.deps.ctx,
      this.deps.getHomeOperatingMode,
      () => handles.homeRuntimeRegistry,
      (timing) => handles.requestMainAuthorityRecovery?.(timing),
      () => handles.homeMembershipService?.observeOwnershipConfigurationChanged(),
      // Lazy over the app field: the controller starts in a later step
      // (startPostStartupBackgroundTasks); until then a write is a no-op and
      // the controller's own start() probe covers it.
      // The ONLY way `pv_forecast_source` changes. Re-resolve the held setting
      // FIRST so the probe gate and both forecast consumers see the new choice,
      // then kick the probe — the handler recomputes prices straight after.
      () => {
        const forecast = handles.backgroundCollectors?.homeySolarForecast;
        if (!forecast) return;
        forecast.refreshSourceSetting();
        void forecast.refresh();
      },
    ));
  }

  // Body in `setup/appObservedControlStateRuntime.ts`; kept as a method so the
  // emitter subscription and test seams keep their call site.
  syncExternalOffHold(event: ObservedControlStateChangedEvent): void {
    // Route a sub-home device through its own bundle (R7b P1#1); read per event
    // from the app's registry handle, so it is undefined (main answers) before
    // `initHomeRuntimeRegistry` and with no sub-homes.
    syncExternalOffHoldForObservation(this.deps.ctx, event, this.deps.handles.homeRuntimeRegistry);
  }

  /**
   * Rebuild the plan of whichever home owns this device.
   *
   * Resolved, not asserted: the target-power reachability lane calls this as a
   * fire-and-forget `void` from a snapshot-mutation hook that is bound during
   * `initDeviceManager`. A synchronous throw there escapes the `.catch` chained
   * at the call site and the `void` around it, so a pre-`initPlanRuntime`
   * mutation would crash boot rather than log. Before the service exists there
   * is no plan to rebuild and nothing to record — the first plan build reads the
   * freshly written reachability anyway.
   */
  /**
   * Whether the plan of whichever home owns this device has it limited by
   * setpoint. Routed exactly as {@link rebuildOwningHomePlanForDevice} is, and
   * for the same reason: main's plan filters sub-home members out, so asking
   * main about one of them would always answer "not limited". Before the plan
   * service exists there is no plan, and nothing in it is limited.
   */
  isDeviceLimitedInOwningHome(deviceId: string): boolean {
    const subHomeRoute = this.deps.handles.homeRuntimeRegistry?.getOwningHomeRouteForDevice(deviceId);
    if (subHomeRoute) return subHomeRoute.hooks.isDeviceLimited(deviceId);
    const resolved = resolvePlanService(this.deps.ctx);
    return resolved.state === 'ready' && resolved.planService.isDeviceLimitedInLatestPlan(deviceId);
  }

  rebuildOwningHomePlanForDevice(deviceId: string, trigger: PlanRebuildTrigger): Promise<unknown> {
    const subHomeRoute = this.deps.handles.homeRuntimeRegistry?.getOwningHomeRouteForDevice(deviceId);
    if (subHomeRoute) return subHomeRoute.hooks.rebuildPlan(trigger);
    const resolved = resolvePlanService(this.deps.ctx);
    if (resolved.state !== 'ready') return Promise.resolve();
    return resolved.planService.rebuildPlanFromCache(trigger);
  }

  async runUninit(): Promise<void> {
    const { ctx, handles } = this.deps;
    // First teardown edge: close the final Main write seam before any awaited
    // or synchronous cleanup can detach the membership authority it also reads.
    // The same edge tells the fire-and-forget native-wiring probe to drop its
    // side effects. We deliberately do NOT await it: it can be parked on a slow
    // flow read, and blocking teardown on that read would stall shutdown.
    // Suppressing its continuation is enough.
    this.deps.shutdown.stop();
    this.mainHomeScope.disposeBinaryCommandReachability();
    // Tear down the per-home bundles BEFORE the global timer sweep so each
    // bundle can flush a pending suffixed tracker persist while its debounce
    // timer is still observable. An in-flight poll resolving after this routes
    // nowhere: the torn-down bundles are skipped, and the poll's generation is
    // bumped when the timers are cleared.
    handles.homeRuntimeRegistry?.teardownAll();
    handles.homeRuntimeRegistry = undefined;
    this.clearUninitTimers();
    this.stopUninitServices();
    // Detach battery control's snapshot feed. Nothing is handed back here:
    // boot recovery from the claim records is the hand-back after a stop.
    this.deps.teardown.clear(BATTERY_CONTROL_TEARDOWN_KEY);
    // Detach the membership recompute triggers BEFORE the transport teardown
    // so a still-in-flight refresh dispatch or detached zone-tree commit can
    // no longer recompute; clearing `ctx.homeMembership` also kills the lazy
    // settings-change trigger.
    this.deps.teardown.clear(MEMBERSHIP_TEARDOWN_KEY);
    handles.requestMainAuthorityRecovery = undefined;
    handles.homeMembershipService = undefined;
    ctx.homeMembership = undefined;
    handles.backgroundCollectors?.pvForecast.stop();
    handles.backgroundCollectors?.homeySolarForecast.stop();
    // Release the warmup gate so any rebuild awaiting it during a partial
    // startup unblocks instead of dangling on a promise the gate would
    // otherwise resolve via its bounded timeout. `shutdown` makes such a
    // rebuild a skip: it has already left the scheduler, so cancelAll below
    // cannot drop it.
    ctx.snapshotWarmupGate?.release('shutdown');
    this.deps.planRebuildScheduler.cancelAll('app_uninit');
    ctx.deviceDiagnosticsService?.destroy();
    // Persist any unflushed deferred-objective plan-history entries before shutting down.
    flushDeferredObjectiveRecorders(ctx);
    flushDailyBudgetStateOnUninit(ctx);
    // The learned peaks are rate-limited to one write a minute: the peak
    // observed in the last minute of a run is precisely the one a restart would
    // drop, and the trailing flush timer is already gone by now.
    ctx.flowBacked.flushLearnedPeaks();
    // Mark how far we've observed; back-fill on next startup picks up from here. Skipped if
    // the recorder is still dirty (save failed), so the next start re-scans the missed window.
    persistDeferredObjectiveObservationWatermark(ctx, ctx.deferredObjectivePlanHistoryRecorder);
    ctx.priceCoordinator?.stop();
    ctx.deviceManager?.destroy();
    ctx.settingsUiDeviceReads.disconnect();
    this.deps.closeUserdataDatabase();
  }

  private clearUninitTimers(): void {
    const { ctx } = this.deps;
    this.deps.powerTrackerHelpers.stopPowerTracker();
    this.deps.timers.clearAll();
    ctx.snapshotHelpers.stop();
    ctx.homeyEnergyHelpers.stop();
    ctx.generationPollSource.stop();
  }

  private stopUninitServices(): void {
    this.deps.backgroundTasks.stopAll();
    this.deps.teardown.clear(SETTINGS_HANDLER_TEARDOWN_KEY);
  }
}
