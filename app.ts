/* eslint-disable max-lines -- Homey app lifecycle remains centralized in the main app class. */
import Homey from 'homey';
import CapacityGuard from './lib/core/capacityGuard';
import {
  DeviceManager,
  PLAN_LIVE_STATE_OBSERVED_EVENT,
  PLAN_RECONCILE_REALTIME_UPDATE_EVENT,
} from './lib/core/deviceManager';
import { PlanEngine } from './lib/plan/planEngine';
import { DevicePlan, ShedBehavior } from './lib/plan/planTypes';
import { PlanService } from './lib/plan/planService';
import { isPlanConverging } from './lib/plan/planStateHelpers';
import { buildPlanCapacityStateSummary } from './lib/plan/planLogging';
import { HomeyDeviceLike, TargetDeviceSnapshot } from './lib/utils/types';
import { PriceCoordinator } from './lib/price/priceCoordinator';
import { PowerTrackerState } from './lib/core/powerTracker';
import { PriceLevel } from './lib/price/priceLevels';
import { buildPeriodicStatusLogFields } from './lib/core/periodicStatus';
import { getDeviceLoadSetting } from './lib/core/deviceLoad';
import { DailyBudgetService } from './lib/dailyBudget/dailyBudgetService';
import type { DailyBudgetUiPayload } from './lib/dailyBudget/dailyBudgetTypes';
import { type DebugLoggingTopic } from './lib/utils/debugLogging';
import {
  AppDeviceControlHelpers,
  normalizeStoredDeviceControlProfiles,
} from './lib/app/appDeviceControlHelpers';
import {
  getAllModes as getAllModesHelper,
  getShedBehavior as getShedBehaviorHelper,
  resolveModeName as resolveModeNameHelper,
} from './lib/utils/capacityHelpers';
import {
  DEVICE_LAST_CONTROLLED_MS,
  FLOW_REPORTED_DEVICE_CAPABILITIES,
  OPERATING_MODE_SETTING,
} from './lib/utils/settingsKeys';
import { isNumberMap, isPowerTrackerState } from './lib/utils/appTypeGuards';
import {
  cancelPendingPowerRebuild,
  executePendingPowerRebuild,
  persistPowerTrackerStateForApp,
  prunePowerTrackerHistoryForApp,
  updateDailyBudgetAndRecordCapForApp,
  PowerSampleRebuildState,
  recordPowerSampleForApp,
  schedulePlanRebuildFromSignal,
} from './lib/app/appPowerHelpers';
import { PlanRebuildScheduler, type RebuildIntent } from './lib/app/planRebuildScheduler';
import {
  createDeviceDiagnosticsService,
  createPlanEngine,
  createPlanService,
  createPriceCoordinator,
  registerAppFlowCards,
} from './lib/app/appInit';
import type { AppContext, StartupBootstrapConfig } from './lib/app/appContext';
import { buildDebugLoggingTopics } from './lib/app/appLoggingHelpers';
import { initSettingsHandlerForApp, loadCapacitySettingsFromHomey } from './lib/app/appSettingsHelpers';
import {
  disableManagedEvDevices as disableManagedEvDevicesHelper,
  disableUnsupportedDevices as disableUnsupportedDevicesHelper,
} from './lib/app/appDeviceSupport';
import { runStartupStep, startAppServices } from './lib/app/appLifecycleHelpers';
import { addPerfDuration, incPerfCounter } from './lib/utils/perfCounters';
import { startPerfLogger } from './lib/app/perfLogging';
import { VOLATILE_WRITE_THROTTLE_MS } from './lib/utils/timingConstants';
import { startResourceWarningListeners as startResourceWarnings } from './lib/app/appResourceWarningHelpers';
import { migrateManagedDevices as migrateManagedDevicesHelper } from './lib/app/appManagedDeviceMigration';
import { restoreCachedTargetSnapshotForApp } from './lib/app/appStartupHelpers';
import { startPriceLowestTriggerChecker as startPriceLowestTriggers } from './lib/app/appPriceLowestTrigger';
import * as realtimeReconcile from './lib/app/appRealtimeDeviceReconcile';
import {
  createRootLogger,
  type Logger as PinoLogger,
  type StructuredDebugEmitter,
} from './lib/logging/logger';
import { createHomeyDestination } from './lib/logging/homeyDestination';
import { normalizeError } from './lib/utils/errorUtils';
import { scheduleAppRealtimeDeviceReconcile } from './lib/app/appRealtimeDeviceReconcileRuntime';
import { logHomeyDeviceComparisonForDebugFromApp } from './lib/app/appDebugHelpers';
import type { ObservedDeviceStateEvent } from './lib/core/deviceManagerRealtimeHandlers';
import { emitSettingsUiPowerUpdatedForApp } from './lib/app/settingsUiAppRuntime';
import type { DeviceDiagnosticsService } from './lib/diagnostics/deviceDiagnosticsService';
import type { SettingsUiDeviceDiagnosticsPayload } from './packages/contracts/src/deviceDiagnosticsTypes';
import type { DeviceControlProfiles } from './lib/utils/types';
import { AppHomeyEnergyHelpers } from './lib/app/appHomeyEnergyHelpers';
import {
  AppSnapshotHelpers,
  type RefreshTargetDevicesSnapshotOptions,
} from './lib/app/appSnapshotHelpers';
import { TimerRegistry } from './lib/app/timerRegistry';
import {
  getFlowReportedDeviceIds,
  parseFlowReportedCapabilities,
  upsertFlowReportedCapability,
  type FlowReportedCapabilityId,
  type FlowReportedCapabilitiesByDevice,
  type FlowReportedCapabilitiesForDevice,
} from './lib/core/flowReportedCapabilities';
const POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 2000;
// Let non-urgent power deltas settle before rebuilding the full plan again.
const POWER_SAMPLE_REBUILD_STABLE_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 15000;
const POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 100 : 30 * 1000;
const FLOW_REBUILD_COOLDOWN_MS = 1000;
const STARTUP_RESTORE_STABILIZATION_MS = 60 * 1000;
const POWER_TRACKER_PRUNE_INITIAL_DELAY_MS = 10 * 1000; const POWER_TRACKER_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const POWER_TRACKER_PERSIST_DELAY_MS = VOLATILE_WRITE_THROTTLE_MS;
type PriceOptimizationSettings = Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
const getAppPlanRebuildNowMs = (): number => (
  process.env.NODE_ENV === 'test'
  || typeof performance === 'undefined'
  || typeof performance.now !== 'function'
    ? Date.now()
    : performance.now()
);

