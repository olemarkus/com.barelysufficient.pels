import Homey from 'homey';
import type { ExpectedPowerOverridesByDeviceId, LearnedPeaksByDeviceId } from './lib/device/devicePowerPeak';
import type CapacityGuard from './lib/power/capacityGuard';
import type { DeviceTransport } from './lib/device/deviceTransport';
import { ObservedStateEmitter } from './lib/observer/observedStateEvents';
import { ObservedHomePower } from './lib/observer/observedHomePower';
import { ObservedDeviceStateProjection } from './lib/observer/observedDeviceStateProjection';
import type { PlanEngine } from './lib/plan/planEngine';
import type { ShedBehavior } from './lib/plan/planTypes';
import type { PlanService } from './lib/plan/planService';
import type { SnapshotWarmupGate } from './lib/plan/snapshotWarmupGate';
import type { DeviceControlProfiles } from './packages/contracts/src/types';
import type { DeviceTargetPowerConfigsWithReachability } from './lib/device/targetPowerReachability';
import type { PriceCoordinator } from './lib/price/priceCoordinator';
import type { PriceFlowTagPublisher } from './lib/price/priceFlowTags';
import type { PowerTrackerState } from './lib/power/tracker';
import type { DailyBudgetService } from './lib/dailyBudget/dailyBudgetService';
import type {
  DeferredObjectiveActivePlanRecorder,
  DeferredObjectivePlanHistoryRecorder,
  DeferredObjectiveEndedBus,
  DeferredObjectiveHoursRemainingBus,
  DeferredObjectiveHoursRemainingTracker,
  DeferredObjectivePlanRevisionBus,
  DeferredObjectiveStatusBus,
} from './lib/objectives/deferredObjectives';
import {
  createDeferredObjectiveEndedBus,
  createDeferredObjectiveHoursRemainingBus,
  createDeferredObjectiveHoursRemainingTracker,
  createDeferredObjectivePlanRevisionBus,
  createDeferredObjectiveStatusBus,
} from './lib/objectives/deferredObjectives';
import type { DebugLoggingTopic } from './packages/shared-domain/src/utils/debugLogging';
import { AppDeviceControlHelpers } from './setup/appDeviceControlHelpers';
import { DEFERRED_OBJECTIVE_HOURS_REMAINING_LATCH, MAIN_HOME_ID } from './lib/utils/settingsKeys';
import type { PowerSampleRebuildState } from './lib/plan/rebuildScheduler/powerDriven';
import { BackgroundTasksController } from './setup/backgroundTasksController';
import { createHomePowerPipeline } from './setup/homeRuntime/createHomePowerPipeline';
import type { PvForecastController } from './setup/appInit/createPvForecastService';
import type { WeatherCollector } from './lib/weather/weatherCollector';
import { SchedulerTelemetryObserver } from './setup/schedulerTelemetryObserver';
import { SettingsRepository } from './setup/settingsRepository';
import { createCombinedPricesReaderForApp } from './setup/priceCombinedPricesAdapter';
import { PowerCalibrationStore } from './lib/device/devicePowerCalibrationStore';
import { PlanRebuildScheduler } from './lib/plan/rebuildScheduler/scheduler';
import type { AppContext, StartupBootstrapConfig } from './lib/app/appContext';
import {
  createModeTargetPersistence,
  createUnsupportedDeviceDemotion,
} from './setup/appInit/createSnapshotSettingsPasses';
import * as homeMode from './setup/homeRuntime/homeOperatingMode';
import type { Logger as PinoLogger } from './lib/logging/logger';
import { normalizeError } from './lib/utils/errorUtils';
import { emitSettingsUiDevicesUpdatedForApp } from './setup/settingsUiAppRuntime';
import type { DeviceDiagnosticsService } from './lib/diagnostics/deviceDiagnosticsService';
import { createGenerationPollSource } from './setup/appInit/createGenerationPollSource';
import { createHomeyEnergyPollSource } from './setup/appInit/createHomeyEnergyPollSource';
import { AppSnapshotHelpers, createTargetPowerReachabilityAppWiring } from './setup/appSnapshotHelpers';
import { AppFlowBacked } from './setup/appFlowBacked';
import { AppSmartTaskApi } from './setup/appSmartTaskApi';
import { AppSmartTaskPayloads } from './setup/appSmartTaskPayloads';
import { getAppPlanRebuildNowMs, PlanRebuildIntentPolicy } from './setup/planRebuildIntentPolicy';
import { AppNativeWiring } from './setup/appNativeWiring';
import { AppServiceWiring } from './setup/appServiceWiring';
import { AppPowerTracker } from './setup/appPowerTracker';
import { TimerRegistry } from './lib/utils/timerRegistry';
import type { FlowReportedCapabilitiesByDevice } from './lib/device/transport/flowReportedCapabilities';
import { withAppApi } from './setup/appRuntimeApi';

