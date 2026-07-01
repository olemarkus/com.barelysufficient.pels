import Homey from 'homey';
import type CapacityGuard from './lib/power/capacityGuard';
import type { DeviceTransport } from './lib/device/deviceTransport';
import { ObservedStateEmitter } from './lib/observer/observedStateEvents';
import { ObservedHomePower } from './lib/observer/observedHomePower';
import { ObservedDeviceStateProjection } from './lib/observer/observedDeviceStateProjection';
import type { PlanEngine } from './lib/plan/planEngine';
import {
  createBinarySettleState,
  type BinarySettleState,
} from './lib/observer/binarySettle';
import type { DevicePlan, ShedBehavior } from './lib/plan/planTypes';
import type { PendingTargetObservationSource } from './lib/plan/planTypes';
import type { PlanService } from './lib/plan/planService';
import type { HeadroomForDeviceDecision } from './lib/plan/planHeadroomDevice';
import type { SnapshotWarmupGate } from './lib/plan/snapshotWarmupGate';
import type { PowerCalibrationSnapshot } from './packages/contracts/src/powerCalibration';
import type {
  DecoratedDeviceSnapshot,
  DeviceControlProfiles,
  DeviceTargetPowerConfigs,
  ObservedDeviceState,
  SteppedLoadDescriptorProbe,
  TargetDeviceSnapshot,
} from './packages/contracts/src/types';
import type { HomeyDeviceLike } from './lib/utils/types';
import type { PriceCoordinator } from './lib/price/priceCoordinator';
import type { PriceFlowTagPublisher } from './lib/price/priceFlowTags';
import type { PowerTrackerState } from './lib/power/tracker';
import { PriceLevel } from './lib/price/priceLevels';
import type { CombinedHourlyPrice } from './lib/price/priceTypes';
import { createObjectivePriceHorizonBuilder } from './setup/appInit/objectivePriceHorizon';
import { buildPeriodicStatusLogFields } from './lib/diagnostics/periodicStatus';
import { getDeviceLoadSetting } from './lib/device/load';
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
import type { PelsWidgetHostApi } from './packages/contracts/src/widgetHostApi';
import type { DebugLoggingTopic } from './packages/shared-domain/src/utils/debugLogging';
import {
  resolveSmartTaskDeviceKind,
  resolveSmartTaskGoalBounds,
} from './packages/shared-domain/src/smartTaskDeviceKind';
import {
  AppDeviceControlHelpers,
  normalizeStoredDeviceControlProfiles,
} from './setup/appDeviceControlHelpers';
import {
  getAllModes as getAllModesHelper,
  getShedBehavior as getShedBehaviorHelper,
  resolveModeName as resolveModeNameHelper,
} from './lib/utils/capacityHelpers';
import {
  DEFERRED_OBJECTIVE_HOURS_REMAINING_LATCH,
  OPERATING_MODE_SETTING,
  POWER_SOURCE,
} from './lib/utils/settingsKeys';
import { normalizePowerSource, type PowerSource } from './lib/power/powerSource';
import {
  executePendingPowerRebuild,
  PowerSampleRebuildState,
} from './lib/plan/rebuildScheduler/powerDriven';
import { TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS } from './lib/plan/rebuildScheduler/policy';
import { assembleActivePlansWithTrajectory } from './setup/deferredObjectiveActivePlansUiAssembler';
import { BackgroundTasksController } from './setup/backgroundTasksController';
import { PowerSamplePipeline } from './setup/powerSamplePipeline';
import type { PvForecastController } from './setup/appInit/createPvForecastService';
import { assembleWeatherAdvisorReadout } from './setup/appInit/weatherAdvisorReadoutAssembler';
import type { WeatherAdvisorReadoutPayload } from './packages/contracts/src/weatherAdvisorTypes';
import type { WeatherCollector } from './lib/weather/weatherCollector';
import { SchedulerTelemetryObserver } from './setup/schedulerTelemetryObserver';
import { SettingsRepository } from './setup/settingsRepository';
import { createCombinedPricesReaderForApp } from './setup/priceCombinedPricesAdapter';
import {
  updateDailyBudgetAndRecordCapForApp,
  type PowerTrackerPersistReason,
} from './lib/power/sampleIngest';
import { PowerCalibrationStore } from './lib/device/devicePowerCalibrationStore';
import { PlanRebuildScheduler, type RebuildIntent } from './lib/plan/rebuildScheduler/scheduler';
import {
  buildDeferredObjectiveDeviceWriteDeps,
  registerAppFlowCards,
  toObservedStateSeed,
  toPlanDevice,
} from './setup/appInit';
import type { AppContext, StartupBootstrapConfig } from './lib/app/appContext';
import {
  createDeferredObjectiveEndedBus,
  createDeferredObjectiveHoursRemainingBus,
  createDeferredObjectiveHoursRemainingTracker,
  createDeferredObjectivePlanRevisionBus,
  createDeferredObjectiveStatusBus,
  migrateBlobToPerKeyIfNeeded,
  normalizeDeferredObjectiveSettingsEntry,
  previewDeferredObjectivePlan,
  readObjectiveForDevice,
  upsertObjectiveForDevice,
  type DeferredObjectiveEndedBus,
  type DeferredObjectiveHoursRemainingBus,
  type DeferredObjectiveHoursRemainingTracker,
  type DeferredObjectivePlanPreviewCandidate,
  type DeferredObjectivePlanRevisionBus,
  type DeferredObjectiveSettingsEntry,
  type DeferredObjectiveStatusBus,
} from './lib/objectives/deferredObjectives';
import { buildDebugLoggingTopics } from './lib/utils/debugLoggingSettings';
import { loadCapacitySettingsFromHomey } from './setup/appSettingsHelpers';
import {
  disableUnsupportedDevices as disableUnsupportedDevicesHelper,
  seedMissingModeTargets as seedMissingModeTargetsHelper,
  isManagedFilterActive as isManagedFilterActiveHelper,
  isRuntimePlannedDevice,
} from './setup/appDeviceSupport';
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
import type { DeferredObjectivePlanHistoryEntry } from './packages/contracts/src/deferredObjectivePlanHistory';
import { toResolvedPlanHistoryEntry } from './packages/shared-domain/src/deferredPlanHistoryResolvedView';
import { isSteppedLoadSnapshot } from './packages/shared-domain/src/steppedLoadObservedState';
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
import { HomeyEnergyPollSource } from './lib/power/sources/homeyEnergyPoll';
import {
  AppSnapshotHelpers,
  type RefreshTargetDevicesSnapshotOptions,
} from './setup/appSnapshotHelpers';
import { AppFlowBacked } from './setup/appFlowBacked';
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
const FLOW_REBUILD_COOLDOWN_MS = 1000;
// Leading window before the first flow rebuild runs, so a burst of settings cards in one
// flow (e.g. set deadline -> allow rescue -> allow rescue) coalesces into a single re-solve
// / one plan revision. 0 in tests so the suite is not delayed.
const FLOW_REBUILD_COALESCE_MS = process.env.NODE_ENV === 'test' ? 0 : 1000;
type PriceOptimizationSettings = Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
const getAppPlanRebuildNowMs = (): number => (
  process.env.NODE_ENV === 'test'
  || typeof performance === 'undefined'
  || typeof performance.now !== 'function'
    ? Date.now()
    : performance.now()
);

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
  public capacityGuard?: CapacityGuard;
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
  public temperatureBoostSettings: import('./packages/contracts/src/types').TemperatureBoostSettings = {};
  public evBoostSettings: import('./packages/contracts/src/types').EvBoostSettings = {};
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
  public deviceTargetPowerConfigs: DeviceTargetPowerConfigs = {};
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
   * Observer-owned binarySettle state, constructed by wiring before
   * `DeviceTransport` so the predicate the transport consults at the
   * realtime parse pipeline points at the same store. Per PR #4 of the
   * observer/transport split (notes/state-management/observer-transport-split.md),
   * transport never statically imports observer; the state and the
   * predicate both flow in via DeviceTransport's constructor options.
   */
  private observerBinarySettleState: BinarySettleState = createBinarySettleState();
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
  public defaultComputeDynamicSoftLimit: (() => number) | undefined = undefined;
  public lastKnownPowerKw: Record<string, number> = {};
  public expectedPowerKwOverrides: Record<string, { kw: number; ts: number }> = {};
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
  private readonly planRebuildScheduler = new PlanRebuildScheduler({
    getNowMs: getAppPlanRebuildNowMs,
    resolveDueAtMs: (intent, state) => this.resolvePlanRebuildDueAtMs(intent, state),
    executeIntent: (intent) => this.executePlanRebuildIntent(intent),
    shouldExecuteImmediately: (intent) => intent.kind !== 'flow',
    onIntentDropped: this.schedulerTelemetry.onIntentDropped,
    onPendingIntentReplaced: this.schedulerTelemetry.onPendingIntentReplaced,
    onIntentCancelled: this.schedulerTelemetry.onIntentCancelled,
    onIntentError: this.schedulerTelemetry.onIntentError,
  });
  private readonly powerSamplePipeline = new PowerSamplePipeline({
    getPowerTracker: () => this.powerTracker,
    getCapacitySettings: () => this.capacitySettings,
    getCapacityGuard: () => this.capacityGuard,
    getPlanEngine: () => this.planEngine,
    getPlanService: () => this.planService,
    getDeviceManager: () => this.deviceManager,
    planRebuildScheduler: this.planRebuildScheduler,
    getPowerSampleRebuildState: () => this.powerSampleRebuildState,
    setPowerSampleRebuildState: (state) => { this.powerSampleRebuildState = state; },
    getLatestTargetSnapshot: () => this.latestTargetSnapshot,
    getPlanRebuildNowMs: () => this.getPlanRebuildNowMs(),
    savePowerTracker: (state) => this.savePowerTracker(state),
    getStructuredDebugEmitter: (component, topic) => this.getStructuredDebugEmitter(component, topic),
    getOutdoorTemperatureC: () => this.weatherCollector?.getCurrentOutdoorTemperatureC(),
    recordPvGenerationSample: (generationW, nowMs) => this.pvForecast?.recordSample(generationW, nowMs),
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
  public readonly snapshotHelpers = new AppSnapshotHelpers({
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
    disableUnsupportedDevices: (snapshot) => disableUnsupportedDevicesHelper({
      snapshot,
      settings: this.homey.settings,
      debugStructured: this.getStructuredDebugEmitter('devices', 'devices'),
    }),
    seedMissingModeTargets: (snapshot) => seedMissingModeTargetsHelper({
      snapshot,
      settings: this.homey.settings,
      structuredLog: (event) => this.getStructuredLogger('devices')?.info(event),
      debugStructured: this.getStructuredDebugEmitter('devices', 'devices'),
    }),
    getFlowReportedDeviceIds: () => this.getFlowReportedDeviceIds(),
    emitFlowBackedRefreshRequests: async (deviceIds) => this.emitFlowBackedRefreshRequests(deviceIds),
    emitSettingsUiDevicesUpdated: () => emitSettingsUiDevicesUpdatedForApp(
      this.homey,
      (message, error) => this.error(message, error),
    ),
    recordPowerSample: async (sample) => this.powerSamplePipeline.recordPowerSample(sample.powerW, undefined, sample),
  });
  public readonly homeyEnergyHelpers = new HomeyEnergyPollSource({
    getPowerSource: () => this.getPowerSource(),
    timers: this.timers,
    pollHomePower: async () => (await this.deviceManager?.pollHomePowerW()) ?? null,
    recordPowerSample: async (sample) => this.powerSamplePipeline.recordPowerSample(sample.powerW, undefined, sample),
    debugStructured: this.getStructuredDebugEmitter('devices', 'devices'),
    error: (...args) => this.error(...args),
  });
  public readonly deviceControlHelpers = new AppDeviceControlHelpers({
    getProfiles: () => this.deviceControlProfiles,
    getDeviceSnapshots: () => this.deviceManager?.getSnapshot() ?? [],
    getLatestPlanSnapshot: () => this.planService?.getLatestPlanSnapshot() ?? null,
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
    syncHeadroomUsageObservation: (params) => { this.planService?.syncHeadroomUsageObservation(params); },
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
    getPowerCalibrationStore: () => this.powerCalibrationStore,
    getObserverBinarySettleState: () => this.observerBinarySettleState,
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
    hasEnabledEvBoostForSnapshot: (device) => this.hasEnabledEvBoostForSnapshot(device),
    loadFlowReportedCapabilities: () => this.loadFlowReportedCapabilities(),
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
    initCapacityGuardProviders: () => this.initCapacityGuardProviders(),
    initSettingsHandler: () => this.initSettingsHandler(),
  });
  public setExpectedOverride(deviceId: string, kw: number): boolean {
    return this.flowBacked.setExpectedOverride(deviceId, kw);
  }

  private loadFlowReportedCapabilities(): void {
    this.flowBacked.loadFlowReportedCapabilities();
  }

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

  public recordPowerSample(powerW: number, nowMs?: number): Promise<void> {
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

  public getObservedState(deviceId: string): ObservedDeviceState | undefined {
    return this.observedDeviceStateProjection.getObservedState(deviceId);
  }

  public seedObservedStateFromSnapshot(): void {
    this.observedDeviceStateProjection.seedMissing(toObservedStateSeed(this.deviceManager?.getSnapshot()));
  }

  public async logTargetRetryComparison(params: {
    deviceId: string;
    name: string;
    targetCap: string;
    desired: number;
    observedValue?: unknown;
    observedSource?: string;
    retryCount: number;
    skipContext: 'plan' | 'shedding' | 'overshoot';
  }): Promise<void> {
    await logHomeyDeviceComparisonForDebugFromApp({
      app: this,
      deviceId: params.deviceId,
      reason: `target_retry:${params.skipContext}:${params.targetCap}`,
      expectedTarget: params.desired,
      observedTarget: params.observedValue,
      observedSource: params.observedSource,
    });
  }

  public syncLivePlanStateAfterTargetActuation(source: PendingTargetObservationSource): boolean | void {
    return this.planService?.syncLivePlanStateInline(source) ?? false;
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
  private getPlanRebuildNowMs(): number {
    return this.planRebuildScheduler.now().nowMs;
  }
  private resolvePlanRebuildDueAtMs(intent: RebuildIntent, state: ReturnType<PlanRebuildScheduler['now']>): number {
    const nowMs = state.nowMs;
    // Execution-side floor: while nothing is actionable, no trigger (signal or
    // hardCap) may execute a rebuild faster than the floor after the last one.
    // Anchored to `lastMs` (set only on a real execution) so `now` deterministically
    // passes it after the interval rather than sliding forward on each recompute.
    // Requires `lastMs > 0`: with a monotonic clock (`performance.now`) an un-run
    // scheduler (`lastMs === 0`) is process start, and `0 + interval` is a real
    // future time that would wrongly defer the very first (initial-sample) rebuild.
    const floorMs = this.powerSampleRebuildState.tightUnactionable === true
      && this.powerSampleRebuildState.lastMs > 0
      ? this.powerSampleRebuildState.lastMs + TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS
      : Number.NEGATIVE_INFINITY;
    if (intent.kind === 'hardCap') return Math.max(nowMs, floorMs);
    if (intent.kind === 'signal') {
      return Math.max(this.powerSampleRebuildState.pendingDueMs ?? nowMs, floorMs);
    }
    if (intent.kind === 'flow') {
      if (state.activeIntent?.kind === 'flow') {
        return Number.POSITIVE_INFINITY;
      }
      const lastCompletedAtMs = state.lastCompletedAtMsByKind.flow ?? Number.NEGATIVE_INFINITY;
      // Leading coalesce window holds the first rebuild a beat so a multi-card flow collapses
      // into one re-solve; the trailing cooldown still throttles subsequent bursts.
      return Math.max(nowMs + FLOW_REBUILD_COALESCE_MS, lastCompletedAtMs + FLOW_REBUILD_COOLDOWN_MS);
    }
    return Number.POSITIVE_INFINITY;
  }
  private executePlanRebuildIntent(intent: RebuildIntent): Promise<void> {
    if (intent.kind === 'signal' || intent.kind === 'hardCap') {
      return executePendingPowerRebuild({
        getState: () => this.powerSampleRebuildState,
        setState: (state) => {
          this.powerSampleRebuildState = state;
        },
        getNowMs: () => this.getPlanRebuildNowMs(),
        rebuildPlanFromCache: (reason?: string) => this.planService.rebuildPlanFromCache(reason),
      });
    }
    return this.planService.rebuildPlanFromCache(intent.reason).then(() => undefined);
  }
  private initCapacityGuardProviders(): void {
    this.serviceWiring.initCapacityGuardProviders();
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
  public startHeartbeat(): void {
    // No-op retained for startup wiring compatibility. The settings UI is only
    // available while the app runtime is alive, so a persistent heartbeat setting
    // only creates write churn without adding useful liveness signal.
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
        temperatureBoostSettings: this.temperatureBoostSettings,
        evBoostSettings: this.evBoostSettings,
        nativeEvWiringDevices: this.nativeEvWiringDevices,
        deviceDriverOverrides: this.deviceDriverOverrides,
        deviceControlProfiles: this.deviceControlProfiles,
        deviceTargetPowerConfigs: this.deviceTargetPowerConfigs,
        deviceCommunicationModels: this.deviceCommunicationModels,
        shedBehaviors: this.shedBehaviors,
      },
    });
    this.capacitySettings = next.capacitySettings;
    this.modeAliases = next.modeAliases;
    this.operatingMode = next.operatingMode;
    this.capacityPriorities = next.capacityPriorities;
    this.modeDeviceTargets = next.modeDeviceTargets;
    this.capacityDryRun = next.capacityDryRun;
    this.controllableDevices = next.controllableDevices;
    this.managedDevices = next.managedDevices;
    this.budgetExemptDevices = next.budgetExemptDevices;
    this.temperatureBoostSettings = next.temperatureBoostSettings;
    this.evBoostSettings = next.evBoostSettings;
    this.nativeEvWiringDevices = next.nativeEvWiringDevices;
    this.deviceDriverOverrides = next.deviceDriverOverrides;
    this.deviceControlProfiles = normalizeStoredDeviceControlProfiles(next.deviceControlProfiles) ?? {};
    this.deviceTargetPowerConfigs = next.deviceTargetPowerConfigs;
    this.deviceCommunicationModels = next.deviceCommunicationModels;
    this.shedBehaviors = next.shedBehaviors;
    this.updatePriceOptimizationEnabled();
    void this.updateOverheadToken(this.capacitySettings.marginKw);
  };
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
    return this.planService?.getLatestPlanSnapshotForUi() ?? null;
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
    const resolved = resolveModeNameHelper(rawMode, this.modeAliases);
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
    return (status?.priceLevel || this.planService?.getLastNotifiedPriceLevel() || PriceLevel.UNKNOWN) as PriceLevel;
  }
  private logPeriodicStatus(options: { includeDeviceHealth?: boolean } = {}): void {
    const periodicStatusParams = {
      capacityGuard: this.capacityGuard,
      powerTracker: this.powerTracker,
      capacitySettings: this.capacitySettings,
      operatingMode: this.operatingMode,
      capacityDryRun: this.capacityDryRun,
      starvedDeviceCount: this.deviceDiagnosticsService?.getCurrentStarvedDeviceCount?.() ?? 0,
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
  getCreateSmartTaskCandidateDevices(): DecoratedDeviceSnapshot[] {
    return this.latestTargetSnapshot.filter(isRuntimePlannedDevice);
  }
  // Currently-starved devices for the starvation-rescue widget. Sourced from the
  // diagnostics service's live starvation state (`getStarvedRescueEntries`,
  // which mirrors the overview `getOverviewStarvation` freshness/eligibility
  // gate) and joined against the runtime-planned snapshot for the device name —
  // a starved device is by definition managed + capacity-controlled, so it is in
  // `latestTargetSnapshot`. The `cause` is the producer-resolved flat value; the
  // widget never re-derives it. Entries whose device is no longer in the snapshot
  // (e.g. removed mid-cycle) are dropped rather than shown with a stale name.
  getStarvedRescueDevices(): StarvationRescueDevice[] {
    const entries = this.deviceDiagnosticsService?.getStarvedRescueEntries?.() ?? [];
    // Index the snapshot by id once (O(N+M)) instead of an O(N×M) `find` per
    // entry — the live snapshot can be sizeable on busy installs.
    const snapshotById = new Map<string, TargetDeviceSnapshot>(
      this.latestTargetSnapshot.map((device) => [device.id, device]),
    );
    const devices: StarvationRescueDevice[] = [];
    for (const entry of entries) {
      const device = snapshotById.get(entry.deviceId);
      if (!device) continue;
      devices.push({
        deviceId: entry.deviceId,
        deviceName: device.name,
        cause: entry.starvation.cause,
        accumulatedMs: entry.starvation.accumulatedMs,
        intendedNormalTargetC: entry.intendedNormalTargetC,
        // A device with an open smart task stays VISIBLE in the held-back list
        // but is not rescuable (the widget suppresses its button): the rescue is
        // a fresh one-shot task and must never replace the device's own active
        // or paused future task. A disabled task whose deadline is already in the
        // past no longer blocks rescue; it is history, not an open task.
        hasSmartTask: this.hasDeferredObjectiveForDevice(entry.deviceId),
      });
    }
    return devices;
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
  private getPowerSource = (): PowerSource => normalizePowerSource(this.homey.settings.get(POWER_SOURCE));
  public getNow = (): Date => new Date();
  public findCheapestHours = (count: number): string[] => this.priceCoordinator.findCheapestHours(count);
  public isCurrentHourCheap = (): boolean => this.priceCoordinator.isCurrentHourCheap();
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
  public async getDeviceLoadSetting(deviceId: string): Promise<number | null> {
    return getDeviceLoadSetting({
      deviceId,
      snapshot: this.latestTargetSnapshot,
      error: (...args: unknown[]) => this.error(...args),
    });
  }
  public getPriorityForDevice = (deviceId: string) => (
    this.capacityPriorities[this.operatingMode || 'Home']?.[deviceId] ?? 100
  );
  public resolveModeName = (name: string) => resolveModeNameHelper(name, this.modeAliases);
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
    // A home battery or solar device is managed observe-only: NEVER capacity-controlled,
    // regardless of the settings maps. `controllable: false` is what keeps it out of
    // shed/restore/boost/starvation; combined with its non-temperature class (no
    // `resolvePlannedTarget`) the device is tracked but inert. Secondary (deviceId-only)
    // agreement with the structural parse stamp — see `resolveManagedState` above.
    !this.isObserveOnlyRoleDevice(deviceId)
    && this.managedDevices[deviceId] === true
    && this.controllableDevices[deviceId] === true
  );
  public isBudgetExempt = (deviceId: string) => this.budgetExemptDevices[deviceId] === true;
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
    return this.planService?.getDeviceLogUiPayload() ?? { version: 1, entriesByDeviceId: {} };
  }
  public getDeferredObjectiveActivePlansUiPayload(): ResolvedDeferredObjectiveActivePlansV1 | null {
    const snapshot = this.deferredObjectiveActivePlanRecorder?.getActivePlansSnapshot() ?? null;
    if (snapshot === null) return null;
    // Stitch live in-progress trajectory (start progress + observed samples)
    // onto the snapshot for the smart-tasks widget chart. UI-only — never
    // persisted (see the assembler + the field doc on the contract).
    return assembleActivePlansWithTrajectory(snapshot, this.deferredObjectivePlanHistoryRecorder);
  }
  // Hidden weather-insight readout (null = flag off → structural UI absence).
  public getWeatherAdvisorReadout(): Promise<WeatherAdvisorReadoutPayload | null> {
    return assembleWeatherAdvisorReadout({ ctx: this.ctx, collector: this.weatherCollector });
  }
  // Read the device's currently-persisted deferred objective, or undefined when
  // none is stored. Backs `hasDeferredObjectiveForDevice`.
  private readDeferredObjectiveEntry(deviceId: string): DeferredObjectiveSettingsEntry | undefined {
    return readObjectiveForDevice(this.homey.settings, deviceId);
  }
  // Whether the device currently has an open deferred objective (a smart task).
  // Enabled entries always count; disabled future entries also count because the
  // user has paused a still-open task. Disabled past entries do not count — they
  // are completed/abandoned history and must not suppress a fresh held-back
  // rescue forever.
  public hasDeferredObjectiveForDevice(deviceId: string): boolean {
    const entry = this.readDeferredObjectiveEntry(deviceId);
    if (!entry) return false;
    return entry.enabled || entry.deadlineAtMs > this.getNow().getTime();
  }
  // Only stepped-load devices (EV chargers + stepped thermal) can honour the
  // `limitLowerPriorityDevices` rescue permission — it engages the device's boost,
  // which the boost resolvers gate on `isSteppedLoad`; a binary on/off device has
  // no higher step to promote to. The rescue gates the grant on this so it never
  // persists (nor surfaces) a permission the device can't use.
  private deviceSupportsLimitLowerPriority(device: TargetDeviceSnapshot & SteppedLoadDescriptorProbe): boolean {
    return device.controlModel === 'stepped_load' && isSteppedLoadSnapshot(device);
  }
  // Gate a create-smart-task candidate's opt-in "Extra permissions" against the
  // device BEFORE it is previewed or persisted — defence-in-depth, since the
  // widget's toggle visibility is client-side and not trusted. Only
  // `limitLowerPriorityDevices` is gated; `exemptFromBudget` is ungated (any
  // device can exceed the soft daily budget). The limit grant is dropped unless
  // it would ACTUALLY change the plan — i.e. it matches every conjunct of the
  // planner's `fullyReserved` floor (`rescueReplan.ts`): the device is
  // stepped-load eligible (a binary device has no higher step to promote to) AND
  // at top priority (`priority === 1`) AND `exemptFromBudget` is granted as
  // `'always'`. Anything weaker is inert at the planner, so we never persist it.
  // This matches the widget's gate-on-effect visibility exactly, and runs on BOTH
  // lanes so preview ≡ persist. Returns the candidate unchanged when it carries
  // no limit-lower-priority grant.
  private gateCandidateExtraPermissions(
    device: (TargetDeviceSnapshot & SteppedLoadDescriptorProbe) | undefined,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): DeferredObjectivePlanPreviewCandidate {
    const rescue = candidate.rescue;
    if (!rescue?.limitLowerPriorityDevices) return candidate;
    const eligible = device !== undefined
      && this.deviceSupportsLimitLowerPriority(device)
      && device.priority === 1
      && rescue.exemptFromBudget === 'always';
    if (eligible) return candidate;
    const { limitLowerPriorityDevices: _dropped, ...keptRescue } = rescue;
    return {
      ...candidate,
      rescue: Object.keys(keptRescue).length > 0 ? keptRescue : undefined,
    };
  }
  // Preview the plan the starvation rescue would actually persist. A rescue only
  // ever runs on a device WITHOUT an existing smart task (`getStarvedRescueDevices`
  // excludes task-having devices), so there is no merge: the fresh candidate IS
  // what persists. This therefore just REUSES the create engine's preview
  // (`previewDeferredObjectivePlan`), which applies the same
  // `gateCandidateExtraPermissions` the create write does — so preview ≡ persist
  // for the rescue's opt-in permissions without any rescue-specific merge logic.
  // `hasExistingObjective` is always false (kept on the return for the widget's
  // stable shape).
  public previewStarvationRescuePlan(
    deviceId: string,
    freshRescueCandidate: DeferredObjectivePlanPreviewCandidate,
  ): { estimate: DeferredObjectivePlanPreviewEstimate; deadlineAtMs: number; hasExistingObjective: boolean } {
    return {
      estimate: this.previewDeferredObjectivePlan(deviceId, freshRescueCandidate),
      deadlineAtMs: freshRescueCandidate.deadlineAtMs,
      hasExistingObjective: false,
    };
  }
  // Instant, in-isolation estimate of the plan the planner WOULD produce for a
  // candidate deferred objective that is not persisted. Gathers the same plan-
  // cycle context the live recorder runs against (device snapshot, power
  // tracker, daily-budget snapshot, hard cap, prices) so the projection stays
  // faithful — see `previewDeferredObjectivePlan`.
  //
  // STRICTLY READ-ONLY: this never mutates live planner state. The candidate
  // device is projected through `toPlanDevice`, a pure read projection with no
  // live-state mutation.
  //
  // NOT A GUARANTEE — and specifically OPTIMISTIC about headroom: the
  // projection assumes the candidate has the price bucket's reserved headroom
  // to ITSELF (it passes `activePlans: null` and lets `concurrentEligibleCount`
  // default to 1). When other reserved sibling tasks are competing for the same
  // buckets, the live plan may schedule fewer or later hours than this estimate
  // shows, so the divergence is toward overstating availability / understating
  // `cannot_meet` risk. A UI must present this as an estimate, never a
  // commitment.
  public previewDeferredObjectivePlan(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): DeferredObjectivePlanPreviewEstimate {
    // The settings-UI device list spans managed devices AND unmanaged-but-
    // eligible picker devices (see `getSettingsUiDevices`). A preview is most
    // useful precisely for a candidate that is not managed yet, so fall back to
    // the picker snapshot before treating the device as missing — otherwise
    // every new-smart-task preview would come back `unavailable`.
    const snapshotDevice = this.latestTargetSnapshot.find((device) => device.id === deviceId)
      ?? this.getUiPickerDevices().find((device) => device.id === deviceId);
    // Gate opt-in extra permissions the same way the create lane does, so the
    // preview reflects exactly what would persist (preview ≡ persist).
    const gatedCandidate = this.gateCandidateExtraPermissions(snapshotDevice, candidate);
    return previewDeferredObjectivePlan({
      nowMs: this.getNow().getTime(),
      timeZone: this.getTimeZone(),
      deviceId,
      candidate: gatedCandidate,
      // Convert through the same `toPlanDevice` producer the plan cycle uses so
      // the projected steps/power match the live planner. `toPlanDevice` is a
      // pure read projection (no live-state mutation), so the preview is
      // read-only by construction. Undefined when the device is in neither
      // snapshot → projection comes back `unavailable`.
      device: snapshotDevice ? toPlanDevice(this.ctx, snapshotDevice) : undefined,
      powerTracker: this.powerTracker,
      dailyBudgetSnapshot: this.dailyBudgetService?.getSnapshot() ?? null,
      buildPriceHorizon: createObjectivePriceHorizonBuilder(this.ctx),
      priceOptimizationEnabled: this.priceOptimizationEnabled,
      hardCapKw: this.capacitySettings.limitKw,
      // The price store exposes a per-kWh RATE label; `previewDeferredObjectivePlan`
      // converts it to a money unit for the total `costEstimate`.
      priceRateLabel: this.priceCoordinator.getPriceUnitLabel(),
    });
  }
  // Persist a new smart task (deferred objective) for an eligible device,
  // routing through the SAME device-scoped write op the deadline Flow cards use
  // (`upsertObjectiveForDevice` over the per-device-key store, built by
  // `buildDeferredObjectiveDeviceWriteDeps`). There is no parallel
  // persistence path: the candidate is validated through the same
  // `normalizeDeferredObjectiveSettingsEntry` normalizer that gates Flow-card
  // and settings writes, and the device's eligibility/kind is checked against
  // the live snapshot the same way the Flow cards check it.
  //
  // PLANNED-SET HONESTY: persistence is restricted to devices in
  // `latestTargetSnapshot` — the managed, runtime-planned set. The planner only
  // evaluates objectives whose device is in that snapshot (see
  // `buildDeferredObjectiveDiagnostics`: a missing device yields
  // `objective_missing_device` and is never planned). When the managed-device
  // filter is active, a picker-only (unmanaged) device is absent from the
  // snapshot, so creating a task on it would persist a task that never plans or
  // controls anything. The Flow-card create path is already honest here — its
  // device autocomplete is sourced from the same runtime snapshot — so to match
  // it we reject picker-only devices with `device_not_planned` rather than
  // inventing a promotion mechanism neither path has. (The preview at
  // `previewDeferredObjectivePlan` keeps its picker fallback: previewing an
  // unmanaged device is harmless and read-only.)
  //
  // The candidate's `deadlineAtMs` is resolved by the caller (the widget API
  // handler, server-side, via `resolveDeferredObjectiveDeadline` against the
  // app timezone) so this method stays timezone-agnostic and matches the
  // Flow-card contract of receiving an already-absolute deadline.
  //
  // Returns `{ ok: false }` with a stable reason code on rejection so the
  // widget can surface an honest error without leaking internal detail.
  // Shared validation for both objective-write lanes (`createDeferredObjective`
  // and `rescueDeviceWithBudgetExemption`): resolve the candidate against the
  // runtime-planned snapshot, the device's goal kind, and the device's actual
  // setpoint range, then normalise it through the canonical normalizer. Returns
  // the validated device + normalised entry, or a stable rejection reason. Both
  // callers share this so the device honesty / kind / bounds / normalizer gates
  // never diverge between the two lanes.
  private resolveValidatedObjectiveEntry(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): { ok: true; device: TargetDeviceSnapshot; entry: DeferredObjectiveSettingsEntry } | {
    ok: false;
    reason: 'device_not_found' | 'device_not_planned' | 'device_not_eligible' | 'invalid_candidate';
  } {
    // Persist ONLY against the runtime-planned snapshot — see PLANNED-SET
    // HONESTY above. A device that exists in the picker but not here, OR that is
    // in the runtime snapshot but `managed: false` (so the planner's
    // `isRuntimePlannedDevice` filter drops it — possible when the managed
    // filter is inactive), is reported as `device_not_planned`, not silently
    // persisted. Uses the SAME predicate the plan service and the candidate
    // listing use so the three never diverge.
    const device = this.latestTargetSnapshot.find((entry) => entry.id === deviceId);
    if (!device || !isRuntimePlannedDevice(device)) {
      const inPickerOrSnapshot = device !== undefined
        || this.getUiPickerDevices().some((entry) => entry.id === deviceId);
      return { ok: false, reason: inPickerOrSnapshot ? 'device_not_planned' : 'device_not_found' };
    }
    // The device must support the goal kind the candidate claims — an EV-SoC
    // goal on a thermostat (or vice versa) is rejected before it can persist.
    const kind = resolveSmartTaskDeviceKind(device);
    if (kind !== candidate.kind) {
      return { ok: false, reason: 'device_not_eligible' };
    }
    // Validate the target against the DEVICE's actual setpoint range, not just
    // the generic normalizer's -50..100 °C / 1..100 % envelope. This mirrors the
    // Flow-card `validateTargetTemperature` (which reads the device capability
    // min/max) and the picker bounds the widget itself offered, so the write
    // rejects an impossible target (e.g. 90 °C on a 30..75 °C heater) instead of
    // persisting one the device can never reach.
    const bounds = resolveSmartTaskGoalBounds(device, kind);
    const targetValue = candidate.kind === 'temperature' ? candidate.targetTemperatureC : candidate.targetPercent;
    if (!Number.isFinite(targetValue) || targetValue < bounds.min || targetValue > bounds.max) {
      return { ok: false, reason: 'invalid_candidate' };
    }
    // Gate opt-in extra permissions against the resolved device before the entry
    // is normalised/persisted (drops an ineligible/inert limit-lower-priority
    // grant), so a tampered or stale client can never persist a permission this
    // device can't honour. Matches the gate the preview applies.
    const gatedCandidate = this.gateCandidateExtraPermissions(device, candidate);
    // Re-validate via the canonical normalizer with `enabled: true`; a creation
    // is implicitly an enabled objective. This rejects malformed deadlines and
    // the generic target envelope exactly as the Flow-card / settings paths do.
    const entry = normalizeDeferredObjectiveSettingsEntry(
      { ...gatedCandidate, enabled: true } as DeferredObjectiveSettingsEntry,
    );
    if (!entry) return { ok: false, reason: 'invalid_candidate' };
    return { ok: true, device, entry };
  }
  public createDeferredObjective(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): { ok: true } | {
    ok: false;
    reason: 'device_not_found' | 'device_not_planned' | 'device_not_eligible' | 'invalid_candidate'
      | 'write_refused';
  } {
    const validated = this.resolveValidatedObjectiveEntry(deviceId, candidate);
    if (!validated.ok) return validated;
    const { device, entry } = validated;

    if (!this.deferredObjectivePlanHistoryRecorder || !this.deferredObjectiveActivePlanRecorder) {
      return { ok: false, reason: 'invalid_candidate' };
    }

    // Per-device-key write: touches only this device's settings key, so it
    // cannot drop a sibling task. When the candidate carries opt-in "Extra
    // permissions" (already eligibility-gated above), the entry's own `rescue` is
    // persisted as-is. When it does not, the default `preserve` policy keeps a
    // standing permission set elsewhere (e.g. by the budget-exempt rescue lane,
    // `rescueDeviceWithBudgetExemption`) intact rather than wiping it. The write
    // can still REFUSE on a transient un-confirmable migration or an untrustworthy
    // absence read; surface that as a retryable failure instead of a false
    // success so the widget can re-offer the create.
    const outcome = upsertObjectiveForDevice(
      buildDeferredObjectiveDeviceWriteDeps(this.ctx, {
        nowMs: this.getNow().getTime(),
        rebuildReason: 'flow_card:create_smart_task_widget',
      }),
      { deviceId, deviceName: device.name ?? null, entry },
    );
    if (!outcome.persisted) return { ok: false, reason: 'write_refused' };
    return { ok: true };
  }
  // Grant a device the starvation-rescue widget's bounded budget-exempt rescue.
  // A rescue is always a FRESH task: `getStarvedRescueDevices` only offers a
  // device that has no smart task yet (and this method re-asserts it), so there
  // is no merge — the rescue REUSES the create engine (`createDeferredObjective`).
  // The candidate carries the rescue permissions (`exemptFromBudget` always, plus
  // `limitLowerPriorityDevices`); `createDeferredObjective`'s
  // `gateCandidateExtraPermissions` then keeps the budget exemption for any device
  // and the limit-lower-priority grant only where it has effect (stepped + top
  // priority). This lifts the DAILY BUDGET and (where effective) grants priority
  // over lower-priority devices, but NEVER raises the physical capacity cap (the
  // hard cap is physical): the priority permission only displaces lower-priority
  // load WITHIN the cap. The budget-exemption assertion is defence-in-depth so it
  // can't be smuggled through a generic create — it doesn't rest solely on the
  // widget API being the only caller.
  public rescueDeviceWithBudgetExemption(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): { ok: true } | {
    ok: false;
    reason: 'device_not_found' | 'device_not_planned' | 'device_not_eligible' | 'invalid_candidate'
      | 'write_refused';
  } {
    // Defence-in-depth (feedback_hard_cap_is_physical): this lane exists only to
    // grant a budget exemption; reject any candidate that does not carry one so
    // the exemption can never be smuggled in through a generic create.
    if (candidate.rescue?.exemptFromBudget !== 'always') {
      return { ok: false, reason: 'invalid_candidate' };
    }
    // Migrate any legacy-blob objective to per-keys BEFORE the eligibility check:
    // a task still only in the un-migrated blob is invisible to the per-key
    // `hasDeferredObjectiveForDevice`, so without this the delegated create would
    // migrate-then-REPLACE it, losing the user's target/deadline. (A transient-
    // empty store defers the migration; the device then still looks task-free
    // here, but `createDeferredObjective`'s own `ensureMigrated` guard refuses the
    // write rather than clobbering — so the user's task is safe either way.)
    migrateBlobToPerKeyIfNeeded(this.homey.settings);
    // A device that already has an open smart task is not rescuable. Re-assert
    // here (the list already excludes it) so this lane can never REPLACE a user's
    // active or paused future task: the rescue is strictly a fresh create.
    if (this.hasDeferredObjectiveForDevice(deviceId)) {
      return { ok: false, reason: 'device_not_eligible' };
    }
    return this.createDeferredObjective(deviceId, candidate);
  }
  private buildPlanHistoryUiPayload(
    accept?: (entry: DeferredObjectivePlanHistoryEntry) => boolean,
  ): SettingsUiDeferredObjectivePlanHistoryPayload {
    const snapshot = this.deferredObjectivePlanHistoryRecorder?.getHistorySnapshot();
    const entriesByDeviceId: SettingsUiDeferredObjectivePlanHistoryPayload['entriesByDeviceId'] = {};
    if (snapshot) {
      // Sort newest finalizedAtMs first within each device to match the UI expectation.
      const byDevice = new Map<string, DeferredObjectivePlanHistoryEntry[]>();
      for (const entry of snapshot.entries) {
        if (accept && !accept(entry)) continue;
        const list = byDevice.get(entry.deviceId) ?? [];
        list.push(entry);
        byDevice.set(entry.deviceId, list);
      }
      for (const [deviceId, list] of byDevice) {
        // Resolve kind-split °C/% pairs to unit-agnostic numbers at this producer boundary.
        entriesByDeviceId[deviceId] = list
          .sort((a, b) => b.finalizedAtMs - a.finalizedAtMs)
          .map(toResolvedPlanHistoryEntry);
      }
    }
    return { version: 1, entriesByDeviceId };
  }

  public getDeferredObjectivePlanHistoryUiPayload(): SettingsUiDeferredObjectivePlanHistoryPayload {
    return this.buildPlanHistoryUiPayload();
  }

  // Bounded variant for the smart-tasks widget: only entries finalized at/after
  // `sinceMs`. The widget refreshes every 60 s and only renders the last 24 h, so
  // serializing the full (unbounded, all-time) history each cycle is wasteful —
  // this keeps the payload proportional to recent activity.
  public getDeferredObjectivePlanHistoryRecentUiPayload(
    sinceMs: number,
  ): SettingsUiDeferredObjectivePlanHistoryPayload {
    return this.buildPlanHistoryUiPayload(
      (entry) => Number.isFinite(entry.finalizedAtMs) && entry.finalizedAtMs >= sinceMs,
    );
  }
  public applyPlanActions = (plan: DevicePlan) => this.planService.applyPlanActions(plan);
  public applySheddingToDevice = (deviceId: string, deviceName: string, reason?: string) =>
    this.planService.applySheddingToDevice(deviceId, deviceName, reason);
}

export = PelsApp;
