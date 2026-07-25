import type Homey from 'homey';
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
import { createExternalOffHoldPolicy } from './externalOffHoldAdapter';
import { SnapshotWarmupGate } from '../lib/plan/snapshotWarmupGate';
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
  createDeferredObjectivePlanHistoryRecorder,
  createDailyBudgetService,
  createDeviceDiagnosticsService,
  createPlanEngine,
  createPlanService,
  createPriceCoordinator,
  createPriceFlowTagPublisher,
  persistDeferredObjectiveObservationWatermark,
} from './appInit';
import { buildMainHomeScope, type HomeScope } from './homeRuntime/homeScope';
import type { HomeRuntimeRegistry } from './homeRuntime/homeRuntimeRegistry';
import {
  buildHomeRuntimeMeterProviders,
  createHomeRuntimeRegistryForApp,
} from './appInit/wireHomeRuntimeRegistry';
import type { HomeMembershipService } from './homeMembership';
import type { PvForecastController } from './appInit/createPvForecastService';
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
import * as realtimeReconcile from './appRealtimeDeviceReconcile';
import { scheduleAppRealtimeDeviceReconcileForApp } from './appRealtimeDeviceReconcileRuntime';
import { readMainMeterSelection } from './mainMeterSettings';
import type { MainMeterSelection } from '../packages/contracts/src/mainMeterSelection';

const STARTUP_RESTORE_STABILIZATION_MS = 60 * 1000;
// Bound the warmup wait so a failed/slow Homey Manager fetch can never deadlock
// startup: if `refreshSnapshot()` does not resolve in this window the gate
// releases with reason `timeout` and the planner proceeds (next snapshot will
// arrive on the periodic refresh and rebuild correctly). Tests use a 0 bound
// to skip the wait entirely. Per `feedback_homey_sdk_unreliable`, a slow SDK
// fetch is treated as a transient gap, not a persisted-state corruption.
const SNAPSHOT_WARMUP_TIMEOUT_MS = process.env.NODE_ENV === 'test' ? 0 : 5_000;