const PelsAppBase = withAppApi(Homey.App);

class PelsApp extends PelsAppBase implements AppContext {
  protected readonly context: AppContext = this;
  public startupBootstrap?: StartupBootstrapConfig;
  // Latched when startup back-fill bailed because the per-key migration marker
  // was not yet set; consumed by the deferred-objective back-fill (see
  // `setup/appInit/deferredRecorders.ts`).
  public deferredObjectiveBackfillPending?: boolean;
  public readonly combinedPricesReader
    = createCombinedPricesReaderForApp(this.homey, () => this.priceCoordinator);
  public powerTracker: PowerTrackerState = {};
  protected powerCalibrationStore: PowerCalibrationStore = new PowerCalibrationStore();
  public capacityGuard!: CapacityGuard;
  public readonly deferredObjectiveStatusBus: DeferredObjectiveStatusBus = createDeferredObjectiveStatusBus();
  public readonly deferredObjectivePlanRevisionBus: DeferredObjectivePlanRevisionBus
    = createDeferredObjectivePlanRevisionBus();
  public readonly deferredObjectiveEndedBus: DeferredObjectiveEndedBus
    = createDeferredObjectiveEndedBus();
  public readonly deferredObjectiveHoursRemainingBus: DeferredObjectiveHoursRemainingBus
    = createDeferredObjectiveHoursRemainingBus();
  // Persist the integer-hour crossing latch via settings so an already-crossed
  // threshold doesn't re-fire after an app restart. A throwing/missing read on
  // cold-start is treated as "no persisted state" — the tracker falls back to
  // first-observation seeding (pre-persistence behaviour). Per
  // `feedback_homey_sdk_unreliable`, never wipe the latch on a single bad read.
  public readonly deferredObjectiveHoursRemainingTracker: DeferredObjectiveHoursRemainingTracker
    = createDeferredObjectiveHoursRemainingTracker({
      load: () => this.homey.settings.get(DEFERRED_OBJECTIVE_HOURS_REMAINING_LATCH),
      save: (latch) => {
        try {
          this.homey.settings.set(DEFERRED_OBJECTIVE_HOURS_REMAINING_LATCH, latch);
        } catch (error) {
          this.getStructuredLogger('deferred_objectives')?.error({
            event: 'deferred_objective_hours_remaining_latch_persist_failed', err: normalizeError(error),
          });
        }
      },
    });
  public capacitySettings = { limitKw: 10, marginKw: 0.2 };
  public capacityDryRun = true;
  public operatingMode = 'Home';
  public modeAliases: Record<string, string> = {};
  public capacityPriorities: Record<string, Record<string, number>> = {};
  public modeDeviceTargets: Record<string, Record<string, number>> = {};
  public controllableDevices: Record<string, boolean> = {};
  public managedDevices: Record<string, boolean> = {};
  public budgetExemptDevices: Record<string, boolean> = {};
  public temperatureControlDisabledDevices: Record<string, boolean> = {};
  public temperatureControlPolicyState: 'unavailable' | 'resolved' = 'unavailable';
  public temperatureBoostSettings: import('./packages/contracts/src/types').TemperatureBoostSettings = {};
  public evBoostSettings: import('./packages/contracts/src/types').EvBoostSettings = {};
  public evCarAssociations: import('./packages/contracts/src/types').EvCarAssociations = {};
  protected nativeEvWiringDevices: Record<string, boolean> = {};
  // Conflict-gated auto-enable decisions for Hoiax native stepped wiring
  // (notes/native-wiring/). In-memory only — recomputed each startup from the
  // flow read + conflict classifier. An explicit user entry in
  // `nativeEvWiringDevices` always takes precedence over this default.
  private autoNativeWiringDecisions: Record<string, boolean> = {};
  // Per-device flow-conflict verdict (the native-write capabilities a user
  // Flow drives), surfaced on the snapshot for the device-detail banner.
  private flowConflictsByDevice: Record<string, { conflictingCapabilities: readonly string[]; flowName?: string }> = {};
  // Flipped in onUninit. The native-wiring probe is fire-and-forget and can
  // still be parked on a slow flow read when the app tears down; this flag lets
  // its continuation drop every side effect (logging, snapshot refresh, plan
  // rebuild) instead of acting on a half-torn-down app or logging into a
  // closing worker rpc (the `onUserConsoleLog`-during-teardown error in CI).
  private nativeWiringUninitializing = false;
  public deviceDriverOverrides: Record<string, string> = {};
  protected flowReportedCapabilities: FlowReportedCapabilitiesByDevice = {};
  public deviceControlProfiles: DeviceControlProfiles = {};
  public deviceTargetPowerConfigs: DeviceTargetPowerConfigsWithReachability = {};
  public deviceCommunicationModels: Record<string, 'local' | 'cloud'> = {};
  public shedBehaviors: Record<string, ShedBehavior> = {};
  public debugLoggingTopics = new Set<DebugLoggingTopic>();
  public dailyBudgetService!: DailyBudgetService;
  public deferredObjectivePlanHistoryRecorder?: DeferredObjectivePlanHistoryRecorder;

