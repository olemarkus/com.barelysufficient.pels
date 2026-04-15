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
import { TARGET_CONFIRMATION_STUCK_POLL_MS } from './lib/plan/planConstants';
import { getLatestDeviceObservationMs, isDeviceObservationStale } from './lib/plan/planObservationPolicy';
import { buildPlanCapacityStateSummary } from './lib/plan/planLogging';
import {
  DeviceActionLogCause,
  DeviceActionLogEntry,
  HomeyDeviceLike,
  TargetDeviceSnapshot,
} from './lib/utils/types';
import { PriceCoordinator } from './lib/price/priceCoordinator';
import { PowerTrackerState } from './lib/core/powerTracker';
import { PriceLevel } from './lib/price/priceLevels';
import { buildPeriodicStatusLogFields } from './lib/core/periodicStatus';
import { getDeviceLoadSetting } from './lib/core/deviceLoad';
import { DailyBudgetService } from './lib/dailyBudget/dailyBudgetService';
import type { DailyBudgetUiPayload } from './lib/dailyBudget/dailyBudgetTypes';
import { type DebugLoggingTopic } from './lib/utils/debugLogging';
import {
  createDeviceControlRuntimeState,
  decorateSnapshotWithDeviceControl,
  markSteppedLoadDesiredStepIssued,
  normalizeStoredDeviceControlProfiles,
  pruneStaleSteppedLoadCommandStates,
  reportSteppedLoadActualStep as reportSteppedLoadActualStepHelper,
  type DeviceControlRuntimeState,
  type ReportSteppedLoadActualStepResult,
  type SteppedLoadDesiredRuntimeState,
} from './lib/app/appDeviceControlHelpers';
import {
  getAllModes as getAllModesHelper,
  getShedBehavior as getShedBehaviorHelper,
  resolveModeName as resolveModeNameHelper,
} from './lib/utils/capacityHelpers';
import {
  OPERATING_MODE_SETTING,
  DEVICE_ACTION_LOG_BY_DEVICE,
} from './lib/utils/settingsKeys';
import type { HeadroomForDeviceDecision } from './lib/plan/planHeadroomDevice';
import { isPowerTrackerState } from './lib/utils/appTypeGuards';
import {
  resolveHomeyEnergyApiFromSdk, type HomeyEnergyApi,
} from './lib/utils/homeyEnergy';
import {
  persistPowerTrackerStateForApp,
  prunePowerTrackerHistoryForApp,
  updateDailyBudgetAndRecordCapForApp,
  PowerSampleRebuildState,
  recordPowerSampleForApp,
  schedulePlanRebuildFromSignal,
} from './lib/app/appPowerHelpers';
import {
  createDeviceDiagnosticsService,
  createPlanEngine,
  createPlanService,
  createPriceCoordinator,
  registerAppFlowCards,
  type FlowCardInitApp,
  type PlanEngineInitApp,
  type PlanServiceInitApp,
} from './lib/app/appInit';
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
import { toStableFingerprint } from './lib/utils/stableFingerprint';
import { startResourceWarningListeners as startResourceWarnings } from './lib/app/appResourceWarningHelpers';
import { createFlowRebuildScheduler, type FlowRebuildScheduler } from './lib/app/appFlowRebuildScheduler';
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
import { DeviceActionLogStore } from './lib/app/deviceActionLogStore';
import type { DeviceDiagnosticsService } from './lib/diagnostics/deviceDiagnosticsService';
import type { SettingsUiDeviceDiagnosticsPayload } from './packages/contracts/src/deviceDiagnosticsTypes';
import type { DeviceControlProfiles, SteppedLoadProfile } from './lib/utils/types';
const SNAPSHOT_REFRESH_MINUTE_INTERVALS = [25, 55];
const TARGET_CONFIRMATION_POLL_INTERVAL_MS = TARGET_CONFIRMATION_STUCK_POLL_MS;
const STALE_OBSERVATION_FALLBACK_REFRESH_INTERVAL_MS = 60 * 1000;
const POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 2000;
const HOMEY_ENERGY_POLL_INTERVAL_MS = 10_000;
// Let non-urgent power deltas settle before rebuilding the full plan again.
const POWER_SAMPLE_REBUILD_STABLE_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 15000;
const POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 100 : 30 * 1000;
const STARTUP_RESTORE_STABILIZATION_MS = 60 * 1000;
const POWER_TRACKER_PRUNE_INITIAL_DELAY_MS = 10 * 1000; const POWER_TRACKER_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const POWER_TRACKER_PERSIST_DELAY_MS = VOLATILE_WRITE_THROTTLE_MS;
type PriceOptimizationSettings = Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;