class PelsApp extends Homey.App {
  private powerTracker: PowerTrackerState = {};
  private capacityGuard?: CapacityGuard;
  private capacitySettings = { limitKw: 10, marginKw: 0.2 };
  private capacityDryRun = true;
  private operatingMode = 'Home';
  private modeAliases: Record<string, string> = {};
  private capacityPriorities: Record<string, Record<string, number>> = {};
  private modeDeviceTargets: Record<string, Record<string, number>> = {};
  private controllableDevices: Record<string, boolean> = {};
  private managedDevices: Record<string, boolean> = {};
  private budgetExemptDevices: Record<string, boolean> = {};
  private flowReportedCapabilities: FlowReportedCapabilitiesByDevice = {};
  private deviceControlProfiles: DeviceControlProfiles = {};
  private deviceCommunicationModels: Record<string, 'local' | 'cloud'> = {};
  private experimentalEvSupportEnabled = false;
  private shedBehaviors: Record<string, ShedBehavior> = {};
  private debugLoggingTopics = new Set<DebugLoggingTopic>();
  private dailyBudgetService!: DailyBudgetService;
  private deviceDiagnosticsService!: DeviceDiagnosticsService;
  private priceCoordinator!: PriceCoordinator;
  private deviceManager!: DeviceManager;
  private planEngine!: PlanEngine;
  private planService!: PlanService;
  private defaultComputeDynamicSoftLimit?: () => number;
  private lastKnownPowerKw: Record<string, number> = {};
  private expectedPowerKwOverrides: Record<string, { kw: number; ts: number }> = {};
  private overheadToken?: Homey.FlowToken;
  private lastMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
  private lastNotifiedOperatingMode = 'Home';
  private powerSampleRebuildState: PowerSampleRebuildState = { lastMs: 0 };
  private readonly planRebuildScheduler = new PlanRebuildScheduler({
    getNowMs: getAppPlanRebuildNowMs,
    resolveDueAtMs: (intent, state) => this.resolvePlanRebuildDueAtMs(intent, state),
    executeIntent: (intent) => this.executePlanRebuildIntent(intent),
    shouldExecuteImmediately: (intent) => intent.kind !== 'flow',
    onIntentDropped: (dropped, kept) => this.onPlanRebuildIntentDropped(dropped, kept),
    onPendingIntentReplaced: (previous, next) => this.onPlanRebuildPendingIntentReplaced(previous, next),
    onIntentCancelled: (intent, reason) => this.onPlanRebuildIntentCancelled(intent, reason),
    onIntentError: (intent, error) => this.onPlanRebuildIntentError(intent, error),
  });
  private powerSampleLoop?: Promise<void>;
  private powerSampleRerunRequested = false;
  private pendingPowerSampleRequest?: { currentPowerW: number; nowMs: number };
  private realtimeDeviceReconcileState = realtimeReconcile.createRealtimeDeviceReconcileState();
  private stopPriceLowestTriggerChecker?: () => void;
  private stopPerfLogging?: () => void;
  private stopResourceWarningListeners?: () => void;
  private stopSettingsHandler?: () => void;
  private structuredLogger?: PinoLogger;
  private readonly timers = new TimerRegistry();
  private readonly snapshotHelpers = new AppSnapshotHelpers({
    homey: this.homey,
    timers: this.timers,
    getDeviceManager: () => this.deviceManager,
    getPlanEngine: () => this.planEngine,
    getPlanService: () => this.planService,
    getLatestTargetSnapshot: () => this.latestTargetSnapshot,
    resolveManagedState: (deviceId) => this.resolveManagedState(deviceId),
    isCapacityControlEnabled: (deviceId) => this.isCapacityControlEnabled(deviceId),
    getStructuredLogger: (component) => this.getStructuredLogger(component),
    logDebug: (topic, ...args) => this.logDebug(topic, ...args),
    error: (...args) => this.error(...args),
    getNow: () => this.getNow(),
    logPeriodicStatus: (options) => this.logPeriodicStatus(options),
    disableUnsupportedDevices: (snapshot) => disableUnsupportedDevicesHelper({
      snapshot,
      settings: this.homey.settings,
      logDebug: (...args: unknown[]) => this.logDebug('devices', ...args),
    }),
    getFlowReportedDeviceIds: () => this.getFlowReportedDeviceIds(),
    emitFlowBackedRefreshRequests: async (deviceIds) => this.emitFlowBackedRefreshRequests(deviceIds),
    recordPowerSample: async (powerW) => this.recordPowerSample(powerW),
  });
  private readonly homeyEnergyHelpers = new AppHomeyEnergyHelpers({
    homey: this.homey,
    timers: this.timers,
    getDeviceManager: () => this.deviceManager,
    recordPowerSample: async (powerW) => this.recordPowerSample(powerW),
    logDebug: (topic, ...args) => this.logDebug(topic, ...args),
    error: (...args) => this.error(...args),
  });
  private readonly deviceControlHelpers = new AppDeviceControlHelpers({
    getProfiles: () => this.deviceControlProfiles,
    getDeviceSnapshots: () => this.deviceManager?.getSnapshot() ?? [],
    getStructuredLogger: (component) => this.getStructuredLogger(component),
    logDebug: (topic, ...args) => this.logDebug(topic, ...args),
  });
  private readonly ctx = this.createAppContext(this);
  private static readonly EXPECTED_OVERRIDE_EQUALS_EPSILON_KW = 0.000001;
  private setExpectedOverride(deviceId: string, kw: number): boolean {
    if (this.deviceControlHelpers.getSteppedLoadProfile(deviceId)) {
      throw new Error(
        'Stepped load devices use configured planning power per step; '
        + 'expected power override is not supported.',
      );
    }
    const existing = this.expectedPowerKwOverrides[deviceId];
    if (typeof existing?.kw === 'number' && Math.abs(existing.kw - kw) <= PelsApp.EXPECTED_OVERRIDE_EQUALS_EPSILON_KW) {
      return false;
    }
    this.expectedPowerKwOverrides[deviceId] = { kw, ts: Date.now() };
    this.planService?.syncHeadroomCardTrackedUsage({
      deviceId,
      trackedKw: kw,
      trackedKwSource: 'expectedPowerKw',
    });
    return true;
  }

  private loadFlowReportedCapabilities(): void {
    this.flowReportedCapabilities = parseFlowReportedCapabilities(
      this.homey.settings.get(FLOW_REPORTED_DEVICE_CAPABILITIES) as unknown,
    );
  }

  private getFlowReportedCapabilitiesForDevice = (deviceId: string): FlowReportedCapabilitiesForDevice => (
    this.flowReportedCapabilities[deviceId] ?? {}
  );

  private getFlowReportedDeviceIds = (): string[] => getFlowReportedDeviceIds(this.flowReportedCapabilities);

  private reportFlowBackedCapability(params: {
    deviceId: string;
    capabilityId: FlowReportedCapabilityId;
    value: boolean | number | string;
  }): 'changed' | 'unchanged' {
    const result = upsertFlowReportedCapability({
      state: this.flowReportedCapabilities,
      deviceId: params.deviceId,
      capabilityId: params.capabilityId,
      value: params.value,
    });
    this.homey.settings.set(FLOW_REPORTED_DEVICE_CAPABILITIES, this.flowReportedCapabilities);
    return result;
  }