  public deferredObjectiveActivePlanRecorder?: DeferredObjectiveActivePlanRecorder;
  public deviceDiagnosticsService!: DeviceDiagnosticsService;
  public priceCoordinator!: PriceCoordinator;
  public priceFlowTagPublisher?: PriceFlowTagPublisher;
  public deviceManager!: DeviceTransport;
  /**
   * Observer-owned emitter for post-translation realtime events
   * (`observed-state-changed`, `observed-control-state-changed`). Wiring builds
   * it during `initDeviceManager`, binds transport's dispatcher to it,
   * and subscribes wiring's own reapply/SoC/perf listeners to it. Per
   * PR #5 of the observer/transport split, transport never statically
   * imports observer; the dispatcher flows in via DeviceTransport's
   * constructor options
   * (notes/state-management/observer-transport-split.md).
   */
  private observedStateEmitter: ObservedStateEmitter = new ObservedStateEmitter();
  // Observer-owned whole-home power scalar (PR2a of the observer/transport
  // split). Transport pushes the Homey-SDK-sourced reading here via the
  // dispatcher; Homey Energy sample paths use the co-temporal transport return.
  private observedHomePower: ObservedHomePower = new ObservedHomePower();
  // Observer-owned maintained projection of `ObservedDeviceState`, fed by the
  // dispatcher push (per-capability deltas + full-refresh batches). Stage 4a of
  // the snapshot decomposition: stood up + shadow-verified only — NO existing
  // reader is routed through it yet (zero behaviour change). Same lifecycle as
  // the device manager / emitter (recreated together on a transport restart).
  protected observedDeviceStateProjection: ObservedDeviceStateProjection = new ObservedDeviceStateProjection();
  public planEngine!: PlanEngine;
  public planService!: PlanService;
  // Created in `onInit` (after the structured logger is wired) and released
  // by `bootstrapSnapshotAndPlan` once the first `refreshSnapshot()`
  // resolves, or by its own bound when the snapshot fetch fails/stalls.
  // Held by `PlanService.rebuildPlanFromCache` so any rebuild triggered
  // between `initDeviceManager` and the first snapshot (price refresh,
  // settings change, realtime device event, flow card) waits for either
  // outcome instead of running the planner against an empty snapshot.
  public snapshotWarmupGate?: SnapshotWarmupGate;
  // Curtailment-surplus estimator seams (optional AppContext members) —
  // ASSIGNED by `wireCurtailmentSurplus` post-startup; declared here so the
  // main pipeline's field-initializer tap below can reference them on `this`.
  public getCurtailedSurplusKw?: () => number | null;
  public recordCurtailmentSample?: (netW: number, generationW: number | undefined, nowMs: number) => void;
  public canContributeCurtailmentSurplus?: () => boolean;
  public defaultComputeDynamicSoftLimit: (() => number) | undefined = undefined;
  public lastKnownPowerKw: LearnedPeaksByDeviceId = {};
  public expectedPowerKwOverrides: ExpectedPowerOverridesByDeviceId = {};
  protected overheadToken?: Homey.FlowToken;
  public lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
  public lastNotifiedOperatingMode = 'Home';
  public powerSampleRebuildState: PowerSampleRebuildState = { lastMs: 0 };
  private readonly settingsRepository = new SettingsRepository(this.homey);
  private readonly schedulerTelemetry = new SchedulerTelemetryObserver({
    getStructuredLogger: () => this.structuredLogger,
    isDebugTopicEnabled: (topic) => this.debugLoggingTopics.has(topic),
    getNowMs: () => this.getPlanRebuildNowMs(),
    getPowerSampleRebuildState: () => this.powerSampleRebuildState,
    setPowerSampleRebuildState: (state) => { this.powerSampleRebuildState = state; },
  });
  private readonly planRebuildIntentPolicy = new PlanRebuildIntentPolicy({
    getPowerSampleRebuildState: () => this.powerSampleRebuildState,
    setPowerSampleRebuildState: (state) => { this.powerSampleRebuildState = state; },
    getPlanRebuildNowMs: () => this.getPlanRebuildNowMs(),
    getPlanService: () => this.planService,
  });
  protected readonly planRebuildScheduler = new PlanRebuildScheduler({
    getNowMs: getAppPlanRebuildNowMs,
    resolveDueAtMs: (intent, state) => this.planRebuildIntentPolicy.resolveDueAtMs(intent, state),
    executeIntent: (intent) => this.planRebuildIntentPolicy.executeIntent(intent),
    shouldExecuteImmediately: (intent) => intent.kind !== 'flow',
    onIntentDropped: this.schedulerTelemetry.onIntentDropped,
    onPendingIntentReplaced: this.schedulerTelemetry.onPendingIntentReplaced,
    onIntentCancelled: this.schedulerTelemetry.onIntentCancelled,
    onIntentError: this.schedulerTelemetry.onIntentError,
  });
  protected readonly powerSamplePipeline = createHomePowerPipeline({
    ctx: this,
    homeId: MAIN_HOME_ID,
    planRebuildScheduler: this.planRebuildScheduler,
    getPlanEngine: () => this.planEngine,
    getPlanService: () => this.planService,
    getCapacityGuard: () => this.capacityGuard,
    getPlanRebuildNowMs: () => this.getPlanRebuildNowMs(),
    savePowerTracker: (state) => this.savePowerTracker(state),
    setPowerSampleRebuildState: (state) => { this.powerSampleRebuildState = state; },
    getOutdoorTemperatureC: () => this.weatherCollector?.getCurrentOutdoorTemperatureC(),
    recordPvGenerationSample: (genW, nowMs, netW) => this.pvForecast?.recordSample(genW, nowMs, netW),
    // Optional AppContext member assigned by wireCurtailmentSurplus post-startup;
    // main-home tap only (sub-home pipelines omit it — see the pipeline factory).
    recordCurtailmentSample: (netW, genW, nowMs) => this.recordCurtailmentSample?.(netW, genW, nowMs),
    // Production for samples that do not carry their own; the factory bounds its
    // freshness. Main home only — a sub-home must not adopt this production.
    observedHomePower: this.observedHomePower,
  });
  private stopSettingsHandler?: () => void;
  protected weatherCollector?: WeatherCollector;
  private pvForecast?: PvForecastController;
  protected readonly backgroundTasks = new BackgroundTasksController({
    homey: this.homey,
    log: (...args: unknown[]) => this.log(...args),
    logDebug: (topic, ...args: unknown[]) => this.logDebug(topic, ...args),
    error: (...args: unknown[]) => this.error(...args),
    isDebugTopicEnabled: (topic) => this.debugLoggingTopics.has(topic),
    getStructuredDebugEmitter: (component, topic) => this.getStructuredDebugEmitter(component, topic),
    getNow: () => this.getNow(),
    getTimeZone: () => this.getTimeZone(),
    getCombinedHourlyPrices: () => this.getCombinedHourlyPrices(),
  });
  protected structuredLogger?: PinoLogger;
  public readonly timers = new TimerRegistry();

