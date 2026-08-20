import type { ExpectedPowerOverridesByDeviceId, LearnedPeaksByDeviceId } from './lib/device/devicePowerPeak';

import Homey from 'homey';
import type CapacityGuard from './lib/power/capacityGuard';
import type { DeviceTransport } from './lib/device/deviceTransport';
import { ObservedStateEmitter } from './lib/observer/observedStateEvents';
import { ObservedHomePower } from './lib/observer/observedHomePower';
import {
  ObservedDeviceStateProjection,
} from './lib/observer/observedDeviceStateProjection';
import type { PlanEngine } from './lib/plan/planEngine';
import type { DevicePlan, ShedBehavior } from './lib/plan/planTypes';
import type { PendingTargetObservationSource } from './lib/plan/planTypes';
import type { PlanService } from './lib/plan/planService';
import type { HeadroomForDeviceDecision } from './lib/plan/planHeadroomDevice';
import type { SnapshotWarmupGate } from './lib/plan/snapshotWarmupGate';
import type { PowerCalibrationSnapshot } from './packages/contracts/src/powerCalibration';
import type {
  DecoratedDeviceSnapshot,
  DeviceControlProfiles,
  ProjectedObservedDeviceState,
  TargetDeviceSnapshot,
} from './packages/contracts/src/types';
import type { DeviceTargetPowerConfigsWithReachability } from './lib/device/targetPowerReachability';
import type { HomeyDeviceLike } from './lib/utils/types';
import type { PriceCoordinator } from './lib/price/priceCoordinator';
import type { PriceFlowTagPublisher } from './lib/price/priceFlowTags';
import type { PowerTrackerState } from './lib/power/tracker';
import { PriceLevel } from './lib/price/priceLevels';
import type { CombinedHourlyPrice } from './lib/price/priceTypes';
import { buildPeriodicStatusLogFields } from './lib/diagnostics/periodicStatus';
import type { DailyBudgetService } from './lib/dailyBudget/dailyBudgetService';
import type {
  DeferredObjectiveActivePlanRecorder,
  DeferredObjectivePlanHistoryRecorder,
} from './lib/objectives/deferredObjectives';
import type {
  DailyBudgetModelPreviewResponse,
  DailyBudgetSettingsInput,
  DailyBudgetUiPayload,
  DailyBudgetUpdateStateOptions,
} from './lib/dailyBudget/dailyBudgetTypes';
import type { SettingsUiPlanSnapshot } from './packages/contracts/src/settingsUiApi';
import type {
  CreateSmartTaskCandidateDevicesRead,
  PelsWidgetHostApi,
} from './packages/contracts/src/widgetHostApi';
import type { SmartTaskHomeScope } from './packages/contracts/src/smartTaskHomeScope';
import type { DebugLoggingTopic } from './packages/shared-domain/src/utils/debugLogging';
import { AppDeviceControlHelpers, normalizeStoredDeviceControlProfiles } from './setup/appDeviceControlHelpers';
import {
  getAllModes as getAllModesHelper,
  getShedBehavior as getShedBehaviorHelper,
  resolveDevicePriority as resolveDevicePriorityHelper,
  resolveModeName as resolveModeNameHelper,
} from './lib/utils/capacityHelpers';
import {
  DEFERRED_OBJECTIVE_HOURS_REMAINING_LATCH,
  MAIN_HOME_ID,
  OPERATING_MODE_SETTING,
} from './lib/utils/settingsKeys';
import {
  buildStarvedRescueDevices,
  readCreateSmartTaskCandidateDevices,
  resolveSmartTaskHomeScope,
} from './setup/appInit/smartTaskHomeScope';
import type { PowerSource } from './lib/power/powerSource';
import type { PowerSampleRebuildState } from './lib/plan/rebuildScheduler/powerDriven';
import { BackgroundTasksController } from './setup/backgroundTasksController';
import { createHomePowerPipeline } from './setup/homeRuntime/createHomePowerPipeline';
import type { PvForecastController } from './setup/appInit/createPvForecastService';
import { assembleWeatherAdvisorReadout } from './setup/appInit/weatherAdvisorReadoutAssembler';
import type { WeatherAdvisorReadoutPayload } from './packages/contracts/src/weatherAdvisorTypes';
import type { WeatherCollector } from './lib/weather/weatherCollector';
import { SchedulerTelemetryObserver } from './setup/schedulerTelemetryObserver';
import { requireConfiguredPowerSource } from './setup/powerSourceSettings';
import { SettingsRepository } from './setup/settingsRepository';
import { createCombinedPricesReaderForApp } from './setup/priceCombinedPricesAdapter';
import {
  updateDailyBudgetAndRecordCapForApp,
  type PowerTrackerPersistReason,
} from './lib/power/sampleIngest';
import { PowerCalibrationStore } from './lib/device/devicePowerCalibrationStore';
import { PlanRebuildScheduler } from './lib/plan/rebuildScheduler/scheduler';
import {
  type CancelDeferredObjectiveOutcome,
  registerAppFlowCards,
  toObservedStateSeed,
} from './setup/appInit';
import type { AppContext, StartupBootstrapConfig } from './lib/app/appContext';
import {
  createDeferredObjectiveEndedBus,
  createDeferredObjectiveHoursRemainingBus,
  createDeferredObjectiveHoursRemainingTracker,
  createDeferredObjectivePlanRevisionBus,
  createDeferredObjectiveStatusBus,
  type SmartTaskWriteOrigin,
  type DeferredObjectiveEndedBus,
  type DeferredObjectiveHoursRemainingBus,
  type DeferredObjectiveHoursRemainingTracker,
  type DeferredObjectivePlanPreviewCandidate,
  type DeferredObjectivePlanRevisionBus,
  type DeferredObjectiveStatusBus,
} from './lib/objectives/deferredObjectives';
import { buildDebugLoggingTopics } from './lib/utils/debugLoggingSettings';
import {
  isTemperatureControlDisabledForApp,
  loadTemperatureControlPolicySettingsForApp,
  loadCapacitySettingsFromHomey,
} from './setup/appSettingsHelpers';
import {
  disableUnsupportedDevices as disableUnsupportedDevicesHelper,
  seedMissingModeTargets as seedMissingModeTargetsHelper,
  isManagedFilterActive as isManagedFilterActiveHelper,
} from './setup/appDeviceSupport';
import * as homeMode from './setup/homeRuntime/homeOperatingMode';
import { migrateManagedDevices as migrateManagedDevicesHelper } from './setup/appManagedDeviceMigration';
import { runBootMigrations as runBootMigrationsHelper } from './setup/appBootMigrations';
import * as realtimeReconcile from './setup/appRealtimeDeviceReconcile';
import type {
  Logger as PinoLogger,
  StructuredDebugEmitter,
} from './lib/logging/logger';
import { normalizeError } from './lib/utils/errorUtils';
import { logHomeyDeviceComparisonForDebugFromApp } from './setup/appDebugHelpers';
import { emitSettingsUiDevicesUpdatedForApp } from './setup/settingsUiAppRuntime';
import type { DeviceDiagnosticsService } from './lib/diagnostics/deviceDiagnosticsService';
import type { SettingsUiDeviceDiagnosticsPayload } from './packages/contracts/src/deviceDiagnosticsTypes';
import type {
  ResolvedDeferredObjectiveActivePlansV1,
} from './packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanPreviewEstimate,
} from './packages/contracts/src/deferredObjectivePlanPreview';
import type {
  StarvationRescueDevice,
} from './packages/contracts/src/starvationRescue';
import type {
  SettingsUiDeferredObjectivePlanHistoryPayload,
  SettingsUiDeviceLogPayload,
} from './packages/contracts/src/settingsUiApi';
import { createGenerationPollSource } from './setup/appInit/createGenerationPollSource';
import { createHomeyEnergyPollSource } from './setup/appInit/createHomeyEnergyPollSource';
import {
  AppSnapshotHelpers, createTargetPowerReachabilityAppWiring,
  type RefreshTargetDevicesSnapshotOptions,
} from './setup/appSnapshotHelpers';
import { AppFlowBacked } from './setup/appFlowBacked';
import {
  AppSmartTaskApi,
  SMART_TASK_WIDGET_WRITE_ORIGIN,
  type SmartTaskWriteResult,
} from './setup/appSmartTaskApi';
import { AppSmartTaskPayloads } from './setup/appSmartTaskPayloads';
import { getAppPlanRebuildNowMs, PlanRebuildIntentPolicy } from './setup/planRebuildIntentPolicy';
import { AppNativeWiring } from './setup/appNativeWiring';
import { AppServiceWiring } from './setup/appServiceWiring';
import { AppPowerTracker } from './setup/appPowerTracker';
import { TimerRegistry } from './lib/utils/timerRegistry';
import {
  getFlowReportedDeviceIds,
  readFlowReportedCapabilitiesForDevice,
  type FlowReportedCapabilityId,
  type FlowReportedCapabilitiesByDevice,
  type FlowReportedCapabilitiesForDevice,
} from './lib/device/transport/flowReportedCapabilities';
import type { FlowBackedCapabilityReportOutcome } from './lib/app/appContext';
type PriceOptimizationSettings = Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;