  private async getHomeyDevicesForFlow(): Promise<HomeyDeviceLike[]> {
    return this.deviceManager?.getDevicesForDebug() ?? [];
  }

  private async emitFlowBackedRefreshRequests(deviceIds: string[]): Promise<void> {
    if (deviceIds.length === 0) return;
    const card = this.homey.flow?.getTriggerCard?.('flow_backed_device_refresh_requested');
    if (!card?.trigger) return;

    const seen = new Set<string>();
    const triggers: Array<Promise<unknown>> = [];
    for (const rawDeviceId of deviceIds) {
      const deviceId = rawDeviceId.trim();
      if (!deviceId || seen.has(deviceId)) continue;
      seen.add(deviceId);
      triggers.push(card.trigger({}, { deviceId }));
    }
    if (triggers.length > 0) {
      await Promise.all(triggers);
    }
  }

  // eslint-disable-next-line max-lines-per-function -- Context assembly is intentionally centralized here.
  private createAppContext(app: PelsApp): AppContext {
    const appRef = app;
    return {
      startupBootstrap: undefined,
      homey: app.homey,
      log: (...args: unknown[]) => app.log(...args),
      error: (...args: unknown[]) => app.error(...args),
      logDebug: (topic, ...args) => app.logDebug(topic, ...args),
      getStructuredLogger: (component) => app.getStructuredLogger(component),
      getStructuredDebugEmitter: (component, debugTopic) => app.getStructuredDebugEmitter(component, debugTopic),
      getNow: () => app.getNow(),
      getTimeZone: () => app.getTimeZone(),
      notifyOperatingModeChanged: (mode) => app.notifyOperatingModeChanged(mode),
      loadPowerTracker: (options) => app.loadPowerTracker(options),
      loadCapacitySettings: () => app.loadCapacitySettings(),
      loadPriceOptimizationSettings: () => app.loadPriceOptimizationSettings(),
      updatePriceOptimizationEnabled: (logChange) => app.updatePriceOptimizationEnabled(logChange),
      updateDebugLoggingEnabled: (logChange) => app.updateDebugLoggingEnabled(logChange),
      updateOverheadToken: (value) => app.updateOverheadToken(value),
      registerFlowCards: () => app.registerFlowCards(),
      refreshTargetDevicesSnapshot: (options) => app.refreshTargetDevicesSnapshot(options),
      recordPowerSample: (powerW, nowMs) => app.recordPowerSample(powerW, nowMs),
      startHeartbeat: () => app.startHeartbeat(),
      handleOperatingModeChange: (rawMode) => app.handleOperatingModeChange(rawMode),
      getFlowSnapshot: () => app.getFlowSnapshot(),
      getCurrentPriceLevel: () => app.getCurrentPriceLevel(),
      isCurrentHourCheap: () => app.isCurrentHourCheap(),
      isCurrentHourExpensive: () => app.isCurrentHourExpensive(),
      getDeviceLoadSetting: (deviceId) => app.getDeviceLoadSetting(deviceId),
      setExpectedOverride: (deviceId, kw) => app.setExpectedOverride(deviceId, kw),
      storeFlowPriceData: (kind, raw) => app.storeFlowPriceData(kind, raw),
      loadDailyBudgetSettings: () => app.dailyBudgetService.loadSettings(),
      updateDailyBudgetState: (options) => app.updateDailyBudgetAndRecordCap(options),
      disableManagedEvDevices: () => app.disableManagedEvDevices(),
      requestFlowPlanRebuild: (source) => app.planRebuildScheduler.request({
        kind: 'flow',
        reason: `flow_card:${source}`,
      }),
      getFlowReportedCapabilitiesForDevice: (deviceId) => app.getFlowReportedCapabilitiesForDevice(deviceId),
      getFlowReportedDeviceIds: () => app.getFlowReportedDeviceIds(),
      reportFlowBackedCapability: (params) => app.reportFlowBackedCapability(params),
      getHomeyDevicesForFlow: () => app.getHomeyDevicesForFlow(),
      emitFlowBackedRefreshRequests: async (deviceIds) => app.emitFlowBackedRefreshRequests(deviceIds),
      getPriorityForDevice: (deviceId) => app.getPriorityForDevice(deviceId),
      resolveModeName: (name) => app.resolveModeName(name),
      getAllModes: () => app.getAllModes(),
      resolveManagedState: (deviceId) => app.resolveManagedState(deviceId),
      getCommunicationModel: (deviceId) => app.getCommunicationModel(deviceId),
      isCapacityControlEnabled: (deviceId) => app.isCapacityControlEnabled(deviceId),
      isBudgetExempt: (deviceId) => app.isBudgetExempt(deviceId),
      getShedBehavior: (deviceId) => app.getShedBehavior(deviceId),
      computeDynamicSoftLimit: () => app.computeDynamicSoftLimit(),
      getDynamicSoftLimitOverride: () => app.getDynamicSoftLimitOverride(),
      logTargetRetryComparison: async (params) => {
        await logHomeyDeviceComparisonForDebugFromApp({
          app,
          deviceId: params.deviceId,
          reason: `target_retry:${params.skipContext}:${params.targetCap}`,
          expectedTarget: params.desired,
          observedTarget: params.observedValue,
          observedSource: params.observedSource,
        });
      },
      syncLivePlanStateAfterTargetActuation: (source) => app.planService?.syncLivePlanStateInline(source) ?? false,
      evaluateHeadroomForDevice: (params) => app.planService.evaluateHeadroomForDevice(params),
      getCombinedHourlyPrices: () => app.getCombinedHourlyPrices(),
      getDailyBudgetUiPayload: () => app.getDailyBudgetUiPayload(),
      getLatestPlanSnapshotForUi: () => app.getLatestPlanSnapshotForUi(),
      get powerTracker() { return app.powerTracker; },
      set powerTracker(value) { appRef.powerTracker = value; },
      get capacitySettings() { return app.capacitySettings; },
      set capacitySettings(value) { appRef.capacitySettings = value; },
      get capacityDryRun() { return app.capacityDryRun; },
      set capacityDryRun(value) { appRef.capacityDryRun = value; },
      get operatingMode() { return app.operatingMode; },
      set operatingMode(value) { appRef.operatingMode = value; },
      get modeAliases() { return app.modeAliases; },
      set modeAliases(value) { appRef.modeAliases = value; },
      get capacityPriorities() { return app.capacityPriorities; },
      set capacityPriorities(value) { appRef.capacityPriorities = value; },
      get modeDeviceTargets() { return app.modeDeviceTargets; },
      set modeDeviceTargets(value) { appRef.modeDeviceTargets = value; },
      get controllableDevices() { return app.controllableDevices; },
      set controllableDevices(value) { appRef.controllableDevices = value; },
      get managedDevices() { return app.managedDevices; },
      set managedDevices(value) { appRef.managedDevices = value; },
      get budgetExemptDevices() { return app.budgetExemptDevices; },
      set budgetExemptDevices(value) { appRef.budgetExemptDevices = value; },
      get deviceControlProfiles() { return app.deviceControlProfiles; },
      set deviceControlProfiles(value) { appRef.deviceControlProfiles = value; },
      get deviceCommunicationModels() { return app.deviceCommunicationModels; },
      set deviceCommunicationModels(value) { appRef.deviceCommunicationModels = value; },
      get experimentalEvSupportEnabled() { return app.experimentalEvSupportEnabled; },
      set experimentalEvSupportEnabled(value) { appRef.experimentalEvSupportEnabled = value; },
      get shedBehaviors() { return app.shedBehaviors; },
      set shedBehaviors(value) { appRef.shedBehaviors = value; },
      get debugLoggingTopics() { return app.debugLoggingTopics; },
      set debugLoggingTopics(value) { appRef.debugLoggingTopics = value; },
      get defaultComputeDynamicSoftLimit() { return app.defaultComputeDynamicSoftLimit; },
      set defaultComputeDynamicSoftLimit(value) { appRef.defaultComputeDynamicSoftLimit = value; },
      get lastKnownPowerKw() { return app.lastKnownPowerKw; },
      get expectedPowerKwOverrides() { return app.expectedPowerKwOverrides; },
      get lastMeasuredPowerKw() { return app.lastMeasuredPowerKw; },
      get lastNotifiedOperatingMode() { return app.lastNotifiedOperatingMode; },
      set lastNotifiedOperatingMode(value) { appRef.lastNotifiedOperatingMode = value; },
      get powerSampleRebuildState() { return app.powerSampleRebuildState; },
      set powerSampleRebuildState(value) { appRef.powerSampleRebuildState = value; },
      get latestTargetSnapshot() { return app.latestTargetSnapshot; },
      get priceOptimizationEnabled() { return app.priceOptimizationEnabled; },
      get priceOptimizationSettings() { return app.priceOptimizationSettings; },
      get capacityGuard() { return app.capacityGuard; },
      set capacityGuard(value) { appRef.capacityGuard = value; },
      get dailyBudgetService() { return app.dailyBudgetService; },
      set dailyBudgetService(value) { appRef.dailyBudgetService = value; },
      get deviceDiagnosticsService() { return app.deviceDiagnosticsService; },
      set deviceDiagnosticsService(value) { appRef.deviceDiagnosticsService = value; },
      get priceCoordinator() { return app.priceCoordinator; },
      set priceCoordinator(value) { appRef.priceCoordinator = value; },
      get deviceManager() { return app.deviceManager; },
      set deviceManager(value) { appRef.deviceManager = value; },
      get planEngine() { return app.planEngine; },
      set planEngine(value) { appRef.planEngine = value; },
      get planService() { return app.planService; },
      set planService(value) { appRef.planService = value; },
      planRebuildScheduler: app.planRebuildScheduler,
      snapshotHelpers: app.snapshotHelpers,
      homeyEnergyHelpers: app.homeyEnergyHelpers,
      deviceControlHelpers: app.deviceControlHelpers,
      timers: app.timers,
    };
  }