// Boundary-resolved whole-home meter authority for the homey_energy source.
// `resolved/null` = Automatic; `unavailable` suppresses Main sampling instead
// of silently promoting an SDK miss to Automatic. Read fresh per call so the
// 10s poll picks up a changed selection without a transport restart.
const resolveHomeyEnergyMeterSelection = (homey: Homey.App['homey']): MainMeterSelection => {
  return readMainMeterSelection(homey.settings);
};

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
  getStablePowerSampleRevision: StableSampleRevisionReader;
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
  // The main home's closure bundle for the plan factories. Built once (the
  // capacity-settings store port inside it is constructed a single time at
  // this wiring site) and shared by `initPlanEngine`/`initPlanService`.
  private readonly mainHomeScope: HomeScope;

  // Detaches the membership recompute triggers (refresh subscription +
  // zone-tree-commit callback); set by `initHomeMembership`, invoked and
  // cleared in `runUninit`.
  private homeMembershipTeardown?: () => void;
  private requestMainAuthorityRecovery?: (timing?: 'scheduled' | 'immediate') => void;

  // Concrete membership service (the ctx carries only the provenance-free
  // port); the per-home bundles' execution gate reads its tree-commit signal.
  private homeMembershipService?: HomeMembershipService;

  // Per-home capacity bundles (multi-home R7b). Built by
  // `initHomeRuntimeRegistry` after membership wiring; empty (and inert) with
  // zero sub-homes configured. Torn down in `runUninit`.
  private homeRuntimeRegistry?: HomeRuntimeRegistry;
  // Set before teardown starts and read at the final Main actuator seam. An
  // already-running recovery reconcile can otherwise resume after membership
  // is detached and issue a late SDK command.
  private mainActuationStopped = false;
  private readonly mainPreparedReconcileFence;
  private mainShortfallSideEffectGate?: ReturnType<
    typeof createMainCapacityGuard
  >['shortfallSideEffectGate'];

  constructor(private readonly deps: AppServiceWiringDeps) {
    this.mainHomeScope = buildMainHomeScope(deps.ctx);
    this.mainPreparedReconcileFence = createPreparedMainReconcileFence(
      deps.getStablePowerSampleRevision,
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
    await runStartupStep('initHomeMembership', () => this.initHomeMembership(), logStartupStepFailure);
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
    await runStartupStep('initHomeRuntimeRegistry', () => this.initHomeRuntimeRegistry(), logStartupStepFailure);
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
    startPostStartupBackgroundTasks(this.deps);
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
    // "Leave off until turned on again". Constructed here so the persisted holds
    // are loaded before the first plan cycle can resume anything — a hold that
    // survived a restart must win over the first rebuild, not lose a race with
    // it. Assigned onto ctx (the wiring-assigns-ctx-members house pattern).
    ctx.externalOffHold = createExternalOffHoldPolicy(ctx.homey.settings);
    // Bound here instead of via a constructor dep so the app.ts wiring literal
    // stays untouched; same resolver instance the transport providers use.
    ctx.snapshotHelpers.bindHomeyEnergyMeterResolver(() => resolveHomeyEnergyMeterSelection(ctx.homey));
    const deviceManager = new DeviceTransport(this.deps.homeyApp, {
      log: ctx.log.bind(ctx),
      debug: (...args: unknown[]) => ctx.logDebug('devices', ...args),
      error: ctx.error.bind(ctx),
      structuredLog,
    }, {
      getHomeyEnergyMeterSelection: () => resolveHomeyEnergyMeterSelection(ctx.homey),
      // Sub-home meter ids for the per-meter live-report extraction, and the
      // fan-out of the readings they resolve (R7b). Both lazy over the
      // registry field: the registry is built after the transport, and cleared
      // at uninit — empty/no-op outside that window, so the single-home path
      // is untouched.
      ...buildHomeRuntimeMeterProviders(() => this.homeRuntimeRegistry),
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

  // Body in `setup/appInit/wireHomeMembership.ts`; the trigger-teardown handle
  // is invoked in `runUninit`.
  initHomeMembership(): void {
    // The zone-tree-commit readiness edge fires each capacity bundle's
    // membership-ready apply (decoupled from meter-sample arrival). Lazy over
    // `this.homeRuntimeRegistry`, which is wired later by
    // `initHomeRuntimeRegistry` — inert (registry undefined) until then.
    const wiring = wireHomeMembership(
      this.deps.ctx,
      this.deps.getObservedStateEmitter(),
      buildAppHomeMembershipOptions({
        getRegistry: () => this.homeRuntimeRegistry,
        getMembership: () => this.homeMembershipService,
        getMainStableSampleRevision: this.deps.getStablePowerSampleRevision,
        beginMainPreparedReconcile: (sampleRevision) => {
          this.mainShortfallSideEffectGate?.holdDeferredUntilPreparedApply();
          return this.mainPreparedReconcileFence.begin(sampleRevision);
        },
        flushMainShortfallSideEffect: async () => (
          this.mainShortfallSideEffectGate?.flushAfterPreparedApply() ?? true
        ),
      }),
    );
    this.deps.ctx.homeMembership = wiring.service;
    this.homeMembershipService = wiring.service;
    this.homeMembershipTeardown = wiring.teardown;
    this.requestMainAuthorityRecovery = wiring.requestMainAuthorityRecovery;
  }

  /**
   * Build the per-home capacity-bundle registry (R7b). Its runtime seams are
   * already wired lazily over `this.homeRuntimeRegistry` (the transport's
   * per-meter provider pair and the suffixed settings-change hooks). Runs
   * AFTER membership wiring so a bundle's first plan input and its
   * execution-readiness gate (fail-closed: false until a committed zone tree
   * has been joined, and false again after teardown) read real membership
   * state. With zero sub-homes the reconcile is a no-op and nothing else runs.
   */
  initHomeRuntimeRegistry(): void {
    this.homeRuntimeRegistry = createHomeRuntimeRegistryForApp(
      this.deps.ctx,
      () => this.homeMembershipService?.isSubHomeExecutionReady() === true,
      () => this.homeMembershipService?.isRuntimeActive() === true,
    );
  }

  initCapacityGuard(): void {
    const { ctx } = this.deps;
    const runtime = createMainCapacityGuard({
      ctx,
      isDiscarded: () => this.mainActuationStopped,
      isTemporarilyFenced: () => (
        this.mainPreparedReconcileFence.isActive()
        || this.homeMembershipService?.isMainHomeActuationFenced() === true
      ),
      isPreparedReconcileActive: this.mainPreparedReconcileFence.isActive,
    });
    ctx.capacityGuard = runtime.guard;
    this.mainShortfallSideEffectGate = runtime.shortfallSideEffectGate;
  }

  initPlanEngine(): void {
    const { ctx } = this.deps;
    if (!ctx.deferredObjectivePlanHistoryRecorder) {
      ctx.deferredObjectivePlanHistoryRecorder = createDeferredObjectivePlanHistoryRecorder(ctx);
    }
    if (!ctx.deferredObjectiveActivePlanRecorder) {
      ctx.deferredObjectiveActivePlanRecorder = createDeferredObjectiveActivePlanRecorder(ctx);
    }
    const planEngine = createPlanEngine(ctx, this.mainHomeScope, {
      // Active sub-home zone membership is provisional until the first real
      // zone tree commits. Main's plan may still contain those fallback-Main
      // devices, so close the final write seam until ownership is trustworthy.
      isActuationFenced: () => this.mainActuationStopped
        || this.mainPreparedReconcileFence.isSuperseded()
        || ctx.homeMembership?.isMainHomeActuationFenced() === true,
    });
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
    ctx.planService = createPlanService(ctx, this.mainHomeScope);
  }

  initCapacityGuardProviders(): void {
    const { ctx } = this.deps;
    if (!ctx.capacityGuard) return;
    ctx.defaultComputeDynamicSoftLimit = ctx.computeDynamicSoftLimit;
    ctx.capacityGuard.setSoftLimitProvider(() => ctx.computeDynamicSoftLimit());
    ctx.capacityGuard.setShortfallThresholdProvider(() => this.deps.computeShortfallThreshold());
  }

  initSettingsHandler(): void {
    // Home-runtime hooks are lazy over the registry field:
    // `initHomeRuntimeRegistry` runs after this step; until then a suffixed
    // write is dropped here and absorbed by the registry's boot-time reconcile.
    this.deps.setStopSettingsHandler(registerSettingsHandler({
      ctx: this.deps.ctx,
      getHomeRuntimeRegistry: () => this.homeRuntimeRegistry,
      requestMainAuthorityRecovery: (timing) => this.requestMainAuthorityRecovery?.(timing),
      observeOwnershipConfigurationChanged: () => {
        this.homeMembershipService?.observeOwnershipConfigurationChanged();
      },
    }));
  }

  // Body in `setup/appRealtimeDeviceReconcileRuntime.ts`; kept as a method so
  // the emitter subscription and test seams keep their call site.
  scheduleRealtimeDeviceReconcile(event: realtimeReconcile.RealtimeDeviceReconcileEvent): void {
    scheduleAppRealtimeDeviceReconcileForApp({
      ctx: this.deps.ctx,
      event,
      state: this.deps.getRealtimeDeviceReconcileState(),
      timers: this.deps.timers,
      // Route a sub-home device's reconcile through its own bundle (R7b P1#1);
      // lazy over the registry field so it stays byte-identical (undefined →
      // main closures) before `initHomeRuntimeRegistry` and with no sub-homes.
      getHomeRuntimeRegistry: () => this.homeRuntimeRegistry,
    });
  }

  async runUninit(): Promise<void> {
    const { ctx } = this.deps;
    // First teardown edge: close the final Main write seam before any awaited
    // or synchronous cleanup can detach the membership authority it also reads.
    this.mainActuationStopped = true;
    // Signal the fire-and-forget native-wiring probe to drop its side effects
    // before anything else tears down. We deliberately do NOT await it: it can
    // be parked on a slow flow read, and blocking teardown on that read would
    // stall shutdown. Suppressing its continuation is enough.
    this.deps.setNativeWiringUninitializing(true);
    // Tear down the per-home bundles BEFORE the global timer sweep so each
    // bundle can flush a pending suffixed tracker persist while its debounce
    // timer is still observable. Clearing the field also disconnects the lazy
    // per-meter fan-out: an in-flight poll resolving after this routes nowhere.
    this.homeRuntimeRegistry?.teardownAll();
    this.homeRuntimeRegistry = undefined;
    this.clearUninitTimers();
    realtimeReconcile.clearRealtimeDeviceReconcileState(this.deps.getRealtimeDeviceReconcileState());
    this.stopUninitServices();
    // Detach the membership recompute triggers BEFORE the transport teardown
    // so a still-in-flight refresh dispatch or detached zone-tree commit can
    // no longer recompute; clearing `ctx.homeMembership` also kills the lazy
    // settings-change trigger.
    this.homeMembershipTeardown?.();
    this.homeMembershipTeardown = undefined;
    this.requestMainAuthorityRecovery = undefined;
    this.homeMembershipService = undefined;
    ctx.homeMembership = undefined;
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