class PelsApp extends Homey.App implements PelsWidgetHostApi, AppContext {
  public startupBootstrap?: StartupBootstrapConfig;
  // Latched when startup back-fill bailed because the per-key migration marker
  // was not yet set; consumed by the deferred-objective back-fill (see
  // `setup/appInit/deferredRecorders.ts`).
  public deferredObjectiveBackfillPending?: boolean;
  public readonly combinedPricesReader
    = createCombinedPricesReaderForApp(this.homey, () => this.priceCoordinator);
  public powerTracker: PowerTrackerState = {};
  private powerCalibrationStore: PowerCalibrationStore = new PowerCalibrationStore();
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
  private nativeEvWiringDevices: Record<string, boolean> = {};
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
  private flowReportedCapabilities: FlowReportedCapabilitiesByDevice = {};
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
   * (`observed-state-changed`, `plan-reconcile-observed`). Wiring builds
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
  private observedDeviceStateProjection: ObservedDeviceStateProjection = new ObservedDeviceStateProjection();
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
  private overheadToken?: Homey.FlowToken;
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
  private readonly planRebuildScheduler = new PlanRebuildScheduler({
    getNowMs: getAppPlanRebuildNowMs,
    resolveDueAtMs: (intent, state) => this.planRebuildIntentPolicy.resolveDueAtMs(intent, state),
    executeIntent: (intent) => this.planRebuildIntentPolicy.executeIntent(intent),
    shouldExecuteImmediately: (intent) => intent.kind !== 'flow',
    onIntentDropped: this.schedulerTelemetry.onIntentDropped,
    onPendingIntentReplaced: this.schedulerTelemetry.onPendingIntentReplaced,
    onIntentCancelled: this.schedulerTelemetry.onIntentCancelled,
    onIntentError: this.schedulerTelemetry.onIntentError,
  });
  private readonly powerSamplePipeline = createHomePowerPipeline({
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
  private realtimeDeviceReconcileState = realtimeReconcile.createRealtimeDeviceReconcileState();
  private stopSettingsHandler?: () => void;
  private weatherCollector?: WeatherCollector;
  private pvForecast?: PvForecastController;
  private readonly backgroundTasks = new BackgroundTasksController({
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
  private structuredLogger?: PinoLogger;
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
    disableUnsupportedDevices: (snapshot, operatingModeResolver) => disableUnsupportedDevicesHelper({
      snapshot, settings: this.homey.settings,
      // Overshoot defaults follow the OWNING home's effective mode.
      resolveOperatingModeForDevice: operatingModeResolver
        ?? ((deviceId) => homeMode.resolveOperatingModeForDevice(this.ctx, deviceId)),
      debugStructured: this.getStructuredDebugEmitter('devices', 'devices'),
    }),
    seedMissingModeTargets: (snapshot) => seedMissingModeTargetsHelper({
      snapshot, settings: this.homey.settings,
      resolveHomeIdForDevice: (deviceId) => homeMode.resolveHomeIdForModeCatalogSeed(this.ctx, deviceId),
      structuredLog: (event) => this.getStructuredLogger('devices')?.info(event),
      debugStructured: this.getStructuredDebugEmitter('devices', 'devices'),
    }),
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
  private readonly flowBacked = new AppFlowBacked({
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
  private readonly nativeWiring = new AppNativeWiring({
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
  private readonly powerTrackerHelpers = new AppPowerTracker({
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
  private readonly ctx: AppContext = this;
  // Smart-task (deferred-objective) preview/create/cancel/rescue + history
  // payload bodies. Declared after `ctx` so the context field is initialized.
  private readonly smartTaskApi = new AppSmartTaskApi(this.ctx);
  private readonly smartTaskPayloads = new AppSmartTaskPayloads(this.ctx);
  // Boot/teardown orchestration + per-service construction. The bodies live in
  // `setup/appServiceWiring.ts`; `PelsApp` keeps slim `onInit`/`onUninit` plus
  // thin `init*` delegators (the integration-test boot helper calls those
  // directly, and `initPlanEngine` is reassigned per-instance by a test seam,
  // so the orchestrator routes it back through this app instance).
  private readonly serviceWiring = new AppServiceWiring({
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
    getRealtimeDeviceReconcileState: () => this.realtimeDeviceReconcileState,
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
    getSnapshotDevice: (deviceId) => this.getSnapshotDevice(deviceId),
    retryDeferredOvershootSeed: (membership, allowPending) => this.snapshotHelpers.retryDeferredOvershootSeed(
      (deviceId) => homeMode.resolveOperatingModeForDevice(this.ctx, deviceId, membership, allowPending),
    ),
    hasEnabledEvBoostForSnapshot: (device) => this.hasEnabledEvBoostForSnapshot(device),
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
  public setExpectedOverride(deviceId: string, kw: number): boolean {
    return this.flowBacked.setExpectedOverride(deviceId, kw);
  }

  public reloadExpectedPowerOverrides = (): void => this.flowBacked.reloadExpectedPowerOverrides();

  public getFlowReportedCapabilitiesForDevice = (deviceId: string): FlowReportedCapabilitiesForDevice => (
    readFlowReportedCapabilitiesForDevice(this.flowReportedCapabilities, deviceId)
  );

  public getFlowReportedDeviceIds = (): string[] => (
    getFlowReportedDeviceIds(this.flowReportedCapabilities)
  );

  public reportFlowBackedCapability(params: {
    deviceId: string;
    capabilityId: FlowReportedCapabilityId;
    value: boolean | number | string;
    reportedAt?: number;
  }): FlowBackedCapabilityReportOutcome {
    return this.flowBacked.reportFlowBackedCapability(params);
  }

  public async getHomeyDevicesForFlow(): Promise<HomeyDeviceLike[]> {
    return this.flowBacked.getHomeyDevicesForFlow();
  }

  public async emitFlowBackedRefreshRequests(deviceIds: string[]): Promise<void> {
    return this.flowBacked.emitFlowBackedRefreshRequests(deviceIds);
  }

  public reloadWeatherCollector(): void {
    this.backgroundTasks.startWeatherCollector(this.weatherCollector);
  }

  public recordPowerSample(powerW: number, nowMs?: number): ReturnType<AppContext['recordPowerSample']> {
    return this.powerSamplePipeline.recordPowerSample(powerW, nowMs);
  }

  public loadDailyBudgetSettings(): void {
    this.dailyBudgetService.loadSettings();
  }

  public updateDailyBudgetState(options?: DailyBudgetUpdateStateOptions): void {
    this.updateDailyBudgetAndRecordCap(options);
  }

  public requestFlowPlanRebuild(source: string): void {
    this.planRebuildScheduler.request({
      kind: 'flow',
      reason: `flow_card:${source}`,
    });
  }

  public getObservedState(deviceId: string): ProjectedObservedDeviceState | undefined {
    return this.observedDeviceStateProjection.getObservedState(deviceId);
  }

  public seedObservedStateFromSnapshot(): void {
    this.observedDeviceStateProjection.seedMissing(toObservedStateSeed(this.deviceManager?.getSnapshot()));
  }

  public async logTargetRetryComparison(params: {
    deviceId: string;
    name: string;
    target: 'temperature';
    desired: number;
    observedValue?: unknown;
    observedSource?: string;
    retryCount: number;
    skipContext: 'plan' | 'shedding' | 'overshoot';
  }): Promise<void> {
    await logHomeyDeviceComparisonForDebugFromApp({
      app: this,
      deviceId: params.deviceId,
      reason: `target_retry:${params.skipContext}:${params.target}`,
      expectedTarget: params.desired,
      observedTarget: params.observedValue,
      observedSource: params.observedSource,
    });
  }

  public syncLivePlanStateAfterTargetActuation(source: PendingTargetObservationSource): boolean | void {
    return this.planService.syncLivePlanStateInline(source);
  }

  public evaluateHeadroomForDevice(
    params: Parameters<PlanService['evaluateHeadroomForDevice']>[0],
  ): HeadroomForDeviceDecision | null {
    return this.planService.evaluateHeadroomForDevice(params);
  }

  public getPowerCalibrationSnapshot(): PowerCalibrationSnapshot {
    return this.powerCalibrationStore.getSnapshot();
  }

  async onInit(): Promise<void> {
    await this.serviceWiring.runInit();
  }

  private runNativeWiringDetectionBestEffort(): void {
    this.nativeWiring.runNativeWiringDetectionBestEffort();
  }

  private delayMs(ms: number): Promise<void> {
    return this.nativeWiring.delayMs(ms);
  }

  private resolveNativeWiringEnabled(deviceId: string): boolean {
    return this.nativeWiring.resolveNativeWiringEnabled(deviceId);
  }

  private async applyNativeWiringAutoDecisions(): Promise<void> {
    return this.nativeWiring.applyNativeWiringAutoDecisions();
  }
  private initPriceCoordinator(): Promise<void> {
    return this.serviceWiring.initPriceCoordinator();
  }
  private initDailyBudgetService(): void {
    this.serviceWiring.initDailyBudgetService();
  }

  private initDeviceManager(): Promise<void> {
    return this.serviceWiring.initDeviceManager();
  }
  private getSnapshotDevice(deviceId: string): TargetDeviceSnapshot | undefined {
    return this.deviceManager?.getSnapshot()?.find((entry) => entry.id === deviceId);
  }

  private hasEnabledEvBoostForSnapshot(device: TargetDeviceSnapshot | undefined): boolean {
    if (!device || device.deviceClass !== 'evcharger') return false;
    const config = this.getEvBoostConfig(device.id);
    return config?.enabled === true && Number.isFinite(config.boostBelowPercent);
  }
  private initCapacityGuard(): void {
    this.serviceWiring.initCapacityGuard();
  }
  private initPlanEngine(): void {
    this.serviceWiring.initPlanEngine();
  }
  private initDeviceDiagnosticsService(): void {
    this.serviceWiring.initDeviceDiagnosticsService();
  }
  private initPlanService(): void {
    this.serviceWiring.initPlanService();
  }
  private subscribePlanObservedState(): void {
    this.serviceWiring.subscribePlanObservedState();
  }
  private getPlanRebuildNowMs(): number {
    return this.planRebuildScheduler.now().nowMs;
  }
  private captureDefaultDynamicSoftLimit(): void {
    this.serviceWiring.captureDefaultDynamicSoftLimit();
  }
  private initSettingsHandler(): void {
    this.serviceWiring.initSettingsHandler();
  }
  async onUninit(): Promise<void> {
    await this.serviceWiring.runUninit();
  }
  public logDebug(topic: DebugLoggingTopic, ...args: unknown[]): void {
    if (this.debugLoggingTopics.has(topic)) this.log(...args);
  }
  public getStructuredLogger(component: string): PinoLogger | undefined {
    if (!this.structuredLogger) return undefined;
    return this.structuredLogger.child({ component });
  }
  // Public accessor so the REST API layer (api.ts) can emit structured handler
  // failures through the same pino logger as the rest of the runtime, instead
  // of the legacy prose `error()` sink.
  public getApiStructuredLogger(): PinoLogger | undefined {
    return this.getStructuredLogger('api');
  }
  public getStructuredDebugEmitter(component: string, debugTopic: DebugLoggingTopic): StructuredDebugEmitter {
    return (payload) => {
      if (!this.structuredLogger || !this.debugLoggingTopics.has(debugTopic)) return;
      this.structuredLogger.child({ component }, { level: 'debug' }).debug({ ...payload, debugTopic });
    };
  }
  public getDynamicSoftLimitOverride(): number | null {
    if (!this.defaultComputeDynamicSoftLimit || this.computeDynamicSoftLimit === this.defaultComputeDynamicSoftLimit) {
      return null;
    }
    const value = this.computeDynamicSoftLimit();
    return Number.isFinite(value) ? value : null;
  }
  // Arrow-function field so the bound reference survives being passed by value
  // (e.g. `loadCapacitySettings: ctx.x` in setup/appSettingsHelpers.ts).
  public updatePriceOptimizationEnabled = (logChange = false): void => {
    this.priceCoordinator.updatePriceOptimizationEnabled(logChange);
  };
  public get priceOptimizationEnabled(): boolean { return this.priceCoordinator.getPriceOptimizationEnabled(); }
  public get priceOptimizationSettings(): PriceOptimizationSettings {
    return this.priceCoordinator.getPriceOptimizationSettings();
  }
  public updateDebugLoggingEnabled = (logChange = false): void => {
    this.debugLoggingTopics = buildDebugLoggingTopics({
      settings: this.homey.settings,
      logChange,
    });
  };
  public notifyOperatingModeChanged(mode: string): void {
    const trimmed = mode.trim();
    if (!trimmed || this.lastNotifiedOperatingMode === trimmed) return;
    const card = this.homey.flow?.getTriggerCard?.('operating_mode_changed');
    if (card && typeof card.trigger === 'function') {
      card.trigger({}, { mode: trimmed }).catch((err: Error) => this.getStructuredLogger('flow')
        ?.error({ event: 'operating_mode_changed_trigger_failed', err: normalizeError(err) }));
    }
    this.lastNotifiedOperatingMode = trimmed;
  }
  public loadPowerTracker(options: { skipDailyBudgetUpdate?: boolean } = {}): void {
    this.powerTrackerHelpers.loadPowerTracker(options);
  }
  private loadPowerCalibrationStore(): void {
    this.powerTrackerHelpers.loadPowerCalibrationStore();
  }
  private persistPowerCalibrationIfDue(nowMs: number = Date.now()): void {
    this.powerTrackerHelpers.persistPowerCalibrationIfDue(nowMs);
  }
  private flushPowerCalibration(nowMs: number = Date.now()): void {
    this.powerTrackerHelpers.flushPowerCalibration(nowMs);
  }
  private runStartupSettingsMigrations(): void {
    migrateManagedDevicesHelper({ homey: this.homey });
    runBootMigrationsHelper({ homey: this.homey });
  }
  public areFlowBackedCardsAvailable(): boolean {
    return this.flowBacked.areFlowBackedCardsAvailable();
  }
  public loadCapacitySettings = (): void => {
    const next = loadCapacitySettingsFromHomey({
      settings: this.homey.settings,
      current: {
        capacitySettings: this.capacitySettings,
        modeAliases: this.modeAliases,
        operatingMode: this.operatingMode,
        capacityPriorities: this.capacityPriorities,
        modeDeviceTargets: this.modeDeviceTargets,
        capacityDryRun: this.capacityDryRun,
        controllableDevices: this.controllableDevices,
        managedDevices: this.managedDevices,
        budgetExemptDevices: this.budgetExemptDevices,
        temperatureControlDisabledDevices: this.temperatureControlDisabledDevices,
        temperatureControlPolicyState: this.temperatureControlPolicyState,
        temperatureBoostSettings: this.temperatureBoostSettings,
        evBoostSettings: this.evBoostSettings,
        evCarAssociations: this.evCarAssociations,
        nativeEvWiringDevices: this.nativeEvWiringDevices,
        deviceDriverOverrides: this.deviceDriverOverrides,
        deviceControlProfiles: this.deviceControlProfiles,
        deviceTargetPowerConfigs: this.deviceTargetPowerConfigs,
        deviceCommunicationModels: this.deviceCommunicationModels,
        shedBehaviors: this.shedBehaviors,
      },
    });
    Object.assign(this, next, {
      deviceControlProfiles: normalizeStoredDeviceControlProfiles(next.deviceControlProfiles) ?? {},
    });
    this.updatePriceOptimizationEnabled();
    void this.updateOverheadToken(this.capacitySettings.marginKw);
  };
  public loadTemperatureControlPolicySettings = (): void => loadTemperatureControlPolicySettingsForApp(this.ctx);
  public loadPriceOptimizationSettings = (): void => { this.priceCoordinator.loadPriceOptimizationSettings(); };
  public getDailyBudgetUiPayload(): DailyBudgetUiPayload | null { return this.dailyBudgetService.getUiPayload(); }
  public recomputeDailyBudgetToday(): DailyBudgetUiPayload | null {
    return this.dailyBudgetService.recomputeTodayPlan();
  }
  public previewDailyBudgetModel(settings: DailyBudgetSettingsInput): DailyBudgetModelPreviewResponse {
    return this.dailyBudgetService.previewModelSettings(settings);
  }
  public applyDailyBudgetModel(settings: DailyBudgetSettingsInput): DailyBudgetUiPayload | null {
    return this.dailyBudgetService.applyModelSettings(settings);
  }
  public getLatestPlanSnapshotForUi(): SettingsUiPlanSnapshot | null {
    return this.planService.getLatestPlanSnapshotForUi();
  }
  public updateOverheadToken = async (value?: number): Promise<void> => {
    const overhead = Number.isFinite(value) ? Number(value) : this.capacitySettings.marginKw;
    try {
      if (!this.overheadToken) {
        this.overheadToken = await this.homey.flow.createToken('capacity_overhead', {
          type: 'number',
          title: 'Soft margin (kW)',
          value: overhead ?? 0,
        });
      }
      await this.overheadToken.setValue(overhead ?? 0);
    } catch (error) {
      this.getStructuredLogger('flow')
        ?.error({ event: 'capacity_overhead_token_update_failed', err: normalizeError(error) });
    }
  };
  private persistPowerTrackerState(reason: PowerTrackerPersistReason = 'write'): void {
    this.powerTrackerHelpers.persistPowerTrackerState(reason);
  }
  private prunePowerTrackerHistory(): void {
    this.powerTrackerHelpers.prunePowerTrackerHistory();
  }
  private startPowerTrackerPruning(): void {
    this.powerTrackerHelpers.startPowerTrackerPruning();
  }
  private savePowerTracker(nextState: PowerTrackerState): void {
    this.powerTrackerHelpers.savePowerTracker(nextState);
  }
  public replacePowerTrackerForUi(nextState: PowerTrackerState): void {
    this.powerTrackerHelpers.replacePowerTrackerForUi(nextState);
  }
  private updateDailyBudgetAndRecordCap(options?: DailyBudgetUpdateStateOptions): void {
    this.powerTracker = updateDailyBudgetAndRecordCapForApp({
      powerTracker: this.powerTracker,
      dailyBudgetService: this.dailyBudgetService,
      options,
    });
  }
  public registerFlowCards(): void {
    registerAppFlowCards(this.ctx);
  }
  public async handleOperatingModeChange(rawMode: string): Promise<void> {
    const resolved = resolveModeNameHelper(
      rawMode,
      this.modeAliases,
      getAllModesHelper('', this.capacityPriorities, this.modeDeviceTargets),
    );
    const previousMode = this.operatingMode;
    if (resolved !== rawMode) {
      this.getStructuredDebugEmitter('settings', 'settings')({
        event: 'mode_resolved_via_alias',
        requestedMode: rawMode,
        resolvedMode: resolved,
      });
    }
    this.operatingMode = resolved;
    this.homey.settings.set(OPERATING_MODE_SETTING, resolved);
    const aliasUsed = rawMode !== resolved ? rawMode : null;
    if (this.homey.settings.get('mode_alias_used') !== aliasUsed) {
      this.homey.settings.set('mode_alias_used', aliasUsed);
    }
    if (previousMode?.toLowerCase() === resolved.toLowerCase()) {
      this.getStructuredDebugEmitter('settings', 'settings')({ event: 'mode_already_active', mode: resolved });
    }
    this.notifyOperatingModeChanged(resolved);
  }
  public async getFlowSnapshot(): Promise<DecoratedDeviceSnapshot[]> {
    if (!this.latestTargetSnapshot || this.latestTargetSnapshot.length === 0) {
      await this.refreshTargetDevicesSnapshot();
    }
    return this.latestTargetSnapshot;
  }
  public getCurrentPriceLevel(): PriceLevel {
    const status = this.homey.settings.get('pels_status') as { priceLevel?: PriceLevel } | null;
    return (status?.priceLevel || this.planService.getLastNotifiedPriceLevel() || PriceLevel.UNKNOWN) as PriceLevel;
  }
  private logPeriodicStatus(options: { includeDeviceHealth?: boolean } = {}): void {
    const periodicStatusParams = {
      capacityGuard: this.capacityGuard,
      powerTracker: this.powerTracker,
      capacitySettings: this.capacitySettings,
      operatingMode: this.operatingMode,
      capacityDryRun: this.capacityDryRun,
      starvedDeviceCount: this.deviceDiagnosticsService?.getCurrentStarvedDeviceCount?.() ?? 0,
      capacityPaceKw: this.computeDynamicSoftLimit(),
      sheddingActive: this.planEngine.state.sheddingActive,
    };
    this.getStructuredLogger('status')?.info(buildPeriodicStatusLogFields(periodicStatusParams));
    if (options.includeDeviceHealth === true) {
      const deviceStatus = this.deviceManager.getPeriodicStatusMetrics();
      if (deviceStatus) {
        this.getStructuredLogger('devices')?.info({
          event: 'periodic_device_health_summary',
          ...deviceStatus,
        });
      }
    }
    const dailyBudgetStatus = this.dailyBudgetService.getPeriodicStatusFields();
    if (dailyBudgetStatus) {
      this.getStructuredLogger('daily_budget')?.info(dailyBudgetStatus);
    }
  }
  public get latestTargetSnapshot(): DecoratedDeviceSnapshot[] {
    const snapshot = this.deviceManager?.getSnapshot() ?? [];
    return this.deviceControlHelpers.decorateTargetSnapshotList(snapshot);
  }
  getUiPickerDevices(): DecoratedDeviceSnapshot[] {
    const snapshot = this.deviceManager?.getUiPickerDevices() ?? [];
    return this.deviceControlHelpers.decorateTargetSnapshotList(snapshot);
  }
  // Devices the create-smart-task widget may OFFER. Sourced from the runtime-
  // planned snapshot AND filtered by the EXACT planned-set predicate the plan
  // service uses (`isRuntimePlannedDevice`, i.e. `managed !== false`). The raw
  // runtime snapshot can still carry `managed: false` devices when the managed
  // filter is inactive (no device explicitly opted-in) — those are dropped by
  // the planner, so offering one would let the widget create a task that never
  // plans or controls anything. `createDeferredObjective` re-applies the same
  // predicate at write time, so listing and validation share one definition.
  getCreateSmartTaskCandidateDevices(): CreateSmartTaskCandidateDevicesRead {
    return readCreateSmartTaskCandidateDevices(this.ctx);
  }
  // Reason-bearing public scope resolver for outer UI adapters. A provisional
  // ownership fence is retryable `unavailable`; only durable relocation is the
  // hard `device_in_sub_home` lane.
  public resolveSmartTaskHomeScope(deviceId: string): SmartTaskHomeScope {
    return resolveSmartTaskHomeScope(this.ctx, deviceId);
  }
  // Currently-starved devices for the starvation-rescue widget; assembly lives
  // with the other smart-task home-scope surfaces (`buildStarvedRescueDevices`
  // — sourcing/join/exclusion rationale documented there).
  getStarvedRescueDevices(): StarvationRescueDevice[] {
    return buildStarvedRescueDevices(this.ctx);
  }
  setSnapshotForTests(snapshot: TargetDeviceSnapshot[]): void {
    this.deviceManager.setSnapshotForTests(snapshot);
  }
  parseDevicesForTests(list: HomeyDeviceLike[]): TargetDeviceSnapshot[] {
    return this.deviceManager.parseDeviceListForTests(list);
  }
  public async refreshTargetDevicesSnapshot(
    options: RefreshTargetDevicesSnapshotOptions = {},
  ): Promise<void> {
    await this.snapshotHelpers.refreshTargetDevicesSnapshot(options);
  }
  public getCombinedHourlyPrices = (): CombinedHourlyPrice[] => this.priceCoordinator.getCombinedHourlyPrices();
  public getTimeZone = (): string => this.homey.clock.getTimezone();
  public getPowerSource = (): PowerSource => requireConfiguredPowerSource(this.homey.settings);
  public getNow = (): Date => new Date();
  public findCheapestHours = (count: number): string[] => this.priceCoordinator.findCheapestHours(count);
  public isCurrentHourCheap = (): boolean => this.priceCoordinator.isCurrentHourCheap();
  // Both flags from ONE combined-series build; the series is uncached, so asking
  // the two predicates separately rebuilt it twice per plan cycle.
  public getCurrentHourPriceLevel = (): { cheap: boolean; expensive: boolean } => (
    this.priceCoordinator.getCurrentHourPriceLevel()
  );
  public isCurrentHourExpensive = (): boolean => this.priceCoordinator.isCurrentHourExpensive();
  public getCurrentHourPriceInfo = (): string => this.priceCoordinator.getCurrentHourPriceInfo();
  storeFlowPriceData(kind: 'today' | 'tomorrow', raw: unknown): {
    dateKey: string;
    storedCount: number;
    missingHours: number[];
  } {
    return this.priceCoordinator.storeFlowPriceData(kind, raw);
  }
  public async applyPriceOptimization() {
    return this.priceCoordinator.applyPriceOptimization();
  }
  // Main's resolver ranks by the GLOBAL mode; a sub-home scope ranks by its
  // own effective mode through the same shared helper (one formula).
  public getPriorityForDevice = (deviceId: string) => (
    resolveDevicePriorityHelper(this.capacityPriorities, this.operatingMode, deviceId)
  );
  public resolveModeName = (name: string) => resolveModeNameHelper(
    name,
    this.modeAliases,
    getAllModesHelper('', this.capacityPriorities, this.modeDeviceTargets),
  );
  public getAllModes = () => getAllModesHelper(this.operatingMode, this.capacityPriorities, this.modeDeviceTargets);
  // A role-detected OBSERVE-ONLY device (home battery OR solar) is ALWAYS managed
  // observe-only. The AUTHORITATIVE resolution is STRUCTURAL at parse
  // (`resolveParsedDeviceSettings` stamps `managed: true, controllable: false` from the
  // device object on every parse path), and the planner reads that snapshot stamp
  // (`toPlanDevice`). These two functions are the SECONDARY agreement for deviceId-only
  // callers (autocomplete, the shortfall-power-rebuild hint) that have no device object:
  // they consult the transport's battery + solar id sets (`isBatteryDevice` /
  // `isSolarDevice`, kept non-empty for a present device) so their answer matches the
  // structural stamp. Non-controllability is the companion `isCapacityControlEnabled`
  // override below; together they keep the device inert (reinforced by its
  // non-temperature class).
  private isObserveOnlyRoleDevice = (deviceId: string) => (
    this.deviceManager?.isBatteryDevice(deviceId) === true
    || this.deviceManager?.isSolarDevice(deviceId) === true
  );
  public resolveManagedState = (deviceId: string) =>
    this.isObserveOnlyRoleDevice(deviceId) || this.managedDevices[deviceId] === true;
  private isManagedFilterActive = () => isManagedFilterActiveHelper(this.managedDevices);
  public getCommunicationModel = (deviceId: string): 'local' | 'cloud' => (
    this.deviceCommunicationModels[deviceId] ?? 'local'
  );
  private getDeviceDriverIdOverride = (deviceId: string): string | undefined => {
    const override = this.deviceDriverOverrides[deviceId]?.trim();
    return override || undefined;
  };
  public isCapacityControlEnabled = (deviceId: string) => (
    // Observe-only devices are never capacity-controlled, regardless of settings maps.
    // This mirrors the structural parse stamp used by `resolveManagedState` above.
    !this.isObserveOnlyRoleDevice(deviceId)
    && this.managedDevices[deviceId] === true
    && this.controllableDevices[deviceId] === true
  );
  public isBudgetExempt = (deviceId: string) => this.budgetExemptDevices[deviceId] === true;
  public isTemperatureControlDisabled = (deviceId: string): boolean => (
    isTemperatureControlDisabledForApp(this.ctx, deviceId)
  );
  public getTemperatureBoostConfig = (deviceId: string) => this.temperatureBoostSettings[deviceId];
  public getEvBoostConfig = (deviceId: string) => this.evBoostSettings[deviceId];
  public getShedBehavior = (deviceId: string) => getShedBehaviorHelper(deviceId, this.shedBehaviors);
  public computeDynamicSoftLimit = () => this.planService.computeDynamicSoftLimit();
  private computeShortfallThreshold = () => this.planService.computeShortfallThreshold();
  public getDeviceDiagnosticsUiPayload(): SettingsUiDeviceDiagnosticsPayload {
    return this.deviceDiagnosticsService?.getUiPayload?.()
      ?? { generatedAt: Date.now(), windowDays: 21, diagnosticsByDeviceId: {} };
  }
  public getDeviceLogUiPayload(): SettingsUiDeviceLogPayload {
    return this.planService.getDeviceLogUiPayload();
  }
  // Hidden weather-insight readout (null = flag off → structural UI absence).
  public getWeatherAdvisorReadout(): Promise<WeatherAdvisorReadoutPayload | null> {
    return assembleWeatherAdvisorReadout({ ctx: this.ctx, collector: this.weatherCollector });
  }
  // ─── Smart tasks (deferred objectives) ───────────────────────────────────
  // Thin delegators onto `setup/appSmartTaskApi.ts` (the write/preview lanes)
  // and `setup/appSmartTaskPayloads.ts` (the read-only UI payloads). They stay
  // on the app class because the widget host API and the settings-UI handlers
  // reach them through `homey.app`; the bodies (and their rationale) live in
  // the setup classes. Regression cover for the wiring itself:
  // `test/integration/appSmartTaskDelegation.test.ts`.
  public hasDeferredObjectiveForDevice(deviceId: string): boolean {
    return this.smartTaskApi.hasDeferredObjectiveForDevice(deviceId);
  }
  public getDeferredObjectiveActivePlansUiPayload(): ResolvedDeferredObjectiveActivePlansV1 | null {
    return this.smartTaskPayloads.getDeferredObjectiveActivePlansUiPayload();
  }
  public previewStarvationRescuePlan(
    deviceId: string,
    freshRescueCandidate: DeferredObjectivePlanPreviewCandidate,
  ): { estimate: DeferredObjectivePlanPreviewEstimate; deadlineAtMs: number; hasExistingObjective: boolean } {
    return this.smartTaskApi.previewStarvationRescuePlan(deviceId, freshRescueCandidate);
  }
  public previewDeferredObjectivePlan(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): DeferredObjectivePlanPreviewEstimate {
    return this.smartTaskApi.previewDeferredObjectivePlan(deviceId, candidate);
  }
  public createDeferredObjective(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
    origin: SmartTaskWriteOrigin = SMART_TASK_WIDGET_WRITE_ORIGIN,
    rescuePolicy: 'preserve' | 'replace' = 'preserve',
  ): SmartTaskWriteResult {
    return this.smartTaskApi.createDeferredObjective(deviceId, candidate, origin, rescuePolicy);
  }
  public cancelDeferredObjective(deviceId: string): CancelDeferredObjectiveOutcome {
    return this.smartTaskApi.cancelDeferredObjective(deviceId);
  }
  public rescueDeviceWithBudgetExemption(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): SmartTaskWriteResult {
    return this.smartTaskApi.rescueDeviceWithBudgetExemption(deviceId, candidate);
  }
  public getDeferredObjectivePlanHistoryUiPayload(): SettingsUiDeferredObjectivePlanHistoryPayload {
    return this.smartTaskPayloads.getDeferredObjectivePlanHistoryUiPayload();
  }
  public getDeferredObjectivePlanHistoryRecentUiPayload(
    sinceMs: number,
  ): SettingsUiDeferredObjectivePlanHistoryPayload {
    return this.smartTaskPayloads.getDeferredObjectivePlanHistoryRecentUiPayload(sinceMs);
  }
  public applyPlanActions = (plan: DevicePlan) => this.planService.applyPlanActions(plan);
  public applySheddingToDevice = (deviceId: string, deviceName: string, reason?: string) =>
    this.planService.applySheddingToDevice(deviceId, deviceName, reason);
}

export = PelsApp;
