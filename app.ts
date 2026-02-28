import Homey from 'homey';
import CapacityGuard from './lib/core/capacityGuard';
import { DeviceManager } from './lib/core/deviceManager';
import { PlanEngine } from './lib/plan/planEngine';
import { DevicePlan, ShedBehavior } from './lib/plan/planTypes';
import { PlanService } from './lib/plan/planService';
import { HomeyDeviceLike, TargetDeviceSnapshot } from './lib/utils/types';
import { PriceCoordinator } from './lib/price/priceCoordinator';
import { PowerTrackerState } from './lib/core/powerTracker';
import { PriceLevel } from './lib/price/priceLevels';
import { buildPeriodicStatusLog } from './lib/core/periodicStatus';
import { getDeviceLoadSetting } from './lib/core/deviceLoad';
import { DailyBudgetService } from './lib/dailyBudget/dailyBudgetService';
import type { DailyBudgetUiPayload } from './lib/dailyBudget/dailyBudgetTypes';
import { type DebugLoggingTopic } from './lib/utils/debugLogging';
import { getAllModes as getAllModesHelper, getShedBehavior as getShedBehaviorHelper, resolveModeName as resolveModeNameHelper } from './lib/utils/capacityHelpers';
import { OPERATING_MODE_SETTING } from './lib/utils/settingsKeys';
import { isPowerTrackerState } from './lib/utils/appTypeGuards';
import { resolveHomeyEnergyApiFromHomeyApi, resolveHomeyEnergyApiFromSdk, type HomeyEnergyApi } from './lib/utils/homeyEnergy';
import {
  persistPowerTrackerStateForApp,
  prunePowerTrackerHistoryForApp,
  updateDailyBudgetAndRecordCapForApp,
  PowerSampleRebuildState,
  recordPowerSampleForApp,
  schedulePlanRebuildFromSignal,
} from './lib/app/appPowerHelpers';
import {
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
import { disableUnsupportedDevices as disableUnsupportedDevicesHelper } from './lib/app/appDeviceSupport';
import { runStartupStep, startAppServices } from './lib/app/appLifecycleHelpers';
import { addPerfDuration, incPerfCounter } from './lib/utils/perfCounters';
import { startPerfLogger } from './lib/app/perfLogging';
import { getHomeyDevicesForDebug as getHomeyDevicesForDebugHelper, logHomeyDeviceForDebug as logHomeyDeviceForDebugHelper } from './lib/app/appDebugHelpers';
import { VOLATILE_WRITE_THROTTLE_MS } from './lib/utils/timingConstants';
import { toStableFingerprint } from './lib/utils/stableFingerprint';
import { startResourceWarningListeners as startResourceWarningListenersHelper } from './lib/app/appResourceWarningHelpers';
import { migrateManagedDevices as migrateManagedDevicesHelper } from './lib/app/appManagedDeviceMigration';
import { restoreCachedTargetSnapshotForApp } from './lib/app/appStartupHelpers';
const SNAPSHOT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 2000;
const POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 100 : 30 * 1000;
const POWER_TRACKER_PRUNE_INITIAL_DELAY_MS = 10 * 1000;
const POWER_TRACKER_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const POWER_TRACKER_PERSIST_DELAY_MS = VOLATILE_WRITE_THROTTLE_MS;
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
  private shedBehaviors: Record<string, ShedBehavior> = {};
  private debugLoggingTopics = new Set<DebugLoggingTopic>();
  private dailyBudgetService!: DailyBudgetService;
  private priceCoordinator!: PriceCoordinator;
  private deviceManager!: DeviceManager;
  private planEngine!: PlanEngine;
  private planService!: PlanService;
  private defaultComputeDynamicSoftLimit?: () => number;
  private snapshotRefreshInterval?: ReturnType<typeof setInterval>;
  private isSnapshotRefreshing = false;
  private snapshotRefreshPending = false;
  private lastKnownPowerKw: Record<string, number> = {};
  private expectedPowerKwOverrides: Record<string, { kw: number; ts: number }> = {};
  private overheadToken?: Homey.FlowToken;
  private lastMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
  private lastNotifiedOperatingMode = 'Home';
  private powerSampleRebuildState: PowerSampleRebuildState = { lastMs: 0 };
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private stopPerfLogging?: () => void;
  private stopResourceWarningListeners?: () => void;
  private updateLocalSnapshot(deviceId: string, updates: { target?: number | null; on?: boolean }): void {
    this.deviceManager.updateLocalSnapshot(deviceId, updates);
  }
  private setExpectedOverride(deviceId: string, kw: number): void { this.expectedPowerKwOverrides[deviceId] = { kw, ts: Date.now() }; }
  private getHomeyEnergyApi(): HomeyEnergyApi | null {
    const sdkEnergy = resolveHomeyEnergyApiFromSdk(this.homey);
    if (sdkEnergy) return sdkEnergy;
    const homeyApi = this.deviceManager?.getHomeyApi?.();
    return resolveHomeyEnergyApiFromHomeyApi(homeyApi);
  }
  async getHomeyDevicesForDebug(): Promise<HomeyDeviceLike[]> {
    return getHomeyDevicesForDebugHelper({ deviceManager: this.deviceManager }).catch((err) => {
      this.log('Failed to get Homey devices for debug', err);
      return [];
    });
  }
  async logHomeyDeviceForDebug(deviceId: string): Promise<boolean> {
    return logHomeyDeviceForDebugHelper({
      deviceId,
      deviceManager: this.deviceManager,
      log: (msg, payload) => this.log(msg, payload),
      error: (msg, err) => this.error(msg, err),
    });
  }
  async onInit() {
    const deferStartupBootstrap = process.env.NODE_ENV !== 'test' || process.env.PELS_ASYNC_STARTUP === '1';
    this.log('PELS has been initialized');
    this.startResourceWarningListeners();
    await runStartupStep('updateDebugLoggingEnabled', () => this.updateDebugLoggingEnabled());
    this.startPerfLogging();
    await runStartupStep('initPriceCoordinator', () => this.initPriceCoordinator());
    await runStartupStep('migrateManagedDevices', () => this.migrateManagedDevices());
    await runStartupStep('loadCapacitySettings', () => this.loadCapacitySettings());
    await runStartupStep('initDailyBudgetService', () => this.initDailyBudgetService());
    await runStartupStep('initDeviceManager', () => this.initDeviceManager());
    const hasCachedTargetSnapshot = restoreCachedTargetSnapshotForApp({
      homey: this.homey,
      deviceManager: this.deviceManager,
      logDebug: (...args: unknown[]) => this.logDebug('devices', ...args),
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
      refreshTargetDevicesSnapshot: () => this.refreshTargetDevicesSnapshot({ fast: true }),
      rebuildPlanFromCache: () => this.planService.rebuildPlanFromCache('startup_snapshot_bootstrap'),
      setLastNotifiedOperatingMode: (mode) => { this.lastNotifiedOperatingMode = mode; },
      getOperatingMode: () => this.operatingMode,
      registerFlowCards: () => this.registerFlowCards(),
      startPeriodicSnapshotRefresh: () => this.startPeriodicSnapshotRefresh(),
      refreshSpotPrices: () => this.priceCoordinator.refreshSpotPrices(),
      refreshGridTariffData: () => this.priceCoordinator.refreshGridTariffData(),
      startPriceRefresh: () => this.priceCoordinator.startPriceRefresh(),
      startPriceOptimization: (applyImmediately) => this.priceCoordinator.startPriceOptimization(applyImmediately),
      logError: (label, error) => this.error(`Startup background task failed (${label})`, error),
      snapshotPlanBootstrapDelayMs,
      runSnapshotPlanBootstrapInBackground: deferStartupBootstrap,
      runPriceBootstrapInBackground: deferStartupBootstrap,
      applyPriceOptimizationImmediatelyOnStart: !deferStartupBootstrap,
    }));
    await runStartupStep('startPowerTrackerPruning', () => this.startPowerTrackerPruning());
  }
  private initPriceCoordinator(): void {
    this.priceCoordinator = createPriceCoordinator({
      homey: this.homey,
      getHomeyEnergyApi: () => this.getHomeyEnergyApi(),
      getCurrentPriceLevel: () => this.getCurrentPriceLevel(),
      rebuildPlanFromCache: (reason?: string) => this.planService?.rebuildPlanFromCache(reason) ?? Promise.resolve(),
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (...args: unknown[]) => this.logDebug('price', ...args),
      error: (...args: unknown[]) => this.error(...args),
    });
  }
  private initDailyBudgetService(): void {
    this.dailyBudgetService = new DailyBudgetService({
      homey: this.homey,
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (...args: unknown[]) => this.logDebug('daily_budget', ...args),
      getPowerTracker: () => this.powerTracker,
      getPriceOptimizationEnabled: () => this.priceOptimizationEnabled,
      getCapacitySettings: () => this.capacitySettings,
    });
    this.dailyBudgetService.loadSettings();
    this.dailyBudgetService.loadState();
  }
  private async initDeviceManager(): Promise<void> {
    this.deviceManager = new DeviceManager(this, {
      log: this.log.bind(this),
      debug: (...args: unknown[]) => this.logDebug('devices', ...args),
      error: this.error.bind(this),
    }, {
      getPriority: (id) => this.getPriorityForDevice(id),
      getControllable: (id) => this.isCapacityControlEnabled(id),
      getManaged: (id) => this.resolveManagedState(id),
    }, {
      expectedPowerKwOverrides: this.expectedPowerKwOverrides,
      lastKnownPowerKw: this.lastKnownPowerKw,
      lastMeasuredPowerKw: this.lastMeasuredPowerKw,
    });
    await this.deviceManager.init();
  }
  private initCapacityGuard(): void {
    this.capacityGuard = new CapacityGuard({
      limitKw: this.capacitySettings.limitKw,
      softMarginKw: this.capacitySettings.marginKw,
      onShortfall: async (deficitKw) => {
        await this.handleShortfall(deficitKw);
      },
      onShortfallCleared: async () => {
        await this.handleShortfallCleared();
      },
      log: (...args) => this.log(...args),
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
      applySheddingToDevice: (deviceId, deviceName, reason) => this.applySheddingToDevice(deviceId, deviceName, reason),
      updateLocalSnapshot: (deviceId, updates) => this.updateLocalSnapshot(deviceId, updates),
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (topic: DebugLoggingTopic, ...args: unknown[]) => this.logDebug(topic, ...args),
      error: (...args: unknown[]) => this.error(...args),
    };
    this.planEngine = createPlanEngine(deps);
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
      isCurrentHourCheap: () => this.isCurrentHourCheap(),
      isCurrentHourExpensive: () => this.isCurrentHourExpensive(),
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (topic: DebugLoggingTopic, ...args: unknown[]) => this.logDebug(topic, ...args),
      error: (...args: unknown[]) => this.error(...args),
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
    initSettingsHandlerForApp({
      homey: this.homey,
      getOperatingMode: () => this.operatingMode,
      notifyOperatingModeChanged: (mode) => this.notifyOperatingModeChanged(mode),
      loadCapacitySettings: () => this.loadCapacitySettings(),
      rebuildPlanFromCache: (reason?: string) => this.planService.rebuildPlanFromCache(reason),
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
      log: (message: string) => this.log(message),
      error: (message: string, error: Error) => this.error(message, error),
    });
  }
  async onUninit(): Promise<void> {
    if (this.powerTrackerSaveTimer) {
      this.persistPowerTrackerState();
    }
    if (this.powerTrackerPruneTimer) {
      clearTimeout(this.powerTrackerPruneTimer);
      this.powerTrackerPruneTimer = undefined;
    }
    if (this.powerTrackerPruneInterval) {
      clearInterval(this.powerTrackerPruneInterval);
      this.powerTrackerPruneInterval = undefined;
    }
    if (this.snapshotRefreshInterval) {
      clearInterval(this.snapshotRefreshInterval);
      this.snapshotRefreshInterval = undefined;
    }
    if (this.powerSampleRebuildState.timer) {
      clearTimeout(this.powerSampleRebuildState.timer);
      this.powerSampleRebuildState.timer = undefined;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (this.stopPerfLogging) {
      this.stopPerfLogging();
      this.stopPerfLogging = undefined;
    }
    if (this.stopResourceWarningListeners) {
      this.stopResourceWarningListeners();
      this.stopResourceWarningListeners = undefined;
    }
    this.planService?.destroy();
    this.priceCoordinator.stop();
    this.deviceManager?.destroy();
  }
  private logDebug(topic: DebugLoggingTopic, ...args: unknown[]): void {
    if (this.debugLoggingTopics.has(topic)) {
      this.log(...args);
    }
  }
  private startHeartbeat(): void {
    const updateHeartbeat = () => this.homey.settings.set('app_heartbeat', Date.now());
    updateHeartbeat();
    this.heartbeatInterval = setInterval(updateHeartbeat, 30 * 1000);
  }
  private startPerfLogging(): void {
    this.stopPerfLogging = startPerfLogger({
      isEnabled: () => this.debugLoggingTopics.has('perf'),
      log: (...args: unknown[]) => this.logDebug('perf', ...args),
      logCpuSpike: (...args: unknown[]) => this.log(...args),
      intervalMs: 30 * 1000,
    });
  }
  private startResourceWarningListeners(): void {
    if (this.stopResourceWarningListeners) {
      this.stopResourceWarningListeners();
      this.stopResourceWarningListeners = undefined;
    }
    this.stopResourceWarningListeners = startResourceWarningListenersHelper({
      homey: this.homey,
      log: (message) => this.log(message),
    });
  }
  private getDynamicSoftLimitOverride(): number | null {
    if (!this.defaultComputeDynamicSoftLimit || this.computeDynamicSoftLimit === this.defaultComputeDynamicSoftLimit) return null;
    const value = this.computeDynamicSoftLimit();
    return Number.isFinite(value) ? value : null;
  }
  private updatePriceOptimizationEnabled(logChange = false): void {
    this.priceCoordinator.updatePriceOptimizationEnabled(logChange);
  }
  private get priceOptimizationEnabled(): boolean { return this.priceCoordinator.getPriceOptimizationEnabled(); }
  private get priceOptimizationSettings(): Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }> { return this.priceCoordinator.getPriceOptimizationSettings(); }
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
    const card = this.homey.flow?.getTriggerCard?.('operating_mode_changed');
    if (card && typeof card.trigger === 'function') {
      card.trigger({}, { mode: trimmed }).catch((err: Error) => this.error('Failed to trigger operating_mode_changed', err));
    }
    this.lastNotifiedOperatingMode = trimmed;
  }
  private loadPowerTracker(options: { skipDailyBudgetUpdate?: boolean } = {}): void {
    const stored = this.homey.settings.get('power_tracker_state') as unknown;
    if (isPowerTrackerState(stored)) {
      this.powerTracker = stored;
    }
    if (options.skipDailyBudgetUpdate !== true) {
      this.dailyBudgetService.updateState({ refreshObservedStats: false });
    }
  }
  private migrateManagedDevices(): void {
    migrateManagedDevicesHelper({
      homey: this.homey,
      log: (message) => this.log(message),
    });
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
    this.shedBehaviors = next.shedBehaviors;
    this.updatePriceOptimizationEnabled();
    void this.updateOverheadToken(this.capacitySettings.marginKw);
  }
  private loadPriceOptimizationSettings(): void {
    this.priceCoordinator.loadPriceOptimizationSettings();
  }
  public getDailyBudgetUiPayload(): DailyBudgetUiPayload | null {
    return this.dailyBudgetService.getUiPayload();
  }
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
    this.powerTrackerPruneTimer = setTimeout(() => this.prunePowerTrackerHistory(), POWER_TRACKER_PRUNE_INITIAL_DELAY_MS);
    this.powerTrackerPruneInterval = setInterval(() => this.prunePowerTrackerHistory(), POWER_TRACKER_PRUNE_INTERVAL_MS);
  }

  private savePowerTracker(nextState: PowerTrackerState = this.powerTracker): void {
    this.powerTracker = nextState;
    this.updateDailyBudgetAndRecordCap({ nowMs: nextState.lastTimestamp ?? Date.now() });

    if (!this.powerTrackerSaveTimer) {
      this.powerTrackerSaveTimer = setTimeout(() => this.persistPowerTrackerState(), POWER_TRACKER_PERSIST_DELAY_MS);
    }
  }

  private updateDailyBudgetAndRecordCap(options?: { nowMs?: number; forcePlanRebuild?: boolean }): void {
    this.powerTracker = updateDailyBudgetAndRecordCapForApp({
      powerTracker: this.powerTracker,
      dailyBudgetService: this.dailyBudgetService,
      options,
    });
  }
  private async recordPowerSample(currentPowerW: number, nowMs: number = Date.now()): Promise<void> {
    const sampleStart = Date.now();
    try {
      await recordPowerSampleForApp({
        currentPowerW,
        nowMs,
        capacitySettings: this.capacitySettings,
        getLatestTargetSnapshot: () => this.latestTargetSnapshot,
        powerTracker: this.powerTracker,
        capacityGuard: this.capacityGuard,
        homey: this.homey,
        schedulePlanRebuild: () => schedulePlanRebuildFromSignal({
          getState: () => this.powerSampleRebuildState,
          setState: (state) => {
            this.powerSampleRebuildState = state;
          },
          minIntervalMs: POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS,
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
    } finally {
      addPerfDuration('power_sample_ms', Date.now() - sampleStart);
      incPerfCounter('power_sample_total');
    }
  }
  private registerFlowCards(): void {
    const deps: FlowCardInitApp = {
      homey: this.homey,
      resolveModeName: (mode) => this.resolveModeName(mode),
      getAllModes: () => this.getAllModes(),
      getOperatingMode: () => this.operatingMode,
      handleOperatingModeChange: (rawMode) => this.handleOperatingModeChange(rawMode),
      getCurrentPriceLevel: () => this.getCurrentPriceLevel(),
      recordPowerSample: (powerW) => this.recordPowerSample(powerW),
      capacityGuard: this.capacityGuard,
      getFlowSnapshot: () => this.getFlowSnapshot(),
      refreshTargetDevicesSnapshot: () => this.refreshTargetDevicesSnapshot(),
      getDeviceLoadSetting: (deviceId) => this.getDeviceLoadSetting(deviceId),
      setExpectedOverride: (deviceId, kw) => this.setExpectedOverride(deviceId, kw),
      storeFlowPriceData: (kind, raw) => this.storeFlowPriceData(kind, raw),
      planService: this.planService,
      loadDailyBudgetSettings: () => this.dailyBudgetService.loadSettings(),
      updateDailyBudgetState: (options) => this.dailyBudgetService.updateState(options),
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (topic: DebugLoggingTopic, ...args: unknown[]) => this.logDebug(topic, ...args),
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
  private getCurrentPriceLevel(): PriceLevel {
    const status = this.homey.settings.get('pels_status') as { priceLevel?: PriceLevel } | null;
    const fallback = this.planService?.getLastNotifiedPriceLevel() ?? PriceLevel.UNKNOWN;
    return (status?.priceLevel || fallback) as PriceLevel;
  }
  private startPeriodicSnapshotRefresh(): void {
    if (this.snapshotRefreshInterval) clearInterval(this.snapshotRefreshInterval);
    this.snapshotRefreshInterval = setInterval(() => {
      this.refreshTargetDevicesSnapshot().catch((e) => this.error('Periodic snapshot refresh failed', e));
      this.logPeriodicStatus();
    }, SNAPSHOT_REFRESH_INTERVAL_MS);
  }
  private logPeriodicStatus(): void {
    this.log(buildPeriodicStatusLog({
      capacityGuard: this.capacityGuard,
      powerTracker: this.powerTracker,
      capacitySettings: this.capacitySettings,
      operatingMode: this.operatingMode,
      capacityDryRun: this.capacityDryRun,
    }));
    const dailyBudgetLog = this.dailyBudgetService.getPeriodicStatusLog();
    if (dailyBudgetLog) this.log(dailyBudgetLog);
  }
  private get latestTargetSnapshot(): TargetDeviceSnapshot[] { return this.deviceManager?.getSnapshot() ?? []; }
  setSnapshotForTests(snapshot: TargetDeviceSnapshot[]): void { this.deviceManager.setSnapshotForTests(snapshot); }
  parseDevicesForTests(list: HomeyDeviceLike[]): TargetDeviceSnapshot[] { return this.deviceManager.parseDeviceListForTests(list); }
  private async refreshTargetDevicesSnapshot(options: { fast?: boolean } = {}): Promise<void> {
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
        await this.deviceManager.refreshSnapshot({ includeLivePower: options.fast !== true });
        const snapshot = this.deviceManager.getSnapshot();
        const existingSnapshot = this.homey.settings.get('target_devices_snapshot') as unknown;
        if (toStableFingerprint(existingSnapshot) !== toStableFingerprint(snapshot)) {
          this.homey.settings.set('target_devices_snapshot', snapshot);
        } else {
          this.logDebug('devices', 'Target devices snapshot unchanged, skipping settings write');
        }
        disableUnsupportedDevicesHelper({ snapshot, settings: this.homey.settings, logDebug: (...args: unknown[]) => this.logDebug('devices', ...args) });
      } while (this.snapshotRefreshPending);
    } finally {
      this.isSnapshotRefreshing = false;
      this.snapshotRefreshPending = false;
    }
  }
  public getCombinedHourlyPrices = (): unknown => this.priceCoordinator.getCombinedHourlyPrices();
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
      getHomeyApi: () => this.deviceManager.getHomeyApi(),
      initHomeyApi: () => this.deviceManager.init(),
      error: (...args: unknown[]) => this.error(...args),
    });
  }
  private getPriorityForDevice = (deviceId: string) => this.capacityPriorities[this.operatingMode || 'Home']?.[deviceId] ?? 100;
  private resolveModeName = (name: string) => resolveModeNameHelper(name, this.modeAliases);
  private getAllModes = () => getAllModesHelper(this.operatingMode, this.capacityPriorities, this.modeDeviceTargets);
  private resolveManagedState = (deviceId: string) => this.managedDevices[deviceId] === true;
  private isCapacityControlEnabled = (deviceId: string) => this.managedDevices[deviceId] === true && this.controllableDevices[deviceId] === true;
  private getShedBehavior = (deviceId: string) => getShedBehaviorHelper(deviceId, this.shedBehaviors);
  private computeDynamicSoftLimit = () => this.planService.computeDynamicSoftLimit();
  private computeShortfallThreshold = () => this.planService.computeShortfallThreshold();
  private handleShortfall = (deficitKw: number) => this.planService.handleShortfall(deficitKw);
  private handleShortfallCleared = () => this.planService.handleShortfallCleared();
  public applyPlanActions = (plan: DevicePlan) => this.planService.applyPlanActions(plan);
  private applySheddingToDevice = (deviceId: string, deviceName?: string, reason?: string) => this.planService.applySheddingToDevice(deviceId, deviceName, reason);
}
export = PelsApp;