  async onInit() {
    const deferStartupBootstrap = process.env.NODE_ENV !== 'test' || process.env.PELS_ASYNC_STARTUP === '1';
    const logStartupStepFailure = (label: string, error: Error): void => {
      this.structuredLogger?.child({ component: 'startup' }).error({
        event: 'startup_step_failed',
        reasonCode: 'startup_step_failed',
        stepLabel: label,
        err: normalizeError(error),
      });
    };
    this.structuredLogger = createRootLogger(
      createHomeyDestination({ log: (...a) => this.log(...a), error: (...a) => this.error(...a) }),
    );
    this.structuredLogger.child({ component: 'startup' }).info({ event: 'app_initialized' });
    this.startResourceWarningListeners();
    await runStartupStep('updateDebugLoggingEnabled', () => this.updateDebugLoggingEnabled(), logStartupStepFailure);
    this.startPerfLogging();
    await runStartupStep('initPriceCoordinator', () => this.initPriceCoordinator(), logStartupStepFailure);
    await runStartupStep('migrateManagedDevices', () => this.migrateManagedDevices(), logStartupStepFailure);
    await runStartupStep('loadCapacitySettings', () => this.loadCapacitySettings(), logStartupStepFailure);
    await runStartupStep('initDailyBudgetService', () => this.initDailyBudgetService(), logStartupStepFailure);
    await runStartupStep(
      'loadFlowReportedCapabilities',
      () => this.loadFlowReportedCapabilities(),
      logStartupStepFailure,
    );
    await runStartupStep(
      'initDeviceDiagnosticsService',
      () => this.initDeviceDiagnosticsService(),
      logStartupStepFailure,
    );
    await runStartupStep('initDeviceManager', () => this.initDeviceManager(), logStartupStepFailure);
    const hasCachedTargetSnapshot = restoreCachedTargetSnapshotForApp({
      homey: this.homey,
      deviceManager: this.deviceManager,
      logDebug: (...args: unknown[]) => this.logDebug('devices', ...args),
      filterEntry: (entry) => this.experimentalEvSupportEnabled || entry.deviceClass !== 'evcharger',
    });
    let snapshotPlanBootstrapDelayMs = 0;
    if (deferStartupBootstrap) {
      snapshotPlanBootstrapDelayMs = hasCachedTargetSnapshot ? 300 : 1200;
    }
    const startupBootstrap: StartupBootstrapConfig = {
      snapshotPlanBootstrapDelayMs,
      runSnapshotPlanBootstrapInBackground: deferStartupBootstrap,
      runPriceBootstrapInBackground: deferStartupBootstrap,
      applyPriceOptimizationImmediatelyOnStart: !deferStartupBootstrap,
    };
    this.ctx.startupBootstrap = startupBootstrap;
    await runStartupStep('initCapacityGuard', () => this.initCapacityGuard(), logStartupStepFailure);
    await runStartupStep('initPlanEngine', () => this.initPlanEngine(), logStartupStepFailure);
    await runStartupStep('initPlanService', () => this.initPlanService(), logStartupStepFailure);
    await runStartupStep('initCapacityGuardProviders', () => this.initCapacityGuardProviders(), logStartupStepFailure);
    await runStartupStep('initSettingsHandler', () => this.initSettingsHandler(), logStartupStepFailure);
    this.lastNotifiedOperatingMode = this.operatingMode;
    await runStartupStep('startAppServices', () => startAppServices(this.ctx), logStartupStepFailure);
    await runStartupStep(
      'startPriceLowestTriggerChecker',
      () => this.startPriceLowestTriggerChecker(),
      logStartupStepFailure,
    );
    await runStartupStep('startPowerTrackerPruning', () => this.startPowerTrackerPruning(), logStartupStepFailure);
  }
  private initPriceCoordinator(): void {
    this.priceCoordinator = createPriceCoordinator(this.ctx);
  }
  private initDailyBudgetService(): void {
    this.dailyBudgetService = new DailyBudgetService({
      homey: this.homey,
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (...args: unknown[]) => this.logDebug('daily_budget', ...args),
      error: (...args: unknown[]) => this.error(...args),
      getPowerTracker: () => this.powerTracker,
      getPriceOptimizationEnabled: () => this.priceOptimizationEnabled,
      getCapacitySettings: () => this.capacitySettings,
      structuredLog: this.structuredLogger?.child({ component: 'daily_budget' }),
    });
    this.dailyBudgetService.loadSettings();
    this.dailyBudgetService.loadState();
  }
  private async initDeviceManager(): Promise<void> {
    this.deviceManager = new DeviceManager(this, {
      log: this.log.bind(this),
      debug: (...args: unknown[]) => this.logDebug('devices', ...args),
      error: this.error.bind(this),
      structuredLog: this.getStructuredLogger('devices'),
    }, {
      getPriority: (id) => this.getPriorityForDevice(id),
      getControllable: (id) => this.isCapacityControlEnabled(id),
      getManaged: (id) => this.resolveManagedState(id),
      getBudgetExempt: (id) => this.isBudgetExempt(id),
      getCommunicationModel: (id) => this.getCommunicationModel(id),
      getExperimentalEvSupportEnabled: () => this.experimentalEvSupportEnabled,
      getFlowReportedCapabilities: (deviceId) => this.getFlowReportedCapabilitiesForDevice(deviceId),
    }, {
      expectedPowerKwOverrides: this.expectedPowerKwOverrides,
      lastKnownPowerKw: this.lastKnownPowerKw,
      lastMeasuredPowerKw: this.lastMeasuredPowerKw,
    }, {
      debugStructured: this.getStructuredDebugEmitter('devices', 'devices'),
    });
    await this.deviceManager.init();
    this.deviceManager.on(
      PLAN_RECONCILE_REALTIME_UPDATE_EVENT,
      (event: realtimeReconcile.RealtimeDeviceReconcileEvent) => {
        this.scheduleRealtimeDeviceReconcile(event);
      },
    );
    this.deviceManager.on(
      PLAN_LIVE_STATE_OBSERVED_EVENT,
      (event: ObservedDeviceStateEvent) => {
        if (
          event.measurePowerBecameSignificantlyPositive === true
          && this.isCapacityControlEnabled(event.deviceId)
        ) {
          this.powerSampleRebuildState = {
            ...this.powerSampleRebuildState,
            shortfallSuppressionInvalidated: true,
          };
        }
        void this.planService?.syncLivePlanState(event.source);
      },
    );
  }
  private initCapacityGuard(): void {
    this.capacityGuard = new CapacityGuard({
      limitKw: this.capacitySettings.limitKw,
      softMarginKw: this.capacitySettings.marginKw,
      onShortfall: async (deficitKw) => this.planService.handleShortfall(deficitKw),
      onShortfallCleared: async () => this.planService.handleShortfallCleared(),
      structuredLog: this.structuredLogger?.child({ component: 'capacity' }),
      capacityStateSummaryProvider: () => buildPlanCapacityStateSummary(
        this.planService?.getLatestPlanSnapshot(),
        {
          summarySource: 'plan_snapshot',
          summarySourceAtMs: this.planService?.getLatestPlanSnapshotUpdatedAtMs() ?? null,
        },
      ),
    });
  }
  private initPlanEngine(): void {
    this.planEngine = createPlanEngine(this.ctx);
    this.hydratePlanEngineControlState();
    this.planEngine.beginStartupRestoreStabilization(STARTUP_RESTORE_STABILIZATION_MS);
  }
  private hydratePlanEngineControlState(): void {
    if (!this.planEngine) return;
    const stored = this.homey.settings.get(DEVICE_LAST_CONTROLLED_MS) as unknown;
    this.planEngine.state.lastDeviceControlledMs = isNumberMap(stored) ? { ...stored } : {};
  }
  private initDeviceDiagnosticsService(): void {
    this.deviceDiagnosticsService = createDeviceDiagnosticsService(this.ctx);
  }
  private initPlanService(): void {
    this.planService = createPlanService(this.ctx);
  }
  private getPlanRebuildNowMs(): number {
    return this.planRebuildScheduler.now().nowMs;
  }
  private resolvePlanRebuildDueAtMs(intent: RebuildIntent, state: ReturnType<PlanRebuildScheduler['now']>): number {
    const nowMs = state.nowMs;
    if (intent.kind === 'hardCap') return nowMs;
    if (intent.kind === 'signal') {
      return this.powerSampleRebuildState.pendingDueMs ?? nowMs;
    }
    if (intent.kind === 'flow') {
      if (state.activeIntent?.kind === 'flow') {
        return Number.POSITIVE_INFINITY;
      }
      const lastCompletedAtMs = state.lastCompletedAtMsByKind.flow ?? Number.NEGATIVE_INFINITY;
      return Math.max(nowMs, lastCompletedAtMs + FLOW_REBUILD_COOLDOWN_MS);
    }
    return this.planService?.getPendingSnapshotDueMs({
      nowMs,
      activeIntent: state.activeIntent,
    }) ?? Number.POSITIVE_INFINITY;
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
    if (intent.kind === 'snapshot') {
      this.planService?.flushPendingNonActionSnapshotFromScheduler(this.getPlanRebuildNowMs());
      return Promise.resolve();
    }
    return this.planService.rebuildPlanFromCache(intent.reason).then(() => undefined);
  }
  private onPlanRebuildIntentDropped(dropped: RebuildIntent, kept: RebuildIntent): void {
    this.logDebug(
      'plan',
      'Plan rebuild scheduler:'
        + ` dropping ${dropped.kind}:${dropped.reason}`
        + ` while ${kept.kind}:${kept.reason} remains scheduled`,
    );
  }
  private onPlanRebuildPendingIntentReplaced(previous: RebuildIntent, next: RebuildIntent): void {
    if (previous.kind === 'flow' && next.kind === 'flow') {
      incPerfCounter('plan_rebuild_requested.flow_coalesced_total');
      if (previous.reason !== next.reason) {
        incPerfCounter('plan_rebuild_requested.flow_pending_source_replaced_total');
      }
    }
    this.logDebug(
      'plan',
      `Plan rebuild scheduler: replacing pending ${previous.kind}:${previous.reason} with ${next.kind}:${next.reason}`,
    );
  }
  private onPlanRebuildIntentCancelled(intent: RebuildIntent, reason: string): void {
    if (intent.kind === 'signal' || intent.kind === 'hardCap') {
      cancelPendingPowerRebuild({
        getState: () => this.powerSampleRebuildState,
        setState: (state) => {
          this.powerSampleRebuildState = state;
        },
        reason,
      });
    }
  }
  private onPlanRebuildIntentError(intent: RebuildIntent, error: Error): void {
    if (intent.kind === 'flow') {
      this.error(`Flow rebuild scheduler failed for ${intent.reason}`, error);
      return;
    }
    if (intent.kind === 'signal' || intent.kind === 'hardCap') {
      this.error('PowerTracker: Failed to rebuild plan after power sample:', error);
      return;
    }
    this.error('Plan rebuild scheduler failed to flush pending snapshot', error);
  }
  private initCapacityGuardProviders(): void {
    if (!this.capacityGuard) return;
    this.defaultComputeDynamicSoftLimit = this.computeDynamicSoftLimit;
    this.capacityGuard.setSoftLimitProvider(() => this.computeDynamicSoftLimit());
    this.capacityGuard.setShortfallThresholdProvider(() => this.computeShortfallThreshold());
  }
  private initSettingsHandler(): void {
    const settingsHandler = initSettingsHandlerForApp(this.ctx);
    this.stopSettingsHandler = settingsHandler.stop;
  }
  async onUninit(): Promise<void> {
    this.clearUninitTimers();
    realtimeReconcile.clearRealtimeDeviceReconcileState(this.realtimeDeviceReconcileState);
    this.stopUninitServices();
    this.planRebuildScheduler.cancelAll('app_uninit');
    this.deviceDiagnosticsService?.destroy();
    this.planService?.destroy();
    this.priceCoordinator.stop();
    this.deviceManager?.destroy();
  }
  private clearUninitTimers(): void {
    if (this.timers.has('powerTrackerSave')) {
      this.persistPowerTrackerState();
    }
    this.timers.clearAll();
    this.snapshotHelpers.stop();
    this.homeyEnergyHelpers.stop();
  }
  private stopUninitServices(): void {
    this.stopPriceLowestTriggerChecker?.(); this.stopPerfLogging?.();
    this.stopResourceWarningListeners?.(); this.stopSettingsHandler?.();
  }
  private logDebug(topic: DebugLoggingTopic, ...args: unknown[]): void {
    if (this.debugLoggingTopics.has(topic)) this.log(...args);
  }
  private getStructuredLogger(component: string): PinoLogger | undefined {
    if (!this.structuredLogger) return undefined;
    return this.structuredLogger.child({ component });
  }
  private getStructuredDebugEmitter(component: string, debugTopic: DebugLoggingTopic): StructuredDebugEmitter {
    return (payload) => {
      if (!this.structuredLogger || !this.debugLoggingTopics.has(debugTopic)) return;
      this.structuredLogger.child({ component }, { level: 'debug' }).debug({ ...payload, debugTopic });
    };
  }
  private scheduleRealtimeDeviceReconcile(event: realtimeReconcile.RealtimeDeviceReconcileEvent): void {
    const structuredLog = this.getStructuredLogger('reconcile');
    const debugStructured = this.getStructuredDebugEmitter('reconcile', 'devices');
    const timer = scheduleAppRealtimeDeviceReconcile({
      event,
      state: this.realtimeDeviceReconcileState,
      hasPendingTimer: this.timers.has('realtimeDeviceReconcile'),
      getLatestPlanSnapshot: () => this.planService?.getLatestReconcilePlanSnapshot() ?? null,
      getLiveDevices: () => this.latestTargetSnapshot,
      structuredLog,
      debugStructured,
      reconcile: () => this.planService?.reconcileLatestPlanState() ?? Promise.resolve(false),
      onTimerFired: () => {
        this.timers.clear('realtimeDeviceReconcile');
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
      this.timers.registerTimeout('realtimeDeviceReconcile', timer);
    }
  }
  private startHeartbeat(): void {
    const updateHeartbeat = () => this.homey.settings.set('app_heartbeat', Date.now());
    updateHeartbeat();
    this.timers.registerInterval('heartbeat', setInterval(updateHeartbeat, 30 * 1000));
  }
  private startPriceLowestTriggerChecker(): void {
    if (this.stopPriceLowestTriggerChecker) this.stopPriceLowestTriggerChecker();
    this.stopPriceLowestTriggerChecker = startPriceLowestTriggers({
      getNow: () => this.getNow(), getTimeZone: () => this.getTimeZone(),
      getCombinedHourlyPrices: () => this.getCombinedHourlyPrices(),
      getTriggerCard: (id) => this.homey.flow.getTriggerCard(id),
      logDebug: (message) => this.logDebug('price', message), error: (message, error) => this.error(message, error),
    });
  }
  private startPerfLogging(): void {
    this.stopPerfLogging = startPerfLogger({
      isEnabled: () => this.debugLoggingTopics.has('perf'), log: (...args: unknown[]) => this.logDebug('perf', ...args),
      logStructured: this.getStructuredDebugEmitter('perf', 'perf'),
      error: (...args: unknown[]) => this.error(...args),
      logCpuSpike: (...args: unknown[]) => this.log(...args), intervalMs: 30 * 1000,
    });
  }
  private startResourceWarningListeners(): void {
    if (this.stopResourceWarningListeners) this.stopResourceWarningListeners();
    this.stopResourceWarningListeners = startResourceWarnings({
      homey: this.homey, log: (message) => this.log(message), error: this.error.bind(this),
    });
  }
  private getDynamicSoftLimitOverride(): number | null {
    if (!this.defaultComputeDynamicSoftLimit || this.computeDynamicSoftLimit === this.defaultComputeDynamicSoftLimit) {
      return null;
    }
    const value = this.computeDynamicSoftLimit();
    return Number.isFinite(value) ? value : null;
  }
  private updatePriceOptimizationEnabled(logChange = false): void {
    this.priceCoordinator.updatePriceOptimizationEnabled(logChange);
  }
  private get priceOptimizationEnabled(): boolean { return this.priceCoordinator.getPriceOptimizationEnabled(); }
  private get priceOptimizationSettings(): PriceOptimizationSettings {
    return this.priceCoordinator.getPriceOptimizationSettings();
  }
  private updateDebugLoggingEnabled(logChange = false): void {
    this.debugLoggingTopics = buildDebugLoggingTopics({
      settings: this.homey.settings,
      log: (...args: unknown[]) => this.log(...args),
      logChange,
    });
  }
  private notifyOperatingModeChanged(mode: string): void {
    const trimmed = mode.trim();
    if (!trimmed || this.lastNotifiedOperatingMode === trimmed) return;
    const card = this.homey.flow?.getTriggerCard?.('operating_mode_changed');
    if (card && typeof card.trigger === 'function') {
      card.trigger({}, { mode: trimmed })
        .catch((err: Error) => this.error('Failed to trigger operating_mode_changed', err));
    }
    this.lastNotifiedOperatingMode = trimmed;
  }
  private loadPowerTracker(options: { skipDailyBudgetUpdate?: boolean } = {}): void {
    const stored = this.homey.settings.get('power_tracker_state') as unknown;
    if (isPowerTrackerState(stored)) this.powerTracker = stored;
    if (options.skipDailyBudgetUpdate !== true) this.dailyBudgetService.updateState({ refreshObservedStats: false });
  }
  private migrateManagedDevices(): void {
    migrateManagedDevicesHelper({ homey: this.homey, log: this.log.bind(this) });
  }
  private loadCapacitySettings(): void {
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
        deviceControlProfiles: this.deviceControlProfiles,
        deviceCommunicationModels: this.deviceCommunicationModels,
        experimentalEvSupportEnabled: this.experimentalEvSupportEnabled,
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
    this.deviceControlProfiles = normalizeStoredDeviceControlProfiles(next.deviceControlProfiles) ?? {};
    this.deviceCommunicationModels = next.deviceCommunicationModels;
    this.experimentalEvSupportEnabled = next.experimentalEvSupportEnabled;
    this.shedBehaviors = next.shedBehaviors;
    this.updatePriceOptimizationEnabled();
    void this.updateOverheadToken(this.capacitySettings.marginKw);
  }
  private disableManagedEvDevices(): void {
    disableManagedEvDevicesHelper({
      snapshot: this.latestTargetSnapshot,
      settings: this.homey.settings,
      logDebug: (...args: unknown[]) => this.logDebug('devices', ...args),
    });
  }
  private loadPriceOptimizationSettings(): void { this.priceCoordinator.loadPriceOptimizationSettings(); }
  public getDailyBudgetUiPayload(): DailyBudgetUiPayload | null { return this.dailyBudgetService.getUiPayload(); }
  public getLatestPlanSnapshotForUi(): DevicePlan | null { return this.planService?.getLatestPlanSnapshot() ?? null; }
  private async updateOverheadToken(value?: number): Promise<void> {
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
      this.error('Failed to create/update capacity_overhead token', error as Error);
    }
  }
  private persistPowerTrackerState(): void {
    this.timers.clear('powerTrackerSave');
    persistPowerTrackerStateForApp({
      homey: this.homey,
      powerTracker: this.powerTracker,
      error: (msg, err) => this.error(msg, err),
    });
  }
  private prunePowerTrackerHistory(): void {
    this.powerTracker = prunePowerTrackerHistoryForApp({
      powerTracker: this.powerTracker,
      logDebug: (msg) => this.logDebug('perf', msg),
      error: (msg, err) => this.error(msg, err),
    });
    this.persistPowerTrackerState();
  }
  private startPowerTrackerPruning(): void {
    this.timers.registerTimeout('powerTrackerPruneInitial', setTimeout(() => {
      this.timers.clear('powerTrackerPruneInitial');
      this.prunePowerTrackerHistory();
    }, POWER_TRACKER_PRUNE_INITIAL_DELAY_MS));
    this.timers.registerInterval('powerTrackerPruneInterval', setInterval(
      () => this.prunePowerTrackerHistory(),
      POWER_TRACKER_PRUNE_INTERVAL_MS,
    ));
  }
  private savePowerTracker(nextState: PowerTrackerState = this.powerTracker): void {
    const stateStart = Date.now();
    this.powerTracker = nextState;
    if (!this.timers.has('powerTrackerSave')) {
      this.timers.registerTimeout(
        'powerTrackerSave',
        setTimeout(() => this.persistPowerTrackerState(), POWER_TRACKER_PERSIST_DELAY_MS),
      );
    }
    addPerfDuration('power_sample_state_ms', Date.now() - stateStart);

    const budgetStart = Date.now();
    this.updateDailyBudgetAndRecordCap({ nowMs: nextState.lastTimestamp ?? Date.now() });
    addPerfDuration('power_sample_budget_ms', Date.now() - budgetStart);

    const uiStart = Date.now();
    emitSettingsUiPowerUpdatedForApp(this.homey, this.powerTracker, (message, error) => this.error(message, error));
    addPerfDuration('power_sample_ui_ms', Date.now() - uiStart);
  }
  public replacePowerTrackerForUi(nextState: PowerTrackerState): void {
    this.powerTracker = nextState;
    this.updateDailyBudgetAndRecordCap({ nowMs: nextState.lastTimestamp ?? Date.now(), forcePlanRebuild: true });
    emitSettingsUiPowerUpdatedForApp(this.homey, this.powerTracker, (message, error) => this.error(message, error));
    this.persistPowerTrackerState();
  }
  private updateDailyBudgetAndRecordCap(options?: { nowMs?: number; forcePlanRebuild?: boolean }): void {
    this.powerTracker = updateDailyBudgetAndRecordCapForApp({
      powerTracker: this.powerTracker,
      dailyBudgetService: this.dailyBudgetService,
      options,
    });
  }
  private async runPowerSample(currentPowerW: number, nowMs: number = Date.now()): Promise<void> {
    const sampleStart = Date.now();
    const previousSampleTs = this.powerTracker.lastTimestamp;
    try {
      const planState = this.planEngine?.state;
      const planConvergenceActive = isPlanConverging(planState, nowMs);
      const latestPlanSummary = buildPlanCapacityStateSummary(
        this.planService?.getLatestPlanSnapshot(),
        {
          summarySource: 'plan_snapshot',
          summarySourceAtMs: this.planService?.getLatestPlanSnapshotUpdatedAtMs() ?? null,
        },
      );
      const skipWhileShortfallUnrecoverable = latestPlanSummary.remainingReducibleControlledLoad === false
        && latestPlanSummary.actuationInFlight === false
        && this.powerSampleRebuildState.shortfallSuppressionInvalidated !== true;
      await recordPowerSampleForApp({
        currentPowerW,
        nowMs,
        capacitySettings: this.capacitySettings,
        getLatestTargetSnapshot: () => this.latestTargetSnapshot,
        powerTracker: this.powerTracker,
        capacityGuard: this.capacityGuard,
        schedulePlanRebuild: async () => {
          await schedulePlanRebuildFromSignal({
            scheduler: this.planRebuildScheduler,
            getState: () => this.powerSampleRebuildState,
            setState: (state) => {
              this.powerSampleRebuildState = state;
            },
            getNowMs: () => this.getPlanRebuildNowMs(),
            minIntervalMs: POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS,
            stableMinIntervalMs: POWER_SAMPLE_REBUILD_STABLE_INTERVAL_MS,
            maxIntervalMs: POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS,
            rebuildPlanFromCache: (reason?: string) => this.planService.rebuildPlanFromCache(reason),
            currentPowerW,
            capacitySettings: this.capacitySettings,
            capacityGuard: this.capacityGuard,
            planConvergenceActive,
            skipWhileShortfallUnrecoverable,
          });
        },
        saveState: (state) => this.savePowerTracker(state),
      });
      if (previousSampleTs === undefined || nowMs > previousSampleTs) {
        this.planEngine.clearStartupRestoreStabilization(nowMs);
      }
    } finally {
      addPerfDuration('power_sample_ms', Date.now() - sampleStart);
      incPerfCounter('power_sample_total');
    }
  }
  private async recordPowerSample(currentPowerW: number, nowMs: number = Date.now()): Promise<void> {
    incPerfCounter('power_sample_requested_total');
    const request = { currentPowerW, nowMs };

    if (this.powerSampleLoop) {
      if (this.powerSampleRerunRequested) {
        incPerfCounter('power_sample_rerun_coalesced_total');
      } else {
        incPerfCounter('power_sample_rerun_requested_total');
      }
      this.powerSampleRerunRequested = true;
      this.pendingPowerSampleRequest = request;
      return this.powerSampleLoop;
    }

    const loopPromise = this.runCoalescedPowerSamples(request);
    this.powerSampleLoop = loopPromise;
    return loopPromise;
  }
  private async runCoalescedPowerSamples(initialRequest: { currentPowerW: number; nowMs: number }): Promise<void> {
    let request = initialRequest;
    try {
      while (true) {
        this.powerSampleRerunRequested = false;
        this.pendingPowerSampleRequest = undefined;
        await this.runPowerSample(request.currentPowerW, request.nowMs);
        if (!this.powerSampleRerunRequested) return;
        incPerfCounter('power_sample_rerun_executed_total');
        request = this.pendingPowerSampleRequest ?? request;
      }
    } finally {
      if (this.powerSampleLoop) {
        this.powerSampleLoop = undefined;
      }
      this.powerSampleRerunRequested = false;
      this.pendingPowerSampleRequest = undefined;
    }
  }
  private registerFlowCards(): void {
    registerAppFlowCards(this.ctx);
  }
  private async handleOperatingModeChange(rawMode: string): Promise<void> {
    const resolved = resolveModeNameHelper(rawMode, this.modeAliases);
    const previousMode = this.operatingMode;
    if (resolved !== rawMode) this.logDebug('settings', `Mode '${rawMode}' resolved via alias to '${resolved}'`);
    this.operatingMode = resolved;
    this.homey.settings.set(OPERATING_MODE_SETTING, resolved);
    const aliasUsed = rawMode !== resolved ? rawMode : null;
    if (this.homey.settings.get('mode_alias_used') !== aliasUsed) {
      this.homey.settings.set('mode_alias_used', aliasUsed);
    }
    if (previousMode?.toLowerCase() === resolved.toLowerCase()) {
      this.logDebug('settings', `Mode '${resolved}' already active`);
    }
    this.notifyOperatingModeChanged(resolved);
  }
  private async getFlowSnapshot(): Promise<TargetDeviceSnapshot[]> {
    if (!this.latestTargetSnapshot || this.latestTargetSnapshot.length === 0) {
      await this.refreshTargetDevicesSnapshot();
    }
    return this.latestTargetSnapshot;
  }
  private getCurrentPriceLevel(): PriceLevel {
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
  private get latestTargetSnapshot(): TargetDeviceSnapshot[] {
    const snapshot = this.deviceManager?.getSnapshot() ?? [];
    return this.deviceControlHelpers.decorateTargetSnapshotList(snapshot);
  }
  setSnapshotForTests(snapshot: TargetDeviceSnapshot[]): void {
    this.deviceManager.setSnapshotForTests(snapshot);
  }
  parseDevicesForTests(list: HomeyDeviceLike[]): TargetDeviceSnapshot[] {
    return this.deviceManager.parseDeviceListForTests(list);
  }
  private async refreshTargetDevicesSnapshot(
    options: RefreshTargetDevicesSnapshotOptions = {},
  ): Promise<void> {
    await this.snapshotHelpers.refreshTargetDevicesSnapshot(options);
  }
  public getCombinedHourlyPrices = (): unknown => this.priceCoordinator.getCombinedHourlyPrices();
  private getTimeZone = (): string => this.homey.clock.getTimezone();
  private getNow = (): Date => new Date();
  public findCheapestHours = (count: number): string[] => this.priceCoordinator.findCheapestHours(count);
  private isCurrentHourCheap = (): boolean => this.priceCoordinator.isCurrentHourCheap();
  private isCurrentHourExpensive = (): boolean => this.priceCoordinator.isCurrentHourExpensive();
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
  private async getDeviceLoadSetting(deviceId: string): Promise<number | null> {
    return getDeviceLoadSetting({
      deviceId,
      snapshot: this.latestTargetSnapshot,
      error: (...args: unknown[]) => this.error(...args),
    });
  }
  private getPriorityForDevice = (deviceId: string) => (
    this.capacityPriorities[this.operatingMode || 'Home']?.[deviceId] ?? 100
  );
  private resolveModeName = (name: string) => resolveModeNameHelper(name, this.modeAliases);
  private getAllModes = () => getAllModesHelper(this.operatingMode, this.capacityPriorities, this.modeDeviceTargets);
  private resolveManagedState = (deviceId: string) => this.managedDevices[deviceId] === true;
  private getCommunicationModel = (deviceId: string): 'local' | 'cloud' => (
    this.deviceCommunicationModels[deviceId] ?? 'local'
  );
  private isCapacityControlEnabled = (deviceId: string) => (
    this.managedDevices[deviceId] === true && this.controllableDevices[deviceId] === true
  );
  private isBudgetExempt = (deviceId: string) => this.budgetExemptDevices[deviceId] === true;
  private getShedBehavior = (deviceId: string) => getShedBehaviorHelper(deviceId, this.shedBehaviors);
  private computeDynamicSoftLimit = () => this.planService.computeDynamicSoftLimit();
  private computeShortfallThreshold = () => this.planService.computeShortfallThreshold();
  public getDeviceDiagnosticsUiPayload(): SettingsUiDeviceDiagnosticsPayload {
    return this.deviceDiagnosticsService?.getUiPayload?.()
      ?? { generatedAt: Date.now(), windowDays: 21, diagnosticsByDeviceId: {} };
  }
  public applyPlanActions = (plan: DevicePlan) => this.planService.applyPlanActions(plan);
  public applySheddingToDevice = (deviceId: string, deviceName: string, reason?: string) =>
    this.planService.applySheddingToDevice(deviceId, deviceName, reason);
}

export = PelsApp;