  private readonly targetPowerReachabilityWiring = createTargetPowerReachabilityAppWiring(this);
  public readonly snapshotHelpers: AppSnapshotHelpers = new AppSnapshotHelpers({
    getPowerSource: () => this.getPowerSource(),
    timers: this.timers,
    getDeviceManager: () => this.deviceManager,
    getPlanEngine: () => this.planEngine,
    getPlanService: () => this.planService,
    getLatestTargetSnapshot: () => this.latestTargetSnapshot,
    resolveManagedState: (deviceId) => this.resolveManagedState(deviceId),
    isCapacityControlEnabled: (deviceId) => this.isCapacityControlEnabled(deviceId),
    getStructuredLogger: (component) => this.getStructuredLogger(component),
    getStructuredDebugEmitter: (component, topic) => this.getStructuredDebugEmitter(component, topic),
    getNow: () => this.getNow(),
    logPeriodicStatus: (options) => this.logPeriodicStatus(options),
    disableUnsupportedDevices: (snapshot, operatingModeResolver) => (
      createUnsupportedDeviceDemotion(this.ctx)(snapshot, operatingModeResolver)
    ),
    persistFilledModeTargets: (snapshot) => createModeTargetPersistence(this.ctx)(snapshot),
    getFlowReportedDeviceIds: () => this.getFlowReportedDeviceIds(),
    emitFlowBackedRefreshRequests: async (deviceIds) => this.emitFlowBackedRefreshRequests(deviceIds),
    emitSettingsUiDevicesUpdated: () => emitSettingsUiDevicesUpdatedForApp(
      this.homey,
      (message, error) => this.error(message, error),
    ),
    recordPowerSample: (sample) => this.powerSamplePipeline.recordPowerSample(sample.powerW, undefined, sample),
    ...this.targetPowerReachabilityWiring.snapshotDeps,
  });
  public readonly homeyEnergyHelpers = createHomeyEnergyPollSource(this, this.powerSamplePipeline);
  public readonly generationPollSource = createGenerationPollSource(this, this.observedHomePower);
  public readonly deviceControlHelpers: AppDeviceControlHelpers = new AppDeviceControlHelpers({
    getProfiles: () => this.deviceControlProfiles,
    ...this.targetPowerReachabilityWiring.deviceControlDeps,
    isTemperatureControlDisabled: (deviceId) => this.isTemperatureControlDisabled(deviceId),
    getDeviceSnapshots: () => this.deviceManager?.getSnapshot() ?? [],
    getLatestPlanSnapshot: () => this.planService.getLatestPlanSnapshot(),
    getStructuredLogger: (component) => this.getStructuredLogger(component),
    debugStructured: this.getStructuredDebugEmitter('devices', 'devices'),
  });
  protected readonly flowBacked = new AppFlowBacked({
    homey: this.homey,
    settingsRepository: this.settingsRepository,
    getStructuredLogger: (component) => this.getStructuredLogger(component),
    getFlowReportedCapabilities: () => this.flowReportedCapabilities,
    setFlowReportedCapabilities: (state) => { this.flowReportedCapabilities = state; },
    getDeviceManager: () => this.deviceManager,
    getLatestTargetSnapshot: () => this.latestTargetSnapshot,
    resolveManagedState: (deviceId) => this.resolveManagedState(deviceId),
    getSnapshotDevice: (deviceId) => this.getSnapshotDevice(deviceId),
    hasEnabledEvBoostForSnapshot: (device) => this.hasEnabledEvBoostForSnapshot(device),
    getSteppedLoadProfile: (deviceId) => this.deviceControlHelpers.getSteppedLoadProfile(deviceId),
    getExpectedPowerKwOverrides: () => this.expectedPowerKwOverrides,
    getLearnedPowerPeaks: () => this.lastKnownPowerKw,
    timers: this.timers,
    syncHeadroomUsageObservation: (params) => { this.planService.syncHeadroomUsageObservation(params); },
  });
  protected readonly nativeWiring = new AppNativeWiring({
    getNativeWiringUninitializing: () => this.nativeWiringUninitializing,
    getAutoNativeWiringDecisions: () => this.autoNativeWiringDecisions,
    setAutoNativeWiringDecisions: (decisions) => { this.autoNativeWiringDecisions = decisions; },
    getFlowConflictsByDevice: () => this.flowConflictsByDevice,
    setFlowConflictsByDevice: (conflicts) => { this.flowConflictsByDevice = conflicts; },
    getNativeEvWiringDevices: () => this.nativeEvWiringDevices,
    getStructuredLogger: (component) => this.getStructuredLogger(component),
    getDeviceManager: () => this.deviceManager,
    getSnapshotWarmupGate: () => this.snapshotWarmupGate,
    getPlanService: () => this.planService,
    refreshTargetDevicesSnapshot: () => this.refreshTargetDevicesSnapshot(),
    delayMs: (ms) => this.delayMs(ms),
    applyNativeWiringAutoDecisions: () => this.applyNativeWiringAutoDecisions(),
  });
  protected readonly powerTrackerHelpers = new AppPowerTracker({
    homey: this.homey,
    settingsRepository: this.settingsRepository,
    timers: this.timers,
    getPowerTracker: () => this.powerTracker,
    setPowerTracker: (state) => { this.powerTracker = state; },
    getPowerCalibrationStore: () => this.powerCalibrationStore,
    setPowerCalibrationStore: (store) => { this.powerCalibrationStore = store; },
    getDailyBudgetService: () => this.dailyBudgetService,
    getStructuredDebugEmitter: (component, topic) => this.getStructuredDebugEmitter(component, topic),
    getTimeZone: () => this.getTimeZone(),
    error: (...args) => this.error(...args),
    updateDailyBudgetAndRecordCap: (options) => this.updateDailyBudgetAndRecordCap(options),
    persistPowerTrackerState: (reason) => this.persistPowerTrackerState(reason),
    persistPowerCalibrationIfDue: (nowMs) => this.persistPowerCalibrationIfDue(nowMs),
    flushPowerCalibration: (nowMs) => this.flushPowerCalibration(nowMs),
    prunePowerTrackerHistory: () => this.prunePowerTrackerHistory(),
  });
  private readonly ctx = this.context;
  // Smart-task (deferred-objective) preview/create/cancel/rescue + history
  // payload bodies. Declared after `ctx` so the context field is initialized.
  protected readonly smartTaskApi = new AppSmartTaskApi(this.ctx);
  protected readonly smartTaskPayloads = new AppSmartTaskPayloads(this.ctx);
  // Boot/teardown orchestration + per-service construction. Public lifecycle
  // and init delegators live on AppRuntimeApi; AppServiceWiring routes through
  // this instance so integration-test method overrides remain observable.
  protected readonly serviceWiring = new AppServiceWiring({
    ctx: this.ctx,
    homeyApp: this,
    backgroundTasks: this.backgroundTasks,
    timers: this.timers,
    nativeWiring: this.nativeWiring,
    planRebuildScheduler: this.planRebuildScheduler,
    getStructuredLogger: () => this.structuredLogger,
    setStructuredLogger: (logger) => { this.structuredLogger = logger; },
    getPlanService: () => this.planService,
    getStablePowerSampleRevision: () => this.powerSamplePipeline.getStableSampleRevision(),
    getPowerCalibrationStore: () => this.powerCalibrationStore,
    getObservedStateEmitter: () => this.observedStateEmitter,
    getObservedHomePower: () => this.observedHomePower,
    getObservedDeviceStateProjection: () => this.observedDeviceStateProjection,
    setObservedDeviceStateProjection: (projection) => { this.observedDeviceStateProjection = projection; },
    setStopSettingsHandler: (stop) => { this.stopSettingsHandler = stop; },
    getStopSettingsHandler: () => this.stopSettingsHandler,
    setWeatherCollector: (collector) => { this.weatherCollector = collector; },
    getPvForecast: () => this.pvForecast,
    setPvForecast: (pvForecast) => { this.pvForecast = pvForecast; },
    setNativeWiringUninitializing: (value) => { this.nativeWiringUninitializing = value; },
    isManagedFilterActive: () => this.isManagedFilterActive(),
    resolveNativeWiringEnabled: (deviceId) => this.resolveNativeWiringEnabled(deviceId),
    runNativeWiringDetectionBestEffort: () => this.runNativeWiringDetectionBestEffort(),
    getDeviceDriverIdOverride: (deviceId) => this.getDeviceDriverIdOverride(deviceId),
    getFlowConflict: (deviceId) => this.flowConflictsByDevice[deviceId],
    computeShortfallThreshold: () => this.computeShortfallThreshold(),
    retryDeferredOvershootSeed: (membership, allowPending) => this.snapshotHelpers.retryDeferredOvershootSeed(
      (deviceId) => homeMode.resolveOperatingModeForDevice(this.ctx, deviceId, membership, allowPending),
    ),
    loadPersistedState: () => this.flowBacked.loadPersistedState(),
    persistLearnedPowerPeaks: () => this.flowBacked.persistLearnedPeaks(),
    flushLearnedPowerPeaks: () => this.flowBacked.flushLearnedPeaks(),
    loadPowerCalibrationStore: () => this.loadPowerCalibrationStore(),
    startPowerTrackerPruning: () => this.startPowerTrackerPruning(),
    persistPowerTrackerState: (reason) => this.persistPowerTrackerState(reason),
    flushPowerCalibration: () => this.flushPowerCalibration(),
    runStartupSettingsMigrations: () => this.runStartupSettingsMigrations(),
    initPlanEngine: () => this.initPlanEngine(),
    initPriceCoordinator: () => this.initPriceCoordinator(),
    initDailyBudgetService: () => this.initDailyBudgetService(),
    initDeviceManager: () => this.initDeviceManager(),
    initCapacityGuard: () => this.initCapacityGuard(),
    initDeviceDiagnosticsService: () => this.initDeviceDiagnosticsService(),
    initPlanService: () => this.initPlanService(),
    subscribePlanObservedState: () => this.subscribePlanObservedState(),
    captureDefaultDynamicSoftLimit: () => this.captureDefaultDynamicSoftLimit(),
    initSettingsHandler: () => this.initSettingsHandler(),
  });
}

export = PelsApp;