function toPersistedTargetSnapshotFingerprint(value: unknown): string {
  if (!Array.isArray(value)) return toStableFingerprint(value);
  return toStableFingerprint(value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const {
      lastFreshDataMs: _lastFreshDataMs,
      lastUpdated: _lastUpdated,
      lastLocalWriteMs: _lastLocalWriteMs,
      ...rest
    } = entry as Record<string, unknown>;
    return rest;
  }));
}

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
  private deviceControlProfiles: DeviceControlProfiles = {};
  private deviceCommunicationModels: Record<string, 'local' | 'cloud'> = {};
  private deviceControlRuntimeState: DeviceControlRuntimeState = createDeviceControlRuntimeState();
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
  private snapshotRefreshTimer?: ReturnType<typeof setTimeout>;
  private staleObservationRefreshTimer?: ReturnType<typeof setTimeout>;
  private staleObservationRefreshStopped = true;
  private targetConfirmationPollInterval?: ReturnType<typeof setInterval>;
  private isSnapshotRefreshing = false;
  private snapshotRefreshPending = false;
  private lastKnownPowerKw: Record<string, number> = {};
  private expectedPowerKwOverrides: Record<string, { kw: number; ts: number }> = {};
  private overheadToken?: Homey.FlowToken;
  private lastMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
  private lastNotifiedOperatingMode = 'Home';
  private powerSampleRebuildState: PowerSampleRebuildState = { lastMs: 0 };
  private powerSampleLoop?: Promise<void>;
  private powerSampleRerunRequested = false;
  private pendingPowerSampleRequest?: { currentPowerW: number; nowMs: number };
  private postActuationRefreshTimer?: ReturnType<typeof setTimeout>;
  private realtimeDeviceReconcileTimer?: ReturnType<typeof setTimeout>;
  private realtimeDeviceReconcileState = realtimeReconcile.createRealtimeDeviceReconcileState();
  private deviceObservationStaleById = new Map<string, boolean>();
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private homeyEnergyPollInterval?: ReturnType<typeof setInterval>;
  private stopPriceLowestTriggerChecker?: () => void;
  private stopPerfLogging?: () => void;
  private stopResourceWarningListeners?: () => void;
  private stopSettingsHandler?: () => void;
  private structuredLogger?: PinoLogger;
  private flowRebuildScheduler?: FlowRebuildScheduler;
  private deviceActionLogStore?: DeviceActionLogStore;
  private pendingModeDrivenTargetCauseByDevice: Record<string, { expectedTarget: number; expiresAtMs: number }> = {};
  private pendingPriceDrivenTargetCauseByDevice: Record<string, { expectedTarget: number; expiresAtMs: number }> = {};
  private static readonly EXPECTED_OVERRIDE_EQUALS_EPSILON_KW = 0.000001;
  private static readonly TARGET_CAUSE_EPSILON = 0.000001;
  private setExpectedOverride(deviceId: string, kw: number): boolean {
    if (this.getSteppedLoadProfile(deviceId)) {
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
    this.planService?.syncHeadroomCardTrackedUsage({ deviceId, trackedKw: kw });
    this.appendDeviceActionLog({
      deviceId,
      eventKind: 'trigger',
      cause: 'expected_power_flow',
      message: `Expected power override set to ${kw.toFixed(2)} kW from Flow`,
      metadata: { kw },
    });
    return true;
  }
  private getSteppedLoadProfile(deviceId: string): SteppedLoadProfile | null {
    const profile = this.deviceControlProfiles[deviceId];
    return profile?.model === 'stepped_load' ? profile : null;
  }
  private decorateTargetSnapshotList(snapshot: TargetDeviceSnapshot[]): TargetDeviceSnapshot[] {
    pruneStaleSteppedLoadCommandStates(this.deviceControlRuntimeState);
    return snapshot.map((device) => decorateSnapshotWithDeviceControl({
      snapshot: device,
      profiles: this.deviceControlProfiles,
      runtimeState: this.deviceControlRuntimeState,
    }));
  }
  private emitSteppedFeedbackLog(params: {
    log: PinoLogger | undefined;
    deviceId: string;
    deviceName: string;
    stepId: string;
    previousReportedStepId: string | undefined;
    previousDesired: SteppedLoadDesiredRuntimeState | undefined;
  }): void {
    const { log, deviceId, deviceName, stepId, previousReportedStepId, previousDesired } = params;
    if (previousDesired?.stepId === stepId) {
      log?.info({
        event: 'stepped_feedback_confirmed',
        deviceId, deviceName,
        reportedStepId: stepId,
        desiredStepId: previousDesired.stepId,
        pending: previousDesired.pending,
        stale: previousDesired.status === 'stale',
      });
    } else if (previousReportedStepId && previousReportedStepId !== stepId) {
      log?.info({
        event: 'stepped_feedback_external_change',
        deviceId, deviceName,
        previousStepId: previousReportedStepId,
        newStepId: stepId,
        desiredStepId: previousDesired?.stepId ?? null,
      });
    } else if (previousDesired?.stepId && previousDesired.stepId !== stepId) {
      log?.info({
        event: 'stepped_feedback_mismatch',
        deviceId, deviceName,
        reportedStepId: stepId,
        desiredStepId: previousDesired.stepId,
      });
    } else {
      log?.info({
        event: 'stepped_feedback_reported',
        deviceId, deviceName,
        reportedStepId: stepId,
      });
    }
  }
  private reportSteppedLoadActualStep(deviceId: string, stepId: string): ReportSteppedLoadActualStepResult {
    const snapshot = this.latestTargetSnapshot.find((device) => device.id === deviceId);
    const deviceName = snapshot?.name?.trim() ?? deviceId;
    const previousReportedStepId = this.deviceControlRuntimeState.steppedLoadReportedByDeviceId[deviceId]?.stepId;
    const previousDesired = this.deviceControlRuntimeState.steppedLoadDesiredByDeviceId[deviceId];
    const changed = reportSteppedLoadActualStepHelper({
      runtimeState: this.deviceControlRuntimeState,
      profiles: this.deviceControlProfiles,
      deviceId,
      stepId,
    });

    if (changed === 'invalid') {
      this.logDebug('devices', `Stepped load feedback ignored for ${deviceName}: invalid step '${stepId}'`);
      return changed;
    }
    if (changed === 'unchanged') {
      this.logDebug('devices', `Stepped load feedback unchanged for ${deviceName}: ${stepId}`);
      return changed;
    }
    this.emitSteppedFeedbackLog({
      log: this.getStructuredLogger('devices'),
      deviceId, deviceName, stepId, previousReportedStepId, previousDesired,
    });
    return changed;
  }
  private markSteppedLoadDesiredStepIssued(params: {
    deviceId: string;
    desiredStepId: string;
    previousStepId?: string;
    issuedAtMs?: number;
    pendingWindowMs?: number;
  }): void {
    markSteppedLoadDesiredStepIssued({
      runtimeState: this.deviceControlRuntimeState,
      deviceId: params.deviceId,
      desiredStepId: params.desiredStepId,
      previousStepId: params.previousStepId,
      issuedAtMs: params.issuedAtMs,
      pendingWindowMs: params.pendingWindowMs,
    });
  }
  private getHomeyEnergyApi(): HomeyEnergyApi | null {
    return resolveHomeyEnergyApiFromSdk(this.homey);
  }
  async onInit() {
    const deferStartupBootstrap = process.env.NODE_ENV !== 'test' || process.env.PELS_ASYNC_STARTUP === '1';
    this.structuredLogger = createRootLogger(
      createHomeyDestination({ log: (...a) => this.log(...a), error: (...a) => this.error(...a) }),
    );
    this.structuredLogger.child({ component: 'startup' }).info({ event: 'app_initialized' });
    this.startResourceWarningListeners();
    this.initDeviceActionLogStore();
    await runStartupStep('updateDebugLoggingEnabled', () => this.updateDebugLoggingEnabled());
    this.startPerfLogging();
    await runStartupStep('initPriceCoordinator', () => this.initPriceCoordinator());
    await runStartupStep('migrateManagedDevices', () => this.migrateManagedDevices());
    await runStartupStep('loadCapacitySettings', () => this.loadCapacitySettings());
    await runStartupStep('initDailyBudgetService', () => this.initDailyBudgetService());
    await runStartupStep('initDeviceDiagnosticsService', () => this.initDeviceDiagnosticsService());
    await runStartupStep('initDeviceManager', () => this.initDeviceManager());
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
    await runStartupStep('initCapacityGuard', () => this.initCapacityGuard());
    await runStartupStep('initPlanEngine', () => this.initPlanEngine());
    await runStartupStep('initPlanService', () => this.initPlanService());
    await runStartupStep('initCapacityGuardProviders', () => this.initCapacityGuardProviders());
    await runStartupStep('initSettingsHandler', () => this.initSettingsHandler());
    await runStartupStep('startAppServices', () => startAppServices({
      loadPowerTracker: (options) => this.loadPowerTracker(options),
      loadPriceOptimizationSettings: () => this.loadPriceOptimizationSettings(),
      initOptimizer: () => this.priceCoordinator.initOptimizer(),
      startHeartbeat: () => this.startHeartbeat(),
      updateOverheadToken: () => this.updateOverheadToken(),
      refreshDailyBudgetState: () => this.dailyBudgetService.updateState({ refreshObservedStats: false }),
      refreshTargetDevicesSnapshot: (options) => this.refreshTargetDevicesSnapshot({ fast: true, ...options }),
      rebuildPlanFromCache: async () => { await this.planService.rebuildPlanFromCache('startup_snapshot_bootstrap'); },
      setLastNotifiedOperatingMode: (mode) => { this.lastNotifiedOperatingMode = mode; },
      getOperatingMode: () => this.operatingMode,
      registerFlowCards: () => this.registerFlowCards(),
      startPeriodicSnapshotRefresh: () => { this.startPeriodicSnapshotRefresh(); this.startHomeyEnergyPoll(); },
      refreshSpotPrices: () => this.priceCoordinator.refreshSpotPrices(),
      refreshGridTariffData: () => this.priceCoordinator.refreshGridTariffData(),
      startPriceRefresh: () => this.priceCoordinator.startPriceRefresh(),
      startPriceOptimization: (applyImmediately) => this.priceCoordinator.startPriceOptimization(applyImmediately),
      logError: (label, error) => {
        const normalizedError = normalizeError(error);
        this.structuredLogger?.child({ component: 'startup' }).error({
          event: 'startup_background_task_failed',
          taskLabel: label,
          err: normalizedError,
        });
      },
      snapshotPlanBootstrapDelayMs,
      runSnapshotPlanBootstrapInBackground: deferStartupBootstrap,
      runPriceBootstrapInBackground: deferStartupBootstrap,
      applyPriceOptimizationImmediatelyOnStart: !deferStartupBootstrap,
    }));
    await runStartupStep('startPriceLowestTriggerChecker', () => this.startPriceLowestTriggerChecker());
    await runStartupStep('startPowerTrackerPruning', () => this.startPowerTrackerPruning());
  }
  private initPriceCoordinator(): void {
    this.priceCoordinator = createPriceCoordinator({
      homey: this.homey,
      getHomeyEnergyApi: () => this.getHomeyEnergyApi(),
      getCurrentPriceLevel: () => this.getCurrentPriceLevel(),
      rebuildPlanFromCache: async (reason?: string) => { await this.planService?.rebuildPlanFromCache(reason); },
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (...args: unknown[]) => this.logDebug('price', ...args),
      error: (...args: unknown[]) => this.error(...args),
      structuredLog: this.structuredLogger,
    });
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
        void this.planService?.syncLivePlanState(event.source);
      },
    );
  }
  private initCapacityGuard(): void {
    this.capacityGuard = new CapacityGuard({
      limitKw: this.capacitySettings.limitKw,
      softMarginKw: this.capacitySettings.marginKw,
      onShortfall: async (deficitKw) => this.handleShortfall(deficitKw),
      onShortfallCleared: async () => this.handleShortfallCleared(),
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
    const deps: PlanEngineInitApp = {
      homey: this.homey,
      deviceManager: this.deviceManager,
      getCapacityGuard: () => this.capacityGuard,
      getCapacitySettings: () => this.capacitySettings,
      getCapacityDryRun: () => this.capacityDryRun,
      getOperatingMode: () => this.operatingMode,
      getModeDeviceTargets: () => this.modeDeviceTargets,
      getPowerTracker: () => this.powerTracker,
      getDailyBudgetSnapshot: () => this.dailyBudgetService.getSnapshot(),
      getPriceOptimizationEnabled: () => this.priceOptimizationEnabled,
      getPriceOptimizationSettings: () => this.priceOptimizationSettings,
      isCurrentHourCheap: () => this.isCurrentHourCheap(),
      isCurrentHourExpensive: () => this.isCurrentHourExpensive(),
      getPriorityForDevice: (deviceId) => this.getPriorityForDevice(deviceId),
      getShedBehavior: (deviceId) => this.getShedBehavior(deviceId),
      getDynamicSoftLimitOverride: () => this.getDynamicSoftLimitOverride(),
      markSteppedLoadDesiredStepIssued: (params) => this.markSteppedLoadDesiredStepIssued(params),
      recordPlanCommandAction: ({ deviceId, cause, message, metadata }) => {
        this.appendDeviceActionLog({
          deviceId,
          eventKind: 'command',
          cause,
          message,
          metadata,
        });
      },
      classifyTargetCommandCause: (deviceId, plannedTarget) => this.classifyTargetCommandCause(deviceId, plannedTarget),
      logTargetRetryComparison: async (params) => {
        await logHomeyDeviceComparisonForDebugFromApp({
          app: this,
          deviceId: params.deviceId,
          reason: `target_retry:${params.skipContext}:${params.targetCap}`,
          expectedTarget: params.desired,
          observedTarget: params.observedValue,
          observedSource: params.observedSource,
        });
      },
      syncLivePlanStateAfterTargetActuation: (source) => this.planService?.syncLivePlanStateInline(source) ?? false,
      deviceDiagnostics: this.deviceDiagnosticsService,
      structuredLog: this.getStructuredLogger('plan'),
      debugStructured: this.getStructuredDebugEmitter('plan', 'plan'),
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (topic: DebugLoggingTopic, ...args: unknown[]) => this.logDebug(topic, ...args),
      error: (...args: unknown[]) => this.error(...args),
    };
    this.planEngine = createPlanEngine(deps);
    this.planEngine.beginStartupRestoreStabilization(STARTUP_RESTORE_STABILIZATION_MS);
  }
  private initDeviceDiagnosticsService(): void {
    this.deviceDiagnosticsService = createDeviceDiagnosticsService({
      homey: this.homey, getTimeZone: () => this.getTimeZone(),
      isDebugEnabled: () => this.debugLoggingTopics.has('diagnostics'),
      logDebug: (topic, ...args) => this.logDebug(topic, ...args),
      error: (...args) => this.error(...args),
    });
  }
  private initPlanService(): void {
    const deps: PlanServiceInitApp = {
      homey: this.homey,
      planEngine: this.planEngine,
      getCapacityDryRun: () => this.capacityDryRun,
      getLastPowerUpdate: () => this.powerTracker.lastTimestamp ?? null,
      getLatestTargetSnapshot: () => this.latestTargetSnapshot,
      resolveManagedState: (deviceId) => this.resolveManagedState(deviceId),
      isCapacityControlEnabled: (deviceId) => this.isCapacityControlEnabled(deviceId),
      isBudgetExempt: (deviceId) => this.isBudgetExempt(deviceId),
      isCurrentHourCheap: () => this.isCurrentHourCheap(),
      isCurrentHourExpensive: () => this.isCurrentHourExpensive(),
      onPriceLevelChanged: (priceLevel, previousPriceLevel) => this.onPriceLevelChanged(priceLevel, previousPriceLevel),
      schedulePostActuationRefresh: () => this.schedulePostActuationRefresh(),
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (topic: DebugLoggingTopic, ...args: unknown[]) => this.logDebug(topic, ...args),
      error: (...args: unknown[]) => this.error(...args),
      structuredLog: this.getStructuredLogger('plan'),
      debugStructured: this.getStructuredDebugEmitter('plan', 'plan'),
      isPlanDebugEnabled: () => this.debugLoggingTopics.has('plan'),
    };
    this.planService = createPlanService(deps);
  }
  private initCapacityGuardProviders(): void {
    if (!this.capacityGuard) return;
    this.defaultComputeDynamicSoftLimit = this.computeDynamicSoftLimit;
    this.capacityGuard.setSoftLimitProvider(() => this.computeDynamicSoftLimit());
    this.capacityGuard.setShortfallThresholdProvider(() => this.computeShortfallThreshold());
  }
  private initSettingsHandler(): void {
    const settingsHandler = initSettingsHandlerForApp({
      homey: this.homey,
      getOperatingMode: () => this.operatingMode,
      notifyOperatingModeChanged: (mode) => this.notifyOperatingModeChanged(mode),
      loadCapacitySettings: () => this.loadCapacitySettings(),
      rebuildPlanFromCache: async (reason?: string) => { await this.planService.rebuildPlanFromCache(reason); },
      refreshTargetDevicesSnapshot: () => this.refreshTargetDevicesSnapshot(),
      loadPowerTracker: () => this.loadPowerTracker(),
      getCapacityGuard: () => this.capacityGuard,
      getCapacitySettings: () => this.capacitySettings,
      getCapacityDryRun: () => this.capacityDryRun,
      loadPriceOptimizationSettings: () => this.loadPriceOptimizationSettings(),
      loadDailyBudgetSettings: () => this.dailyBudgetService.loadSettings(),
      updateDailyBudgetState: (options) => this.updateDailyBudgetAndRecordCap(options),
      resetDailyBudgetLearning: () => this.dailyBudgetService.resetLearning(),
      priceService: this.priceCoordinator,
      updatePriceOptimizationEnabled: (logChange) => this.updatePriceOptimizationEnabled(logChange),
      updateOverheadToken: (value) => this.updateOverheadToken(value),
      updateDebugLoggingEnabled: (logChange) => this.updateDebugLoggingEnabled(logChange),
      getExperimentalEvSupportEnabled: () => this.experimentalEvSupportEnabled,
      disableManagedEvDevices: () => this.disableManagedEvDevices(),
      restartHomeyEnergyPoll: () => this.startHomeyEnergyPoll(),
      log: (message: string) => this.log(message),
      error: (message: string, error: Error) => this.error(message, error),
    });
    this.stopSettingsHandler = settingsHandler.stop;
  }
  async onUninit(): Promise<void> {
    this.staleObservationRefreshStopped = true;
    this.clearUninitTimers();
    realtimeReconcile.clearRealtimeDeviceReconcileState(this.realtimeDeviceReconcileState);
    this.deviceActionLogStore?.destroy();
    this.deviceActionLogStore = undefined;
    this.stopUninitServices();
    this.flowRebuildScheduler?.stop();
    this.deviceDiagnosticsService?.destroy();
    this.planService?.destroy();
    this.priceCoordinator.stop();
    this.deviceManager?.destroy();
  }
  private clearUninitTimers(): void {
    if (this.powerTrackerSaveTimer) this.persistPowerTrackerState();
    if (this.powerTrackerPruneTimer) clearTimeout(this.powerTrackerPruneTimer);
    if (this.powerTrackerPruneInterval) clearInterval(this.powerTrackerPruneInterval);
    if (this.snapshotRefreshTimer) clearTimeout(this.snapshotRefreshTimer);
    if (this.staleObservationRefreshTimer) clearTimeout(this.staleObservationRefreshTimer);
    if (this.targetConfirmationPollInterval) clearInterval(this.targetConfirmationPollInterval);
    if (this.powerSampleRebuildState.timer) clearTimeout(this.powerSampleRebuildState.timer);
    if (this.realtimeDeviceReconcileTimer) clearTimeout(this.realtimeDeviceReconcileTimer);
    if (this.postActuationRefreshTimer) clearTimeout(this.postActuationRefreshTimer);
    this.stopHomeyEnergyPoll();
  }
  private stopUninitServices(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
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
      hasPendingTimer: Boolean(this.realtimeDeviceReconcileTimer),
      getLatestPlanSnapshot: () => this.planService?.getLatestReconcilePlanSnapshot() ?? null,
      getLiveDevices: () => this.latestTargetSnapshot,
      structuredLog,
      debugStructured,
      reconcile: () => this.planService?.reconcileLatestPlanState() ?? Promise.resolve(false),
      onTimerFired: () => { this.realtimeDeviceReconcileTimer = undefined; },
      onError: (error) => {
        const normalizedError = normalizeError(error);
        structuredLog?.error({
          event: 'realtime_reconcile_failed',
          err: normalizedError,
        });
      },
    });
    if (timer) this.realtimeDeviceReconcileTimer = timer;
  }
  private startHeartbeat(): void {
    const updateHeartbeat = () => this.homey.settings.set('app_heartbeat', Date.now());
    updateHeartbeat();
    this.heartbeatInterval = setInterval(updateHeartbeat, 30 * 1000);
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
    const trimmed = (mode || '').trim();
    if (!trimmed || this.lastNotifiedOperatingMode === trimmed) return;
    const previousMode = this.lastNotifiedOperatingMode;
    this.logModeChangeTriggers(previousMode, trimmed);
    const card = this.homey.flow?.getTriggerCard?.('operating_mode_changed');
    if (card && typeof card.trigger === 'function') {
      card.trigger({}, { mode: trimmed })
        .catch((err: Error) => this.error('Failed to trigger operating_mode_changed', err));
    }
    this.lastNotifiedOperatingMode = trimmed;
  }
  private initDeviceActionLogStore(): void {
    this.deviceActionLogStore = new DeviceActionLogStore({
      settings: this.homey.settings,
      settingKey: DEVICE_ACTION_LOG_BY_DEVICE,
      error: (message, error) => this.error(message, error),
    });
    this.deviceActionLogStore.loadFromSettings();
  }
  private appendDeviceActionLog(params: {
    deviceId: string;
    eventKind: DeviceActionLogEntry['eventKind'];
    cause: DeviceActionLogCause;
    message: string;
    metadata?: Record<string, unknown>;
  }): void {
    const deviceId = params.deviceId.trim();
    const message = params.message.trim();
    if (!deviceId || !message) return;
    this.deviceActionLogStore?.append(deviceId, {
      timestamp: Date.now(),
      eventKind: params.eventKind,
      cause: params.cause,
      message,
      ...(params.metadata ? { metadata: params.metadata } : {}),
    });
  }
  private resolveModeChangeTargetState(
    previousTargets: Record<string, number>,
    nextTargets: Record<string, number>,
    deviceId: string,
  ): {
      previousTarget: number | null;
      nextTarget: number | null;
    } | null {
    const previousTarget = previousTargets[deviceId];
    const nextTarget = nextTargets[deviceId];
    const hasPreviousTarget = Number.isFinite(previousTarget);
    const hasNextTarget = Number.isFinite(nextTarget);
    if (!hasPreviousTarget && !hasNextTarget) return null;
    if (
      hasPreviousTarget
      && hasNextTarget
      && Math.abs((previousTarget as number) - (nextTarget as number)) <= PelsApp.TARGET_CAUSE_EPSILON
    ) {
      return null;
    }
    return {
      previousTarget: hasPreviousTarget ? (previousTarget as number) : null,
      nextTarget: hasNextTarget ? (nextTarget as number) : null,
    };
  }
  private updatePendingModeDrivenTargetCause(deviceId: string, nextTarget: number | null): void {
    if (nextTarget === null) {
      delete this.pendingModeDrivenTargetCauseByDevice[deviceId];
      return;
    }
    const activePriceDelta = this.resolveActivePriceDelta(deviceId, this.getLivePriceLevel());
    this.pendingModeDrivenTargetCauseByDevice[deviceId] = {
      expectedTarget: nextTarget + (activePriceDelta ?? 0),
      expiresAtMs: Date.now() + 60_000,
    };
  }
  private updatePendingPriceDrivenTargetCause(deviceId: string, expectedTarget: number): void {
    this.pendingPriceDrivenTargetCauseByDevice[deviceId] = {
      expectedTarget,
      expiresAtMs: Date.now() + 60_000,
    };
  }
  private logModeChangeTriggers(previousMode: string, nextMode: string): void {
    const previousTargets = this.modeDeviceTargets[previousMode] ?? {};
    const nextTargets = this.modeDeviceTargets[nextMode] ?? {};
    const deviceIds = new Set<string>([
      ...Object.keys(previousTargets),
      ...Object.keys(nextTargets),
    ]);
    for (const deviceId of deviceIds) {
      if (!this.resolveManagedState(deviceId)) continue;
      const targetState = this.resolveModeChangeTargetState(previousTargets, nextTargets, deviceId);
      if (!targetState) continue;
      this.updatePendingModeDrivenTargetCause(deviceId, targetState.nextTarget);
      this.appendDeviceActionLog({
        deviceId,
        eventKind: 'trigger',
        cause: 'mode',
        message: `Mode changed from ${previousMode} to ${nextMode}`,
        metadata: {
          previousMode,
          nextMode,
          previousTarget: targetState.previousTarget,
          nextTarget: targetState.nextTarget,
        },
      });
    }
  }
  private onPriceLevelChanged(priceLevel: PriceLevel, previousPriceLevel: PriceLevel): void {
    if (priceLevel === previousPriceLevel) return;
    if (!this.priceOptimizationEnabled) return;
    if (previousPriceLevel === PriceLevel.UNKNOWN) return;
    for (const [deviceId, config] of Object.entries(this.priceOptimizationSettings)) {
      if (!config?.enabled) continue;
      if (!this.resolveManagedState(deviceId)) continue;
      const modeTarget = this.modeDeviceTargets[this.operatingMode]?.[deviceId];
      if (!Number.isFinite(modeTarget)) continue;
      const nextDelta = this.resolveActivePriceDelta(deviceId, priceLevel);
      const previousDelta = this.resolveActivePriceDelta(deviceId, previousPriceLevel);
      if (nextDelta === null || previousDelta === null) continue;
      if (nextDelta === previousDelta) continue;
      this.updatePendingPriceDrivenTargetCause(deviceId, modeTarget + nextDelta);
      this.appendDeviceActionLog({
        deviceId,
        eventKind: 'trigger',
        cause: 'price',
        message: `Price level changed from ${previousPriceLevel} to ${priceLevel}`,
        metadata: {
          previousPriceLevel,
          priceLevel,
          previousDelta,
          nextDelta,
        },
      });
    }
  }
  private classifyTargetCommandCause(deviceId: string, plannedTarget: number): 'mode' | 'price' | 'unknown' {
    const modeTarget = this.modeDeviceTargets[this.operatingMode]?.[deviceId];
    if (!Number.isFinite(modeTarget) || !Number.isFinite(plannedTarget)) return 'unknown';
    const pendingModeCause = this.pendingModeDrivenTargetCauseByDevice[deviceId];
    if (pendingModeCause) {
      if (pendingModeCause.expiresAtMs < Date.now()) {
        delete this.pendingModeDrivenTargetCauseByDevice[deviceId];
      } else if (Math.abs(plannedTarget - pendingModeCause.expectedTarget) <= PelsApp.TARGET_CAUSE_EPSILON) {
        delete this.pendingModeDrivenTargetCauseByDevice[deviceId];
        return 'mode';
      }
    }
    const pendingPriceCause = this.pendingPriceDrivenTargetCauseByDevice[deviceId];
    if (pendingPriceCause) {
      if (pendingPriceCause.expiresAtMs < Date.now()) {
        delete this.pendingPriceDrivenTargetCauseByDevice[deviceId];
      } else if (Math.abs(plannedTarget - pendingPriceCause.expectedTarget) <= PelsApp.TARGET_CAUSE_EPSILON) {
        delete this.pendingPriceDrivenTargetCauseByDevice[deviceId];
        return 'price';
      }
    }
    if (Math.abs(plannedTarget - modeTarget) <= PelsApp.TARGET_CAUSE_EPSILON) return 'mode';
    const activePriceDelta = this.resolveActivePriceDelta(deviceId);
    if (
      activePriceDelta !== null
      && Math.abs(plannedTarget - (modeTarget + activePriceDelta)) <= PelsApp.TARGET_CAUSE_EPSILON
    ) {
      return activePriceDelta === 0 ? 'mode' : 'price';
    }
    return 'unknown';
  }
  private resolveActivePriceDelta(
    deviceId: string,
    priceLevel: PriceLevel = this.getCurrentPriceLevel(),
  ): number | null {
    const config = this.priceOptimizationSettings[deviceId];
    if (!config?.enabled) return null;
    if (priceLevel === PriceLevel.CHEAP) return config.cheapDelta;
    if (priceLevel === PriceLevel.EXPENSIVE) return config.expensiveDelta;
    return 0;
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
  public getDeviceActionLogEntriesForUi(deviceId: string): DeviceActionLogEntry[] {
    return this.deviceActionLogStore?.getEntriesNewestFirst(deviceId) ?? [];
  }
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
  private powerTrackerSaveTimer?: NodeJS.Timeout;
  private powerTrackerPruneInterval?: NodeJS.Timeout;
  private powerTrackerPruneTimer?: NodeJS.Timeout;
  private persistPowerTrackerState(): void {
    if (this.powerTrackerSaveTimer) {
      clearTimeout(this.powerTrackerSaveTimer);
      this.powerTrackerSaveTimer = undefined;
    }
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
    this.powerTrackerPruneTimer = setTimeout(
      () => this.prunePowerTrackerHistory(),
      POWER_TRACKER_PRUNE_INITIAL_DELAY_MS,
    );
    this.powerTrackerPruneInterval = setInterval(
      () => this.prunePowerTrackerHistory(),
      POWER_TRACKER_PRUNE_INTERVAL_MS,
    );
  }
  private savePowerTracker(nextState: PowerTrackerState = this.powerTracker): void {
    const stateStart = Date.now();
    this.powerTracker = nextState;
    if (!this.powerTrackerSaveTimer) {
      this.powerTrackerSaveTimer = setTimeout(() => this.persistPowerTrackerState(), POWER_TRACKER_PERSIST_DELAY_MS);
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
      await recordPowerSampleForApp({
        currentPowerW,
        nowMs,
        capacitySettings: this.capacitySettings,
        getLatestTargetSnapshot: () => this.latestTargetSnapshot,
        powerTracker: this.powerTracker,
        capacityGuard: this.capacityGuard,
        schedulePlanRebuild: () => schedulePlanRebuildFromSignal({
          getState: () => this.powerSampleRebuildState,
          setState: (state) => {
            this.powerSampleRebuildState = state;
          },
          minIntervalMs: POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS,
          stableMinIntervalMs: POWER_SAMPLE_REBUILD_STABLE_INTERVAL_MS,
          maxIntervalMs: POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS,
          currentPowerW,
          capacitySettings: this.capacitySettings,
          capacityGuard: this.capacityGuard,
          rebuildPlanFromCache: (reason?: string) => this.planService.rebuildPlanFromCache(reason),
          logError: (error) => {
            // Log error but don't throw - state is already persisted
            this.error('PowerTracker: Failed to rebuild plan after power sample:', error);
          },
        }),
        saveState: (state) => this.savePowerTracker(state),
      });
      if (previousSampleTs === undefined || nowMs > previousSampleTs) {
        this.planEngine.clearStartupRestoreStabilization();
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
    this.flowRebuildScheduler ??= createFlowRebuildScheduler({
      rebuildPlanFromCache: async (reason) => { await this.planService.rebuildPlanFromCache(reason); },
      logDebug: (...args: unknown[]) => this.logDebug('settings', ...args),
      logError: (message, error) => this.error(message, error),
    });
    const deps: FlowCardInitApp = {
      homey: this.homey,
      resolveModeName: (mode) => this.resolveModeName(mode),
      getAllModes: () => this.getAllModes(),
      getOperatingMode: () => this.operatingMode,
      handleOperatingModeChange: (rawMode) => this.handleOperatingModeChange(rawMode),
      getCurrentPriceLevel: () => this.getCurrentPriceLevel(),
      recordPowerSample: (powerW) => {
        if (this.homey.settings.get('power_source') === 'homey_energy') return Promise.resolve();
        return this.recordPowerSample(powerW);
      },
      capacityGuard: this.capacityGuard,
      getFlowSnapshot: () => this.getFlowSnapshot(),
      refreshTargetDevicesSnapshot: () => this.refreshTargetDevicesSnapshot(),
      reportSteppedLoadActualStep: (deviceId, stepId) => this.reportSteppedLoadActualStep(deviceId, stepId),
      getDeviceLoadSetting: (deviceId) => this.getDeviceLoadSetting(deviceId),
      setExpectedOverride: (deviceId, kw) => this.setExpectedOverride(deviceId, kw),
      storeFlowPriceData: (kind, raw) => this.storeFlowPriceData(kind, raw),
      requestFlowPlanRebuild: (source) => this.flowRebuildScheduler?.requestRebuild(source),
      evaluateHeadroomForDevice: (params) => this.evaluateHeadroomForDevice(params),
      loadDailyBudgetSettings: () => this.dailyBudgetService.loadSettings(),
      updateDailyBudgetState: (options) => this.dailyBudgetService.updateState(options),
      getCombinedHourlyPrices: () => this.getCombinedHourlyPrices(),
      getTimeZone: () => this.getTimeZone(),
      getNow: () => this.getNow(),
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (topic: DebugLoggingTopic, ...args: unknown[]) => this.logDebug(topic, ...args),
      error: (...args: unknown[]) => this.error(...args),
    };
    registerAppFlowCards(deps);
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
  private getLivePriceLevel(): PriceLevel {
    const livePriceLevel = this.planService?.getLastNotifiedPriceLevel();
    if (livePriceLevel && livePriceLevel !== PriceLevel.UNKNOWN) return livePriceLevel;
    const status = this.homey.settings.get('pels_status') as { priceLevel?: PriceLevel } | null;
    return (status?.priceLevel || livePriceLevel || PriceLevel.UNKNOWN) as PriceLevel;
  }
  private getCurrentPriceLevel(): PriceLevel {
    return this.getLivePriceLevel();
  }
  private startHomeyEnergyPoll(): void {
    if (this.homeyEnergyPollInterval) clearInterval(this.homeyEnergyPollInterval);
    if (this.homey.settings.get('power_source') !== 'homey_energy') return;
    // Fire immediately so the first reading doesn't wait for the interval
    this.pollHomeyEnergyPower()
      .catch((e) => this.error('Homey Energy initial poll failed', e));
    this.homeyEnergyPollInterval = setInterval(() => {
      this.pollHomeyEnergyPower()
        .catch((e) => this.error('Homey Energy poll failed', e));
    }, HOMEY_ENERGY_POLL_INTERVAL_MS);
  }

  private stopHomeyEnergyPoll(): void {
    if (this.homeyEnergyPollInterval) {
      clearInterval(this.homeyEnergyPollInterval);
      this.homeyEnergyPollInterval = undefined;
    }
  }

  private async pollHomeyEnergyPower(): Promise<void> {
    const homePowerW = await this.deviceManager.pollHomePowerW();
    if (typeof homePowerW === 'number') {
      this.logDebug('devices', `Homey Energy poll: ${homePowerW}W`);
      await this.recordPowerSample(homePowerW);
    } else {
      this.logDebug('devices', 'Homey Energy poll: no cumulative power reading available');
    }
  }

  private startPeriodicSnapshotRefresh(): void {
    if (this.snapshotRefreshTimer) clearTimeout(this.snapshotRefreshTimer);
    this.scheduleNextSnapshotRefresh();
    this.startStaleObservationRefreshFallback();

    if (this.targetConfirmationPollInterval) clearInterval(this.targetConfirmationPollInterval);
    this.targetConfirmationPollInterval = setInterval(() => {
      this.pollStuckTargetConfirmations()
        .catch((e) => this.error('Pending target confirmation poll failed', e));
    }, TARGET_CONFIRMATION_POLL_INTERVAL_MS);
  }

  private startStaleObservationRefreshFallback(): void {
    this.staleObservationRefreshStopped = false;
    if (this.staleObservationRefreshTimer) clearTimeout(this.staleObservationRefreshTimer);
    this.scheduleStaleObservationRefreshFallback();
  }

  private scheduleStaleObservationRefreshFallback(): void {
    if (this.staleObservationRefreshStopped) return;
    this.staleObservationRefreshTimer = setTimeout(async () => {
      try {
        await this.refreshStaleDeviceObservations();
      } catch (e) {
        this.error('Stale device observation refresh failed', e);
      } finally {
        if (!this.staleObservationRefreshStopped) {
          this.scheduleStaleObservationRefreshFallback();
        }
      }
    }, STALE_OBSERVATION_FALLBACK_REFRESH_INTERVAL_MS);
  }

  private async refreshStaleDeviceObservations(): Promise<void> {
    if (!this.deviceManager || this.isSnapshotRefreshing) return;
    const snapshot = this.latestTargetSnapshot.filter((device) => this.resolveManagedState(device.id));
    this.logDeviceFreshnessTransitions(snapshot, 'stale_observation_check');
    const staleDevices = snapshot.filter((device) => isDeviceObservationStale(device));
    if (staleDevices.length === 0) return;

    this.logDebug(
      'devices',
      `Refreshing target devices snapshot because ${staleDevices.length}/${snapshot.length} managed devices are stale`,
    );
    const staleDeviceIds = new Set(staleDevices.map((device) => device.id));
    await this.refreshTargetDevicesSnapshot({ targeted: true });
    const refreshedSnapshot = this.latestTargetSnapshot.filter((device) => this.resolveManagedState(device.id));
    const refreshedById = new Map(refreshedSnapshot.map((device) => [device.id, device]));
    let freshAfterRefreshDevices = 0;
    let stillStaleAfterRefreshDevices = 0;
    for (const deviceId of staleDeviceIds) {
      const refreshedDevice = refreshedById.get(deviceId);
      if (!refreshedDevice || isDeviceObservationStale(refreshedDevice)) {
        stillStaleAfterRefreshDevices += 1;
      } else {
        freshAfterRefreshDevices += 1;
      }
    }
    this.getStructuredLogger('devices')?.info({
      event: 'stale_device_observation_refresh',
      staleDevices: staleDevices.length,
      devicesTotal: snapshot.length,
      refreshedDevices: staleDevices.length,
      freshAfterRefreshDevices,
      stillStaleAfterRefreshDevices,
    });
  }

  private logDeviceFreshnessTransitions(
    snapshot: TargetDeviceSnapshot[],
    source: string,
  ): void {
    const activeDeviceIds = new Set(snapshot.map((device) => device.id));
    for (const deviceId of this.deviceObservationStaleById.keys()) {
      if (!activeDeviceIds.has(deviceId)) this.deviceObservationStaleById.delete(deviceId);
    }

    const nowMs = Date.now();
    for (const device of snapshot) {
      const isStale = isDeviceObservationStale(device);
      const wasStale = this.deviceObservationStaleById.get(device.id);
      this.deviceObservationStaleById.set(device.id, isStale);
      if (wasStale === undefined || wasStale === isStale) continue;

      const lastObservationMs = getLatestDeviceObservationMs(device);
      const ageMs = typeof lastObservationMs === 'number' ? Math.max(0, nowMs - lastObservationMs) : null;
      const planDevice = this.planService?.getLatestPlanSnapshot()?.devices.find((d) => d.id === device.id);
      this.getStructuredLogger('devices')?.info({
        event: isStale ? 'device_became_stale' : 'device_became_fresh',
        deviceId: device.id,
        deviceName: device.name,
        ageMs,
        lastObservationAt: typeof lastObservationMs === 'number' ? new Date(lastObservationMs).toISOString() : null,
        source,
        currentPowerW: resolveSnapshotPowerW(device),
        isControlled: this.isCapacityControlEnabled(device.id),
        isShed: planDevice ? planDevice.plannedState === 'shed' : null,
      });
    }
  }

  private scheduleNextSnapshotRefresh(): void {
    const now = this.getNow();
    const currentMinute = now.getMinutes();
    const nextMinute = SNAPSHOT_REFRESH_MINUTE_INTERVALS.find((m) => m > currentMinute);

    const next = new Date(now);
    if (nextMinute !== undefined) {
      next.setMinutes(nextMinute, 0, 0);
    } else {
      next.setHours(now.getHours() + 1, SNAPSHOT_REFRESH_MINUTE_INTERVALS[0], 0, 0);
    }

    this.snapshotRefreshTimer = setTimeout(async () => {
      let refreshed = false;
      try {
        await this.refreshTargetDevicesSnapshot({ targeted: true });
        refreshed = true;
      } catch (e) {
        this.error('Periodic snapshot refresh failed', e);
      }
      this.logPeriodicStatus({ includeDeviceHealth: refreshed });
      this.scheduleNextSnapshotRefresh();
    }, next.getTime() - now.getTime());
  }

  private async pollStuckTargetConfirmations(): Promise<void> {
    if (!this.planEngine?.hasPendingTargetCommandsOlderThan(TARGET_CONFIRMATION_STUCK_POLL_MS)) return;
    this.logDebug(
      'devices',
      `Pending target confirmation older than ${Math.round(TARGET_CONFIRMATION_STUCK_POLL_MS / 1000)}s; `
      + 'polling device state',
    );
    await this.refreshTargetDevicesSnapshot({ targeted: true });
  }
  private logPeriodicStatus(options: { includeDeviceHealth?: boolean } = {}): void {
    const periodicStatusParams = {
      capacityGuard: this.capacityGuard,
      powerTracker: this.powerTracker,
      capacitySettings: this.capacitySettings,
      operatingMode: this.operatingMode,
      capacityDryRun: this.capacityDryRun,
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
    return this.decorateTargetSnapshotList(snapshot);
  }
  setSnapshotForTests(snapshot: TargetDeviceSnapshot[]): void {
    this.deviceManager.setSnapshotForTests(snapshot);
  }
  parseDevicesForTests(list: HomeyDeviceLike[]): TargetDeviceSnapshot[] {
    return this.deviceManager.parseDeviceListForTests(list);
  }
  private static readonly POST_ACTUATION_REFRESH_DELAY_MS = 5_000;
  private schedulePostActuationRefresh(): void {
    if (this.postActuationRefreshTimer) {
      this.logDebug('plan', 'Post-actuation snapshot refresh already scheduled');
      return;
    }
    this.logDebug(
      'plan',
      `Scheduling post-actuation snapshot refresh in ${Math.round(PelsApp.POST_ACTUATION_REFRESH_DELAY_MS / 1000)} s`,
    );
    this.postActuationRefreshTimer = setTimeout(async () => {
      this.postActuationRefreshTimer = undefined;
      this.logDebug('plan', 'Running post-actuation targeted snapshot refresh');
      try {
        await this.refreshTargetDevicesSnapshot({ targeted: true, recordHomeyEnergySample: false });
      } catch (err) {
        this.error('Post-actuation snapshot refresh failed:', err);
      }
    }, PelsApp.POST_ACTUATION_REFRESH_DELAY_MS);
  }
  private async refreshTargetDevicesSnapshot(
    options: { fast?: boolean; targeted?: boolean; recordHomeyEnergySample?: boolean } = {},
  ): Promise<void> {
    if (this.isSnapshotRefreshing) {
      this.snapshotRefreshPending = true;
      this.logDebug('devices', 'Snapshot refresh already in progress, queued another refresh');
      return;
    }
    this.isSnapshotRefreshing = true;
    try {
      do {
        this.snapshotRefreshPending = false;
        this.logDebug('devices', 'Refreshing target devices snapshot');
        await this.deviceManager.refreshSnapshot({
          includeLivePower: options.fast !== true,
          targetedRefresh: options.targeted,
        });
        const snapshot = this.latestTargetSnapshot;
        this.logDeviceFreshnessTransitions(
          snapshot.filter((device) => this.resolveManagedState(device.id)),
          'snapshot_refresh',
        );
        await this.planService?.syncLivePlanState('snapshot_refresh');
        this.planService?.syncHeadroomCardState({
          devices: snapshot,
          cleanupMissingDevices: true,
        });
        const existingSnapshot = this.homey.settings.get('target_devices_snapshot') as unknown;
        if (toPersistedTargetSnapshotFingerprint(existingSnapshot) !== toPersistedTargetSnapshotFingerprint(snapshot)) {
          this.homey.settings.set('target_devices_snapshot', snapshot);
        } else {
          this.logDebug('devices', 'Target devices snapshot unchanged, skipping settings write');
        }
        disableUnsupportedDevicesHelper({
          snapshot,
          settings: this.homey.settings,
          logDebug: (...args: unknown[]) => this.logDebug('devices', ...args),
        });
        if (options.recordHomeyEnergySample !== false && this.homey.settings.get('power_source') === 'homey_energy') {
          const homePowerW = this.deviceManager.getHomePowerW();
          if (typeof homePowerW === 'number') {
            await this.recordPowerSample(homePowerW);
          }
        }
      } while (this.snapshotRefreshPending);
    } finally {
      this.isSnapshotRefreshing = false;
      this.snapshotRefreshPending = false;
    }
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
  private handleShortfall = (deficitKw: number) => this.planService.handleShortfall(deficitKw);
  private handleShortfallCleared = () => this.planService.handleShortfallCleared();
  private evaluateHeadroomForDevice = (
    params: Parameters<PlanService['evaluateHeadroomForDevice']>[0],
  ): HeadroomForDeviceDecision | null => this.planService.evaluateHeadroomForDevice(params);
  public getDeviceDiagnosticsUiPayload(): SettingsUiDeviceDiagnosticsPayload {
    return this.deviceDiagnosticsService?.getUiPayload?.()
      ?? { generatedAt: Date.now(), windowDays: 21, diagnosticsByDeviceId: {} };
  }
  public applyPlanActions = (plan: DevicePlan) => this.planService.applyPlanActions(plan);
  public applySheddingToDevice = (deviceId: string, deviceName?: string, reason?: string) =>
    this.planService.applySheddingToDevice(deviceId, deviceName, reason);
}

function resolveSnapshotPowerW(device: TargetDeviceSnapshot): number | null {
  const kw = typeof device.measuredPowerKw === 'number'
    ? device.measuredPowerKw
    : device.powerKw;
  return typeof kw === 'number' && Number.isFinite(kw) ? kw * 1000 : null;
}

export = PelsApp;
